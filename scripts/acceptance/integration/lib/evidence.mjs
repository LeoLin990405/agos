/**
 * 证据完整性:日志哈希由**矩阵自己重算**,不采信生产者报的那一串。
 *
 * 一份结果 JSON 里的 `logs[].sha256` 是生产者的**声称**。生产者写完结果之后日志被改过
 * (或者一开始就把哈希填错/手抄错/从上一次运行复制过来),结果 JSON 看起来仍然完整,
 * 而它指向的日志已经不是被判定的那一份 —— 证据链在这里断掉,且外表毫无异样。
 *
 * 所以矩阵在采集每一层时都对 `logs[]` 逐条读盘重算,对不上就拒绝下结论(不是降级成告警)。
 * 这条路径本身有真子进程负例:篡改一份日志一个字节,矩阵必须变红。
 */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

export function sha256(buf) {
	return createHash('sha256').update(buf).digest('hex')
}

/** 文件的 sha256;不存在或不是普通文件返回 null(调用方据此报具体原因,不猜)。 */
export function sha256File(p) {
	if (!existsSync(p)) return null
	const st = lstatSync(p)
	if (!st.isFile()) return null
	return sha256(readFileSync(p))
}

/**
 * 逐条核对 `logs[]`。
 *
 * 路径解析顺序:绝对路径直接用;相对路径先按 `baseDir`(该层自己的日志目录)解,
 * 解不到再按 `repoRoot` 解 —— 现有验收器写进 JSON 的 `log` 字段就是相对仓根的。
 * 两处都找不到叫 `log-missing`,而不是「哈希对不上」:这两种坏法要能分开读。
 *
 * @returns `{ checked, entries, mismatches }`,mismatches 非空即为证据完整性失败。
 */
export function verifyLogs(logs, { baseDir, repoRoot }) {
	const entries = []
	const mismatches = []
	if (!Array.isArray(logs)) {
		return { checked: 0, entries, mismatches: [{ code: 'logs-not-an-array', detail: `logs 字段不是数组: ${JSON.stringify(logs)}` }] }
	}
	for (const [i, entry] of logs.entries()) {
		if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
			mismatches.push({ code: 'log-entry-not-an-object', index: i, detail: `logs[${i}] 不是对象` })
			continue
		}
		const declaredPath = entry.path
		const declared = entry.sha256
		if (typeof declaredPath !== 'string' || declaredPath === '') {
			mismatches.push({ code: 'log-entry-missing-path', index: i, detail: `logs[${i}].path 缺失或不是字符串` })
			continue
		}
		if (typeof declared !== 'string' || !/^[0-9a-f]{64}$/.test(declared)) {
			mismatches.push({ code: 'log-entry-bad-digest', index: i, path: declaredPath, detail: `logs[${i}].sha256 不是 64 位十六进制: ${JSON.stringify(declared)}` })
			continue
		}
		const candidates = isAbsolute(declaredPath)
			? [declaredPath]
			: [resolve(baseDir, declaredPath), resolve(repoRoot, declaredPath)]
		const found = candidates.find((c) => existsSync(c)) ?? null
		if (found === null) {
			mismatches.push({ code: 'log-missing', index: i, path: declaredPath, searched: candidates, detail: `日志文件不存在(找过 ${candidates.join(' 与 ')})` })
			continue
		}
		const actual = sha256File(found)
		if (actual === null) {
			mismatches.push({ code: 'log-not-a-regular-file', index: i, path: declaredPath, resolvedPath: found, detail: '存在但不是普通文件(目录或符号链接?)' })
			continue
		}
		const shown = found.startsWith(repoRoot) ? relative(repoRoot, found) : found
		entries.push({ path: declaredPath, resolvedPath: shown, declaredSha256: declared, actualSha256: actual, match: actual === declared })
		if (actual !== declared) {
			mismatches.push({
				code: 'log-digest-mismatch', index: i, path: declaredPath, resolvedPath: shown,
				declared, actual,
				detail: `声称 ${declared.slice(0, 16)}… 实测 ${actual.slice(0, 16)}… —— 结果 JSON 指向的日志不是被判定的那一份`,
			})
		}
	}
	return { checked: entries.length, entries, mismatches }
}
