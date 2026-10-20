/**
 * Demo mode — run the SPA with NO dsh host (:3091), for screenshots,
 * recordings and first-look evaluation.
 *
 * On:  `?demo=1` in the URL, or build with `VITE_AGOS_DEMO=1`.
 * Off: `?demo=0` (clears the sticky flag).
 *
 * DESIGN.md「不为好看编 KPI」still applies: every fixture record is sample data
 * and says so (【示例数据】 prefix, `demo-` ids, provider `demo-fixture`), the
 * UI shows a permanent DEMO banner, and anything without a fixture answers
 * 「演示模式未采集」 instead of an invented number.
 */

const STORAGE_KEY = 'agos.demo'

export function isDemoMode(): boolean {
  const env = (import.meta as { env?: Record<string, string | undefined> }).env
  if (env?.['VITE_AGOS_DEMO'] === '1') return true
  if (typeof window === 'undefined') return false
  const param = new URLSearchParams(window.location.search).get('demo')
  try {
    if (param === '0' || param === 'false') { window.sessionStorage.removeItem(STORAGE_KEY); return false }
    if (param !== null) { window.sessionStorage.setItem(STORAGE_KEY, '1'); return true }
    return window.sessionStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return param !== null && param !== '0' && param !== 'false'
  }
}

/** Error code every un-fixtured demo endpoint answers with. */
export const DEMO_NOT_COLLECTED = 'DEMO_NOT_COLLECTED'
export const DEMO_NOT_COLLECTED_MESSAGE = '演示模式未采集：此数据需要连接本机 dsh 宿主 (:3091)'
