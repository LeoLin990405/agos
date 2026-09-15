/**
 * 依赖面产物的「输入指纹」—— 判断一份离线测出来的快照还算不算数。
 *
 * 背景:`dependency-surface.json` 是离线跑一遍所有套件测出来的,它声称「哪个套件需要哪个包」。
 * 这份声称只在**被它测过的那些文件没变**时成立。本轮实测踩到的坑:一份 2026-09-08 测的快照
 * (比 swarm 解耦还早、只认识 69 个套件、通篇没有 swarm)让验收器的依赖面预检报了「无缺失」——
 * 它描述的是一棵已经不存在的树,而输出看起来和真体检过一模一样。
 *
 * 为什么不用 gitHead 比对:产物本身要被提交,一提交 HEAD 就变,于是它永远「陈旧」。
 * 那样的判据只会有两个结局 —— 要么天天报警变噪音,要么(更糟)预检从此永不拦人。
 * 所以按**内容**判:摘要覆盖产物真正依赖的那些文件(各插件的 test/*.mjs 与 lib 下的源码,
 * 以及宿主依赖树的 package.json)。这些一个字没变,快照就仍然算数,提交多少次都不影响。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

/** 与 measure-dependency-surface.mjs 同一份插件清单。 */
export const SURFACE_PLUGINS = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']

/** 递归收集一棵目录下的 .js/.mjs(不含 node_modules)。 */
function collect(dir, out) {
	if (!existsSync(dir)) return out
	for (const name of readdirSync(dir).sort()) {
		if (name === 'node_modules' || name.startsWith('.')) continue
		const abs = join(dir, name)
		const st = statSync(abs)
		if (st.isDirectory()) collect(abs, out)
		else if (name.endsWith('.mjs') || name.endsWith('.js')) out.push(abs)
	}
	return out
}

/**
 * 摘要覆盖的文件清单 —— 与产物的判定范围一致。
 * @param repoRoot - 仓库根。
 * @returns 相对仓根、已排序的路径数组。
 */
export function surfaceInputFiles(repoRoot) {
	const files = []
	for (const plugin of SURFACE_PLUGINS) {
		collect(join(repoRoot, 'plugins', plugin, 'test'), files)
		collect(join(repoRoot, 'plugins', plugin, 'lib'), files)
	}
	const hostDeps = join(repoRoot, 'plugins', 'package.json')
	if (existsSync(hostDeps)) files.push(hostDeps)
	return files.map((abs) => relative(repoRoot, abs)).sort()
}

/**
 * 输入指纹。路径与内容都进摘要 —— 只改内容、只增删文件,两种都要能看出来。
 * @param repoRoot - 仓库根。
 * @returns sha256 十六进制串。
 */
export function surfaceInputsDigest(repoRoot) {
	const hash = createHash('sha256')
	for (const rel of surfaceInputFiles(repoRoot)) {
		hash.update(rel)
		hash.update('\0')
		hash.update(createHash('sha256').update(readFileSync(join(repoRoot, rel))).digest('hex'))
		hash.update('\n')
	}
	return hash.digest('hex')
}
