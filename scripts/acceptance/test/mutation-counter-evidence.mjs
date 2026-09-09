#!/usr/bin/env node
// 削弱反证(mutation counter-evidence):把修复逐条**改坏**,确认对应测试真的变红。
//
// 为什么要有这个东西:"测试通过"本身不证明测试在测什么。一条永远绿的断言和一条
// 真正守着不变量的断言,在绿色输出里长得一模一样。所以每条修复都配一条突变:
// 在临时副本上还原缺陷,然后要求指定的测试**必须**变红。
//
// 有两条突变(M2/M3)额外带 expectStayGreen:它们证明两道防线**互相独立** ——
// 摘掉 .dsh 路径段检查时,靠窄 allow-root 的那条测试仍绿;摘掉包含性检查时,
// 靠 .dsh 命名的那条测试仍绿。没有这组断言就无法排除"其实只有一条在兜底"。
//
// M1 的教训值得留在这儿:第一版 M1 只把祖先解析改成词法,结果测试仍然绿 ——
// 因为允许根在 defaultAllowedRoots 里已被 realpath 成 /private/var/…,而词法
// realTarget 是 /var/…,macOS 的 /var 软链让检查"歪打正着"地拒绝了。那种拒绝
// 不是防御在起作用。必须把四处路径规范化一起退回词法,才是忠实还原原始缺陷。
//
// 安全性:只在 mkdtemp 临时副本上改坏代码,绝不碰真实工作树;跑完删除副本。
//
// 跑法:node scripts/acceptance/test/mutation-counter-evidence.mjs
// 退出码:0 = 全部突变都被抓到;1 = 有突变没被抓到(测试有假绿)

import { spawnSync } from 'node:child_process'
import { cpSync, readFileSync, writeFileSync, rmSync, mkdirSync, mkdtempSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// 仓根由本文件位置推导,不写死操作员路径(交付物不得带个人绝对路径)。
const SRC_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
// 突变副本一律建在系统临时目录里,绝不在真实工作树上改坏任何东西。
const WORK = mkdtempSync(join(tmpdir(), 'agos-mutation-'))

const SUITES = {
  W: 'scripts/acceptance/test/write-guard.test.mjs',
  G: 'scripts/acceptance/test/import-graph.test.mjs',
  V: 'scripts/acceptance/test/verify-host-tree.test.mjs',
  H: 'scripts/acceptance/test/host-integrations.test.mjs',
}

/**
 * 每条突变:改哪个文件、把什么替换成什么、期望哪些测试变红、期望哪些保持绿。
 * expectStayGreen 是关键:它证明两条防线**互相独立**,不是一条在兜底。
 */
const MUTATIONS = [
  {
    // 忠实还原原始缺陷:原代码是**纯词法**检查(path.resolve + 字符串前缀,两侧都不 realpath)。
    // 只把祖先解析改成词法是不够的 —— 允许根仍被 realpath,macOS 上 /var 与 /private/var
    // 的不一致会让检查"歪打正着"地拒绝,那不是防御在起作用。所以两侧一起改成词法。
    id: 'M1',
    why: '把整条守卫退回纯词法 resolve + 字符串前缀(忠实还原原始缺陷)',
    file: 'scripts/acceptance/lib/safe-write-root.mjs',
    edits: [
      { from: '\tconst realAncestor = realpathOrNull(ancestor)', to: '\tconst realAncestor = resolve(ancestor) // MUTATED: 退回词法' },
      { from: '\tconst okRoots = (allowedRoots ?? []).map((r) => realpathOrNull(r) ?? resolve(r))', to: '\tconst okRoots = (allowedRoots ?? []).map((r) => resolve(r)) // MUTATED: 退回词法' },
      { from: '\t\tconst realBad = realpathOrNull(bad) ?? resolve(bad)', to: '\t\tconst realBad = resolve(bad) // MUTATED: 退回词法' },
      // 允许根在 defaultAllowedRoots 里就被 realpath 过了 —— 不一起改,realTarget(/var/…)
      // 与允许根(/private/var/…)会因 macOS 的 /var 软链而不匹配,于是"歪打正着"地拒绝。
      // 那种拒绝不是防御在起作用,会掩盖突变。
      { from: '\t\tconst real = realpathOrNull(r)\n\t\tif (real && !out.includes(real)) out.push(real)', to: '\t\tconst real = resolve(r) // MUTATED: 退回词法\n\t\tif (real && !out.includes(real)) out.push(real)' },
    ],
    suite: 'W',
    expectRed: ['NC-W1', 'NC-W2', 'NC-W3'],
  },
  {
    id: 'M2',
    why: '摘掉 .dsh 受保护路径段检查',
    file: 'scripts/acceptance/lib/safe-write-root.mjs',
    from: "export const FORBIDDEN_PATH_SEGMENTS = ['.dsh', '.ssh', '.gnupg']",
    to: 'export const FORBIDDEN_PATH_SEGMENTS = [] // MUTATED',
    suite: 'W',
    expectRed: ['NC-W1'],
    expectStayGreen: ['NC-W2'],
    note: 'NC-W2 用窄 allow-root,应当仍绿 → 证明包含性检查独立于命名规则',
  },
  {
    id: 'M3',
    why: '摘掉"真实路径必须落在允许根内"的包含性检查',
    file: 'scripts/acceptance/lib/safe-write-root.mjs',
    from: '\t} else if (!okRoots.some((r) => isInsideLexical(realTarget, r))) {',
    to: '\t} else if (false) { // MUTATED',
    suite: 'W',
    expectRed: ['NC-W2'],
    expectStayGreen: ['NC-W1'],
    note: 'NC-W1 的假 profile 含 .dsh 段,应当仍绿 → 证明两条规则各自成立',
  },
  {
    id: 'M4',
    why: '把 O_NOFOLLOW 写入退回成普通 writeFileSync(会穿过软链)',
    file: 'scripts/acceptance/lib/safe-write-root.mjs',
    from: '\tconst flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW',
    to: '\tconst flags = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC // MUTATED',
    suite: 'W',
    expectRed: ['NC-W5'],
  },
  {
    id: 'M5',
    why: '把守卫在 --check 模式下关掉(不变量按模式打折)',
    file: 'scripts/acceptance/prepare-host-modules.mjs',
    from: 'if (!guard.ok) {',
    to: 'if (!guard.ok && !checkOnly) { // MUTATED',
    suite: 'W',
    expectRed: ['NC-W7'],
  },
  {
    id: 'M6',
    why: '不再递归跟随相对导入(只看入口文件本身)',
    file: 'scripts/acceptance/lib/import-graph.mjs',
    from: '\t\t\t\tqueue.push({ file: hit, kind: item.kind, from: file })\n\t\t\t\tcontinue',
    to: '\t\t\t\tcontinue // MUTATED: 不再递归',
    suite: 'G',
    expectRed: ['NC-G1', 'NC-G2'],
  },
  {
    id: 'M7',
    why: '词法器不再跳过行注释(注释里的 import 会被当真)',
    file: 'scripts/acceptance/lib/import-graph.mjs',
    from: "\t\tif (c === '/' && src[i + 1] === '/') {\n\t\t\twhile (i < n && src[i] !== '\\n') i += 1\n\t\t\tcontinue\n\t\t}",
    to: "\t\tif (false) { // MUTATED: 不跳过行注释\n\t\t\twhile (i < n && src[i] !== '\\n') i += 1\n\t\t\tcontinue\n\t\t}",
    suite: 'G',
    expectRed: ['POS-G5'],
  },
  {
    id: 'M8',
    why: '不再扫描测试入口(test/*.mjs)',
    file: 'scripts/acceptance/lib/import-graph.mjs',
    from: 'export function entryPointsOf(pkgDir, { includeTests = true } = {}) {',
    to: 'export function entryPointsOf(pkgDir, { includeTests = false } = {}) { // MUTATED',
    suite: 'G',
    expectRed: ['NC-G3'],
  },
  {
    id: 'M9',
    why: '不再折叠同文件字符串常量(动态 import(CONST) 又变成不可见)',
    file: 'scripts/acceptance/lib/import-graph.mjs',
    from: '\t\tif (typeof v === \'string\' && v !== \'\') return { specifier: v, folded: true, via: arg.value, line: arg.line }',
    to: '\t\tif (false) return null // MUTATED',
    suite: 'G',
    expectRed: ['NC-G7'],
  },
  {
    id: 'M10',
    why: '摘掉版本一致性检查整段(只留内容摘要)',
    file: 'scripts/acceptance/verify-host-tree.mjs',
    from: '    } else if (actual !== lock.version) {',
    to: '    } else if (false) { // MUTATED',
    suite: 'V',
    expectRed: ['NC-V1', 'NC-V2', 'NC-V4'],
  },
  {
    id: 'M11',
    why: '树没装时跳过版本判定(还原"没装就静默失效")',
    file: 'scripts/acceptance/verify-host-tree.mjs',
    from: '    const actual = installed ?? base?.version ?? null',
    to: '    const actual = installed ?? null // MUTATED: 不退回基准',
    suite: 'V',
    expectRed: ['NC-V4'],
  },
  {
    id: 'M12',
    why: '把"不证明干净安装"的诚实表述删掉(还原夸大措辞)',
    file: 'scripts/acceptance/verify-host-tree.mjs',
    from: "\t\t'不证明这棵树等于从 registry 干净安装(npm ci)的结果 —— 基准由本仓自己写入自己校验,属自指',",
    to: '',
    suite: 'V',
    expectRed: ['NC-V6'],
  },
  {
    id: 'M13',
    why: '把输出里的"不证明"提示行删掉',
    file: 'scripts/acceptance/verify-host-tree.mjs',
    from: "console.log('   本脚本**不**证明:该树等于从 registry 干净安装的结果(基准自记自校,属自指)')",
    to: '// MUTATED: 删掉诚实提示',
    suite: 'V',
    expectRed: ['NC-V6'],
  },

  // ---- 缺陷 4:「宿主环境集成」这层分类不能变成藏包的手段 ----
  {
    // 主控点名要求的削弱反证:把安全阀改坏,让静态 import 也放行。
    id: 'M14',
    why: '【安全阀】让加载期导入形态也算「可选」—— 静态 import 缺包被放行',
    file: 'scripts/acceptance/lib/import-graph.mjs',
    from: "\treturn !String(kind).startsWith('dynamic-import')",
    to: '\treturn false // MUTATED: 安全阀失效,什么形态都算可选',
    suite: 'H',
    expectRed: ['NEG-HI-C1', 'NEG-HI-C2', 'NEG-HI-C3', 'NEG-HI-C4', 'NEG-HI-C5', 'NEG-HI-C6', 'NEG-HI-C8', 'UNIT-HI-1'],
    expectStayGreen: ['NEG-HI-A1', 'NEG-HI-A2', 'NEG-HI-E1'],
    note: '安全阀失效不牵连「清单外缺包照旧阻断」与 fail-closed —— 三层互相独立,不是一层在兜底。',
  },
  {
    // 只放行 ESM 静态形态、仍拦 require 的"半吊子"改法也必须被抓到。
    id: 'M15',
    why: '【安全阀】只把 ESM 静态形态放行(留着 require 判定),看是否仍被抓到',
    file: 'scripts/acceptance/lib/import-graph.mjs',
    from: "\treturn !String(kind).startsWith('dynamic-import')",
    to: "\treturn String(kind).startsWith('require') // MUTATED: 只拦 require,放行 ESM 静态",
    suite: 'H',
    expectRed: ['NEG-HI-C1', 'NEG-HI-C2', 'NEG-HI-C3', 'NEG-HI-C4', 'NEG-HI-C8', 'UNIT-HI-1'],
    expectStayGreen: ['NEG-HI-C5', 'NEG-HI-C6'],
    note: 'ESM 静态那四条变红、require 那两条仍绿 —— 证明六条形态是分别被断言的,不是一条覆盖全部。',
  },
  {
    id: 'M16',
    why: '【fail-closed】清单读不了时静默当成空清单继续跑',
    file: 'scripts/acceptance/prepare-host-modules.mjs',
    from: "\tif (err instanceof ManifestError) die(2, `宿主集成清单不可用(fail-closed,不降级成空清单):\\n  ${err.message.split('\\n').join('\\n  ')}`)",
    to: '\tif (err instanceof ManifestError) { hostManifest = { path: "(none)", integrations: [] } } // MUTATED: 静默空清单',
    suite: 'H',
    expectRed: ['NEG-HI-E1', 'NEG-HI-E2', 'NEG-HI-E3', 'NEG-HI-E4', 'NEG-HI-E5', 'NEG-HI-E6', 'NEG-HI-E7', 'NEG-HI-E8', 'NEG-HI-E9', 'NEG-HI-E10', 'NEG-HI-E11'],
    expectStayGreen: ['NEG-HI-A1', 'NEG-HI-C1'],
    note: 'fail-open 不牵连安全阀与默认行为 —— 三层独立。',
  },
  {
    id: 'M17',
    why: '【豁免范围】不看 verdict,清单里列了就一律豁免',
    file: 'scripts/acceptance/prepare-host-modules.mjs',
    from: "\tconst exempt = new Set(report.hostIntegrations.filter((h) => h.verdict === 'absent-expected').map((h) => h.specifier))",
    to: '\tconst exempt = new Set(report.hostIntegrations.map((h) => h.specifier)) // MUTATED: 列了就放行',
    suite: 'H',
    expectRed: ['NEG-HI-C1', 'NEG-HI-C2', 'NEG-HI-C3', 'NEG-HI-C4', 'NEG-HI-C5', 'NEG-HI-C6', 'NEG-HI-C8', 'NEG-HI-D1', 'NEG-HI-D2', 'NEG-HI-D3'],
    expectStayGreen: ['NEG-HI-A1'],
  },
  {
    id: 'M18',
    why: '【声明核验】不核验降级实现是否真的导出声明的那个名字',
    file: 'scripts/acceptance/lib/host-integrations.mjs',
    from: '\t\t\t\telse {\n\t\t\t\t\tproblems.push(`降级实现 ${entry.degradation.file} 并不导出 ${entry.degradation.export}`)\n\t\t\t\t}',
    to: '\t\t\t\telse { degradationOk = true } // MUTATED: 不核验导出名',
    suite: 'H',
    expectRed: ['NEG-HI-D2'],
    expectStayGreen: ['NEG-HI-D1', 'NEG-HI-C1'],
  },
  {
    id: 'M19',
    why: '【报告可见性】把宿主集成专节整节删掉(让它从输出里静默消失)',
    file: 'scripts/acceptance/prepare-host-modules.mjs',
    from: "console.log(`-- 宿主环境集成(清单:${report.hostIntegrationsFile};缺席属预期,但不豁免安全阀) --`)",
    to: '// MUTATED: 专节消失',
    suite: 'H',
    expectRed: ['POS-HI-B1', 'POS-HI-B4'],
    expectStayGreen: ['NEG-HI-C1'],
    note: '「不能从输出里静默消失」这条要求确实被断言在守,不是写在注释里的空话。',
  },
  {
    id: 'M20',
    why: '【如实披露】图没观测到时不说明「图无法佐证」,假装一切已核实',
    file: 'scripts/acceptance/prepare-host-modules.mjs',
    from: "\t\tconsole.log(`                    所以「它是动态形态」这点**图无法佐证**,本行依据的是上面已核验的降级实现。`)",
    to: '\t\t// MUTATED: 不披露盲区',
    suite: 'H',
    expectRed: ['POS-HI-B2'],
    expectStayGreen: ['POS-HI-B1'],
  },
]

function parseResults(out) {
  const red = new Set()
  const green = new Set()
  for (const line of out.split('\n')) {
    let m = /^\s*✔\s+(\S+?):/.exec(line)
    if (m) { green.add(m[1]); continue }
    m = /^\s*✖\s+(\S+?):/.exec(line)
    if (m) red.add(m[1])
  }
  return { red, green }
}

const results = []
for (const mut of MUTATIONS) {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })
  cpSync(join(SRC_REPO, 'scripts'), join(WORK, 'scripts'), { recursive: true })

  const target = join(WORK, mut.file)
  let src = readFileSync(target, 'utf8')
  const edits = mut.edits ?? [{ from: mut.from, to: mut.to }]
  let missingAnchor = null
  for (const e of edits) {
    if (!src.includes(e.from)) { missingAnchor = e.from; break }
    src = src.replace(e.from, e.to)
  }
  if (missingAnchor) {
    results.push({ ...mut, status: 'ANCHOR-NOT-FOUND' })
    console.log(`\n[${mut.id}] ⚠️  锚点没找到,突变未应用:${missingAnchor.slice(0, 70)}`)
    continue
  }
  writeFileSync(target, src)

  const suiteFile = join(WORK, SUITES[mut.suite])
  const res = spawnSync(process.execPath, ['--test', suiteFile], { encoding: 'utf8', timeout: 300000, cwd: WORK })
  const out = (res.stdout ?? '') + (res.stderr ?? '')
  const { red, green } = parseResults(out)

  const missedRed = mut.expectRed.filter((id) => !red.has(id))
  const brokeGreen = (mut.expectStayGreen ?? []).filter((id) => !green.has(id))
  const status = missedRed.length === 0 && brokeGreen.length === 0 ? 'OK' : 'PROBLEM'
  results.push({ ...mut, status, redSeen: [...red], missedRed, brokeGreen, exit: res.status })

  console.log(`\n[${mut.id}] ${mut.why}`)
  console.log(`   突变文件: ${mut.file}`)
  console.log(`   套件退出码: ${res.status}   变红: ${[...red].join(', ') || '(无)'}`)
  console.log(`   期望变红: ${mut.expectRed.join(', ')}  → ${missedRed.length === 0 ? '✅ 全部变红' : `❌ 没红: ${missedRed.join(', ')}`}`)
  if (mut.expectStayGreen) {
    console.log(`   期望保持绿: ${mut.expectStayGreen.join(', ')}  → ${brokeGreen.length === 0 ? '✅ 仍绿' : `❌ 被牵连: ${brokeGreen.join(', ')}`}`)
    if (mut.note) console.log(`   含义: ${mut.note}`)
  }
  console.log(`   判定: ${status}`)
}

rmSync(WORK, { recursive: true, force: true })

console.log('\n\n================ 削弱反证汇总 ================')
let bad = 0
for (const r of results) {
  const ok = r.status === 'OK'
  if (!ok) bad += 1
  console.log(`${ok ? '✅' : '❌'} ${r.id}  ${r.why}`)
  console.log(`      套件 ${r.suite} 退出 ${r.exit ?? '?'};期望红 [${r.expectRed.join(', ')}]${r.expectStayGreen ? `;期望绿 [${r.expectStayGreen.join(', ')}]` : ''} → ${r.status}`)
}
console.log(`\n${bad === 0 ? `✅ 全部 ${results.length} 条突变都被测试抓到(且独立性断言成立)` : `❌ ${bad} 条突变未被抓到`}`)
process.exit(bad === 0 ? 0 : 1)
