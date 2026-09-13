import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { link, unlink, realpath, readFile, rename } from 'node:fs/promises'

import { openPlanFile, resolvePlanPath } from '../lib/plan-path.mjs'

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'cn-plan-path-'))
  const planDir = join(root, 'plans')
  await mkdir(planDir)
  return { root, planDir }
}

test('resolvePlanPath: basename and planDir/basename work; escape and illegal names fail', async (t) => {
  const { root, planDir } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  const okBase = resolvePlanPath('plan-123.json', planDir)
  assert.equal(okBase.ok, true)
  assert.equal(okBase.name, 'plan-123.json')
  assert.equal(okBase.path, join(planDir, 'plan-123.json'))

  const okFull = resolvePlanPath(join(planDir, 'plan-123.json'), planDir)
  assert.equal(okFull.ok, true)
  assert.equal(okFull.path, okBase.path)

  assert.equal(resolvePlanPath('../plan-123.json', planDir).code, 'ESCAPE')
  assert.equal(resolvePlanPath(join(root, 'plan-123.json'), planDir).code, 'ESCAPE')
  assert.equal(resolvePlanPath('/etc/passwd', planDir).code, 'INVALID_NAME')
  assert.equal(resolvePlanPath('plan-abc.json', planDir).code, 'INVALID_NAME')
  assert.equal(resolvePlanPath('notes.json', planDir).code, 'INVALID_NAME')
  assert.equal(resolvePlanPath('plan-1.json/../plan-2.json', planDir).code, 'ESCAPE')
  assert.equal(resolvePlanPath('subdir/plan-1.json', planDir).code, 'ESCAPE')
  assert.equal(resolvePlanPath('', planDir).code, 'INVALID_NAME')
  assert.equal(resolvePlanPath('plan-1.json', '').code, 'INVALID_DIR')
})

test('openPlanFile: ordinary file still works for read and write', async (t) => {
  const { root, planDir } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const name = 'plan-1700000000000.json'
  const created = await openPlanFile({ path: name, planDir, flags: 'wx' })
  assert.equal(created.ok, true, created.message)
  await created.handle.writeFile(JSON.stringify({ goal: 'x', steps: [{ id: 1, title: 'a' }] }, null, 2), 'utf8')
  await created.handle.close()

  const read = await openPlanFile({ path: name, planDir, flags: 'r' })
  assert.equal(read.ok, true, read.message)
  const body = JSON.parse(await read.handle.readFile('utf8'))
  await read.handle.close()
  assert.equal(body.goal, 'x')
  assert.equal(body.steps[0].title, 'a')

  const rewritten = await openPlanFile({ path: join(planDir, name), planDir, flags: 'w' })
  assert.equal(rewritten.ok, true, rewritten.message)
  await rewritten.handle.writeFile(JSON.stringify({ goal: 'y', steps: [{ id: 1, title: 'b' }] }), 'utf8')
  await rewritten.handle.close()

  const again = await openPlanFile({ path: name, planDir, flags: 'r' })
  const after = JSON.parse(await again.handle.readFile('utf8'))
  await again.handle.close()
  assert.equal(after.goal, 'y')
})

test('openPlanFile: legal-name symlink is rejected (read and write)', async (t) => {
  const { root, planDir } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const secret = join(root, 'secret.json')
  await writeFile(secret, '{"pwned":true}', 'utf8')
  const name = 'plan-9.json'
  await symlink(secret, join(planDir, name))

  const read = await openPlanFile({ path: name, planDir, flags: 'r' })
  assert.equal(read.ok, false)
  assert.equal(read.code, 'SYMLINK')

  const write = await openPlanFile({ path: name, planDir, flags: 'w' })
  assert.equal(write.ok, false)
  assert.equal(write.code, 'SYMLINK')
})

test('openPlanFile: planDir symlink and non-regular leaf fail', async (t) => {
  const { root, planDir } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))

  const linkedDir = join(root, 'plans-link')
  await symlink(planDir, linkedDir)
  const viaLink = await openPlanFile({ path: 'plan-1.json', planDir: linkedDir, flags: 'wx' })
  assert.equal(viaLink.ok, false)
  assert.equal(viaLink.code, 'SYMLINK')

  await mkdir(join(planDir, 'plan-2.json'))
  const dirLeaf = await openPlanFile({ path: 'plan-2.json', planDir, flags: 'r' })
  assert.equal(dirLeaf.ok, false)
  assert.equal(dirLeaf.code, 'NOT_REGULAR')
})

test('openPlanFile: missing file is ENOENT; wx does not follow a planted name', async (t) => {
  const { root, planDir } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const missing = await openPlanFile({ path: 'plan-404.json', planDir, flags: 'r' })
  assert.equal(missing.ok, false)
  assert.equal(missing.code, 'ENOENT')

  const created = await openPlanFile({ path: 'plan-3.json', planDir, flags: 'wx' })
  assert.equal(created.ok, true, created.message)
  await created.handle.writeFile('{"steps":[]}', 'utf8')
  await created.handle.close()
  const again = await openPlanFile({ path: 'plan-3.json', planDir, flags: 'wx' })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'EEXIST')
})

test('openPlanFile: world-writable ordinary file is still a regular file we can read', async (t) => {
  const { root, planDir } = await fixture()
  t.after(() => rm(root, { recursive: true, force: true }))
  const name = 'plan-4.json'
  await writeFile(join(planDir, name), '{"steps":[{"id":1}]}', { mode: 0o666 })
  await chmod(join(planDir, name), 0o666)
  const read = await openPlanFile({ path: name, planDir, flags: 'r' })
  assert.equal(read.ok, true, read.message)
  const text = await read.handle.readFile('utf8')
  await read.handle.close()
  assert.match(text, /"id":\s*1/)
})

test('a replacement during open is rejected before any truncation (string and numeric flags)', async (t) => {
  for (const flags of ['w', fs.constants.O_WRONLY | fs.constants.O_TRUNC]) {
    const fixtureRoot = await fixture()
    const root = await realpath(fixtureRoot.root)
    const planDir = join(root, 'plans')
    t.after(() => rm(root, { recursive: true, force: true }))
    const path = join(planDir, 'plan-1.json')
    const victim = join(root, 'outside.json')
    await writeFile(path, 'original plan')
    await writeFile(victim, 'must survive')
    const originalOpen = fs.promises.open
    let replaced = false
    const mocked = t.mock.method(fs.promises, 'open', async (target, ...args) => {
      if (target === path && !replaced) {
        replaced = true
        await unlink(path)
        await link(victim, path)
      }
      return originalOpen(target, ...args)
    })
    syncBuiltinESMExports()
    try {
      const opened = await openPlanFile({ path, planDir, flags })
      assert.equal(replaced, true)
      assert.equal(opened.ok, false)
      assert.equal(await readFile(victim, 'utf8'), 'must survive')
    } finally { mocked.mock.restore(); syncBuiltinESMExports() }
  }
})

test('replacing planDir under the same pathname cannot redirect a write', async (t) => {
  const fixtureRoot = await fixture()
  const root = await realpath(fixtureRoot.root)
  const planDir = join(root, 'plans')
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = join(planDir, 'plan-2.json')
  await writeFile(path, 'old plan')
  const originalOpen = fs.promises.open
  let replaced = false
  const mocked = t.mock.method(fs.promises, 'open', async (target, ...args) => {
    if (target === path && !replaced) {
      replaced = true
      await rename(planDir, join(root, 'old-plans'))
      await mkdir(planDir)
      await writeFile(path, 'replacement must survive')
    }
    return originalOpen(target, ...args)
  })
  syncBuiltinESMExports()
  try {
    const opened = await openPlanFile({ path, planDir, flags: 'w' })
    assert.equal(opened.ok, false)
    assert.equal(await readFile(path, 'utf8'), 'replacement must survive')
  } finally { mocked.mock.restore(); syncBuiltinESMExports() }
})
