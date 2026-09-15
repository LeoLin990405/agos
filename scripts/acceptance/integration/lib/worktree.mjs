/**
 * 工作树身份:一次集成层运行到底量的是哪棵树。
 *
 * 为什么不能只记 `git rev-parse HEAD`:HEAD 只描述**已提交**的内容。集成层几乎总是跑在
 * 有未提交改动的树上(本轮就是:五个代理并行改同一个工作区),此时两次运行的 HEAD 完全相同
 * 而被测代码已经不是同一份。只记 HEAD 的证据链等于宣称「这个结论对 745a0a6 成立」——
 * 而它其实对「745a0a6 加上某些没人记下来的改动」成立,后者无法复现,也就无法反驳。
 *
 * 所以摘要必须覆盖**工作树的实际内容**:HEAD + HEAD 的 tree 对象 + 每一条 porcelain 条目
 * (含未跟踪文件)的路径、状态字母与磁盘上的内容哈希。tree 对象单独进摘要是为了让
 * 「改了内容再 amend 成同名提交」这种情况也能看出来。
 *
 * 为什么不逐一哈希全部 tracked 文件:那是 596 次读盘,而 `git status` 已经精确告诉我们
 * 哪些偏离了 HEAD。干净树的摘要只取决于 HEAD/tree,脏树的摘要额外吃进每一处偏离的内容 ——
 * 「脏了摘要必须变」这条性质由此成立,代价却是常数级的。
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { digestTrackedFiles } from './tracked-digest.mjs'

/** 跑一条 git 子命令,失败返回 null(不抛):调用方要能在非 git 目录里降级,而不是崩掉。 */
function git(repoRoot, argv) {
	const res = spawnSync('git', argv, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
	if (res.status !== 0) return null
	return String(res.stdout ?? '')
}

/** 当前 HEAD 的完整 sha,拿不到(空仓/非 git 目录)返回 null。 */
export function gitHead(repoRoot) {
	const out = git(repoRoot, ['rev-parse', 'HEAD'])
	return out === null ? null : out.trim()
}

/**
 * `git status --porcelain=v1 -uall -z` 的解析。
 *
 * `-uall` 是硬要求:默认的 `-unormal` 会把一整个未跟踪目录折叠成一条 `?? dir/`,
 * 于是「往那个目录里再塞一个文件」不改变 porcelain 输出,摘要也就不变 —— 一个能让
 * 脏树伪装成上一次状态的口子。`-z` 是为了让含空格/换行的路径不需要反引号解码。
 *
 * 重命名/复制条目在 -z 下是**两个** NUL 段(新路径在前、原路径在后),必须一起消费,
 * 否则原路径会被当成下一条条目的状态字母,后续全部错位。
 */
export function porcelainEntries(repoRoot) {
	const raw = git(repoRoot, ['status', '--porcelain=v1', '-uall', '-z'])
	if (raw === null) return null
	const parts = raw.split('\0')
	const entries = []
	for (let i = 0; i < parts.length; i++) {
		const seg = parts[i]
		if (seg === '') continue
		const xy = seg.slice(0, 2)
		const path = seg.slice(3)
		let orig = null
		if (xy[0] === 'R' || xy[0] === 'C') {
			i += 1
			orig = parts[i] ?? null
		}
		entries.push({ xy, path, orig })
	}
	entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
	return entries
}

/** 磁盘上这个路径的内容指纹。目录/不存在/符号链接各有不同标记,不静默当成"没内容"。 */
function contentTag(abs) {
	if (!existsSync(abs)) return 'absent'
	const st = lstatSync(abs)
	if (st.isSymbolicLink()) return `symlink:${createHash('sha256').update(readlinkSync(abs)).digest('hex')}`
	if (st.isDirectory()) return 'dir'
	if (!st.isFile()) return `nonfile:${st.mode}`
	return `file:${createHash('sha256').update(readFileSync(abs)).digest('hex')}`
}

/**
 * 工作树摘要。
 * @param repoRoot 仓库根(绝对路径)。
 * @returns `{ digest, head, tree, dirtyFiles, available }`;不是 git 仓时 available=false 且
 *          digest 为 `unavailable:<原因>` —— 拿不到身份就**明说**拿不到,不返回一个看起来
 *          像摘要的常量,否则两棵不同的树会得到同一个"摘要"。
 */
export function worktreeDigest(repoRoot) {
	const head = gitHead(repoRoot)
	const tree = head === null ? null : (git(repoRoot, ['rev-parse', 'HEAD^{tree}']) ?? '').trim() || null
	const entries = porcelainEntries(repoRoot)
	if (head === null || entries === null) {
		return { available: false, digest: `unavailable:not-a-git-worktree:${repoRoot}`, head, tree, dirtyFiles: null }
	}
	const h = createHash('sha256')
	h.update(`head=${head}\n`)
	h.update(`tree=${tree ?? 'none'}\n`)
	h.update(`entries=${entries.length}\n`)
	for (const e of entries) {
		h.update(e.xy)
		h.update('\0')
		h.update(e.path)
		h.update('\0')
		if (e.orig !== null) {
			h.update(`orig=${e.orig}`)
			h.update('\0')
		}
		h.update(contentTag(join(repoRoot, e.path)))
		h.update('\n')
	}
	return { available: true, digest: h.digest('hex'), head, tree, dirtyFiles: entries.length }
}

/**
 * 契约口径的工作树摘要:只吃 **tracked 文件的磁盘字节**。
 *
 * 与 `worktreeDigest` 并存,不是替代。A/B/C 三份入口按任务表写的是
 * 「tracked 内容哈希,脏了必变,删除也算,忽略 untracked」—— 并行代理的草稿
 * 否则会让摘要失去意义。矩阵自己的记录仍用上面那份更严的 porcelain 摘要。
 *
 * 字节格式必须与 `frontend/tests/host-integration/layer-result.mjs` 以及
 * `scripts/acceptance/integration/linux/lib/evidence.mjs` **逐字节相同**,
 * 否则矩阵用「声称值 ∈ 窗口观测」做归属时,一次真实的 9/9 会被判
 * `stale-layer-result:worktree` —— 2026-09-10 R2 复审实测:同一时刻
 * C = `8b3645fa…`(596 tracked)、D = `c5103f35…`(含 56 个脏/未跟踪),永远不相等。
 */
export function trackedWorktreeDigest(repoRoot) {
	const listed = git(repoRoot, ['ls-files', '-z'])
	if (listed === null) {
		return { available: false, digest: `unavailable:not-a-git-worktree:${repoRoot}`, fileCount: null }
	}
	const files = listed.split('\0').filter((entry) => entry !== '').sort()
	const digest = digestTrackedFiles(files, (file) => {
		const abs = join(repoRoot, file)
		// Match Linux/frontend/swarm producer semantics: read the target bytes.
		return existsSync(abs) && statSync(abs).isFile() ? readFileSync(abs) : null
	})
	return { available: true, digest, fileCount: files.length }
}
