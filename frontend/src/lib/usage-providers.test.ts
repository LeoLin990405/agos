import assert from 'node:assert/strict'
import test from 'node:test'
import { cacheAgeLabel, cacheFreshness, entryAgeLabel, parseUsagePayload, providerEntryAgeMs, USAGE_ALIAS, usageForRoute, usageSummaryText } from './usage-providers.ts'

// 2026-08-23 08:14Z 实测的 GET /api/usage/providers 原样(1788 字节,无密钥字段)。
const LIVE = {
  "at": "2026-08-23T08:14:16.000Z",
  "providers": [
    {
      "id": "codex",
      "label": "Codex Pro",
      "usedPct": 78,
      "resetAt": "2026-08-27T06:35:10.000Z",
      "raw": {
        "capturedAt": "2026-08-23T08:12:32.000Z"
      }
    },
    {
      "id": "claude",
      "label": "Claude",
      "usedPct": 23,
      "resetAt": "2026-08-23T08:49:59.000Z",
      "raw": {
        "capturedAt": "2026-07-30T09:00:56.000Z"
      }
    },
    {
      "id": "antigravity",
      "label": "Antigravity",
      "usedPct": 0,
      "resetAt": "2026-08-21T09:23:57.000Z",
      "raw": {
        "capturedAt": "2026-08-21T04:23:56.000Z"
      }
    },
    {
      "id": "kimi",
      "label": "Kimi",
      "usedPct": 0,
      "remaining": 100,
      "resetAt": "2026-08-15T11:25:32.891Z",
      "raw": {
        "limit": 100,
        "capturedAt": "2026-05-30T07:12:14.000Z",
        "totalRemaining": 99,
        "totalLimit": 100
      }
    },
    {
      "id": "manus",
      "label": "Manus",
      "remaining": 10348,
      "resetAt": "2026-08-14T16:00:00.000Z",
      "raw": {
        "monthlyCredits": 12000,
        "capturedAt": "2026-05-30T07:12:14.000Z"
      }
    },
    {
      "id": "minimax",
      "label": "MiniMax",
      "remaining": 12554,
      "raw": {
        "remainingUnit": "seconds",
        "weeklyUsed": 0,
        "capturedAt": "2026-07-21T08:30:21.000Z"
      }
    },
    {
      "id": "glm",
      "label": "GLM",
      "raw": {
        "limits": [],
        "capturedAt": "2026-08-14T08:30:17.000Z"
      }
    },
    {
      "id": "stepfun",
      "label": "StepFun",
      "resetAt": "2027-04-15T04:28:21.000Z",
      "raw": {
        "plan": "Plus",
        "capturedAt": "2026-05-30T07:12:14.000Z",
        "remainingUnit": "percent"
      }
    },
    {
      "id": "doubao",
      "label": "Doubao",
      "usedPct": 3.141769,
      "remaining": 9685.8231,
      "raw": {
        "plan": "medium",
        "window": "5h",
        "quota": 10000,
        "capturedAt": "2026-08-14T08:30:23.000Z"
      }
    },
    {
      "id": "qwen",
      "label": "Qwen",
      "raw": {
        "fiveHourRemaining": 3000,
        "weeklyRemaining": 10000,
        "capturedAt": "2026-08-14T08:30:11.000Z"
      }
    },
    {
      "id": "deepseek",
      "label": "DeepSeek",
      "remaining": "142.97",
      "raw": {
        "currency": "CNY",
        "capturedAt": "2026-06-02T07:16:01.000Z"
      }
    }
  ],
  "stale": false,
  "source": "codexbar-cache"
} as const

test('capturedAt 是条目创建时间不是采集时间:只作「条目创建于」显示;新鲜度只按 cacheMtime;顶层 stale 不传染', () => {
  const p = parseUsagePayload(LIVE)
  assert.equal(p.stale, false)
  assert.equal(p.providers.length, 11)
  const atMs = Date.parse(p.at)
  const days = (id: string): number => Math.round((providerEntryAgeMs(p.providers.find((x) => x.id === id)!, atMs) ?? Number.NaN) / 86_400_000)
  // 这些数字是条目创建时间距今,**不是**采集间隔(claude 条目 07-30 而 resetAt 在一小时内)。
  assert.equal(days('kimi'), 85)
  assert.equal(days('claude'), 24)
  assert.match(entryAgeLabel(providerEntryAgeMs(p.providers.find((x) => x.id === 'kimi')!, atMs)), /条目创建于 85 天前（非采集时间）/)
  assert.doesNotMatch(entryAgeLabel(1), /采集$/)
  // 这份夹具是 cacheMtime 字段加进后端之前抓的:新鲜度未采集,不标陈旧也不标新鲜。
  assert.equal(cacheFreshness(p), 'unknown')
  assert.equal(cacheAgeLabel(p), '缓存写入时间未采集')
  // 带 cacheMtime 的载荷:2 天前写入 → 整份缓存陈旧;2 分钟前 → 新鲜。
  const withOld = parseUsagePayload({ ...LIVE, cacheMtime: '2026-08-21T02:23:00.000Z' })
  assert.equal(cacheFreshness(withOld), 'stale')
  assert.match(cacheAgeLabel(withOld), /缓存最后写入 2 天前/)
  const withNew = parseUsagePayload({ ...LIVE, cacheMtime: '2026-08-23T08:12:00.000Z' })
  assert.equal(cacheFreshness(withNew), 'fresh')
})

test('文案只说数据里真有的:deepseek 字符串 + CNY;glm/qwen 无顶层字段;doubao 小数四舍五入;kimi 带 limit', () => {
  const p = parseUsagePayload(LIVE)
  const by = (id: string) => p.providers.find((x) => x.id === id)!
  assert.equal(by('deepseek').remaining, '142.97')
  assert.equal(usageSummaryText(by('deepseek')), '剩余 142.97 CNY')
  assert.equal(usageSummaryText(by('glm')), '额度字段未采集')
  assert.equal(usageSummaryText(by('qwen')), '配额上限 5 小时 3000 · 每周 10000（非剩余量）')
  assert.equal(usageSummaryText(by('doubao')), '已用 3%')
  assert.equal(usageSummaryText(by('kimi')), '已用 0%')
  assert.equal(usageSummaryText(by('minimax')), '剩余 12554 秒')
  assert.equal(usageSummaryText(by('manus')), '剩余 10348 / 12000 credits')
  assert.equal(usageSummaryText(by('stepfun')), '额度字段未采集')
  assert.equal(usageSummaryText(by('codex')), '已用 78%')
})

test('alias:3 家直连、3 家改名、2 家无额度源、未知 route id 不猜;载荷未到什么都不给', () => {
  const p = parseUsagePayload(LIVE)
  assert.equal(usageForRoute('minimax-cn', p)?.provider.id, 'minimax')
  assert.equal(usageForRoute('zhipu', p)?.provider.id, 'glm')
  assert.equal(usageForRoute('deepseek-official', p)?.provider.id, 'deepseek')
  assert.equal(usageForRoute('stepfun', p)?.provider.id, 'stepfun')
  assert.equal(usageForRoute('xiaomi-token-plan-sgp', p), null)
  assert.equal(usageForRoute('longcat', p), null)
  assert.equal(usageForRoute('openai', p), undefined)
  assert.equal(usageForRoute('stepfun', undefined), undefined)
  assert.equal(Object.keys(USAGE_ALIAS).length, 8)
  const r = usageForRoute('stepfun', p)!
  assert.equal(r.freshness, 'unknown')
  assert.equal(usageForRoute('stepfun', parseUsagePayload({ ...LIVE, cacheMtime: '2026-08-21T02:23:00.000Z' }))!.freshness, 'stale')
})

test('软失败形状:providers=[] + error 字符串是 200,解析后 error 透出;缺 at 则拒绝', () => {
  const p = parseUsagePayload({ at: '2026-08-23T00:00:00.000Z', providers: [], stale: true, source: 'codexbar-cache', error: 'CodexBar cache is unavailable: /x' })
  assert.equal(p.providers.length, 0)
  // 后端 error 串带绝对路径;只留句子。
  assert.equal(p.error, 'CodexBar cache is unavailable')
  assert.doesNotMatch(p.error ?? '', /\/x|\/Users/)
  assert.throws(() => parseUsagePayload({ providers: [] }), /缺少/)
  assert.equal(entryAgeLabel(undefined), '条目时间未采集')
  assert.match(entryAgeLabel(5 * 3_600_000), /条目创建于 5 小时前（非采集时间）/)
})
