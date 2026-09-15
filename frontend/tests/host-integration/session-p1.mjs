/**
 * 真宿主浏览器核验会话三个 P1:顶栏打开同一对话框、非法 CWD 拒建、主题写入侧栏。
 * 不进九场景回归门;单独跑:
 *   node tests/host-integration/session-p1.mjs
 */
import path from 'node:path'
import { createHarness } from './harness.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGINS = [{
  id: 'dsh-agos',
  entry: path.join(REPO_ROOT, 'plugins', 'dsh-agos', 'lib', 'index.js'),
  probe: { kind: 'http', path: '/api/agos/turn-evidence?sessionId=probe' },
}]

async function fillReactInput(locator, value) {
  await locator.evaluate((node, next) => {
    const input = node
    const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    descriptor?.set?.call(input, next)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  }, value)
}

async function cwdReady(dialog) {
  const cwd = dialog.getByLabel('工作目录')
  await cwd.waitFor({ timeout: 10_000 })
  await cwd.evaluate((node) => new Promise((resolve) => {
    const input = node
    if (input.value.startsWith('/')) { resolve(undefined); return }
    const started = Date.now()
    const timer = setInterval(() => {
      if (input.value.startsWith('/') || Date.now() - started > 2000) {
        clearInterval(timer)
        resolve(undefined)
      }
    }, 50)
  }))
  return cwd
}

const checks = []
const record = (ok, detail) => {
  checks.push({ ok, detail })
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${detail}`)
}

const harness = await createHarness({ plugins: PLUGINS })
try {
  const loaded = await harness.plugins.loaded()
  if (!loaded.includes('dsh-agos')) {
    throw new Error(`dsh-agos 未挂上,workspace-stat 不可用: ${loaded.join(',')}`)
  }
  await harness.openApp()
  const page = harness.page
  const topbarNew = page.locator('.app-topbar [aria-label="新会话"]')
  await topbarNew.waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => {
    const btn = document.querySelector('.app-topbar [aria-label="新会话"]')
    return btn instanceof HTMLButtonElement && !btn.disabled
  }, { timeout: 30_000 })

  const before = await page.locator('.session-row-open').count()
  await topbarNew.click()
  const dialog = page.getByRole('dialog', { name: '新建 Agent OS 会话' })
  try {
    await dialog.waitFor({ timeout: 10_000 })
  } catch (error) {
    await harness.screenshot('session-p1-no-dialog')
    const names = await page.locator('button,[role="dialog"]').evaluateAll((nodes) =>
      nodes.map((node) => `${node.tagName}:${node.getAttribute('aria-label') ?? node.textContent?.trim()?.slice(0, 40) ?? ''}`),
    )
    throw new Error(`${error}\nvisible names: ${names.join(' | ')}`)
  }
  record(await dialog.isVisible(), '顶栏「新会话」打开与侧栏相同的创建对话框')
  // 打开时 effect 会把宿主 home 填进 CWD;等它落盘再改,否则会盖住非法路径。
  const cwd = await cwdReady(dialog)
  const titleBox = dialog.getByLabel('会话主题')
  await fillReactInput(titleBox, '验收会话A-无效目录')
  const invalidCwd = `/Users/leo/this-path-does-not-exist-agos-p1-${Date.now()}`
  await fillReactInput(cwd, invalidCwd)
  record(await cwd.inputValue() === invalidCwd, `提交前 CWD 仍是非法路径 (${await cwd.inputValue()})`)
  const createBtn = dialog.getByRole('button', { name: /创建并进入会话/ })
  await createBtn.click()
  try {
    await page.getByText(/工作目录不存在|无法核验工作目录|必须是绝对路径|必须是目录/).waitFor({ timeout: 10_000 })
  } catch (error) {
    await harness.screenshot('session-p1-no-cwd-error')
    const dialogText = await dialog.innerText().catch(() => '(dialog gone)')
    throw new Error(`${error}\ndialog: ${dialogText}`)
  }
  const afterInvalid = await page.locator('.session-row-open').count()
  record(afterInvalid === before, `非法 CWD 未新建会话 (before=${before}, after=${afterInvalid})`)
  record(await dialog.isVisible(), '非法 CWD 后对话框仍开着,可改路径再提交')

  await fillReactInput(titleBox, '验收会话A')
  await fillReactInput(cwd, harness.workspace)
  record(await cwd.inputValue() === harness.workspace, `合法 CWD 已填入 (${await cwd.inputValue()})`)
  await dialog.getByRole('button', { name: /创建并进入会话/ }).click()
  try {
    await page.getByRole('dialog', { name: '新建 Agent OS 会话' }).waitFor({ state: 'hidden', timeout: 15_000 })
  } catch (error) {
    await harness.screenshot('session-p1-create-stuck')
    const dialogText = await dialog.innerText().catch(() => '(no dialog)')
    const rows = await page.locator('.session-sidebar').innerText().catch(() => '')
    throw new Error(`${error}\ndialog: ${dialogText}\nsidebar: ${rows}`)
  }
  const titles = await page.locator('.session-row-title').allTextContents()
  record(titles.includes('验收会话A'), `侧栏标题是填写的主题,实际=${JSON.stringify(titles)}`)
} finally {
  await harness.dispose()
}

const failed = checks.filter((c) => !c.ok)
console.log(`session-p1: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0 || checks.length === 0) process.exit(1)
