import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../server.mjs'

test('tts without a key is 503 and /.env is not served', async () => {
  const running = await startServer({
    env: {
      MINIMAX_API_KEY: '',
      MINIMAX_CLONE_AUDIO: '',
      DSH_CN_VISION_DIR: '/no/such/vision',
      HOST: '127.0.0.1',
    },
    host: '127.0.0.1',
    port: 0,
  })
  try {
    const tts = await fetch(`${running.url}api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    })
    const body = await tts.text()
    assert.equal(tts.status, 503)
    assert.match(body, /MINIMAX_API_KEY/)
    assert.equal(body.includes('super-secret'), false)
    const envFile = await fetch(`${running.url}.env`)
    assert.equal(envFile.status, 404)
  } finally {
    await running.close()
  }
})

test('a failing speech.py does not put stderr in the HTTP body', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-http-py-'))
  const script = join(dir, 'speech.py')
  await writeFile(script, 'import sys\nsys.stderr.write("MINIMAX_API_KEY=super-secret\\n")\nraise SystemExit(1)\n')
  const running = await startServer({
    env: {
      MINIMAX_API_KEY: '',
      MINIMAX_CLONE_AUDIO: '',
      DSH_CN_VISION_DIR: dir,
      HOST: '127.0.0.1',
    },
    host: '127.0.0.1',
    port: 0,
  })
  try {
    const tts = await fetch(`${running.url}api/tts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Hello' }),
    })
    const body = await tts.text()
    assert.equal(tts.status, 502)
    assert.equal(body.includes('super-secret'), false)
    assert.match(body, /英文配音失败/)
  } finally {
    await running.close()
    await rm(dir, { recursive: true, force: true })
  }
})
