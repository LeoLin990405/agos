// F 包的尺:公开合成中文语料 → 三份**分开**的读数(抽取 / 来源 / 召回)。零模型、零网络、
// 零个人语料 —— 本文件只读 test/fixtures/session-memory-zh/ 下的三个 jsonl,不碰任何用户目录。
//
// 口径与合成保证见 fixtures/session-memory-zh/README.md。三条纪律:
//   1) 三份读数各自报、各自进门,不许用一份的提升抵消另一份的回归;
//   2) 误收(false-accept)、误召回(false-recall)、两难(ambiguous)分开报,两难不进 pass/fail 分母;
//   3) **发现规则错了就改规则或如实报错,绝不回头改 label。** 现存不过的样本全在 KNOWN_GAPS 里
//      逐条写明「修了还是报了」以及为什么;新增失败会红,修好了也会红(提示更新 KNOWN_GAPS)。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  extractSessionMemory,
  isSensitiveMemoryText,
  isDirectUserSource,
  pinSessionMemoryItem,
} from '../lib/session-memory.mjs'
import { catalogEntryOrigin } from '../lib/skills-evolve.js'
import {
  MEMORY_FALLBACK_METHOD,
  MEMORY_LEXICAL_METHOD,
  MEMORY_RESERVE_METHOD,
  proposeSessionMemory,
} from '../lib/session-memory-rank.js'

const here = dirname(fileURLToPath(import.meta.url))
export const ZH_CORPUS = join(here, 'fixtures', 'session-memory-zh')
const FIXED = 1787400000000
const now = () => new Date(FIXED)

function readRows(name) {
  return readFileSync(join(ZH_CORPUS, name), 'utf8')
    .split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
}

/**
 * 现存不过的样本。每条必须写清 decision:
 *   'fixed'    —— 已改代码(不该出现在这里,出现即说明 KNOWN_GAPS 没跟着更新)
 *   'reported' —— 如实报错、本轮不改代码,并写明为什么不改
 * 绝不允许通过改 fixtures 的 expect 把条目从这里删掉。
 */
const KNOWN_GAPS = {
  extraction: {
    'zh-q-07': {
      miss: 'false-reject',
      decision: 'reported',
      why: '问句否决是子串匹配:句中出现「为什么」就整句否决,吃掉了这条真规矩。改法只能是放宽否决,'
        + '而放宽否决会把误收(误报规矩)推高 —— 私有语料的 constraint 精确率正是靠这个否决撑起来的,'
        + '本工作树跑不到那份语料,不敢用「可能多收」换「多召回一条」。',
    },
    'zh-neg-05': {
      miss: 'false-reject',
      decision: 'reported',
      why: '口语否定「别…」没进 constraint 关键词表。加「别」会与「别的 / 别人 / 区别 / 特别」大面积撞车,'
        + '需要词性判断才安全,纯正则做不到。如实报漏收。',
    },
    'zh-once-07': {
      miss: 'false-accept',
      decision: 'reported',
      why: 'fact 分支的「^我…」一支只要句首是「我」再加任意一字就成立,一次性意图句(「我这次想先看看日志」)'
        + '因此被当成关于用户的持久事实。这是本包唯一剩下的误收。收紧它要给第一人称意图动词'
        + '(想 / 要 / 打算 / 先)加否决,而这一支同时承担私有语料的 fact 召回(实测 R=0.62),'
        + '在拿不到那份语料的机器上改它等于盲改。如实报误收 1 条。',
    },
    'zh-pref-06': {
      miss: 'false-reject',
      decision: 'reported',
      why: '不带偏好动词的持久偏好(「以后写文档默认用中文」)抽不到。补它必须放宽 preference 门,'
        + '同样是「拿精确率换召回」的方向,不在本包无语料的条件下做。',
    },
    'zh-corr-03': {
      miss: 'false-reject',
      decision: 'reported',
      why: 'fact 门的具名实体式是 ^ 锚定的,句首任何前置小句(「说错了，…」)都会把它挡住。放宽 ^ 锚定'
        + '等于放宽整个 fact 门,方向同上,不做。',
    },
    'zh-corr-05': {
      miss: 'false-reject',
      decision: 'reported',
      why: '同 zh-corr-03:「刚才说的 8080 作废，现在是 8443。」的判断词在前置小句之后,^ 锚定挡住。',
    },
  },
  provenance: {},
  retrieval: {
    'ret-08': {
      miss: 'fallback-label',
      decision: 'reported',
      why: '这条的两个要紧断言都过了:敏感条目连 pin 都被拒,因此 recall 为空、notRecall 命中。'
        + '对不上的只有次要字段 fallback —— fixture 写 null(表示「存在词面命中」),实际报 empty-store。'
        + 'fixture 确实把这个次要字段写窄了:该行只有一个条目且它在 pin 阶段就被拒,pin 之后 store 是**空的**,'
        + '空 store 下任何诚实实现都给不出 null。所以登记而不改 expect(改 expect 才是掩盖)。'
        + '⚠️ 2026-09-09 校正(接线审查者实测证伪):原先这里写的理由是「store 里还有别的条目,与 query'
        + '没有整段重合」—— 事实错误,store 里一条都没有。照原理由去修这条缺口的人会去找不存在的条目。'
        + '⚠️ 2026-09-09 机制修复:空 store 与「有条目但都不匹配」已拆成 empty-store / no-overlap 两个'
        + '结构化状态(lib/session-memory-rank.js),note 不再对空 store 声称「按重要度回注」。本行的'
        + 'fixture 期望(null)在空 store 下仍然不可满足,缺口性质从「混同」降级为「fixture 次要字段写窄」,'
        + '继续按原纪律登记,不改 expect。',
    },
    // ⚠️ 这里曾被主控加过一条 'rank-empty-store',立刻被本文件的纪律挡回来了 —— 而挡得对:
    // F2-3 断言「失败 id 集合**等于**KNOWN_GAPS」,而这张表是按**夹具 id** 索引的,
    // 塞一个非夹具 id 进来会从「多出一项」那侧报红。缺口表不是随记本,不该为了记事削弱它。
    // 那条发现(空 store 与「有条目但都不匹配」共用 no-overlap,且 note 声称了并未发生的回注)
    // 已在 2026-09-09 由 GLM 修复轮落地:fallback 拆成 empty-store / empty-query / no-overlap 三态,
    // 行为回归见 test/session-memory-rank.test.mjs 的 empty store 用例。
    'ret-04': {
      miss: 'false-recall',
      decision: 'reported',
      why: '会话记忆没有取代(supersession)机制:mergeItems 按 kind+text 哈希去重,纠正后的新值与被纠正的'
        + '旧值是两个不同 id,两条都留在 store 里,词面又都命中,于是同一跳把作废值和现值一起回注。'
        + '要修得加「取代」关系(新条目声明它取代哪个 id)+ 落盘 schema + 前端展示,超出本包的文件边界'
        + '(schema 与前端不在 F 的所有权里)。如实报误召回 1 条,并记进未解决风险。',
    },
  },
}

const gapIds = (lane) => Object.keys(KNOWN_GAPS[lane]).sort()

function userEvents(text, source = { kind: 'user', rpcId: 'demo-rpc' }) {
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: FIXED, data: { role: 'user', source, content: [{ type: 'text', text }] } },
  ]
}

function assistantEvents(text, source) {
  return [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: FIXED, data: { turn: 1, message: { source, content: [{ type: 'text', text }] } } },
  ]
}

// ---------------------------------------------------------------- 1) 抽取正确性

/**
 * 逐行核对**全部**产出条目,不是只看 items[0].kind。
 * 2026-09-09 前本函数只读 items[0]:实现多吐、错吐第二条条目时评估器完全看不见。
 * deps.extract 只被负控 meta 测试注入;正式读数永远用真 extractSessionMemory。
 */
export function evaluateExtraction(rows, deps = {}) {
  const extract = deps.extract ?? extractSessionMemory
  const report = {
    total: rows.length, scored: 0, pass: 0,
    falseAccept: [], falseReject: [], wrongKind: [], extraItems: [], ambiguous: [],
    byCategory: {},
  }
  for (const row of rows) {
    const result = extract(userEvents(row.text), { now, header: { delegationDepth: 0 } })
    const got = result.items.map((item) => item.kind)
    const sensitiveRefused = got.length === 0 && result.skippedSensitive >= 1
    const wantKinds = row.expect.sensitive || row.expect.kind === null ? [] : [row.expect.kind]
    const want = row.expect.sensitive ? 'REFUSE' : row.expect.kind
    const ok = row.expect.sensitive ? sensitiveRefused : got.length === wantKinds.length
      && got.every((kind, index) => kind === wantKinds[index])
    const actual = row.expect.sensitive ? (sensitiveRefused ? 'REFUSE' : `KEPT:${got.join('+')}`) : got.length === 0 ? null : got.join('+')
    const bucket = report.byCategory[row.category] ?? { total: 0, scored: 0, pass: 0, ambiguous: 0 }
    bucket.total += 1
    if (row.expect.ambiguous) {
      bucket.ambiguous += 1
      report.ambiguous.push({ id: row.id, want, got: actual, agrees: ok, why: row.expect.why })
    } else {
      report.scored += 1
      bucket.scored += 1
      if (ok) { report.pass += 1; bucket.pass += 1 } else {
        const entry = {
          id: row.id, category: row.category, want, got: actual,
          skippedSensitive: result.skippedSensitive, text: row.text,
        }
        // 期望空集(敏感/负例)却产出了 → 误收;期望非空但一条没出 → 漏收
        // (区分是抽取门拒绝还是敏感闸拒绝:entry 里带 skippedSensitive 供诊断);
        // 期望非空且产出是期望的超集 → 多吐;其余 → 错类。
        if (wantKinds.length === 0) report.falseAccept.push(entry)
        else if (got.length === 0) report.falseReject.push(entry)
        else if (got.length > wantKinds.length) report.extraItems.push(entry)
        else report.wrongKind.push(entry)
      }
    }
    report.byCategory[row.category] = bucket
  }
  return report
}

test('F2-1 抽取正确性:合成中文语料九类,误收/漏收/多吐/错类/两难分开报', () => {
  const rows = readRows('extraction.jsonl')
  const report = evaluateExtraction(rows)
  console.log(`[F2-1 抽取] 总 ${report.total} · 计分 ${report.scored} · 通过 ${report.pass}`
    + ` · 误收 ${report.falseAccept.length} · 漏收 ${report.falseReject.length}`
    + ` · 多吐 ${report.extraItems.length} · 错类 ${report.wrongKind.length} · 两难 ${report.ambiguous.length}(不计分)`)
  for (const [category, s] of Object.entries(report.byCategory)) {
    console.log(`  ${category.padEnd(12)} 计分 ${s.pass}/${s.scored}${s.ambiguous ? ` · 两难 ${s.ambiguous}` : ''}`)
  }
  for (const row of [...report.falseAccept, ...report.falseReject, ...report.extraItems, ...report.wrongKind]) {
    console.log(`  ✗ ${row.id} want=${row.want} got=${row.got} · ${row.text.slice(0, 34)}`)
  }
  for (const row of report.ambiguous) {
    console.log(`  ~ ${row.id} 两难(当前产出 ${row.got},与其中一种读法${row.agrees ? '一致' : '不一致'})`)
  }
  const failed = [...report.falseAccept, ...report.falseReject, ...report.extraItems, ...report.wrongKind]
    .map((row) => row.id).sort()
  assert.deepEqual(failed, gapIds('extraction'),
    '抽取失败集合与 KNOWN_GAPS 不符:新增失败必须改代码或写进 KNOWN_GAPS(带理由),'
    + '修好了也要把对应条目从 KNOWN_GAPS 删掉。禁止改 fixtures 的 expect 来消掉差异。')
  assert.equal(report.scored + report.ambiguous.length, report.total)
})

test('F2-1 负控(评估器自检):只看 items[0] 或悄悄多吐条目的坏实现必须被抓', () => {
  // 故意改坏实现的三种形状,证明评估器本身有区分力。这不是对产品行为的断言,
  // 是对「尺」的断言。真正的历史盲区是形状一:2026-09-09 前评估器只看 items[0].kind,
  // 多吐的第二条对它完全不可见;形状二(items[0] 错类)旧评估器其实也看得见,这里
  // 一并钉住,防将来有人把比对逻辑整体削弱。
  const rows = readRows('extraction.jsonl').filter((row) => !row.expect.ambiguous && !row.expect.sensitive && row.expect.kind !== null)
  assert.ok(rows.length >= 20, '合成语料至少要有 20 条非两难正例供负控改坏')
  // 形状一:多吐第二条垃圾条目(第一条正确)。items[0] 相同 → 旧评估器看不见。
  const withExtraGarbage = (events, options) => {
    const real = extractSessionMemory(events, options)
    return real.items.length === 0 ? real : {
      ...real,
      items: [...real.items, { ...real.items[0], id: `${real.items[0].id}-x`, kind: 'fact' }],
    }
  }
  const reportExtra = evaluateExtraction(rows, { extract: withExtraGarbage })
  assert.ok(reportExtra.extraItems.length >= 20, `多吐负控必须大面积报红,实际 ${reportExtra.extraItems.length}`)
  // 形状二:第二条才是对的,第一条错类(items[0] 对尺子撒谎)。
  const wrongFirst = (events, options) => {
    const real = extractSessionMemory(events, options)
    return real.items.length === 0 ? real : { ...real, items: [{ ...real.items[0], kind: 'rejected' }, ...real.items.slice(1)] }
  }
  const reportWrong = evaluateExtraction(rows, { extract: wrongFirst })
  assert.ok(reportWrong.wrongKind.length >= 20, `首条错类负控必须大面积报红,实际 ${reportWrong.wrongKind.length}`)
  // 形状三:只保留第一条(截断实现)—— 对单条语料这是「有意的」判对:单条语料的尺
  // 就是一条,截断的危害在多吐/漏收两侧,上面两种形状已覆盖。这里断言它不产生
  // **新增**失败(它身上的 5 条失败与真实现相同,是 KNOWN_GAPS 的既知漏收行)。
  const truncate = (events, options) => {
    const real = extractSessionMemory(events, options)
    return real.items.length > 0 ? { ...real, items: [real.items[0]] } : real
  }
  const reportTruncate = evaluateExtraction(rows, { extract: truncate })
  const realFailures = evaluateExtraction(rows).falseReject.map((row) => row.id).sort()
  assert.deepEqual(
    [...reportTruncate.falseAccept, ...reportTruncate.falseReject, ...reportTruncate.extraItems, ...reportTruncate.wrongKind]
      .map((row) => row.id).sort(),
    realFailures,
    '截断负控:除既知漏收外不许有新增失败(单条语料上截断不可区分,属尺的设计边界)',
  )
})

// ------------------------------------------------------------------ 2) 来源判定

export function evaluateProvenance(rows) {
  const report = { total: rows.length, pass: 0, sessionSource: { total: 0, pass: 0 }, skillOrigin: { total: 0, pass: 0 }, failures: [] }
  for (const row of rows) {
    if (row.kind === 'session-source') {
      report.sessionSource.total += 1
      const header = row.header ?? undefined
      const events = row.role === 'assistant'
        ? assistantEvents(row.text, row.source)
        : userEvents(row.text, row.source)
      const result = extractSessionMemory(events, { now, header })
      const extracted = result.items.length > 0
      const gate = row.role === 'user' ? isDirectUserSource(row.source, header) : null
      const wantGate = row.expect.provenance === 'user-direct'
      const ok = extracted === row.expect.extracted && (row.role !== 'user' || gate === wantGate)
      if (ok) { report.pass += 1; report.sessionSource.pass += 1 } else {
        report.failures.push({ id: row.id, want: row.expect.provenance, gate, extracted })
      }
    } else {
      report.skillOrigin.total += 1
      const got = catalogEntryOrigin(row.entry)
      if (got === row.expect.origin) { report.pass += 1; report.skillOrigin.pass += 1 } else {
        report.failures.push({ id: row.id, want: row.expect.origin, got })
      }
    }
  }
  return report
}

test('F2-2 来源判定:会话来源门 + 技能来源标签,未采集一律 unknown', () => {
  const rows = readRows('provenance.jsonl')
  const report = evaluateProvenance(rows)
  console.log(`[F2-2 来源] 总 ${report.total} · 通过 ${report.pass}`
    + ` · 会话来源 ${report.sessionSource.pass}/${report.sessionSource.total}`
    + ` · 技能来源 ${report.skillOrigin.pass}/${report.skillOrigin.total}`)
  for (const row of report.failures) console.log(`  ✗ ${JSON.stringify(row)}`)
  assert.deepEqual(report.failures.map((row) => row.id).sort(), gapIds('provenance'))

  // 来源判定的硬不变量:缺来源永远是 unknown,不许猜成 global(那会让它被裁掉)
  const unknowns = rows.filter((row) => row.kind === 'skill-origin' && row.expect.origin === 'unknown')
  assert.ok(unknowns.length >= 4, '至少要有 4 条来源不可判的技能样本')
  for (const row of unknowns) assert.equal(catalogEntryOrigin(row.entry), 'unknown', row.id)
})

// -------------------------------------------------------------------- 3) 召回

function pinnedStore(items, pin = pinSessionMemoryItem) {
  const byKey = new Map()
  const refused = []
  for (const spec of items) {
    const pinned = pin({ kind: spec.kind, text: spec.text, confirm: true }, { now })
    if (!pinned.ok) { refused.push({ key: spec.key, code: pinned.code }); continue }
    byKey.set(spec.key, pinned.item)
  }
  return { byKey, refused }
}

/**
 * 完整核对期望集合与实际回注集合:
 *  - 期望 recall 的 key 若连 pin 都被拒,**计入漏召回**,不从统计里豁免
 *    (2026-09-09 前:item===undefined 时按「不算漏」处理,敏感闸若错拒期望条目会静默溜过);
 *  - 实际 served 必须恰好等于期望集合:多出的任何条目(含 fixture 没提名的)都算误召回
 *    (此前只查 notRecall 点名的 key,回注一个谁都没提的条目对评估器不可见);
 *  - fixture 没声明 pinRefused 却出现被拒 pin → 记 unexpectedRefused 并计失败
 *    (敏感闸对期望条目变严是行为变化,必须红)。
 * deps.pin / deps.propose 只被负控 meta 测试注入;正式读数用真实现。
 */
export function evaluateRetrieval(rows, deps = {}) {
  const pin = deps.pin ?? pinSessionMemoryItem
  const propose = deps.propose ?? proposeSessionMemory
  const report = {
    total: rows.length, scored: 0, pass: 0,
    falseRecall: [], missedRecall: [], fallbackMismatch: [], ambiguous: [], refusedPins: [],
    unexpectedRefused: [],
  }
  for (const row of rows) {
    const { byKey, refused } = pinnedStore(row.items, pin)
    report.refusedPins.push(...refused.map((entry) => ({ id: row.id, ...entry })))
    // fixture 的 pinRefused 原先是死数据:被拒的 pin 只被计数、从不与期望比对,
    // 那个字段改成任何值都不会红。由接线审查者指出(E3)。这里把它接上。
    // 注意方向:这是「哪些条目连人工 pin 都进不去」的期望,是本包敏感边界的一部分,
    // 不是次要字段 —— 它要是悄悄变空,等于敏感闸失效而无人察觉。
    if (row.pinRefused) {
      assert.deepEqual(
        refused.map((entry) => entry.key).sort(),
        [...row.pinRefused].sort(),
        `${row.id}:实际被拒的 pin 与 fixture 的 pinRefused 不符(敏感闸的行为变了)`,
      )
    }
    const declaredRefused = new Set(row.pinRefused ?? [])
    for (const entry of refused) {
      if (!declaredRefused.has(entry.key)) report.unexpectedRefused.push({ id: row.id, ...entry })
    }
    const store = [...byKey.values()]
    const proposal = propose(store, row.query, [])
    const servedIds = new Set(proposal.items.map((item) => item.id))
    const keyOf = (key) => byKey.get(key)
    const missed = (row.expect.recall ?? []).filter((key) => {
      const item = keyOf(key)
      return item === undefined ? true : !servedIds.has(item.id)
    }).map((key) => ({ key, refusedPin: keyOf(key) === undefined }))
    // 完整集合:期望被回注的 id 集合 vs 实际回注集合,差集就是误召回
    // (notRecall 点名的与 fixture 没提名的条目在这里统一覆盖)。
    const expectedIds = new Set((row.expect.recall ?? [])
      .map((key) => keyOf(key)).filter((item) => item !== undefined).map((item) => item.id))
    // 集合比较还要检查基数: Set 只看 membership,会把同一条被重复回注两次
    // 当成一次命中。重复曝光也是误召回,否则实现可以靠重复项绕过完整集合闸。
    const expectedCounts = new Map([...expectedIds].map((id) => [id, 1]))
    const servedCounts = new Map()
    const wrong = []
    for (const item of proposal.items) {
      const count = (servedCounts.get(item.id) ?? 0) + 1
      servedCounts.set(item.id, count)
      if (!expectedCounts.has(item.id) || count > expectedCounts.get(item.id)) {
        wrong.push({ id: item.id, text: item.text?.slice(0, 24) })
      }
    }
    const fallbackOk = (proposal.fallback ?? null) === (row.expect.fallback ?? null)
      && proposal.reserved === row.expect.reserved
    const ok = missed.length === 0 && wrong.length === 0 && fallbackOk
      && report.unexpectedRefused.every((entry) => entry.id !== row.id)
    if (row.expect.ambiguous) {
      report.ambiguous.push({ id: row.id, agrees: ok, served: proposal.items.length, why: row.expect.why })
    } else {
      report.scored += 1
      if (ok) report.pass += 1
      if (wrong.length > 0) report.falseRecall.push({ id: row.id, keys: wrong })
      if (missed.length > 0) report.missedRecall.push({ id: row.id, keys: missed })
      if (!fallbackOk) {
        report.fallbackMismatch.push({ id: row.id, want: row.expect.fallback ?? null, got: proposal.fallback ?? null, reserved: proposal.reserved })
      }
    }
  }
  return report
}

test('F2-3 召回:误召回、漏召回与 fallback 诚实度分开报,保送不算相关', () => {
  const rows = readRows('retrieval.jsonl')
  const report = evaluateRetrieval(rows)
  console.log(`[F2-3 召回] 总 ${report.total} · 计分 ${report.scored} · 通过 ${report.pass}`
    + ` · 误召回 ${report.falseRecall.length} · 漏召回 ${report.missedRecall.length}`
    + ` · fallback 口径不符 ${report.fallbackMismatch.length} · 两难 ${report.ambiguous.length}(不计分)`
    + ` · pin 被拒 ${report.refusedPins.length} · 意外被拒 pin ${report.unexpectedRefused.length}`)
  for (const row of [...report.falseRecall, ...report.missedRecall, ...report.fallbackMismatch, ...report.unexpectedRefused]) {
    console.log(`  ✗ ${JSON.stringify(row)}`)
  }
  for (const row of report.ambiguous) console.log(`  ~ ${row.id} 两难(回注 ${row.served} 条)`)
  const failed = [...new Set([
    ...report.falseRecall.map((row) => row.id),
    ...report.missedRecall.map((row) => row.id),
    ...report.fallbackMismatch.map((row) => row.id),
    ...report.unexpectedRefused.map((row) => row.id),
  ])].sort()
  assert.deepEqual(failed, gapIds('retrieval'),
    '召回失败集合与 KNOWN_GAPS 不符。禁止改 fixtures 的 expect 来消掉差异。')
})

test('F2-3 负控(评估器自检):错拒期望条目的 pin 与超集回注必须被抓', () => {
  const rows = readRows('retrieval.jsonl')
  // 形状一:pin 把期望被召回的条目错拒(这里拒掉 ret-01 的 dist-fact 文本)。
  // 2026-09-09 前的评估器对 item===undefined 按「不算漏」豁免 —— 这个形状当时全绿,
  // 敏感闸若真的变严,期望条目会无声消失。现在必须红在 missedRecall + unexpectedRefused。
  const refusingPin = (input) => (
    input.text.includes('构建目录')
      ? { ok: false, status: 400, code: 'SENSITIVE', error: '负控:故意错拒' }
      : pinSessionMemoryItem(input, { now })
  )
  const reportRefused = evaluateRetrieval(rows, { pin: refusingPin })
  assert.ok(reportRefused.missedRecall.some((row) => row.id === 'ret-01'
    && row.keys.some((key) => key.key === 'dist-fact' && key.refusedPin === true)),
    '被错拒的期望条目必须计入漏召回,不许从统计里豁免')
  assert.ok(reportRefused.unexpectedRefused.some((entry) => entry.id === 'ret-01'),
    'fixture 没声明的被拒 pin 必须独立报失败')
  // 形状二:回注实现把整个 store 倒出来(超集)。这条对「退回 notRecall 点名式比对」
  // 的退化**没有**独立区分力(ret-01 的两条都被 fixture 点名,旧比对也会红)——完整
  // 集合比对的证明由形状一承担;这里保留它钉住「点名式比对被整体删掉」的方向。
  const dumpingPropose = (items, query, state) => {
    const report = proposeSessionMemory(items, query, state)
    return { ...report, items: [...items], hits: items.map((item, index) => ({ ...item, method: report.hits[0]?.method ?? 'lexical+posterior', lexical: 1, benchRank: index + 1 })) }
  }
  const reportDump = evaluateRetrieval(rows, { propose: dumpingPropose })
  assert.ok(reportDump.falseRecall.some((row) => row.id === 'ret-01'),
    '超集回注(serve 期望之外的条目)必须报误召回')
  // 形状三:重复回注同一条期望条目。Set membership 不能把它当成完整集合通过。
  const duplicatePropose = (items, query, state) => {
    const report = proposeSessionMemory(items, query, state)
    return report.items.length === 0 ? report : { ...report, items: [report.items[0], ...report.items] }
  }
  const reportDuplicate = evaluateRetrieval(rows, { propose: duplicatePropose })
  assert.ok(reportDuplicate.falseRecall.some((row) => row.id === 'ret-01'),
    '重复回注同一条条目也必须报误召回')
  // 基准:真实现上这两个桶不该因负控路径出现(负控只在注入的假实现上成立)。
  const reportReal = evaluateRetrieval(rows)
  assert.equal(reportReal.unexpectedRefused.length, 0)
})

// ----------------------------------------------------------- 硬不变量(永不许红)

test('敏感候选整条拒收:0 条产出、skippedSensitive 计数、敏感句不留片段、邻句不受连坐', () => {
  const rows = readRows('extraction.jsonl').filter((row) => row.expect.sensitive === true)
  assert.ok(rows.length >= 5, '敏感样本至少 5 条')
  for (const row of rows) {
    assert.equal(isSensitiveMemoryText(row.text), true, row.id)
    const result = extractSessionMemory(userEvents(row.text), { now, header: { delegationDepth: 0 } })
    assert.deepEqual(result.items, [], `${row.id} 敏感候选不许产出任何条目`)
    assert.ok(result.skippedSensitive >= 1, `${row.id} 拒收必须计数,不能静默丢弃`)
    // 人工 pin 这条同样必须被拒:拒收不是抽取器独有的门
    const pinned = pinSessionMemoryItem({ kind: 'fact', text: row.text, confirm: true }, { now })
    assert.equal(pinned.ok, false, `${row.id} pin 也必须拒`)
    assert.equal(pinned.code, 'SENSITIVE', row.id)
  }
  // mustNotAppear 的可证伪形态(2026-09-09 前是重言式:前一行已断言 items 为空,
  // 对空数组 .some() 恒假,这个字段怎么写都不会红)。把敏感句和一条正常偏好句拼进
  // 同一段输入:邻句必须照常被抽取(拒收不许变成「全拒」,否则谁都过不了第一个断言),
  // 而产出的条目正文里不许出现任何敏感片段(此时左侧集合非空,断言可失败)。
  // 「敏感句自己产出空条目」由上面第一组断言守着,不靠这里。
  const guardSentence = '以后所有文档我都希望用空格缩进。'
  const guardResult = extractSessionMemory(userEvents(guardSentence), { now, header: { delegationDepth: 0 } })
  assert.equal(guardResult.items.length, 1, '前置:邻句单独输入必须产出一条 preference(夹具自检)')
  assert.equal(guardResult.items[0].kind, 'preference')
  for (const row of rows) {
    if (!row.mustNotAppear || row.mustNotAppear.length === 0) continue
    const combined = extractSessionMemory(
      userEvents(`${row.text}\n${guardSentence}`),
      { now, header: { delegationDepth: 0 } },
    )
    assert.ok(combined.skippedSensitive >= 1, `${row.id}:敏感句仍须整条拒收并计数`)
    assert.equal(combined.items.length, 1, `${row.id}:邻句必须照常抽取,拒收不许连坐正常句子`)
    assert.equal(combined.items[0].kind, 'preference')
    for (const fragment of row.mustNotAppear) {
      assert.equal(combined.items.some((item) => item.text.includes(fragment)), false,
        `${row.id}:敏感片段「${fragment}」出现在了产出条目里`)
    }
  }
})

test('否定与纠正的正文原样落库:不许把「不要用 X」存成「用 X」', () => {
  const rows = readRows('extraction.jsonl').filter((row) => Array.isArray(row.mustContainInText))
  assert.ok(rows.length >= 5)
  let checked = 0
  for (const row of rows) {
    const result = extractSessionMemory(userEvents(row.text), { now, header: { delegationDepth: 0 } })
    if (result.items.length === 0) continue // 漏收由 F2-1 的 KNOWN_GAPS 管,这里只管「收了就必须原样」
    checked += 1
    for (const fragment of row.mustContainInText) {
      assert.ok(result.items[0].text.includes(fragment), `${row.id} 正文丢了「${fragment}」:${result.items[0].text}`)
    }
  }
  assert.ok(checked >= 4, '至少要有 4 条真的被收进来并验过正文')
})

test('召回的 fallback 必须自报身份:没问句/没重合都不许说成相关', () => {
  const rows = readRows('retrieval.jsonl')
  for (const row of rows) {
    if (row.expect.fallback === null) continue
    const { byKey } = pinnedStore(row.items)
    const proposal = proposeSessionMemory([...byKey.values()], row.query, [])
    assert.equal(proposal.fallback, row.expect.fallback, row.id)
    assert.equal(proposal.method, MEMORY_FALLBACK_METHOD, `${row.id} fallback 不许标成词面相关`)
    assert.equal(proposal.queryCollected, row.query.trim() !== '', row.id)
    for (const hit of proposal.hits) {
      assert.equal(hit.method, MEMORY_FALLBACK_METHOD, `${row.id} fallback 命中不许标成 ${hit.method}`)
      assert.equal(hit.posterior, null, `${row.id} fallback 不许发明后验`)
    }
  }
})

test('约束保送标成 constraint-reserve,不冒充更相关', () => {
  const row = readRows('retrieval.jsonl').find((entry) => entry.expect.reserved === true)
  assert.ok(row, '语料里要有一条保送样本')
  const { byKey } = pinnedStore(row.items)
  const proposal = proposeSessionMemory([...byKey.values()], row.query, [])
  assert.equal(proposal.reserved, true)
  for (const [key, method] of Object.entries(row.reserveMethod ?? {})) {
    const item = byKey.get(key)
    const hit = proposal.hits.find((entry) => entry.id === item.id)
    assert.equal(hit?.method, method, key)
    assert.equal(hit?.lexical, 0, '保送的词面分必须是 0,不许伪装成命中')
  }
  assert.equal(proposal.hits.some((hit) => hit.method === MEMORY_LEXICAL_METHOD), true, '保送不许吃掉真词面命中')
  assert.equal(MEMORY_RESERVE_METHOD, 'constraint-reserve')
})

test('语料自检:全合成、不含凭据形状、不引用任何个人路径', () => {
  const files = ['extraction.jsonl', 'provenance.jsonl', 'retrieval.jsonl', 'README.md']
  // 本文件自身也进自检:评测器不许出现个人语料路径或 homedir 探测
  const sources = [...files.map((name) => [name, readFileSync(join(ZH_CORPUS, name), 'utf8')]),
    ['session-memory-zh-eval.test.mjs', readFileSync(join(here, 'session-memory-zh-eval.test.mjs'), 'utf8')]]
  // self-scan:pattern-table:begin
  // 这张表自己就写着要禁的字面,所以扫本文件时必须把这一段先剜掉,否则扫描器永远命中自己的
  // 规则定义(F 包留下的自指假阳性就是这么来的:报「命中 会话归档目录」,命中的是下面这行正则)。
  // 用哨位注释显式划界而不是把本文件整体豁免 —— 豁免整个文件就等于自检不覆盖评测器本身。
  const forbidden = [
    ['凭据形状 sk-', /\bsk-[A-Za-z0-9_-]{16,}/],
    ['凭据形状 gh*_', /\bgh[opusr]_[A-Za-z0-9]{16,}/],
    ['凭据形状 AKIA', /\bAKIA[0-9A-Z]{16}\b/],
    ['凭据形状 JWT', /\beyJ[A-Za-z0-9_-]{10,}\./],
    ['凭据形状 xox*', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
    ['凭据形状 PRIVATE KEY', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ['个人 home 路径', /\/Users\/[a-z]/i],
    ['homedir 探测', /homedir\(/],
    ['会话归档目录', /\.dsh\/sessions|sessions-trash|agos-private/],
    ['其他 agent 家目录', /\.claude\/|\.Codex\/|fleet-credentials/],
    ['私有语料开关', /SESSION_MEMORY_CORPUS_DIR/],
  ]
  // self-scan:pattern-table:end
  const SELF_BEGIN = '// self-scan:pattern-table:begin'
  const SELF_END = '// self-scan:pattern-table:end'
  /**
   * 剜掉哨位区段。找不到哨位就直接失败,不许静默降级成「整文件豁免」。
   *
   * ⚠️ 2026-09-09 补强(接线审查者实测证伪了原实现的说法):原来只断言「哨位存在且有序」,
   * 这**挡不住**把 begin 移到文件头、end 移到文件尾 —— 断言照样通过,整个文件被剜掉,
   * 自检彻底空转。审查者在 /tmp 上实测:哨位放宽到包住全文时剜掉 16727 字节、零命中,
   * 断言未触发。而主控当时在 REVIEW.md 里明写了「不允许静默降级成整文件豁免」,
   * 说得比代码做到的强。主控自己的两条反证(区段之外注入、删掉起始哨位)都绕开了这个方向。
   *
   * 所以除了「存在且有序」,还要钉住区段的**大小上界**与**内容**:它必须小得只能框住
   * 规则表本身,并且确实框住了规则表。这样放宽哨位就会撞上界,而不是静默生效。
   */
  const SELF_REGION_MAX_BYTES = 1200
  function withoutPatternTable(name, text) {
    if (name !== 'session-memory-zh-eval.test.mjs') return text
    const from = text.indexOf(SELF_BEGIN)
    const to = text.indexOf(SELF_END)
    assert.ok(from !== -1 && to > from, '自检哨位注释缺失或次序颠倒,评测器自扫已失效')
    const region = text.slice(from, to)
    assert.ok(
      region.length < SELF_REGION_MAX_BYTES,
      `自检哨位区段 ${region.length} 字节,超过上界 ${SELF_REGION_MAX_BYTES}:`
        + '区段被放大就等于整文件豁免,自检不再覆盖评测器本身',
    )
    assert.ok(region.includes('const forbidden = ['), '哨位区段没有框住规则表,剜错了位置')
    return text.slice(0, from) + text.slice(to + SELF_END.length)
  }
  for (const [name, raw] of sources) {
    const text = withoutPatternTable(name, raw)
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(text), false, `${name} 命中禁止形状:${label}`)
    }
  }
  // 合成语料里的域名只允许 RFC 2606 保留的 example.invalid
  for (const row of readRows('extraction.jsonl')) {
    for (const host of row.text.match(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []) {
      assert.ok(host === 'example.invalid' || host === 'demo.git' || /^[a-z-]+\.(?:mjs|js|json|jsonl|md)$/i.test(host),
        `${row.id} 出现了非保留域名 ${host}`)
    }
  }
})

test('语料自检:九类齐全,且每类都有难负例', () => {
  const rows = readRows('extraction.jsonl')
  const categories = ['question', 'quotation', 'negation', 'conditional', 'oneshot', 'preference', 'correction', 'outdated', 'sensitive']
  const seen = new Map()
  for (const row of rows) {
    assert.ok(categories.includes(row.category), `${row.id} 类别未登记:${row.category}`)
    assert.equal(typeof row.expect.why, 'string', `${row.id} 缺 why`)
    assert.ok(row.expect.why.trim() !== '', `${row.id} why 是空的`)
    seen.set(row.category, (seen.get(row.category) ?? 0) + 1)
  }
  for (const category of categories) assert.ok((seen.get(category) ?? 0) >= 5, `${category} 少于 5 条`)
  // 难负例 = 同一类里期望与本类主流期望相反的样本(问句里的真规矩、敏感类里的非敏感规矩……)
  const hardNegatives = rows.filter((row) => (
    (['question', 'conditional', 'oneshot', 'outdated'].includes(row.category) && row.expect.kind !== null)
    || (row.category === 'sensitive' && row.expect.sensitive === false)
    || (row.category === 'quotation' && row.expect.kind !== null && row.expect.ambiguous === false)
    || (row.category === 'correction' && row.expect.kind === null)
  ))
  assert.ok(hardNegatives.length >= 7, `难负例只有 ${hardNegatives.length} 条`)
  const ambiguous = rows.filter((row) => row.expect.ambiguous === true)
  assert.ok(ambiguous.length >= 3, '至少要有 3 条诚实两难')
})
