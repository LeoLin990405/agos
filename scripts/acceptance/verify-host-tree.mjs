#!/usr/bin/env node
// 隔离宿主依赖树的内容校验。
//
// 为什么需要这个东西:plugins/package-lock.json 给两个包记的是 registry tarball 与
// integrity 哈希,但磁盘上真正让套件变绿的内容**不是** registry 内容:
//
//   · dsh-kimicode-swarm  —— registry 的 0.1.0/0.1.1/0.1.2 都不导出 dsh-fleet 需要的
//     publishProgress / parseResultsXml / escapeXml / textOf(实测,见 DEPENDENCIES.md)。
//     磁盘那份是本机构建的 kimicode-swarm-aligned,公网无等价物。
//   · @deepseek-ai/dsh-settings —— 磁盘是 0.1.0-rc.6,清单声明 0.1.2-rc.1。npm ls 因此
//     报 invalid。这一条**不是**内容漂移:registry 上的 0.1.0-rc.6 与磁盘字节等同,
//     是当初钉错了版本。但它不能简单改声明:0.1.0-rc.6 声明 peer dsh-invariants
//     ^0.1.0-rc.6,与树里另外七个包要求的 ^0.1.2-rc.1 冲突,npm 拒绝解析,而本轮禁止
//     用 --force / --legacy-peer-deps 掩盖。详见 DEPENDENCIES.md 的校正记录。
//
// 于是就有了审查者 2 指出的 P1:清单声称的可复现性并不存在,而且**没有任何东西会发现**
// 这件事 —— 在 plugins/ 里跑一次 npm ci 就会把工作树换成 registry 内容并让套件变红,
// 而锁文件的 integrity 哈希让这棵树看起来像是被验证过的。
//
// 这个脚本就是那个「会发现」的东西:它不假装树可以由 npm ci 产生,只负责在树的内容
// 偏离「产出绿色结果的那份内容」时**大声失败**并指名道姓。
//
// 摘要口径(显式写死,便于任何人手工复算):
//   对包目录下每个文件(排除嵌套 node_modules),按相对路径排序,
//   逐行喂入 `<相对路径>\0<字节数>\0<该文件 sha256>\n`,对整个流取 sha256。
// 覆盖**所有**文件而不只是 js/mjs/json:换掉一个 .node 二进制或 .d.ts 同样要被发现。
//
// 用法:
//   node scripts/acceptance/verify-host-tree.mjs           校验,不匹配则退出 1
//   node scripts/acceptance/verify-host-tree.mjs --write    重算并写入基准(仅在绿树上跑)

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..', '..')
const baselineFile = join(here, 'host-tree-digests.json')

/**
 * 必须逐字节校验的包。只列「公网不可得」或「清单与磁盘不一致」的那些 ——
 * 能由 registry 精确复现的包由 package-lock.json 的 integrity 负责,不在这里重复。
 */
const TRACKED = [
  {
    name: 'dsh-kimicode-swarm',
    dir: 'plugins/node_modules/dsh-kimicode-swarm',
    why: 'registry 无任何版本提供 dsh-fleet 需要的四个导出;磁盘为本机构建产物,操作者必须显式提供',
    provenance: '~/.dsh/profiles/desktop/plugins/kimicode-swarm-aligned',
  },
  {
    name: '@deepseek-ai/dsh-settings',
    dir: 'plugins/node_modules/@deepseek-ai/dsh-settings',
    why: '磁盘 0.1.0-rc.6 与清单声明的 0.1.2-rc.1 不一致(npm ls 报 invalid);内容与 registry 的 0.1.0-rc.6 字节等同,但该版本的 peer 与 pin 线冲突',
    provenance: 'registry @deepseek-ai/dsh-settings@0.1.0-rc.6(与 DSH Desktop.app 内副本字节等同)',
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

function measure() {
  const rows = []
  for (const pkg of TRACKED) {
    const absDir = join(repoRoot, pkg.dir)
    if (!existsSync(absDir)) {
      rows.push({ ...pkg, missing: true })
      continue
    }
    if (!statSync(absDir).isDirectory()) {
      rows.push({ ...pkg, missing: true })
      continue
    }
    rows.push({ ...pkg, version: versionOf(absDir), ...treeDigest(absDir) })
  }
  return rows
}

const write = process.argv.includes('--write')
const measured = measure()

if (write) {
  const missing = measured.filter((row) => row.missing)
  if (missing.length > 0) {
    console.error(`✖ 拒绝写入基准:${missing.map((m) => m.name).join('、')} 不在树里。`)
    console.error('  基准只能在一棵完整且已跑绿的树上生成,否则等于把缺失固化成期望。')
    process.exit(1)
  }
  writeFileSync(baselineFile, `${JSON.stringify({
    note: '隔离宿主依赖树里「不可由 registry 精确复现」的包的内容基准。'
      + '摘要口径见 verify-host-tree.mjs 顶部注释。仅在套件全绿时用 --write 重算。',
    convention: 'sha256 over sorted lines of `<relpath>\\0<bytes>\\0<sha256(file)>\\n`, nested node_modules excluded',
    packages: measured.map(({ name, dir, why, provenance, version, digest, fileCount }) => ({
      name, dir, why, provenance, version, fileCount, digest,
    })),
  }, null, 2)}\n`, 'utf8')
  console.log(`✅ 已写入基准 ${relative(repoRoot, baselineFile)}`)
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
let bad = 0

for (const row of measured) {
  const want = expected.get(row.name)
  if (!want) {
    console.error(`✖ ${row.name}:基准里没有这个包,基准与 TRACKED 已不同步`)
    bad += 1
    continue
  }
  if (row.missing) {
    console.error(`✖ ${row.name}:不在树里(期望 ${want.dir})`)
    console.error(`   ${row.why}`)
    console.error(`   来源:${row.provenance}`)
    bad += 1
    continue
  }
  if (row.digest !== want.digest) {
    console.error(`✖ ${row.name}:内容与基准不一致`)
    console.error(`   期望 ${want.digest}  (${want.version}, ${want.fileCount} 文件)`)
    console.error(`   实际 ${row.digest}  (${row.version}, ${row.fileCount} 文件)`)
    console.error(`   ${row.why}`)
    console.error(`   最可能的原因:在 plugins/ 里跑过 npm ci / npm install,把操作者提供的内容换成了 registry 内容。`)
    console.error(`   恢复来源:${row.provenance}`)
    bad += 1
    continue
  }
  console.log(`✅ ${row.name}@${row.version}  ${row.fileCount} 文件  内容与基准一致`)
}

for (const want of baseline.packages) {
  if (!measured.some((row) => row.name === want.name)) {
    console.error(`✖ ${want.name}:基准里有但 TRACKED 里没有,基准与脚本已不同步`)
    bad += 1
  }
}

if (bad > 0) {
  console.error(`\n✖ 宿主树校验失败:${bad} 项。这棵树与产出验收结果的那棵不是同一棵,结果不可采信。`)
  process.exit(1)
}
console.log('\n✅ 宿主树内容与基准一致')
