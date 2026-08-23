import { access, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SOURCE = 'codexbar-cache'
const DEFAULT_STALE_MS = 30 * 60 * 1000

const defaultPaths = () => ({
  cacheDbPath: join(homedir(), 'Library', 'Caches', 'CodexBar', 'Cache.db'),
  historyDir: join(homedir(), 'Library', 'Application Support', 'com.steipete.codexbar', 'history'),
})

const finite = (value) => {
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const percent = (value) => {
  const number = finite(value)
  return number === undefined ? undefined : Math.max(0, Math.min(100, number))
}

const iso = (value) => {
  if (value === undefined || value === null || value === '') return undefined
  let date
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) {
    const number = Number(value)
    date = new Date(number > 9_999_999_999 ? number : number * 1000)
  } else {
    const text = String(value).trim()
    date = new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(text) ? text.replace(' ', 'T') + 'Z' : text)
  }
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

const decode = (value) => {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value).toString('utf8')
  return String(value ?? '')
}

const compact = (object) => Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined))

function readCacheRows(cacheDbPath) {
  const db = new DatabaseSync(cacheDbPath, { readOnly: true })
  try {
    return db.prepare(`
      SELECT c.request_key AS requestKey, c.time_stamp AS capturedAt, r.receiver_data AS body
      FROM cfurl_cache_response c
      JOIN cfurl_cache_receiver_data r ON c.entry_ID = r.entry_ID
      ORDER BY c.time_stamp DESC, c.entry_ID DESC
    `).all().flatMap((row) => {
      try {
        const body = JSON.parse(decode(row.body))
        return [{ requestKey: decode(row.requestKey), capturedAt: iso(row.capturedAt), body }]
      } catch {
        return []
      }
    })
  } finally {
    db.close()
  }
}

async function readHistory(historyDir) {
  const out = []
  for (const [id, label] of [['codex', 'Codex Pro'], ['claude', 'Claude'], ['antigravity', 'Antigravity']]) {
    try {
      const data = JSON.parse(await readFile(join(historyDir, id + '.json'), 'utf8'))
      let latest
      for (const records of Object.values(data.accounts || {})) {
        for (const record of records || []) {
          for (const entry of record.entries || []) {
            if (!latest || String(entry.capturedAt || '') > String(latest.capturedAt || '')) latest = entry
          }
        }
      }
      if (!latest) continue
      out.push(compact({
        id,
        label,
        usedPct: percent(latest.usedPercent),
        remaining: finite(latest.remaining),
        resetAt: iso(latest.resetsAt),
        raw: compact({ capturedAt: iso(latest.capturedAt) }),
      }))
    } catch {}
  }
  return out
}

const EXTRACTORS = [
  {
    id: 'kimi', label: 'Kimi', hints: ['api.kimi.com/coding/v1/usages'],
    parse: (body, capturedAt) => {
      const usage = body.usage || {}
      const remaining = finite(usage.remaining)
      const limit = finite(usage.limit)
      return compact({ remaining, usedPct: remaining !== undefined && limit ? percent((limit - remaining) / limit * 100) : undefined,
        resetAt: iso(usage.resetTime), raw: compact({ limit, capturedAt }) })
    },
  },
  {
    id: 'kimi', label: 'Kimi', hints: ['kimi.gateway.billing.v1.BillingService/GetUsages'],
    parse: (body, capturedAt) => {
      const quota = body.totalQuota || {}
      return { raw: compact({ totalRemaining: finite(quota.remaining), totalLimit: finite(quota.limit), capturedAt }) }
    },
  },
  {
    id: 'manus', label: 'Manus', hints: ['api.manus.im'],
    parse: (body, capturedAt) => compact({ remaining: finite(body.totalCredits), resetAt: iso(body.nextRefreshTime),
      raw: compact({ monthlyCredits: finite(body.proMonthlyCredits), capturedAt }) }),
  },
  {
    id: 'minimax', label: 'MiniMax', hints: ['api.minimaxi.com/v1/token_plan/remains', 'api.minimaxi.com/v1/api/openplatform/coding_plan/remains'],
    parse: (body, capturedAt) => {
      const window = (body.model_remains || [])[0] || body.data || {}
      const remainingMs = finite(window.remains_time ?? window.remainsTime)
      return compact({ remaining: remainingMs === undefined ? undefined : Math.round(remainingMs / 1000),
        raw: compact({ remainingUnit: 'seconds', weeklyUsed: finite(window.current_weekly_usage_count ?? window.currentWeeklyUsageCount), capturedAt }) })
    },
  },
  {
    id: 'glm', label: 'GLM', hints: ['api.z.ai/api/monitor/usage/quota/limit', 'api.z.ai/api/monitor/usage/model-usage'],
    parse: (body, capturedAt) => {
      const limits = body?.data?.limits || body?.data?.list || body?.data || []
      const rows = Array.isArray(limits) ? limits : []
      const percentages = rows.map((item) => percent(item.percentage ?? item.usage_percent ?? item.usagePercent)).filter((v) => v !== undefined)
      return compact({ usedPct: percentages.length ? Math.max(...percentages) : undefined,
        raw: compact({ limits: rows.slice(0, 8).map((item) => compact({ type: item.type ?? item.model, usedPct: percent(item.percentage ?? item.usage_percent ?? item.usagePercent) })), capturedAt }) })
    },
  },
  {
    id: 'stepfun', label: 'StepFun', hints: ['GetStepPlanStatus'],
    parse: (body, capturedAt) => ({ resetAt: iso(body?.subscription?.expired_at), raw: compact({ plan: body?.subscription?.name, capturedAt }) }),
  },
  {
    id: 'stepfun', label: 'StepFun', hints: ['QueryStepPlanRateLimit'],
    parse: (body, capturedAt) => {
      const leftRate = finite(body.subscription_credit_left_rate)
      return compact({ remaining: leftRate === undefined ? undefined : Math.max(0, leftRate * 100),
        usedPct: leftRate === undefined ? undefined : percent((1 - leftRate) * 100), raw: compact({ remainingUnit: 'percent', capturedAt }) })
    },
  },
  {
    id: 'doubao', label: 'Doubao', hints: ['GetAFPUsage', 'open.volcengineapi.com'],
    parse: (body, capturedAt) => {
      const result = body.Result || body.result || {}
      const window = result.AFPFiveHour || result.afpFiveHour || {}
      const used = finite(window.Used ?? window.used)
      const quota = finite(window.Quota ?? window.quota)
      return compact({ remaining: used !== undefined && quota !== undefined ? Math.max(0, quota - used) : undefined,
        usedPct: used !== undefined && quota ? percent(used / quota * 100) : undefined,
        resetAt: iso(window.ResetAt ?? window.resetAt), raw: compact({ plan: result.PlanType ?? result.planType, window: '5h', quota, capturedAt }) })
    },
  },
  {
    id: 'qwen', label: 'Qwen', hints: ['tokenplan/personal/api/v2/quota-config', 'bailian-cs.console.aliyun.com/data/api.json'],
    parse: (body, capturedAt) => {
      const standard = body?.data?.DataV2?.data?.data?.standard || body?.data?.standard || {}
      return { raw: compact({ fiveHourRemaining: finite(standard.five_hour), weeklyRemaining: finite(standard.weekly), capturedAt }) }
    },
  },
  {
    id: 'claude', label: 'Claude', hints: ['claude.ai/api/organizations', 'api.anthropic.com/api/oauth/usage'],
    parse: (body, capturedAt) => {
      const five = body.five_hour || body.fiveHour || {}
      const seven = body.seven_day || body.sevenDay || {}
      return compact({ usedPct: percent(five.utilization), resetAt: iso(five.resets_at ?? five.resetsAt),
        raw: compact({ sevenDayUsedPct: percent(seven.utilization), capturedAt }) })
    },
  },
  {
    id: 'deepseek', label: 'DeepSeek', hints: ['api.deepseek.com/user/balance'],
    parse: (body, capturedAt) => compact({ remaining: body?.balance_infos?.[0]?.total_balance,
      raw: compact({ currency: body?.balance_infos?.[0]?.currency, capturedAt }) }),
  },
  {
    id: 'deepseek', label: 'DeepSeek', hints: ['platform.deepseek.com/api/v0/usage/amount', 'platform.deepseek.com/api/v0/usage/cost'],
    parse: (body, capturedAt) => ({ raw: compact({ amount: finite(body.amount ?? body?.data?.amount), cost: finite(body.cost ?? body?.data?.cost), capturedAt }) }),
  },
]

function mergeProvider(target, next) {
  const merged = { ...target }
  for (const key of ['usedPct', 'remaining', 'resetAt']) {
    if (merged[key] === undefined && next[key] !== undefined) merged[key] = next[key]
  }
  const raw = compact({ ...(target.raw || {}), ...(next.raw || {}) })
  if (Object.keys(raw).length) merged.raw = raw
  return merged
}

function extractProviders(rows, history) {
  const providers = new Map(history.map((provider) => [provider.id, provider]))
  for (const extractor of EXTRACTORS) {
    const hit = rows.find((row) => extractor.hints.some((hint) => row.requestKey.includes(hint)))
    if (!hit) continue
    try {
      const parsed = compact({ id: extractor.id, label: extractor.label, ...extractor.parse(hit.body, hit.capturedAt) })
      providers.set(extractor.id, mergeProvider(providers.get(extractor.id) || { id: extractor.id, label: extractor.label }, parsed))
    } catch {}
  }
  return [...providers.values()]
}

function newestCapture(providers) {
  return providers.reduce((latest, provider) => {
    const value = Date.parse(provider.raw?.capturedAt || '')
    return Number.isFinite(value) ? Math.max(latest, value) : latest
  }, 0)
}

async function readCodexBarUsage(options = {}) {
  const paths = defaultPaths()
  const cacheDbPath = options.cacheDbPath || paths.cacheDbPath
  const historyDir = options.historyDir || paths.historyDir
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now())
  const at = now.toISOString()
  try {
    await access(cacheDbPath)
  } catch {
    return { at, providers: [], stale: true, source: SOURCE, error: 'CodexBar cache is unavailable: ' + cacheDbPath }
  }
  try {
    const rows = readCacheRows(cacheDbPath)
    const history = await readHistory(historyDir)
    const providers = extractProviders(rows, history)
    const newest = newestCapture(providers)
    const staleMs = finite(options.staleMs) ?? DEFAULT_STALE_MS
    return { at, providers, stale: newest === 0 || now.getTime() - newest > staleMs, source: SOURCE }
  } catch (error) {
    return { at, providers: [], stale: true, source: SOURCE, error: 'CodexBar cache could not be read: ' + String(error?.message || error) }
  }
}

function formatCodexBarUsage(result) {
  const lines = ['== CodexBar 用量总览 ==']
  if (result.error) lines.push('• ' + result.error)
  for (const provider of result.providers) {
    const fields = []
    if (provider.usedPct !== undefined) fields.push('已用 ' + provider.usedPct.toFixed(1).replace(/\.0$/, '') + '%')
    if (provider.remaining !== undefined) fields.push('剩余 ' + provider.remaining)
    if (provider.resetAt) fields.push('重置 ' + provider.resetAt)
    if (!fields.length && provider.raw) fields.push(JSON.stringify(provider.raw))
    lines.push('• ' + provider.label + ': ' + (fields.join(' · ') || '暂无字段'))
  }
  lines.push('', '来源: CodexBar 本地缓存' + (result.stale ? '（可能已过期）' : ''))
  return lines.join('\n')
}

export { extractProviders, formatCodexBarUsage, readCodexBarUsage }
