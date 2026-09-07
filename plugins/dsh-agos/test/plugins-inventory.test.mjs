import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { AGOS_PLUGIN_IDS, INVENTORY_COPY, buildPluginsInventory, detectCurrentProfile } from '../lib/plugins-inventory.js'

test('inventory is read-only and reports AgOS copies without inventing drift', async () => {
  const home = await mkdtemp(join(tmpdir(), 'agos-inv-'))
  const repo = join(home, 'repo', 'plugins')
  const web = join(home, '.dsh', 'profiles', 'web')
  await mkdir(join(repo, 'dsh-agos', 'lib'), { recursive: true })
  await mkdir(join(web, 'plugins', 'dsh-agos', 'lib'), { recursive: true })
  await mkdir(join(web, 'plugins', 'dsh-civ'), { recursive: true })
  await writeFile(join(repo, 'dsh-agos', 'lib', 'index.js'), 'export const name = "agos"\n')
  await writeFile(join(web, 'plugins', 'dsh-agos', 'lib', 'index.js'), 'export const name = "agos"\n')
  await writeFile(join(web, 'package.json'), JSON.stringify({
    dsh: { profile: { bundles: ['@dsh-local/agos', 'dsh-memory-vault'] } },
  }))
  await writeFile(join(web, 'cordis.patch.yml'), '- id: dsh-memory\n- id: dsh-agos\n')

  const inventory = buildPluginsInventory({ home, repoPlugins: repo, now: () => 1_778_000_000_000 })
  assert.equal(inventory.writable, false)
  assert.equal(inventory.copy, INVENTORY_COPY)
  assert.equal(inventory.at, 1_778_000_000_000)
  const webProfile = inventory.profiles.find((row) => row.name === 'web')
  assert.equal(webProfile.pluginCount, 2)
  assert.deepEqual(webProfile.bundles, ['@dsh-local/agos', 'dsh-memory-vault'])
  assert.deepEqual(webProfile.cordisIds, ['dsh-memory', 'dsh-agos'])
  const agos = webProfile.plugins.find((row) => row.id === 'dsh-agos')
  assert.equal(agos.kind, 'agos')
  assert.equal(agos.drift, false)
  const civ = webProfile.plugins.find((row) => row.id === 'dsh-civ')
  assert.equal(civ.kind, 'host')
  assert.equal(civ.drift, undefined)
  assert.equal(inventory.agos.find((row) => row.id === 'dsh-agos')?.web, true)
  assert.equal(inventory.agos.find((row) => row.id === 'dsh-agos')?.drift, false)
  assert.equal(AGOS_PLUGIN_IDS.length, 5)
  assert.equal(inventory.currentProcess, undefined)
})

test('current process is collected from argv or plugin path, never guessed', () => {
  assert.equal(detectCurrentProfile({ argv: ['dsh', '--profile', 'web'] }), 'web')
  assert.equal(detectCurrentProfile({ here: '/Users/leo/.dsh/profiles/desktop/plugins/dsh-agos/lib/' }), 'desktop')
  assert.equal(detectCurrentProfile({ here: '/Users/leo/Projects/agos/plugins/dsh-agos/lib/' }), undefined)
})
