// 写入目标的**真实路径**守卫。修 P1:依赖准备可沿 --prefix 软链写入受保护目录。
//
// 原缺陷(已实测复现,见 ../test/safe-write-root.test.mjs 的 spawn 负例):
//   prepare-host-modules.mjs 用 path.resolve() + 字符串前缀比较来确认「我只写沙箱内」。
//   resolve() 是**纯词法**的:它折叠 `.` 与 `..`,但从不读文件系统,所以完全看不见
//   祖先目录是不是软链。于是
//       --prefix=<沙箱>/via/host-deps      (其中 <沙箱>/via 是指向 ~/.dsh/profiles/web/node_modules 的软链)
//   通过了「不在 ~/.dsh 下」的检查,而随后的 mkdirSync + writeFileSync **穿过软链**
//   落进了用户的活 profile。实测:offline 模式在退出 1 之前已经写出了 <layer>/package.json。
//
// 修法:在任何写入之前,
//   1. 逐级向上找到第一个**已存在**的祖先(用 lstat,所以悬空软链算「存在且是软链」);
//   2. 对它做 realpathSync —— 真的解析软链,而不是词法折叠;
//   3. 把待创建的尾段接在真实祖先后面,得到「写入最终会落到哪」的真实路径;
//   4. 对这个真实路径做四道检查:允许根内、禁止根外、无禁止路径段、祖先属当前用户。
//
// ⚠️ 诚实边界(不要当成完备):这是 check-then-write,存在 TOCTOU 残留窗口。
//   检查与 npm 真正落盘之间,攻击者仍可把某一级祖先换成软链。本模块能做到的是
//   「检查的对象与创建的对象一致」(createIdentity/assertSameObject,基于 dev+ino),
//   抓不到「创建之后、npm 写入期间」被换掉的情况。要真正关掉这个窗口需要 OS 级
//   沙箱(macOS Seatbelt 限定可写子路径)或 openat/O_NOFOLLOW 全链路,不在本模块范围内。
//   详见 assertSameObject 的注释与交付说明。

import { lstatSync, realpathSync, statSync, openSync, writeSync, closeSync, constants } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'

/** 任何依赖安装根都不可能合法地落在这些名字的目录里。`.dsh` 是本项目的硬不变量。 */
export const FORBIDDEN_PATH_SEGMENTS = ['.dsh', '.ssh', '.gnupg']

/** 路径是否落在某个前缀下(纯词法;调用方负责先把两边 realpath 掉)。 */
export function isInsideLexical(child, parent) {
	const c = resolve(child)
	const p = resolve(parent)
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep)
}

/** realpath 一个可能不存在的路径;不存在就返回 null(不抛)。 */
function realpathOrNull(p) {
	try {
		return realpathSync(p)
	} catch {
		return null
	}
}

/**
 * 默认允许的写入根:仓根 + 系统临时目录。
 * 两个都 realpath 掉:macOS 上 /tmp → /private/tmp、$TMPDIR → /private/var/folders/…,
 * 不解析就会把合法的临时路径判成越界。
 */
export function defaultAllowedRoots(repoRoot) {
	const roots = [repoRoot, tmpdir(), '/tmp']
	const out = []
	for (const r of roots) {
		const real = realpathOrNull(r)
		if (real && !out.includes(real)) out.push(real)
	}
	return out
}

/** 默认禁止的写入根:用户的活 DSH profile。 */
export function defaultForbiddenRoots(home = homedir()) {
	const dsh = join(home, '.dsh')
	// 同时记录词法路径与真实路径:~ 本身可能是软链(有些机器 /home/x → /Users/x)。
	return [...new Set([dsh, realpathOrNull(dsh)].filter(Boolean))]
}

/**
 * 逐级向上找第一个已存在的祖先。
 * 用 lstatSync 而不是 existsSync:existsSync 会跟随软链,悬空软链会被误判成
 * 「不存在、待创建」,而 mkdirSync 在悬空软链上是 EEXIST —— 那种路径必须被拒,不能被忽略。
 */
export function firstExistingAncestor(declared) {
	let cur = resolve(declared)
	const tailReversed = []
	for (;;) {
		let st = null
		try {
			st = lstatSync(cur)
		} catch {
			st = null
		}
		if (st) return { ancestor: cur, ancestorStat: st, tail: [...tailReversed].reverse() }
		const up = dirname(cur)
		if (up === cur) return { ancestor: null, ancestorStat: null, tail: [...tailReversed].reverse() }
		tailReversed.push(basename(cur))
		cur = up
	}
}

/**
 * 在**任何写入之前**判定「写 declared 最终会落到哪」,并检查那个真实位置是否被允许。
 *
 * 返回 { ok, declared, realTarget, realAncestor, createdTail, symlinkTraversal, violations, disclosures }。
 * 绝不抛、绝不写盘 —— 调用方拿到 ok:false 就该在写任何东西之前退出。
 *
 * @param {object} o
 * @param {string} o.target        操作员声明的写入目标(如 --prefix)
 * @param {string[]} o.allowedRoots   真实路径必须落在其中之一内
 * @param {string[]} [o.forbiddenRoots] 真实路径不得落在其中任一内
 * @param {string[]} [o.forbiddenSegments] 真实路径不得含这些路径段
 * @param {boolean} [o.requireOwner=true] 是否要求真实祖先属当前 uid
 */
export function inspectWriteTarget({
	target,
	allowedRoots,
	forbiddenRoots = defaultForbiddenRoots(),
	forbiddenSegments = FORBIDDEN_PATH_SEGMENTS,
	requireOwner = true,
}) {
	const declared = resolve(target)
	const violations = []
	const disclosures = []

	const { ancestor, ancestorStat, tail } = firstExistingAncestor(declared)
	if (!ancestor) {
		violations.push(`路径 ${declared} 一级祖先都不存在(连文件系统根都 stat 不到),拒绝写入`)
		return { ok: false, declared, realTarget: null, realAncestor: null, createdTail: tail, symlinkTraversal: false, violations, disclosures }
	}

	// 悬空软链 / 指向不存在目标的软链:realpathSync 会抛,这里必须拒而不是忽略。
	const realAncestor = realpathOrNull(ancestor)
	if (!realAncestor) {
		violations.push(`最近的已存在祖先 ${ancestor} 无法 realpath(悬空软链或权限不足),拒绝写入`)
		return { ok: false, declared, realTarget: null, realAncestor: null, createdTail: tail, symlinkTraversal: false, violations, disclosures }
	}

	let ancestorRealStat = null
	try {
		ancestorRealStat = statSync(realAncestor)
	} catch {
		ancestorRealStat = null
	}
	if (!ancestorRealStat || !ancestorRealStat.isDirectory()) {
		violations.push(`最近的已存在祖先的真实路径 ${realAncestor} 不是目录,拒绝写入`)
	}

	// 关键一步:真实祖先 + 待创建尾段 = 写入真正会落到的位置。
	const realTarget = tail.length ? join(realAncestor, ...tail) : realAncestor
	const symlinkTraversal = realAncestor !== ancestor
	if (symlinkTraversal) {
		// 只**披露**不判罪:macOS 上 /tmp → /private/tmp,合法临时路径必然触发这条。
		disclosures.push(`声明路径经过软链解析:${ancestor} → ${realAncestor}(写入真正会落到 ${realTarget})`)
	}

	const okRoots = (allowedRoots ?? []).map((r) => realpathOrNull(r) ?? resolve(r))
	if (okRoots.length === 0) {
		violations.push('没有给出任何允许的写入根,fail-closed 拒绝')
	} else if (!okRoots.some((r) => isInsideLexical(realTarget, r))) {
		violations.push(
			`真实写入位置 ${realTarget} 不在任何允许的写入根内。允许:${okRoots.join('、')}。`
			+ (symlinkTraversal ? `(声明的是 ${declared},但 ${ancestor} 是软链 → ${realAncestor};词法前缀检查看不出这一点,这正是本次修复的缺陷)` : ''),
		)
	}

	for (const bad of forbiddenRoots) {
		const realBad = realpathOrNull(bad) ?? resolve(bad)
		if (isInsideLexical(realTarget, realBad)) {
			violations.push(`真实写入位置 ${realTarget} 落在受保护目录 ${realBad} 内 —— 活 DSH profile 只能当只读输入,绝不能当写入目标`)
		}
	}

	const segments = realTarget.split(sep)
	for (const seg of forbiddenSegments) {
		if (segments.includes(seg)) {
			violations.push(`真实写入位置 ${realTarget} 含受保护路径段 "${seg}" —— 拒绝写入(这条能抓到被搬走/改名的 profile,不只是 $HOME 下那个)`)
		}
	}

	if (requireOwner && ancestorRealStat && typeof process.getuid === 'function') {
		const me = process.getuid()
		if (ancestorRealStat.uid !== me) {
			violations.push(`真实祖先 ${realAncestor} 属 uid ${ancestorRealStat.uid},当前进程是 uid ${me} —— 拒绝写入他人所有的目录`)
		}
	}

	return { ok: violations.length === 0, declared, realTarget, realAncestor, createdTail: tail, symlinkTraversal, violations, disclosures }
}

/** 记录一个已存在对象的文件系统身份(dev+ino),用于事后确认「还是同一个对象」。 */
export function identityOf(p) {
	try {
		const st = lstatSync(p)
		return { dev: st.dev, ino: st.ino, isSymlink: st.isSymbolicLink() }
	} catch {
		return null
	}
}

/**
 * 创建目录后确认「我创建的就是我检查过的那个对象」。
 *
 * ⚠️ 这是**尽力而为**,不是完备防御。它关掉的是「检查通过 → mkdir 之间被换掉」这一段:
 * mkdir 之后立刻 realpath + lstat,若真实路径已不等于检查时算出的 realTarget,或该路径
 * 本身变成了软链,就中止。它**关不掉**「mkdir 之后、npm 子进程写入期间」的替换 ——
 * npm 自己解析路径,我们无法把已验证的 fd 传给它。残留窗口如实记在模块顶部与交付说明里。
 */
export function assertSameObject(createdPath, expectedRealTarget) {
	const st = identityOf(createdPath)
	if (!st) return { ok: false, reason: `创建后 lstat 不到 ${createdPath}` }
	if (st.isSymlink) return { ok: false, reason: `创建后 ${createdPath} 变成了软链,中止(检查时它不是)` }
	const real = realpathOrNull(createdPath)
	if (!real) return { ok: false, reason: `创建后无法 realpath ${createdPath}` }
	if (real !== expectedRealTarget) {
		return { ok: false, reason: `创建后真实路径漂移:期望 ${expectedRealTarget},实际 ${real} —— 检查与写入之间路径被换过,中止` }
	}
	return { ok: true, reason: 'same-object', identity: st, realPath: real }
}

/**
 * 写文件,且**不跟随最后一段的软链**(O_NOFOLLOW)。
 * 用途:即使目录检查全过,<layerRoot>/package.json 本身也可能是一条指向别处的软链;
 * 普通 writeFileSync 会顺着它写出去。O_NOFOLLOW 让内核在最后一段是软链时直接 ELOOP。
 */
export function writeFileNoFollow(path, data) {
	const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW
	const fd = openSync(path, flags, 0o644)
	try {
		writeSync(fd, data)
	} finally {
		closeSync(fd)
	}
}
