import assert from 'node:assert/strict'
import test from 'node:test'
import type { AgosClient } from '../api-client/index.ts'
import {
  collectCredentialRefs,
  deriveSettingRows,
  formatSettingValue,
  loadSettingsSnapshot,
  type SettingsNamespaceView,
} from './settings-data.ts'

const schema = {
  uid: 0,
  refs: {
    0: { type: 'object', dict: { endpoint: 1, retry: 2, apiKeyEnv: 4, secretToken: 5 }, meta: {} },
    1: { type: 'string', meta: { description: '服务地址', default: 'https://default.invalid' } },
    2: { type: 'object', dict: { attempts: 3 }, meta: {} },
    3: { type: 'number', meta: { default: 2 } },
    4: { type: 'string', meta: { role: 'credential-ref' } },
    5: { type: 'string', meta: { role: 'secret' } },
  },
}

const namespace: SettingsNamespaceView = {
  ns: 'llm-example',
  schema,
  value: {
    endpoint: 'https://resolved.invalid',
    retry: { attempts: 4 },
    apiKeyEnv: 'EXAMPLE_API_KEY',
  },
  base: { endpoint: 'https://resolved.invalid' },
  user: { retry: { attempts: 4 } },
  applies: 'restart',
  secrets: [{ path: ['secretToken'], set: true }],
  revision: 7,
}

test('schema projection lists declared leaves and derives honest layer sources', () => {
  const rows = deriveSettingRows(namespace)
  assert.deepEqual(rows.map(({ label, source, value, protected: isProtected }) => ({ label, source, value, isProtected })), [
    { label: 'endpoint', source: 'base', value: 'https://resolved.invalid', isProtected: false },
    { label: 'retry.attempts', source: 'user', value: 4, isProtected: false },
    { label: 'apiKeyEnv', source: 'default', value: 'EXAMPLE_API_KEY', isProtected: false },
    { label: 'secretToken', source: 'protected', value: true, isProtected: true },
  ])
  assert.equal(rows[0]?.description, '服务地址')
  assert.ok(rows.every((row) => row.applies === 'restart'))
})

test('schema parser fails soft and credential collection only returns valid references', () => {
  assert.deepEqual(deriveSettingRows({ ...namespace, schema: { unexpected: true } }), [])
  assert.deepEqual(collectCredentialRefs([
    namespace,
    { ...namespace, ns: 'another', value: { nested: [{ apiKeyEnv: 'SECOND_KEY' }, { apiKeyEnv: 'not-valid-key' }] } },
  ]), ['EXAMPLE_API_KEY', 'SECOND_KEY'])
  assert.equal(formatSettingValue(undefined), '未设置')
  assert.equal(formatSettingValue({ enabled: true }), '{\n  "enabled": true\n}')
})

test('secret-role containers remain one boolean row and never expose child fields', () => {
  const containerSchema = {
    uid: 10,
    refs: {
      10: { type: 'object', dict: { auth: 11 }, meta: {} },
      11: { type: 'object', dict: { token: 12, header: 13 }, meta: { role: 'secret' } },
      12: { type: 'string', meta: {} },
      13: { type: 'string', meta: {} },
    },
  }
  const secretNamespace: SettingsNamespaceView = {
    ...namespace,
    schema: containerSchema,
    value: {},
    base: undefined,
    user: undefined,
    secrets: [{ path: ['auth'], set: true }],
  }

  assert.deepEqual(deriveSettingRows(secretNamespace).map((row) => ({
    label: row.label,
    value: row.value,
    source: row.source,
    protected: row.protected,
  })), [{ label: 'auth', value: true, source: 'protected', protected: true }])
  assert.deepEqual(deriveSettingRows({
    ...secretNamespace,
    secrets: [{ path: ['auth'], set: false }],
  }).map((row) => ({ label: row.label, value: row.value })), [{ label: 'auth', value: false }])
})

test('degraded loader (DSH 0.1.2, batch B2 restores full read) issues no unary calls', async () => {
  // 0.1.2 removed settings.describe / llm.providers / llm.models; the loader
  // returns an empty snapshot and makes no calls until batch B2 re-aligns them.
  const calls: string[] = []
  const fake = {
    call: async (method: string) => { calls.push(method); return { rpcId: 'fixture', result: { ok: true, value: undefined } } },
  } as unknown as Pick<AgosClient, 'call'>
  const snapshot = await loadSettingsSnapshot(fake)
  assert.deepEqual(calls, [])
  assert.deepEqual(snapshot, {
    writable: false,
    hasDocument: true,
    namespaces: [],
    credentials: {},
    providers: [],
    modelGroups: [],
    modelFailures: [],
  })
})
