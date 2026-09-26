/**
 * REST GET fixtures for demo mode. Only endpoints listed here answer; every
 * other GET answers 503 DEMO_NOT_COLLECTED so the UI shows its honest
 * 「未采集」/unavailable state instead of made-up numbers.
 *
 * Numbers here are DERIVED from the sample fixtures (e.g. sessions.total is
 * the length of DEMO_SESSIONS); nothing is a free-standing KPI.
 */
import { DEMO_SESSIONS, DEMO_T0, DEMO_TAG } from './demo-fixtures.ts'

type MemType = 'user' | 'feedback' | 'project' | 'reference'
const NODES: { id: string, type: MemType, description: string, validUntil?: string }[] = [
  { id: 'demo-design-no-fake-kpi', type: 'feedback', description: `${DEMO_TAG}缺字段写「未采集」，不为好看编 KPI` },
  { id: 'demo-motion-running-only', type: 'feedback', description: `${DEMO_TAG}infinite 动效只挂 running，失败静止` },
  { id: 'demo-scanline-removed', type: 'feedback', description: `${DEMO_TAG}扫描线已删：装饰不传递状态` },
  { id: 'demo-frozen-layers', type: 'project', description: `${DEMO_TAG}冻结层：stores/ fold/ api-client/ contract/` },
  { id: 'demo-dispatch-wording', type: 'project', description: `${DEMO_TAG}组装侧一律叫「试跑」，与电脑台 swarm 批次分开` },
  { id: 'demo-starmap-idle', type: 'project', description: `${DEMO_TAG}星图空闲停 rAF，听 prefers-reduced-motion` },
  { id: 'demo-starmap-v1', type: 'project', description: `${DEMO_TAG}星图 v1：力导向，无时间层`, validUntil: '2026-09-01' },
  { id: 'demo-starmap-v2', type: 'project', description: `${DEMO_TAG}星图 v2：按 supersedes / validUntil 分时间层` },
  { id: 'demo-user-zh-first', type: 'user', description: `${DEMO_TAG}界面文案中文优先，英文作小标签` },
  { id: 'demo-user-report-only', type: 'user', description: `${DEMO_TAG}审计类任务：只报告，不改代码` },
  { id: 'demo-ref-dsh-contract', type: 'reference', description: `${DEMO_TAG}DSH 0.1.2 remote.mux 协议要点` },
  { id: 'demo-ref-tokens', type: 'reference', description: `${DEMO_TAG}tokens.css：四态 state-* 与 --u-dur-*` },
]
const EDGES: { from: string, to: string, kind: 'wikilink' | 'supersedes' }[] = [
  { from: 'demo-starmap-v2', to: 'demo-starmap-v1', kind: 'supersedes' },
  { from: 'demo-starmap-v2', to: 'demo-starmap-idle', kind: 'wikilink' },
  { from: 'demo-starmap-idle', to: 'demo-motion-running-only', kind: 'wikilink' },
  { from: 'demo-motion-running-only', to: 'demo-scanline-removed', kind: 'wikilink' },
  { from: 'demo-design-no-fake-kpi', to: 'demo-ref-tokens', kind: 'wikilink' },
  { from: 'demo-frozen-layers', to: 'demo-ref-dsh-contract', kind: 'wikilink' },
  { from: 'demo-user-report-only', to: 'demo-design-no-fake-kpi', kind: 'wikilink' },
  { from: 'demo-dispatch-wording', to: 'demo-frozen-layers', kind: 'wikilink' },
  { from: 'demo-user-zh-first', to: 'demo-dispatch-wording', kind: 'wikilink' },
  { from: 'demo-starmap-v2', to: 'demo-frozen-layers', kind: 'wikilink' },
]

export function demoMemoryGraph(): unknown {
  const byType: Record<string, number> = {}
  for (const n of NODES) byType[n.type] = (byType[n.type] ?? 0) + 1
  return {
    at: DEMO_T0,
    nodes: NODES.map((n, i) => ({
      id: n.id,
      type: n.type,
      description: n.description,
      bytes: 400 + n.description.length * 3,
      mtime: DEMO_T0 - i * 3_600_000,
      outDegree: EDGES.filter((e) => e.from === n.id).length,
      ...(n.validUntil === undefined ? {} : { validUntil: n.validUntil }),
    })),
    edges: EDGES.map((e) => ({ ...e, dangling: false, resolution: 'direct' })),
    counts: {
      nodes: NODES.length,
      edges: EDGES.length,
      dangling: 0,
      byType,
      linkResolution: { normalized: 0, dead: 0, nonMemory: 0 },
      unknownTypes: {},
    },
  }
}

/** Only what the sample sessions can honestly support; other groups stay absent →「未采集」. */
export function demoOverview(): unknown {
  return {
    at: DEMO_T0,
    demo: true,
    sessions: { total: DEMO_SESSIONS.length },
  }
}

export function demoRestFixture(url: URL): unknown | undefined {
  switch (url.pathname) {
    case '/api/memory/graph': return demoMemoryGraph()
    case '/api/agos/overview': return demoOverview()
    default: return undefined
  }
}
