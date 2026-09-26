import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildT2aBody, readMinimaxAudio, synthesizeSpeech, MINIMAX_DEFAULT_VOICE } from '../lib/tts.mjs'

function toneWav() {
  const rate = 8000
  const count = 1600
  const data = Buffer.alloc(count * 2)
  for (let i = 0; i < count; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2)
  }
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

test('T2A uses the speak-tool default voice and keeps the key out of the body', () => {
  const body = buildT2aBody('Hello', MINIMAX_DEFAULT_VOICE, {})
  assert.equal(body.voice_setting.voice_id, 'female-shaonv')
  assert.equal(body.model, 'speech-2.8-hd')
  assert.equal(body.stream, true)
  assert.equal(body.audio_setting.format, 'pcm')
  assert.equal(body.audio_setting.bitrate, undefined)
  assert.equal(body.output_format, 'hex')
  assert.equal(body.stream_options.exclude_aggregated_audio, true)
  assert.equal(JSON.stringify(body).includes('MINIMAX'), false)
})

test('hex audio from MiniMax becomes wav bytes', () => {
  const wav = toneWav()
  const decoded = readMinimaxAudio({ base_resp: { status_code: 0 }, data: { audio: wav.toString('hex') } })
  assert.equal(decoded.subarray(0, 4).toString(), 'RIFF')
  assert.throws(() => readMinimaxAudio({ base_resp: { status_code: 1004, status_msg: 'bad key' } }), /bad key/)
  assert.throws(() => readMinimaxAudio({ base_resp: { status_code: 0 }, data: { audio: Buffer.from('not-a-wav').toString('hex') } }), /not wav or mp3/)
})

test('HTTP speech posts t2a_v2 with the bearer key and female-shaonv', async () => {
  const wav = toneWav()
  let seen
  const fetchImpl = async (url, options) => {
    seen = { url: String(url), options }
    return new Response(JSON.stringify({
      base_resp: { status_code: 0 },
      data: { audio: wav.toString('hex') },
    }), { status: 200 })
  }
  const audio = await synthesizeSpeech('Hello everyone', {
    MINIMAX_API_KEY: 'mm-test',
    MINIMAX_API_HOST: 'https://api.minimaxi.com',
    DSH_CN_VISION_DIR: '/no/such/vision',
  }, { fetchImpl, existsSync: () => false })
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF')
  assert.equal(seen.url, 'https://api.minimaxi.com/v1/t2a_v2')
  assert.equal(seen.options.headers.authorization, 'Bearer mm-test')
  assert.equal(JSON.parse(seen.options.body).voice_setting.voice_id, 'female-shaonv')
})

test('a clone sample is uploaded once, then speech uses that voice id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-clone-'))
  const sample = join(dir, 'me.wav')
  const wav = toneWav()
  await writeFile(sample, wav)
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith('/v1/files/upload')) {
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, file: { file_id: 'file-1' } }), { status: 200 })
    }
    if (String(url).endsWith('/v1/voice_clone')) {
      return new Response(JSON.stringify({ base_resp: { status_code: 0 }, demo_audio: 'ok' }), { status: 200 })
    }
    return new Response(JSON.stringify({
      base_resp: { status_code: 0 },
      data: { audio: wav.toString('hex') },
    }), { status: 200 })
  }
  const env = {
    MINIMAX_API_KEY: 'mm-test',
    MINIMAX_API_HOST: 'https://api.minimaxi.com',
    MINIMAX_VOICE_ID: 'LinEnglish01',
    MINIMAX_CLONE_AUDIO: sample,
    DSH_CN_VISION_DIR: '/no/such/vision',
  }
  await synthesizeSpeech('Hello', env, { fetchImpl, existsSync: () => false })
  await synthesizeSpeech('Again', env, { fetchImpl, existsSync: () => false })
  const paths = calls.map((call) => new URL(call.url).pathname)
  assert.deepEqual(paths, ['/v1/files/upload', '/v1/voice_clone', '/v1/t2a_v2', '/v1/t2a_v2'])
  const clone = JSON.parse(calls[1].options.body)
  assert.equal(clone.voice_id, 'LinEnglish01')
  assert.equal(clone.file_id, 'file-1')
  assert.equal(JSON.parse(calls[3].options.body).voice_setting.voice_id, 'LinEnglish01')
  await rm(dir, { recursive: true, force: true })
})

test('installed speech.py speaks with --voice and never receives MiMo --clone', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-speechpy-'))
  const script = join(dir, 'speech.py')
  const wav = toneWav()
  const fixture = join(dir, 'tone.wav')
  await writeFile(fixture, wav)
  await writeFile(script, `import sys\nargv = sys.argv\nassert argv[1] == 'speak'\nassert '--provider' in argv and argv[argv.index('--provider') + 1] == 'minimax'\nassert argv[argv.index('--voice') + 1] == 'LinEnglish01'\nassert '--clone' not in argv\nsys.stdout.write('x' * 100000)\nsys.stdout.flush()\nout = argv[argv.index('--out') + 1]\nopen(out, 'wb').write(open(${JSON.stringify(fixture)}, 'rb').read())\n`)
  const audio = await synthesizeSpeech('Hello', {
    DSH_CN_VISION_DIR: dir,
    MINIMAX_VOICE_ID: 'LinEnglish01',
    MINIMAX_CLONE_AUDIO: fixture,
  }, { existsSync: (path) => path === script })
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF')
  await rm(dir, { recursive: true, force: true })
})

test('a missing key does not call fetch and is a 503', async () => {
  let called = false
  await assert.rejects(
    () => synthesizeSpeech('Hello', {
      MINIMAX_API_KEY: '',
      DSH_CN_VISION_DIR: '/no/such/vision',
    }, {
      fetchImpl: () => { called = true },
      existsSync: () => false,
    }),
    (error) => error.status === 503 && !/super-secret/.test(error.message),
  )
  assert.equal(called, false)
})

test('MiniMax status_msg is the error, not the missing-key message', async () => {
  await assert.rejects(
    () => synthesizeSpeech('Hello', {
      MINIMAX_API_KEY: 'mm-test',
      MINIMAX_API_HOST: 'https://api.minimaxi.com',
      DSH_CN_VISION_DIR: '/no/such/vision',
    }, {
      existsSync: () => false,
      fetchImpl: async () => new Response(JSON.stringify({
        base_resp: { status_code: 1008, status_msg: 'quota exceeded' },
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    }),
    (error) => /quota exceeded/.test(error.publicMessage) && !/MINIMAX_API_KEY/.test(error.publicMessage),
  )
})

test('a key uses HTTP even when speech.py is installed', async () => {
  const wav = toneWav()
  let fetched = false
  const audio = await synthesizeSpeech('Hello', {
    MINIMAX_API_KEY: 'mm-test',
    MINIMAX_API_HOST: 'https://api.minimaxi.com',
    DSH_CN_VISION_DIR: '/tmp/has-speech',
  }, {
    existsSync: () => true,
    fetchImpl: async () => {
      fetched = true
      return new Response(JSON.stringify({
        base_resp: { status_code: 0 },
        data: { audio: wav.toString('hex') },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  assert.equal(fetched, true)
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF')
})

test('an existing clone id still speaks, and the sample keeps its type', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-clone-dup-'))
  const sample = join(dir, 'me.mp3')
  await writeFile(sample, Buffer.from('ID3fake'))
  const calls = []
  const wav = toneWav()
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith('/v1/files/upload')) {
      const file = options.body.get('file')
      assert.equal(file.name, 'me.mp3')
      assert.equal(file.type, 'audio/mpeg')
      return new Response('{"base_resp":{"status_code":0,"status_msg":"success"},"file":{"file_id":9007199254740993}}', { status: 200 })
    }
    if (String(url).endsWith('/v1/voice_clone')) {
      assert.match(options.body, /9007199254740993/)
      return new Response(JSON.stringify({
        base_resp: { status_code: 2013, status_msg: 'voice id already exists' },
      }), { status: 200 })
    }
    return new Response(JSON.stringify({
      base_resp: { status_code: 0 },
      data: { audio: wav.toString('hex') },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const env = {
    MINIMAX_API_KEY: 'mm-test',
    MINIMAX_API_HOST: 'https://api.minimaxi.com',
    MINIMAX_VOICE_ID: 'LinEnglishDup',
    MINIMAX_CLONE_AUDIO: sample,
    DSH_CN_VISION_DIR: '/no/such/vision',
  }
  const audio = await synthesizeSpeech('Hello', env, { fetchImpl, existsSync: () => false })
  assert.equal(audio.subarray(0, 4).toString(), 'RIFF')
  const paths = calls.map((call) => new URL(call.url).pathname)
  assert.deepEqual(paths, ['/v1/files/upload', '/v1/voice_clone', '/v1/t2a_v2'])
  await rm(dir, { recursive: true, force: true })
})

test('speech.py exit does not call t2a and hides stderr', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-speechpy-fail-'))
  const script = join(dir, 'speech.py')
  await writeFile(script, 'import sys\nsys.stderr.write("MINIMAX_API_KEY=super-secret\\n")\nraise SystemExit(1)\n')
  let fetched = false
  await assert.rejects(
    () => synthesizeSpeech('Hello', {
      DSH_CN_VISION_DIR: dir,
      MINIMAX_API_KEY: '',
    }, {
      existsSync: (path) => path === script,
      fetchImpl: () => { fetched = true },
    }),
    (error) => error.status === 502 && !/super-secret/.test(error.message) && !/super-secret/.test(error.publicMessage || ''),
  )
  assert.equal(fetched, false)
  await rm(dir, { recursive: true, force: true })
})
