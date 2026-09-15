import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import type { AgosClient } from '../api-client/index.ts'
import type { SettingsNamespaceView } from '../contract/api/index.ts'
import type { SettingsReadSnapshot } from './settings-data.ts'
import {
  AGENT_DEFAULT_MODEL_NS,
  callSettingsMutate,
  parseDefaultModel,
  parsePermissionDefault,
  PERMISSION_SETTINGS_NS,
  prepareDefaultModelMutate,
  preparePermissionMutate,
  replaceNamespaceView,
} from './settings-write.ts'

const permissionSchema = {
  uid: 6,
  refs: {
    1: { type: 'const', value: 'read-only' },
    2: { type: 'const', meta: { description: 'Workspace' }, value: 'workspace-write' },
    3: { type: 'union', list: [1, 2] },
    6: { type: 'object', dict: { defaultPreset: 3 } },
  },
}

function permissionView(
  defaultPreset: string,
  revision = 4,
  schema: SettingsNamespaceView['schema'] = permissionSchema,
): SettingsNamespaceView {
  return {
    ns: PERMISSION_SETTINGS_NS,
    schema,
    value: { defaultPreset },
    base: { defaultPreset: 'read-only' },
    applies: 'live',
    secrets: [],
    revision,
  }
}

const modelSchema = {
  uid: 0,
  refs: {
    0: { type: 'object', dict: { provider: 1, model: 2, reasoningEffort: 3 } },
    1: { type: 'string' },
    2: { type: 'string' },
    3: { type: 'string' },
  },
}

function modelView(
  value: { provider: string, model: string, reasoningEffort?: string },
  revision = 3,
  extras: Partial<SettingsNamespaceView> = {},
): SettingsNamespaceView {
  return {
    ns: AGENT_DEFAULT_MODEL_NS,
    schema: modelSchema,
    value,
    applies: 'live',
    secrets: [],
    revision,
    ...extras,
  }
}

const writableContext = (namespaces: SettingsNamespaceView[]) => ({ writable: true, namespaces })

test('parsePermissionDefault reads union/const choices and host labels', () => {
  const parsed = parsePermissionDefault(permissionView('read-only'))
  assert.deepEqual(parsed, {
    currentValue: 'read-only',
    options: [
      { id: 'read-only', label: 'read-only' },
      { id: 'workspace-write', label: 'Workspace' },
    ],
  })
  const single = {
    uid: 2,
    refs: {
      1: { type: 'const', meta: { description: '' }, value: 'read-only' },
      2: { type: 'object', dict: { defaultPreset: 1 } },
    },
  }
  assert.deepEqual(parsePermissionDefault(permissionView('read-only', 0, single)), {
    currentValue: 'read-only',
    options: [{ id: 'read-only', label: 'read-only' }],
  })
})

test('parsePermissionDefault fails soft on missing or malformed descriptors', () => {
  assert.equal(parsePermissionDefault(undefined), undefined)
  assert.equal(parsePermissionDefault({ ...permissionView('read-only'), value: {} }), undefined)
  assert.equal(parsePermissionDefault(permissionView('read-only', 0, { unexpected: true })), undefined)
  assert.equal(parsePermissionDefault(permissionView('read-only', 0, {
    uid: 1, refs: { 1: { type: 'object', dict: {} } },
  })), undefined)
  assert.equal(parsePermissionDefault(permissionView('read-only', 0, {
    uid: 2,
    refs: {
      1: { type: 'union' },
      2: { type: 'object', dict: { defaultPreset: 1 } },
    },
  })), undefined)
  assert.equal(parsePermissionDefault(permissionView('missing')), undefined)
  const withCustom = {
    uid: 8,
    refs: {
      1: { type: 'const', value: 'read-only' },
      2: { type: 'const', value: 'custom' },
      3: { type: 'union', list: [1, 2] },
      8: { type: 'object', dict: { defaultPreset: 3 } },
    },
  }
  assert.equal(parsePermissionDefault(permissionView('custom', 0, withCustom)), undefined)
  assert.deepEqual(parsePermissionDefault(permissionView('read-only', 0, withCustom))?.options.map((option) => option.id), [
    'read-only',
  ])
})

test('parseDefaultModel shows collected provider/model and optional effort', () => {
  assert.deepEqual(parseDefaultModel(modelView({ provider: 'agos-fake', model: 'agos-fake-1' })), {
    provider: 'agos-fake',
    model: 'agos-fake-1',
    reasoningEffort: '',
  })
  assert.deepEqual(parseDefaultModel(modelView({
    provider: 'agos-fake',
    model: 'agos-fake-1',
    reasoningEffort: 'high',
  })), {
    provider: 'agos-fake',
    model: 'agos-fake-1',
    reasoningEffort: 'high',
  })
  assert.equal(parseDefaultModel(undefined), undefined)
  assert.equal(parseDefaultModel(modelView({ provider: 'agos-fake', model: 'agos-fake-1' }, 3, { value: {} })), undefined)
})

test('preparePermissionMutate refuses writes the page must not send', () => {
  const view = permissionView('read-only', 4)
  assert.equal(preparePermissionMutate({ writable: false, namespaces: [view] }, 'workspace-write').ok, false)
  assert.equal(preparePermissionMutate(writableContext([]), 'workspace-write').ok, false)
  assert.equal(preparePermissionMutate(writableContext([view]), 'not-a-preset').ok, false)
  assert.equal(preparePermissionMutate(writableContext([view]), 'custom').ok, false)
  assert.equal(preparePermissionMutate(writableContext([{
    ...view,
    secrets: [{ path: ['defaultPreset'], set: false }],
  }]), 'workspace-write').ok, false)
  assert.equal(preparePermissionMutate(writableContext([permissionView('read-only', 4, {
    uid: 6,
    refs: {
      1: { type: 'const', value: 'read-only' },
      2: { type: 'const', value: 'workspace-write' },
      3: { type: 'union', list: [1, 2], meta: { role: 'secret' } },
      6: { type: 'object', dict: { defaultPreset: 3 } },
    },
  })]), 'workspace-write').ok, false)
})

test('preparePermissionMutate builds the exact defaultPreset payload', () => {
  const prepared = preparePermissionMutate(
    writableContext([permissionView('read-only', 4)]),
    'workspace-write',
  )
  assert.deepEqual(prepared, {
    ok: true,
    payload: {
      ns: PERMISSION_SETTINGS_NS,
      ops: [{ op: 'set', path: ['defaultPreset'], value: 'workspace-write' }],
      expectedRevision: 4,
    },
  })
})

test('prepareDefaultModelMutate sets provider+model and unsets a cleared effort', () => {
  const view = modelView({ provider: 'agos-fake', model: 'agos-fake-1', reasoningEffort: 'high' }, 3)
  assert.deepEqual(prepareDefaultModelMutate(writableContext([view]), {
    provider: 'agos-fake',
    model: 'agos-fake-2',
    reasoningEffort: 'low',
  }), {
    ok: true,
    payload: {
      ns: AGENT_DEFAULT_MODEL_NS,
      ops: [
        { op: 'set', path: ['provider'], value: 'agos-fake' },
        { op: 'set', path: ['model'], value: 'agos-fake-2' },
        { op: 'set', path: ['reasoningEffort'], value: 'low' },
      ],
      expectedRevision: 3,
    },
  })
  assert.deepEqual(prepareDefaultModelMutate(writableContext([view]), {
    provider: 'agos-fake',
    model: 'agos-fake-2',
    reasoningEffort: '  ',
  }), {
    ok: true,
    payload: {
      ns: AGENT_DEFAULT_MODEL_NS,
      ops: [
        { op: 'set', path: ['provider'], value: 'agos-fake' },
        { op: 'set', path: ['model'], value: 'agos-fake-2' },
        { op: 'unset', path: ['reasoningEffort'] },
      ],
      expectedRevision: 3,
    },
  })
})

test('prepareDefaultModelMutate refuses empty model, missing ns, read-only, and secret paths', () => {
  const view = modelView({ provider: 'agos-fake', model: 'agos-fake-1' }, 3)
  const draft = { provider: 'agos-fake', model: 'agos-fake-2', reasoningEffort: '' }
  assert.equal(prepareDefaultModelMutate({ writable: false, namespaces: [view] }, draft).ok, false)
  assert.equal(prepareDefaultModelMutate(writableContext([]), draft).ok, false)
  assert.equal(prepareDefaultModelMutate(writableContext([view]), {
    provider: 'agos-fake',
    model: '',
    reasoningEffort: '',
  }).ok, false)
  assert.equal(prepareDefaultModelMutate(writableContext([view]), {
    provider: '  ',
    model: 'agos-fake-2',
    reasoningEffort: '',
  }).ok, false)
  assert.equal(prepareDefaultModelMutate(writableContext([{
    ...view,
    secrets: [{ path: ['provider'], set: true }],
  }]), draft).ok, false)
  assert.equal(prepareDefaultModelMutate(writableContext([modelView(
    { provider: 'agos-fake', model: 'agos-fake-1' },
    3,
    {
      schema: {
        uid: 0,
        refs: {
          0: { type: 'object', dict: { provider: 1, model: 2, reasoningEffort: 3 } },
          1: { type: 'string', meta: { role: 'secret' } },
          2: { type: 'string' },
          3: { type: 'string' },
        },
      },
    },
  )]), draft).ok, false)
})

test('callSettingsMutate folds the returned view and surfaces the host message as-is', async () => {
  const accepted = permissionView('workspace-write', 5)
  const calls: Array<{ method: string, payload: unknown }> = []
  const fake = {
    call: async (method: string, payload: unknown) => {
      calls.push({ method, payload })
      if (method !== 'settings/mutate') throw new Error(`unexpected ${method}`)
      return { rpcId: 'fixture', result: { ok: true, value: accepted } }
    },
  } as unknown as Pick<AgosClient, 'call'>

  const prepared = preparePermissionMutate(writableContext([permissionView('read-only', 4)]), 'workspace-write')
  assert.equal(prepared.ok, true)
  if (!prepared.ok) return
  const result = await callSettingsMutate(fake, prepared.payload)
  assert.deepEqual(result, { ok: true, view: accepted })
  assert.deepEqual(calls, [{ method: 'settings/mutate', payload: prepared.payload }])

  const failing = {
    call: async () => ({
      rpcId: 'fixture',
      result: { ok: false, error: { code: 'settings-conflict', message: 'stale revision', details: {} } },
    }),
  } as unknown as Pick<AgosClient, 'call'>
  const failed = await callSettingsMutate(failing, prepared.payload)
  assert.deepEqual(failed, { ok: false, message: 'stale revision' })

  const snapshot: SettingsReadSnapshot = {
    writable: true,
    hasDocument: false,
    namespaces: [permissionView('read-only', 4)],
    credentials: {},
    providers: [],
    modelGroups: [],
    modelFailures: [],
  }
  assert.equal(replaceNamespaceView(snapshot, accepted).namespaces[0]?.revision, 5)
  assert.equal(replaceNamespaceView(snapshot, accepted).namespaces[0]?.value &&
    (replaceNamespaceView(snapshot, accepted).namespaces[0]?.value as { defaultPreset: string }).defaultPreset, 'workspace-write')
  assert.equal(replaceNamespaceView(snapshot, modelView({ provider: 'x', model: 'y' })).namespaces[0]?.ns, PERMISSION_SETTINGS_NS)
})

test('source lock keeps the settings write surface on path-addressed mutate only', () => {
  const dir = dirname(fileURLToPath(import.meta.url))
  const forbidden = [
    'credentials/set',
    'settings/replace',
    'settings/update',
    'Swarm 并发',
    ['routes', 'dec'.concat('ide')].join('/'),
  ]
  for (const file of ['SettingsPage.tsx', 'settings-write.ts'] as const) {
    const text = readFileSync(join(dir, file), 'utf8')
    for (const token of forbidden) {
      assert.equal(text.includes(token), false, `${file} must not contain ${token}`)
    }
  }
})
