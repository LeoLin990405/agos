import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROUTER_SETTINGS_NAMESPACE,
  RouterSettingsSchema,
  installRouterSettings,
} from '../lib/settings.js'

test('settings section uses the injected 0.1.2 installSection service', () => {
  const entry = { provider: 'fake', model: 'offline' }
  const hooks = { setSource() {}, onChange() {}, validate(value) { return value } }
  let installed
  const ctx = {
    inject(names, callback) {
      assert.deepEqual(names, ['settings'])
      callback({
        settings: {
          installSection(...args) {
            installed = args
          },
        },
      })
    },
  }

  installRouterSettings(ctx, entry, hooks)

  assert.equal(ROUTER_SETTINGS_NAMESPACE, 'agos-router')
  assert.deepEqual(installed, [ctx, 'agos-router', RouterSettingsSchema, entry, hooks])
})
