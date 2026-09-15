/**
 * 真宿主浏览器核验设置 P4:新会话默认写面在，凭据仍只读，无虚构 Swarm 开关。
 * 宿主可写且权限 <select> 可用时，真改 defaultPreset，并核对 POST /api/settings/mutate。
 * 宿主可写且默认模型输入在时，改 advertised 模型串并点「写入默认模型」，
 * 核对 payload.args.ns === agent-default-model。
 * 不可写或「未采集」记 blocked/skip，不判产品失败。
 * 不进九场景回归门;单独跑:
 *   node tests/host-integration/settings-p4.mjs
 */
import path from 'node:path'
import { createHarness } from './harness.mjs'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const PLUGINS = [{
  id: 'dsh-agos',
  entry: path.join(REPO_ROOT, 'plugins', 'dsh-agos', 'lib', 'index.js'),
  probe: { kind: 'http', path: '/api/agos/turn-evidence?sessionId=probe' },
}]

const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

const checks = []
const record = (ok, detail) => {
  checks.push({ ok, detail })
  console.log(`   ${ok ? 'ok  ' : 'FAIL'} ${detail}`)
}

/** Thrown-away-host write was not exercisable; still a passing check. */
const skip = (why) => {
  record(true, `blocked/skip: ${why}`)
  console.log(`   why  ${why}`)
}

function isSettingsMutatePost(request) {
  if (request.method() !== 'POST') return false
  let pathname
  try {
    pathname = new URL(request.url()).pathname
  } catch {
    pathname = request.url()
  }
  return pathname === '/api/settings/mutate' || pathname.endsWith('/api/settings/mutate')
}

function listenMutatePosts(page) {
  const seen = []
  const onRequest = (request) => {
    if (isSettingsMutatePost(request)) seen.push(request)
  }
  page.on('request', onRequest)
  return {
    seen,
    stop() { page.off('request', onRequest) },
  }
}

/** Live Remote is mutate(ns, ops, expectedRevision) — args must not wrap `request`. */
function mutateArgsOf(request) {
  let body
  try {
    body = request.postDataJSON?.() ?? JSON.parse(request.postData() || '{}')
  } catch {
    return undefined
  }
  const args = body?.payload?.args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return undefined
  return args
}

function isNamespacedMutatePost(request, ns) {
  return isSettingsMutatePost(request) && mutateArgsOf(request)?.ns === ns
}

function firstMutateByNs(requests, ns) {
  return requests.find((request) => mutateArgsOf(request)?.ns === ns)
}

function recordMutateEnvelope(request, expectedNs) {
  const args = mutateArgsOf(request)
  if (args === undefined) {
    record(false, '截到 mutate POST 但读不出 payload.args')
    return
  }
  const wrapped = Object.hasOwn(args, 'request') && !Object.hasOwn(args, 'ns')
  const nsOk = typeof args.ns === 'string' && (expectedNs === undefined || args.ns === expectedNs)
  record(
    nsOk && Array.isArray(args.ops) && !wrapped,
    wrapped
      ? 'mutate 信封仍包了 request,宿主要的是顶层 ns/ops'
      : expectedNs !== undefined && args.ns !== expectedNs
        ? `mutate args.ns=${args.ns}，期望 ${expectedNs}`
        : `mutate args 是顶层 ns/ops（ns=${args.ns}）`,
  )
}

async function credentialsHaveNoSecretInputs(page) {
  const section = page.locator('.settings-section').filter({
    has: page.getByRole('heading', { name: '凭据状态' }),
  })
  const controls = section.locator('input, textarea, select, [contenteditable="true"]')
  const passwords = page.locator('.settings-body input[type="password"]')
  return {
    present: await section.count() > 0,
    controlCount: await controls.count(),
    passwordCount: await passwords.count(),
  }
}

async function recordCredentialsStillReadOnly(page) {
  const creds = await credentialsHaveNoSecretInputs(page)
  record(
    creds.present && creds.controlCount === 0 && creds.passwordCount === 0,
    `凭据区仍无密码框/密钥输入 (inputs=${creds.controlCount}, password=${creds.passwordCount})`,
  )
}

async function probePermissionWriteSurface(page) {
  const defaults = page.locator('.settings-section').filter({
    has: page.getByRole('heading', { name: '新会话默认' }),
  })
  const chipText = ((await defaults.locator('.u-chip').first().innerText().catch(() => ''))).trim()
  const writable = chipText === '可写'
  const permissionGroup = defaults.locator('.settings-write > .form-group').filter({
    has: page.locator('label[for="settings-permission-preset"]'),
  })
  const select = page.locator('#settings-permission-preset')
  const selectCount = await select.count()
  const uncollected = selectCount === 0
    && await permissionGroup.getByText('未采集', { exact: true }).count() > 0
  return { defaults, chipText, writable, permissionGroup, select, selectCount, uncollected }
}

async function probeModelWriteSurface(page) {
  const defaults = page.locator('.settings-section').filter({
    has: page.getByRole('heading', { name: '新会话默认' }),
  })
  const chipText = ((await defaults.locator('.u-chip').first().innerText().catch(() => ''))).trim()
  const writable = chipText === '可写'
  const modelGroup = defaults.locator('.settings-write > .form-group').filter({
    has: page.locator('.form-label', { hasText: /^默认模型$/ }),
  })
  const provider = page.getByRole('textbox', { name: '默认模型提供商' })
  const model = page.getByRole('textbox', { name: '默认模型', exact: true })
  const save = page.getByRole('button', { name: '写入默认模型' })
  const providerCount = await provider.count()
  const modelCount = await model.count()
  const saveCount = await save.count()
  const uncollected = providerCount === 0 && modelCount === 0 && saveCount === 0
    && await modelGroup.getByText('未采集', { exact: true }).count() > 0
  return {
    chipText,
    writable,
    modelGroup,
    provider,
    model,
    save,
    providerCount,
    modelCount,
    saveCount,
    uncollected,
  }
}

let permissionMutateFired = false
let permissionWriteOutcome = 'not-attempted'
let modelMutateFired = false
let modelWriteOutcome = 'not-attempted'

const harness = await createHarness({ plugins: PLUGINS })
try {
  await harness.openApp()
  const page = harness.page
  await page.locator('.app-container').waitFor({ timeout: 30_000 })
  await page.getByRole('button', { name: '系统设置' }).click()
  await page.getByRole('heading', { name: '新会话默认' }).waitFor({ timeout: 30_000 })
  const body = await page.locator('.settings-body').innerText()
  record(body.includes('新会话默认'), '设置页有新会话默认写面')
  record(body.includes('凭据与密钥槽位仍不可在此输入'), '读取边界仍禁止在浏览器填凭据')
  record(!body.includes('Swarm 并发'), '设置页不画未接入的 Swarm 开关')
  record(body.includes('权限默认预设'), '权限默认预设行在')
  record(body.includes('默认模型'), '默认模型行在')
  record(await page.getByRole('heading', { name: '凭据状态' }).count() > 0, '凭据区仍在且只读展示')

  const surface = await probePermissionWriteSurface(page)
  if (surface.uncollected) {
    permissionWriteOutcome = 'skip-uncollected'
    skip('权限默认预设是「未采集」，没有可写的 <select>，不改 defaultPreset')
  } else if (!surface.writable) {
    permissionWriteOutcome = 'skip-readonly'
    skip(`宿主设置面不可写（芯片「${surface.chipText || '无'}」），不改 defaultPreset`)
    if (surface.selectCount > 0 && await surface.select.isEnabled()) {
      record(false, '只读层遮蔽时权限 <select> 仍可点，写控件应禁用')
    }
  } else if (surface.selectCount === 0) {
    permissionWriteOutcome = 'skip-uncollected'
    skip('可写面上没有 #settings-permission-preset，按未采集跳过写入')
  } else if (!await surface.select.isEnabled()) {
    record(false, '宿主芯片是「可写」但权限 <select> 被禁用，写面钩子不对')
    permissionWriteOutcome = 'disabled-on-writable'
  } else {
    const listener = listenMutatePosts(page)
    try {
      const current = await surface.select.inputValue()
      const options = await surface.select.evaluate((node) =>
        [...node.options].map((option) => option.value).filter((value) => value !== ''))
      const next = options.find((value) => value !== current)
      if (next === undefined) {
        permissionWriteOutcome = 'skip-single-option'
        skip(`权限预设只有当前 advertised option「${current}」，无法改 defaultPreset`)
      } else {
        const pending = page.waitForRequest(isSettingsMutatePost, { timeout: 20_000 }).catch(() => undefined)
        await surface.select.selectOption(next)
        const request = await pending
        permissionMutateFired = request !== undefined || listener.seen.length > 0
        await page.waitForFunction(() => {
          const alert = document.querySelector('.settings-write [role="alert"]')
          if (alert instanceof HTMLElement && alert.textContent?.trim()) return true
          const el = document.querySelector('#settings-permission-preset')
          return el instanceof HTMLSelectElement && !el.disabled
        }, undefined, { timeout: 20_000 }).catch(() => undefined)

        const alertText = ((await page.locator('.settings-write [role="alert"]').innerText().catch(() => ''))).trim()
        if (permissionMutateFired) {
          permissionWriteOutcome = alertText === '' ? 'mutate-ok' : 'mutate-host-error'
          record(true, `真实 POST /api/settings/mutate 已发出 (${listener.seen.length || 1} 次)`)
          recordMutateEnvelope(request ?? listener.seen[0], 'permission')
        } else if (alertText !== '') {
          permissionWriteOutcome = 'host-error-no-capture'
          record(true, `未截到 mutate POST，页面原样展示宿主错误: ${alertText}`)
        } else {
          permissionWriteOutcome = 'no-mutate'
          await harness.screenshot('settings-p4-no-mutate').catch(() => undefined)
          record(false, `改到 ${next} 后既没有 POST /api/settings/mutate，也没有宿主错误`)
        }

        if (alertText !== '') {
          record(true, `宿主错误原样上屏: ${alertText}`)
        } else if (permissionMutateFired) {
          const stayed = await surface.select.inputValue()
          record(stayed === next, `成功后权限预设仍停在 advertised option ${next}（当前=${stayed}）`)
        }
      }
    } catch (error) {
      permissionWriteOutcome = 'write-threw'
      await harness.screenshot('settings-p4-write').catch(() => undefined)
      record(false, `改 defaultPreset 失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      listener.stop()
    }
  }

  const modelSurface = await probeModelWriteSurface(page)
  if (modelSurface.uncollected) {
    modelWriteOutcome = 'skip-uncollected'
    skip('默认模型是「未采集」，没有可写的 provider/model 输入，不发明 catalog')
  } else if (!modelSurface.writable) {
    modelWriteOutcome = 'skip-readonly'
    skip(`宿主设置面不可写（芯片「${modelSurface.chipText || '无'}」），不改默认模型`)
    const enabledInput = (modelSurface.providerCount > 0 && await modelSurface.provider.isEnabled())
      || (modelSurface.modelCount > 0 && await modelSurface.model.isEnabled())
    if (enabledInput) {
      record(false, '只读层遮蔽时默认模型输入仍可改，写控件应禁用')
    }
  } else if (modelSurface.providerCount === 0 || modelSurface.modelCount === 0 || modelSurface.saveCount === 0) {
    modelWriteOutcome = 'skip-uncollected'
    skip('可写面上没有默认模型提供商/模型输入或「写入默认模型」，按未采集跳过写入')
  } else {
    const advertisedProvider = (await modelSurface.provider.inputValue()).trim()
    const advertisedModel = (await modelSurface.model.inputValue()).trim()
    if (advertisedProvider === '' || advertisedModel === '') {
      modelWriteOutcome = 'skip-empty-advertised'
      skip(`默认模型 advertised 值为空（provider=${JSON.stringify(advertisedProvider)}, model=${JSON.stringify(advertisedModel)}），不发明 catalog`)
    } else if (!await modelSurface.provider.isEnabled() || !await modelSurface.model.isEnabled()) {
      record(false, '宿主芯片是「可写」但默认模型输入被禁用，写面钩子不对')
      modelWriteOutcome = 'disabled-on-writable'
    } else {
      const listener = listenMutatePosts(page)
      try {
        const nextModel = advertisedModel.endsWith('-p4') ? `${advertisedModel}-again` : `${advertisedModel}-p4`
        await modelSurface.model.fill(nextModel)
        await modelSurface.save.waitFor({ state: 'visible', timeout: 5_000 })
        if (!await modelSurface.save.isEnabled()) {
          record(false, '填了 advertised provider/model 后「写入默认模型」仍禁用')
          modelWriteOutcome = 'save-disabled'
        } else {
          const pending = page.waitForRequest(
            (request) => isNamespacedMutatePost(request, AGENT_DEFAULT_MODEL_NS),
            { timeout: 20_000 },
          ).catch(() => undefined)
          await modelSurface.save.click()
          const request = await pending
          const captured = request
            ?? firstMutateByNs(listener.seen, AGENT_DEFAULT_MODEL_NS)
            ?? listener.seen[0]
          modelMutateFired = captured !== undefined
          await page.waitForFunction(() => {
            const alert = document.querySelector('.settings-write [role="alert"]')
            if (alert instanceof HTMLElement && alert.textContent?.trim()) return true
            const button = [...document.querySelectorAll('button')]
              .find((node) => (node.textContent ?? '').trim() === '写入默认模型')
            return button instanceof HTMLButtonElement && !button.disabled
          }, undefined, { timeout: 20_000 }).catch(() => undefined)

          const alertText = ((await page.locator('.settings-write [role="alert"]').innerText().catch(() => ''))).trim()
          if (modelMutateFired) {
            modelWriteOutcome = alertText === '' ? 'mutate-ok' : 'mutate-host-error'
            record(true, `默认模型真实 POST /api/settings/mutate 已发出 (${listener.seen.length || 1} 次)`)
            recordMutateEnvelope(captured, AGENT_DEFAULT_MODEL_NS)
          } else if (alertText !== '') {
            modelWriteOutcome = 'host-error-no-capture'
            record(true, `未截到默认模型 mutate POST，页面原样展示宿主错误: ${alertText}`)
          } else {
            modelWriteOutcome = 'no-mutate'
            await harness.screenshot('settings-p4-model-no-mutate').catch(() => undefined)
            record(false, `写入默认模型后既没有 POST /api/settings/mutate（ns=${AGENT_DEFAULT_MODEL_NS}），也没有宿主错误`)
          }

          if (alertText !== '') {
            record(true, `默认模型宿主错误原样上屏: ${alertText}`)
          } else if (modelMutateFired) {
            const stayedProvider = (await modelSurface.provider.inputValue()).trim()
            const stayedModel = (await modelSurface.model.inputValue()).trim()
            record(
              stayedProvider === advertisedProvider && stayedModel === nextModel,
              `成功后默认模型仍停在刚写入的 ${advertisedProvider}/${nextModel}（当前=${stayedProvider}/${stayedModel}）`,
            )
          }
        }
      } catch (error) {
        modelWriteOutcome = 'write-threw'
        await harness.screenshot('settings-p4-model-write').catch(() => undefined)
        record(false, `改默认模型失败: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        listener.stop()
      }
    }
  }

  await recordCredentialsStillReadOnly(page)
} finally {
  await harness.dispose()
}

const failed = checks.filter((c) => !c.ok)
console.log(`settings-p4: ${checks.length - failed.length}/${checks.length} passed`)
console.log(`settings-p4 write: permission-mutate=${permissionMutateFired ? 'fired' : 'no'} permission-outcome=${permissionWriteOutcome} model-mutate=${modelMutateFired ? 'fired' : 'no'} model-outcome=${modelWriteOutcome}`)
if (failed.length > 0 || checks.length === 0) process.exit(1)
