/**
 * 真宿主浏览器核验控制台 P3 诚实片:
 * 无 fleet / trace 插件时，机器页不写 Homelab，轨迹页不把 404 装成健康空页。
 * 不进九场景回归门;单独跑:
 *   node tests/host-integration/console-p3.mjs
 */
import path from 'node:path'
import { createHarness } from './harness.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGINS = [{
  id: 'dsh-agos',
  entry: path.join(REPO_ROOT, 'plugins', 'dsh-agos', 'lib', 'index.js'),
  probe: { kind: 'http', path: '/api/agos/turn-evidence?sessionId=probe' },
}]

const checks = []
const record = (ok, detail) => {
  checks.push({ ok, detail })
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${detail}`)
}

const harness = await createHarness({ plugins: PLUGINS })
try {
  const loaded = await harness.plugins.loaded()
  if (loaded.includes('dsh-fleet') || loaded.includes('dsh-trace-view')) {
    throw new Error(`本核验要求不挂 fleet/trace,实际=${loaded.join(',')}`)
  }
  await harness.openApp()
  const page = harness.page

  const traceStatus = await page.evaluate(async () => {
    const r = await fetch('/api/trace/sessions')
    return { status: r.status, text: (await r.text()).slice(0, 80) }
  })
  record(traceStatus.status === 404, `/api/trace/sessions 在本宿主是 HTTP ${traceStatus.status}`)

  await page.getByRole('button', { name: '控制台', exact: true }).click()
  await page.getByRole('button', { name: '机器与机架', exact: true }).click()
  const farmTitle = page.locator('#fleet-view-title')
  await farmTitle.waitFor({ timeout: 15_000 })
  const heading = (await farmTitle.innerText()).trim()
  record(heading === '机器与机架', `机器页标题是功能面,实际=${JSON.stringify(heading)}`)
  record(!heading.includes('Homelab'), '机器页标题不写 Homelab')

  const farm = page.locator('.fleet-view')
  try {
    await farm.getByText('未采集').first().waitFor({ timeout: 15_000 })
  } catch (error) {
    await harness.screenshot('console-p3-fleet-no-uncollected')
    const body = await farm.innerText().catch(() => '(no farm)')
    throw new Error(`${error}\nfleet: ${body}`)
  }
  record(true, '无 fleet 插件时机架面写「未采集」')
  record(
    await farm.getByRole('button', { name: '重试' }).count() > 0,
    '机架 404 提供重试，不是静默空卡',
  )
  const farmText = await farm.innerText()
  record(!farmText.includes('Homelab 执行农场'), '机架正文不再出现 Homelab 执行农场')

  await page.getByRole('button', { name: '轨迹时间流', exact: true }).click()
  try {
    await page.getByText(/\/api\/trace\/sessions 未采集/).waitFor({ timeout: 15_000 })
  } catch (error) {
    await harness.screenshot('console-p3-trace-healthy-empty')
    const body = await page.locator('.surface-page').innerText().catch(() => '(no page)')
    throw new Error(`${error}\ntrace: ${body}`)
  }
  record(true, '轨迹 404 写成未采集，不装「暂无会话轨迹」')
  record(await page.getByText(/HTTP 404/).count() > 0, '轨迹失败带出 HTTP 404')
  record(await page.getByRole('button', { name: '重试' }).count() > 0, '轨迹 404 提供重试')
  record(await page.locator('.trace-legend').count() === 0, '404 不画 LLM/工具图例')
  record(await page.getByText('暂无会话轨迹').count() === 0, '404 不冒充健康空列表')
} finally {
  await harness.dispose()
}

const failed = checks.filter((c) => !c.ok)
console.log(`console-p3: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0 || checks.length === 0) process.exit(1)
