#!/usr/bin/env node
// 隔离宿主依赖树的**本地未篡改**校验 + **版本一致性**校验。
//
// ┌───────────────────────────────────────────────────────────────────────────┐
// │ 这个脚本证明什么、不证明什么(必读,别再把它当可复现性凭据)               │
// ├───────────────────────────────────────────────────────────────────────────┤
// │ 证明:                                                                     │
// │   1. 磁盘上这棵树的内容,与**本仓自己记录的基准摘要**逐字节一致 ——         │
// │      也就是「树自基准写入以来没有被本地改动过」。                          │
// │   2. 实装包的 package.json 版本,与 plugins/package-lock.json 声明的版本   │
// │      一致;不一致就点名(这条能抓到「声明 A、实装 B」的钉版矛盾)。        │
// │                                                                           │
// │ **不**证明(审查者的判定成立,已按其要求降级表述):                       │
// │   · **不**证明这棵树等于「从 registry 干净安装(npm ci)的结果」。          │
// │     基准是在这台机器上对**当时磁盘内容**取的摘要,由本仓自己写入、自己校验。│
// │     「当前树 == 我自己记的摘要」是自指的:它对「这份内容从哪来、是否等于    │
// │     上游发布物」零信息量。用它论证可复现性是循环论证。                     │
// │   · **不**证明内容来源可信。provenance 字段是**操作者自述**,不是可验证凭据 │
// │     (无签名、无 registry integrity 比对、无第三方见证)。                  │
// │   · **不**证明这棵树能被任何人重建。实测反例:dsh-kimicode-swarm 的 registry │
// │     版(0.1.0/0.1.1/0.1.2)都不导出 dsh-fleet 需要的四个符号,磁盘那份是    │
// │     本机构建产物,公网无等价物 —— 所以这棵树**在设计上就无法**由 npm ci 复现。│
// │                                                                           │
// │ 一句话:本脚本是**篡改检测器**,不是**可复现性证明**。真正的干净安装证明   │
// │ 需要「锁文件 + 公网可得的等价发布物 + 无 --force 的 npm ci 实跑」,那属于   │
// │ 主控的锁文件/依赖拆除工作,不在本脚本能力范围内。                          │
// └───────────────────────────────────────────────────────────────────────────┘
//
// 摘要口径(显式写死,便于任何人手工复算):
//   对包目录下每个文件(排除嵌套 node_modules),按相对路径排序,
//   逐行喂入 `<相对路径>\0<字节数>\0<该文件 sha256>\n`,对整个流取 sha256。
// 覆盖**所有**文件而不只是 js/mjs/json:换掉一个 .node 二进制或 .d.ts 同样要被发现。
//
// 退出码:
//   0  内容与基准一致,且版本声明一致
//   1  内容缺失/漂移(树被本地改过,或基准与脚本不同步)
//   4  内容一致但**版本声明矛盾**(锁文件说 A、实装/基准是 B)
//
// 用法:
//   node scripts/acceptance/verify-host-tree.mjs              校验
//   node scripts/acceptance/verify-host-tree.mjs --write      重算并写入基准(仅在绿树上跑)
//   node scripts/acceptance/verify-host-tree.mjs --json=<f>   机读报告
//   node scripts/acceptance/verify-host-tree.mjs --repo-root=<dir>   可测性接缝:对夹具树跑
//   node scripts/acceptance/verify-host-tree.mjs --baseline=<f>      可测性接缝:换基准文件
//
// 未知参数 / 裸 --repo-root 等 / 空 --write= :立刻退 78(与 NC19c / NC21 同类)。
// --write 是故意的裸改写标志;--print / --write-floors 不存在,不能被吞掉后再走默认路径。

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryPointsOf, walkImportGraph } from './lib/import-graph.mjs'
import { assertKnownArgv, VERIFY_HOST_TREE_ARGV } from './lib/argv.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
// 必须在解析路径、读树、--write 写盘之前。opt() 只认 --name=value,
// 未知 token 否则会一声不响地落空,然后 --write 改写 tracked 的 host-tree-digests.json。
assertKnownArgv(argv, VERIFY_HOST_TREE_ARGV)
const opt = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d }
// --repo-root / --baseline 是**可测性接缝**:让自检能在 mkdtemp 夹具树上验证
// 版本矛盾与内容漂移两条判定路径,而不必污染真实仓库、也不必真的装包。
const repoRoot = resolve(opt('repo-root', resolve(here, '..', '..')))
const baselineFile = resolve(opt('baseline', join(here, 'host-tree-digests.json')))
const lockFile = resolve(opt('lockfile', join(repoRoot, 'plugins', 'package-lock.json')))
const jsonOut = opt('json', null)
const write = argv.includes('--write')

/** 本脚本**证明什么/不证明什么**的机读版本,随 --json 一起交付,防止下游再次夸大。 */
const CLAIMS = {
	proves: [
		'磁盘上这棵树的内容与本仓自己记录的基准摘要逐字节一致(即:自基准写入以来未被本地改动)',
		'实装包的 package.json 版本与 plugins/package-lock.json 声明的版本一致',
	],
	doesNotProve: [
		'不证明这棵树等于从 registry 干净安装(npm ci)的结果 —— 基准由本仓自己写入自己校验,属自指',
		'不证明内容来源可信 —— provenance 是操作者自述,无签名、无 registry integrity 比对、无第三方见证',
		'不证明这棵树可被他人重建 —— dsh-kimicode-swarm 的 registry 版本不导出所需符号,该树在设计上无法由 npm ci 复现',
	],
	summary: '这是篡改检测器,不是可复现性证明。',
}

/**
 * 必须逐字节校验的包。只列「公网不可得」或「清单与磁盘不一致」的那些 ——
 * 能由 registry 精确复现的包由 package-lock.json 的 integrity 负责,不在这里重复。
 */
const TRACKED = [
  {
    name: 'dsh-kimicode-swarm',
    dir: 'plugins/node_modules/dsh-kimicode-swarm',
    why: 'registry 无任何版本提供 dsh-fleet 需要的四个导出;磁盘为本机构建产物,操作者必须显式提供',
    provenance: '~/.dsh/profiles/desktop/plugins/kimicode-swarm-aligned(操作者自述,非可验证凭据)',
  },
  {
    name: '@deepseek-ai/dsh-settings',
    dir: 'plugins/node_modules/@deepseek-ai/dsh-settings',
    why: '磁盘 0.1.0-rc.6 与清单声明的 0.1.2-rc.1 不一致(npm ls 报 invalid);内容与 registry 的 0.1.0-rc.6 字节等同,但该版本的 peer 与 pin 线冲突',
    provenance: 'registry @deepseek-ai/dsh-settings@0.1.0-rc.6(操作者自述与 DSH Desktop.app 内副本字节等同,未独立验证)',
  },
]

function walk(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.push(relative(base, full))
  }
  return out
}

function treeDigest(absDir) {
  const files = walk(absDir).sort()
  const stream = createHash('sha256')
  for (const rel of files) {
    const bytes = readFileSync(join(absDir, rel))
    stream.update(`${rel}\0${bytes.length}\0${createHash('sha256').update(bytes).digest('hex')}\n`)
  }
  return { digest: stream.digest('hex'), fileCount: files.length }
}

function versionOf(absDir) {
  try {
    return JSON.parse(readFileSync(join(absDir, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

/**
 * 锁文件声明的版本。
 * 口径:packages['node_modules/<name>'].version —— lockfileVersion 2/3 的权威字段。
 * 同时取 plugins/package.json 的 dependencies 里那条 range,便于报告里说清"谁声明的"。
 */
function declaredVersions() {
  const out = { available: false, lockfile: relative(repoRoot, lockFile), byPackage: {} }
  if (!existsSync(lockFile)) return out
  let lock
  try { lock = JSON.parse(readFileSync(lockFile, 'utf8')) } catch { return out }
  out.available = true
  out.lockfileVersion = lock.lockfileVersion ?? null
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue
    const name = key.slice('node_modules/'.length)
    if (name.includes('/node_modules/')) continue   // 嵌套安装,不是本层声明
    out.byPackage[name] = { version: entry.version ?? null, resolved: entry.resolved ?? null }
  }
  const manifest = join(repoRoot, 'plugins', 'package.json')
  if (existsSync(manifest)) {
    try {
      const j = JSON.parse(readFileSync(manifest, 'utf8'))
      for (const [k, v] of Object.entries(j.dependencies ?? {})) {
        if (out.byPackage[k]) out.byPackage[k].declaredRange = v
      }
    } catch {}
  }
  return out
}

function measure() {
  const rows = []
  for (const pkg of TRACKED) {
    const absDir = join(repoRoot, pkg.dir)
    if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
      rows.push({ ...pkg, missing: true })
      continue
    }
    rows.push({ ...pkg, version: versionOf(absDir), ...treeDigest(absDir) })
  }
  return rows
}

/**
 * 插件源码当前**还导入哪些**裸包 —— 从源码扫,不写死包名。
 *
 * 为什么要它:TRACKED 是一份静态清单,而上游可能**合法地拆掉**某个依赖
 * (本轮主控就在拆 dsh-kimicode-swarm)。拆干净之后,「TRACKED 里有、树里没有」
 * 不是事故而是清单过期;这时候硬报红会把一道有用的闸变成常红噪音,
 * 而常红的闸等于没有闸。反过来,只要源码**还在**导入它,缺失就仍是硬失败。
 * 判据取自源码扫描,所以主控拆完之后这里自动跟上,无需我改代码。
 */
function importedBareSpecifiers() {
  const plugins = ['dsh-agos', 'dsh-agos-router', 'dsh-mcp-bridge', 'cn-capabilities', 'dsh-fleet']
  const roots = []
  for (const p of plugins) {
    const dir = join(repoRoot, 'plugins', p)
    if (!existsSync(dir)) continue
    roots.push(...entryPointsOf(dir))
  }
  if (roots.length === 0) return { available: false, packages: new Map() }
  try {
    const graph = walkImportGraph({ roots, repoRoot })
    return { available: true, packages: new Map(graph.bare.map((b) => [b.pkg, b.importers.map((i) => `${i.file}:${i.line}`)])) }
  } catch {
    return { available: false, packages: new Map() }
  }
}

const measured = measure()
const declared = declaredVersions()
const imported = importedBareSpecifiers()

if (write) {
  const missing = measured.filter((row) => row.missing)
  if (missing.length > 0) {
    console.error(`✖ 拒绝写入基准:${missing.map((m) => m.name).join('、')} 不在树里。`)
    console.error('  基准只能在一棵完整且已跑绿的树上生成,否则等于把缺失固化成期望。')
    process.exit(1)
  }
  writeFileSync(baselineFile, `${JSON.stringify({
    note: '隔离宿主依赖树里「不可由 registry 精确复现」的包的**本地未篡改**基准。'
      + '摘要口径见 verify-host-tree.mjs 顶部注释。仅在套件全绿时用 --write 重算。',
    claims: CLAIMS,
    convention: 'sha256 over sorted lines of `<relpath>\\0<bytes>\\0<sha256(file)>\\n`, nested node_modules excluded',
    packages: measured.map(({ name, dir, why, provenance, version, digest, fileCount }) => ({
      name, dir, why, provenance, version, fileCount, digest,
    })),
  }, null, 2)}\n`, 'utf8')
  console.log(`✅ 已写入基准 ${relative(repoRoot, baselineFile)}`)
  console.log('   ⚠️  提醒:这份基准只能证明「此后没被本地改过」,不能证明「等于 registry 干净安装」。')
  for (const row of measured) console.log(`   ${row.name}@${row.version}  ${row.fileCount} 文件  ${row.digest}`)
  process.exit(0)
}

if (!existsSync(baselineFile)) {
  console.error(`✖ 基准缺失:${relative(repoRoot, baselineFile)}`)
  console.error('  先在一棵跑绿的树上执行 --write。缺基准时本脚本 fail-closed,不当作通过。')
  process.exit(1)
}

const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
const expected = new Map(baseline.packages.map((p) => [p.name, p]))
let contentBad = 0
let retired = 0
const report = {
  schema: 'agos-acceptance/host-tree-verification@1',
  generatedAt: new Date().toISOString(),
  claims: CLAIMS,
  content: [],
  versionConsistency: [],
  lockfile: declared,
  importGraphAvailable: imported.available,
}

console.log('== 宿主树校验 ==')
console.log('   本脚本证明:树未被本地篡改(对自记基准) + 版本声明与锁文件一致')
console.log('   本脚本**不**证明:该树等于从 registry 干净安装的结果(基准自记自校,属自指)')
console.log('')
console.log('-- 内容(是否被本地改过) --')

for (const row of measured) {
  const want = expected.get(row.name)
  if (!want) {
    console.error(`✖ ${row.name}:基准里没有这个包,基准与 TRACKED 已不同步`)
    report.content.push({ name: row.name, verdict: 'baseline-out-of-sync' })
    contentBad += 1
    continue
  }
  if (row.missing) {
    const inLock = Boolean(declared.byPackage[row.name])
    const importers = imported.packages.get(row.name) ?? []
    const stillNeeded = inLock || importers.length > 0
    if (!stillNeeded && imported.available) {
      // 已被上游合法拆除:不在树、不在锁文件、也不再被任何源码导入。
      // 报为「已退役」而不是失败 —— 但明确要求清理清单,不让它无声留着。
      console.log(`⊘ ${row.name}:已退役 —— 不在树里、不在锁文件里、源码也不再导入它`)
      console.log(`   这不算失败:依赖被合法拆除了。请把它从 TRACKED 与 ${relative(repoRoot, baselineFile)} 里删掉,`)
      console.log(`   否则这份清单会一直带着一个不存在的期望值。`)
      report.content.push({ name: row.name, verdict: 'retired', inLock, importers })
      retired += 1
      continue
    }
    console.error(`✖ ${row.name}:不在树里(期望 ${want.dir})`)
    console.error(`   ${row.why}`)
    console.error(`   来源:${row.provenance}`)
    if (importers.length > 0) {
      console.error(`   ⚠️  但源码**仍在导入**它,所以缺失是硬失败,不是「已拆除」:`)
      for (const i of importers.slice(0, 6)) console.error(`        ${i}`)
      if (importers.length > 6) console.error(`        …… 另有 ${importers.length - 6} 处`)
    }
    if (inLock) console.error(`   ⚠️  锁文件仍声明它(${declared.byPackage[row.name].version}),所以缺失是硬失败`)
    if (!imported.available) console.error('   (源码导入图扫描不可用,按 fail-closed 处理)')
    report.content.push({ name: row.name, verdict: 'missing', expectedDir: want.dir, inLock, importers })
    contentBad += 1
    continue
  }
  if (row.digest !== want.digest) {
    console.error(`✖ ${row.name}:内容与基准不一致`)
    console.error(`   期望 ${want.digest}  (${want.version}, ${want.fileCount} 文件)`)
    console.error(`   实际 ${row.digest}  (${row.version}, ${row.fileCount} 文件)`)
    console.error(`   ${row.why}`)
    console.error(`   最可能的原因:在 plugins/ 里跑过 npm ci / npm install,把操作者提供的内容换成了 registry 内容。`)
    console.error(`   恢复来源:${row.provenance}`)
    report.content.push({ name: row.name, verdict: 'digest-drift', expected: want.digest, actual: row.digest })
    contentBad += 1
    continue
  }
  console.log(`✅ ${row.name}@${row.version}  ${row.fileCount} 文件  内容与基准一致(仅此而已 —— 不代表等于 registry 内容)`)
  report.content.push({ name: row.name, verdict: 'matches-baseline', digest: row.digest, version: row.version })
}

for (const want of baseline.packages) {
  if (!measured.some((row) => row.name === want.name)) {
    console.error(`✖ ${want.name}:基准里有但 TRACKED 里没有,基准与脚本已不同步`)
    report.content.push({ name: want.name, verdict: 'tracked-out-of-sync' })
    contentBad += 1
  }
}

// ---- 版本一致性:锁文件声明 vs 实装 vs 基准 ----
//
// 为什么这条独立于内容摘要:内容摘要**按定义**抓不到版本矛盾。反例已实测 ——
// 锁文件声明 @deepseek-ai/dsh-settings@0.1.2-rc.1,而基准记录/磁盘实装是 0.1.0-rc.6。
// 摘要只回答「内容变没变」,回答不了「声明的版本是不是这个版本」。
// 两条判定分开跑,是为了让「树没被改」与「声明没撒谎」互不掩盖。
console.log('')
console.log('-- 版本一致性(锁文件声明 vs 实装 vs 基准) --')
let versionBad = 0
if (!declared.available) {
  console.error(`⚠️  锁文件不可读:${declared.lockfile} —— 版本一致性无法判定,fail-closed 记为不一致`)
  report.versionConsistency.push({ verdict: 'lockfile-unreadable', lockfile: declared.lockfile })
  versionBad += 1
} else {
  const retiredNames = new Set(report.content.filter((c) => c.verdict === 'retired').map((c) => c.name))
  for (const row of measured) {
    if (retiredNames.has(row.name)) {
      console.log(`⊘ ${row.name}:已退役,跳过版本一致性判定`)
      report.versionConsistency.push({ name: row.name, verdict: 'retired' })
      continue
    }
    const lock = declared.byPackage[row.name]
    const base = expected.get(row.name)
    const installed = row.missing ? null : row.version
    const entry = {
      name: row.name,
      lockfileVersion: lock?.version ?? null,
      declaredRange: lock?.declaredRange ?? null,
      installedVersion: installed,
      baselineVersion: base?.version ?? null,
    }
    if (!lock) {
      console.error(`✖ ${row.name}:锁文件里没有这个包 —— 无法判定版本一致性(fail-closed)`)
      entry.verdict = 'absent-from-lockfile'
      versionBad += 1
      report.versionConsistency.push(entry)
      continue
    }
    // 实装存在 → 以实装为准比;实装不存在 → 退一步用基准记录的版本比,
    // 这样「树没装」也不会让这条检查静默失效(那正是上一轮漏掉版本矛盾的原因)。
    const actual = installed ?? base?.version ?? null
    const actualFrom = installed ? '实装' : '基准记录'
    if (actual === null) {
      console.error(`✖ ${row.name}:既无实装也无基准版本 —— 无法判定(fail-closed)`)
      entry.verdict = 'no-actual-version'
      versionBad += 1
    } else if (actual !== lock.version) {
      console.error(`✖ ${row.name}:版本声明与实际不一致`)
      console.error(`   锁文件 ${declared.lockfile} 声明:${lock.version}${lock.declaredRange ? `(plugins/package.json 写 ${lock.declaredRange})` : ''}`)
      console.error(`   ${actualFrom}的版本:            ${actual}`)
      console.error('   这不是内容漂移,内容摘要按定义抓不到它。含义:锁文件描述的树与这棵树不是同一棵,')
      console.error('   因此「锁文件 + npm ci 可重建本树」这一说法不成立。修:改钉版并解决随之而来的 peer 冲突')
      console.error('   (不得用 --force / --legacy-peer-deps 掩盖),属主控的锁文件工作。')
      entry.verdict = 'version-mismatch'
      entry.actualFrom = actualFrom
      versionBad += 1
    } else {
      console.log(`✅ ${row.name}:锁文件声明 ${lock.version} == ${actualFrom} ${actual}`)
      entry.verdict = 'consistent'
      entry.actualFrom = actualFrom
    }
    report.versionConsistency.push(entry)
  }
}

report.exitCode = contentBad > 0 ? 1 : versionBad > 0 ? 4 : 0
if (jsonOut) {
  const p = resolve(jsonOut)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(report, null, 2) + '\n')
  console.log(`\n报告已写入 ${relative(repoRoot, p)}`)
}

console.log('')
if (retired > 0) {
  console.log(`ℹ️  ${retired} 个受跟踪包已退役(上游拆除,源码不再导入)。判定按「不再需要」处理,但清单待清理。`)
}
if (contentBad > 0) {
  console.error(`✖ 宿主树校验失败:内容 ${contentBad} 项${versionBad ? `、版本 ${versionBad} 项` : ''}。这棵树与产出验收结果的那棵不是同一棵,结果不可采信。`)
  process.exit(1)
}
if (versionBad > 0) {
  console.error(`✖ 版本一致性失败:${versionBad} 项(内容本身与基准一致)。`)
  console.error('  含义:树未被本地篡改,但**锁文件声明的版本与这棵树不符** ——')
  console.error('  所以不能用锁文件论证「这棵树可由 npm ci 重建」。退出码 4 与内容漂移(1)区分开,便于定位。')
  process.exit(4)
}
console.log('✅ 宿主树:内容与基准一致,且版本声明与锁文件一致')
console.log('   再次明确:以上**不**构成「该树等于 registry 干净安装结果」的证明。')
