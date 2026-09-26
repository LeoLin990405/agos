import {
  commitPartial,
  createSession,
  englishCaption,
  ingest,
  isFillerOnly,
  isHold,
  isSpeakableEnglish,
  mandarinCaption,
  normalizeMandarin,
  readRecognitionResults,
  setClauseEnglish,
  setProvisional,
} from '/lib/session.mjs'

const SAMPLE = '各位好，我是林中岳。今天演示同声传译。我说中文，英文会同时出来，然后我们录像。'
const FLUSH_MS = 12000
const MIC_ERRORS = {
  'not-allowed': '麦克风被拒绝。在 Chrome 地址栏允许麦克风，或用本机 http://127.0.0.1 打开。也可以点「排练一句」。',
  'service-not-allowed': '浏览器禁止了语音识别。请用 Chrome，并允许麦克风。也可以点「排练一句」。',
  'audio-capture': '没有可用的麦克风。检查系统输入设备，或点「排练一句」。',
  network: '语音识别连不上。检查网络，或点「排练一句」。',
}

const speakButton = document.querySelector('#speak')
const cameraButton = document.querySelector('#camera-btn')
const recordButton = document.querySelector('#record')
const rehearseButton = document.querySelector('#rehearse')
const duckInput = document.querySelector('#duck')
const stage = document.querySelector('#stage')
const camera = document.querySelector('#camera')
const mandarinEl = document.querySelector('#mandarin')
const englishEl = document.querySelector('#english')
const statusEl = document.querySelector('#status')
const providersEl = document.querySelector('#providers')
const recordFlag = document.querySelector('#record-flag')
const after = document.querySelector('#after')
const playback = document.querySelector('#playback')
const download = document.querySelector('#download')
const recordGuard = document.querySelector('#record-guard')
const recordAnyway = document.querySelector('#record-anyway')
const recordCancel = document.querySelector('#record-cancel')

const trace = []
const translationJobs = new Map()
const ttsJobs = new Map()
const activeSources = new Set()
let state = createSession()
let generation = 0
let listening = false
let rehearsing = false
let revealedCount = 0
let recognition = null
let silenceTimer = 0
let provisionalTimer = 0
let provisionalToken = 0
let cameraStream = null
let micStream = null
let micForTake = null
let audioCtx = null
let recordDest = null
let recording = false
let starting = false
let takeId = 0
let activeTake = null
let playbackChain = Promise.resolve()
let config = {
  translationProvider: 'mymemory',
  minimaxVoice: 'female-shaonv',
  minimaxKey: false,
}

window.__trace = trace
window.__takes = []
window.__studio = {
  feed,
  sample: SAMPLE,
  caption: () => ({ mandarin: mandarinCaption(state), english: englishCaption(state) }),
  revealed: () => revealedCount,
  generation: () => generation,
}

function mark(kind, extra = {}) {
  trace.push({ kind, t: performance.now(), revealed: revealedCount, gen: generation, ...extra })
}

function setStatus(text) {
  statusEl.textContent = text
}

function audio() {
  if (!audioCtx) audioCtx = new AudioContext()
  if (audioCtx.state === 'suspended') void audioCtx.resume()
  return audioCtx
}

function render() {
  const mandarin = mandarinCaption(state)
  const english = englishCaption(state)
  mandarinEl.textContent = mandarin || '等待开口。'
  englishEl.textContent = english || 'English will appear while you are still speaking.'
  stage.dataset.mandarin = mandarin
  stage.dataset.english = english
}

function abortSpeech() {
  for (const job of ttsJobs.values()) {
    try { job.ctrl.abort() } catch { /* already finished */ }
  }
  ttsJobs.clear()
  for (const source of activeSources) {
    try { source.stop() } catch { /* already stopped */ }
  }
  activeSources.clear()
  playbackChain = Promise.resolve()
}

function resetSession() {
  generation += 1
  window.clearTimeout(silenceTimer)
  window.clearTimeout(provisionalTimer)
  abortSpeech()
  translationJobs.clear()
  state = createSession()
  render()
}

function feed(update) {
  const { stable, provisionalSource } = ingest(state, update)
  render()
  for (const clause of stable) void translateClause(clause, generation)
  scheduleProvisional(provisionalSource, generation)
  armSilence(generation)
}

function armSilence(gen) {
  window.clearTimeout(silenceTimer)
  if (!state.partial) return
  silenceTimer = window.setTimeout(() => {
    if (gen !== generation) return
    const committed = commitPartial(state)
    render()
    for (const clause of committed) void translateClause(clause, generation)
  }, 700)
}

function scheduleProvisional(source, gen) {
  window.clearTimeout(provisionalTimer)
  if (!source || [...source].length < 2) return
  const token = ++provisionalToken
  provisionalTimer = window.setTimeout(() => {
    if (gen !== generation) return
    void translateProvisional(source, token)
  }, 220)
}

function stripQuotes(text) {
  const value = String(text || '').trim()
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('“') && value.endsWith('”')))) {
    return value.slice(1, -1).trim()
  }
  return value
}

function previousClause(clause) {
  const index = state.clauses.findIndex((item) => item.id === clause.id)
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!state.clauses[i].provisional) return state.clauses[i]
  }
  return null
}

function contextFor(clause) {
  const prev = clause.context || previousClause(clause)
  if (!prev?.source) return undefined
  const fragment = Boolean(clause.context?.fragment) || isHold(clause.source)
  if (config.translationProvider === 'mymemory' && !fragment) return undefined
  return {
    source: prev.source,
    english: prev.english || '',
    spoken: Boolean(prev.spoken),
    fragment,
  }
}

async function fetchTranslation(text, context, onDelta) {
  mark('interpret-start', { source: text })
  if (window.__translator && config.translationProvider === 'mymemory') {
    const english = stripQuotes(String(await window.__translator.translate(text)).trim())
    onDelta?.(english)
    mark('interpret-done', { source: text, english })
    return english
  }
  const response = await fetch('/api/interpret', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, previous: context }),
    signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) {
    const message = (await response.text()).trim()
    if (response.status >= 500 && window.__translator) {
      const english = stripQuotes(String(await window.__translator.translate(text)).trim())
      mark('interpret-done', { source: text, english })
      return english
    }
    throw new Error(message || 'Translation failed')
  }
  const reader = response.body?.getReader?.()
  if (!reader) {
    const english = stripQuotes((await response.text()).trim())
    onDelta?.(english)
    mark('interpret-done', { source: text, english })
    return english
  }
  const decoder = new TextDecoder()
  let english = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    english += decoder.decode(value, { stream: true })
    onDelta?.(english.trim())
  }
  english = stripQuotes(english.trim())
  mark('interpret-done', { source: text, english })
  return english
}

function requestTranslation(text, context, onDelta) {
  const key = `${context?.source || ''}|${context?.fragment ? 1 : 0}|${text}`
  const existing = translationJobs.get(key)
  if (existing) return existing
  const job = fetchTranslation(text, context, onDelta).catch((error) => {
    translationJobs.delete(key)
    throw error
  })
  translationJobs.set(key, job)
  return job
}

async function translateProvisional(source, token) {
  if (isFillerOnly(source) || isHold(source)) return
  try {
    const english = await requestTranslation(normalizeMandarin(source), undefined, (partial) => {
      if (token !== provisionalToken) return
      if (setProvisional(state, source, partial)) render()
    })
    if (token !== provisionalToken) return
    if (setProvisional(state, source, english)) render()
  } catch (error) {
    setStatus(error.message)
  }
}

async function translateClause(clause, gen) {
  const source = clause.source
  if (isFillerOnly(source)) {
    clause.skipped = true
    return
  }
  try {
    if (!clause.english) {
      const english = await requestTranslation(normalizeMandarin(source), contextFor(clause), (partial) => {
        if (gen !== generation || clause.source !== source) return
        setClauseEnglish(state, clause.id, partial)
        render()
      })
      if (gen !== generation || clause.source !== source) return
      setClauseEnglish(state, clause.id, english)
      render()
      if (!english || !isSpeakableEnglish(english)) {
        clause.skipped = true
        setStatus('这句英文不可用，已跳过配音。')
        return
      }
    } else if (!isSpeakableEnglish(clause.english)) {
      clause.skipped = true
      setStatus('这句英文不可用，已跳过配音。')
      return
    }
    enqueueSpeak(clause, gen)
  } catch (error) {
    setStatus(error.message)
  }
}

function enqueueSpeak(clause, gen) {
  if (gen !== generation || clause.spoken || clause.skipped || !clause.english) return
  if (!isSpeakableEnglish(clause.english)) {
    clause.skipped = true
    setStatus('这句英文不可用，已跳过配音。')
    return
  }
  const source = clause.source
  const english = clause.english
  const token = `${clause.id}:${source}:${english}`
  if (!ttsJobs.has(token)) ttsJobs.set(token, prefetchTts(clause, gen, english))
  playbackChain = playbackChain
    .then(() => playPrefetched(clause, gen, token, source, english))
    .catch((error) => setStatus(error.message || '英文配音失败'))
}

function prefetchTts(clause, gen, english) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 45000)
  mark('tts-start', { english, gen })
  const promise = fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: english }),
    signal: ctrl.signal,
  }).then(async (response) => {
    clearTimeout(timer)
    if (gen !== generation) return { dropped: true }
    if (!response.ok) {
      const message = (await response.text()).trim()
      return { ok: false, status: response.status, message }
    }
    if ((response.headers.get('x-audio-format') || '') === 'pcm') return { ok: true, pcm: response }
    const bytes = await response.arrayBuffer()
    if (gen !== generation) return { dropped: true }
    try {
      const buffer = await audio().decodeAudioData(bytes.slice(0))
      return { ok: true, buffer }
    } catch {
      return { ok: false, status: 200, message: '英文配音失败', decode: true }
    }
  }).catch((error) => {
    clearTimeout(timer)
    if (error?.name === 'AbortError') return { dropped: true }
    return { ok: false, status: 0, message: '英文配音失败' }
  })
  return { promise, ctrl, gen }
}

async function playPrefetched(clause, gen, token, source, english) {
  const job = ttsJobs.get(token)
  if (!job) return
  const result = await job.promise
  if (gen !== generation || result?.dropped || clause.spoken) return
  if (clause.source !== source || clause.english !== english) return
  if (!result?.ok) {
    if (result?.status === 503) {
      await speakWithSynthesis(english)
      if (gen !== generation) return
      clause.spoken = true
      mark('spoken-browser', { english, gen })
      setStatus('浏览器在朗读英文。这段声音不会混进录像。要混进成片，设置 MINIMAX_API_KEY。')
      return
    }
    if (!clause.ttsRetried) {
      clause.ttsRetried = true
      ttsJobs.delete(token)
      enqueueSpeak(clause, gen)
      return
    }
    const message = result?.message || ''
    setStatus(message.startsWith('英文配音失败') ? message : '英文配音失败')
    return
  }
  if (gen !== generation) return
  if (result.buffer) await playDecoded(result.buffer, clause, gen, recordDest, true)
  else if (result.pcm) await playPcm(result.pcm, clause, gen)
  if (gen !== generation) return
  clause.spoken = true
  mark('spoken', { english, gen })
  setStatus('英文正在播出。')
}

function playDecoded(buffer, clause, gen, dest, speakers) {
  return new Promise((resolve) => {
    if (gen !== generation) {
      resolve()
      return
    }
    const ctx = audio()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    if (speakers) source.connect(ctx.destination)
    if (dest) {
      source.connect(dest)
      if (clause) clause.mixedTake = takeId
    }
    if (clause) clause.audio = buffer
    activeSources.add(source)
    const timer = setTimeout(() => {
      try { source.stop() } catch { /* already ended */ }
      activeSources.delete(source)
      resolve()
    }, (buffer.duration + 1.5) * 1000)
    source.onended = () => {
      clearTimeout(timer)
      activeSources.delete(source)
      resolve()
    }
    source.start()
  })
}

async function playPcm(response, clause, gen) {
  const reader = response.body?.getReader?.()
  if (!reader) return
  const ctx = audio()
  const dest = recordDest
  const rate = Number(response.headers.get('x-sample-rate') || 32000)
  let nextTime = ctx.currentTime
  let leftover = new Uint8Array(0)
  const samples = []
  const schedule = (bytes) => {
    if (gen !== generation || bytes.length < 2) return
    const count = bytes.length / 2
    const buffer = ctx.createBuffer(1, count, rate)
    const channel = buffer.getChannelData(0)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    for (let i = 0; i < count; i += 1) {
      const sample = view.getInt16(i * 2, true) / 32768
      channel[i] = sample
      samples.push(sample)
    }
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    if (dest) source.connect(dest)
    activeSources.add(source)
    const startAt = Math.max(nextTime, ctx.currentTime + 0.02)
    source.start(startAt)
    nextTime = startAt + buffer.duration
    source.onended = () => activeSources.delete(source)
  }
  while (true) {
    const { value, done } = await reader.read()
    if (gen !== generation) {
      try { await reader.cancel() } catch { /* closed */ }
      break
    }
    if (done) break
    const merged = new Uint8Array(leftover.length + value.length)
    merged.set(leftover, 0)
    merged.set(value, leftover.length)
    const even = merged.length - (merged.length % 2)
    if (even >= 2) schedule(merged.slice(0, even))
    leftover = merged.slice(even)
  }
  if (clause && samples.length) {
    const buffer = ctx.createBuffer(1, samples.length, rate)
    buffer.getChannelData(0).set(samples)
    clause.audio = buffer
    if (dest) clause.mixedTake = takeId
  }
  const waitMs = Math.max(0, (nextTime - ctx.currentTime) * 1000)
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs + 40))
}

function speakWithSynthesis(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve()
      return
    }
    const utter = new SpeechSynthesisUtterance(text)
    utter.lang = 'en-US'
    utter.onend = () => resolve()
    utter.onerror = () => resolve()
    window.speechSynthesis.speak(utter)
  })
}

async function ensureMic() {
  if (micStream && micStream.getAudioTracks().some((track) => track.readyState === 'live')) return micStream
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
  return micStream
}

function startMic() {
  const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!Ctor) {
    setStatus('这个浏览器没有语音识别。请用 Chrome 说中文，或先点「排练一句」。')
    return
  }
  audio()
  recognition = new Ctor()
  recognition.lang = 'zh-CN'
  recognition.continuous = true
  recognition.interimResults = true
  recognition.onresult = (event) => {
    feed(readRecognitionResults(event.results, event.resultIndex))
  }
  recognition.onerror = (event) => {
    if (event.error === 'aborted' || event.error === 'no-speech') return
    listening = false
    speakButton.setAttribute('aria-pressed', 'false')
    speakButton.textContent = '开始说中文'
    setStatus(MIC_ERRORS[event.error] || `语音识别：${event.error}`)
  }
  recognition.onend = () => {
    if (!listening) return
    try { recognition.start() } catch { /* Chrome restarts can overlap a live session. */ }
  }
  try {
    recognition.start()
  } catch (error) {
    setStatus(MIC_ERRORS[error?.error] || MIC_ERRORS['not-allowed'])
    return
  }
  listening = true
  speakButton.setAttribute('aria-pressed', 'true')
  speakButton.textContent = '停止聆听'
  setStatus('正在听中文。英文会在你还在说的时候出现。')
  mark('listen-start')
  void ensureMic().catch((error) => {
    if (!listening) return
    setStatus(error?.name === 'NotAllowedError' ? MIC_ERRORS['not-allowed'] : MIC_ERRORS['audio-capture'])
  })
}

function stopMic() {
  listening = false
  speakButton.setAttribute('aria-pressed', 'false')
  speakButton.textContent = '开始说中文'
  if (recognition) recognition.onend = null
  try { recognition?.stop() } catch { /* already stopped */ }
  recognition = null
}

speakButton.addEventListener('click', () => {
  audio()
  if (listening) {
    stopMic()
    const committed = commitPartial(state, { force: true })
    for (const clause of committed) void translateClause(clause, generation)
    setStatus('已停止聆听。')
    return
  }
  rehearsing = false
  startMic()
})

async function ensureCamera() {
  if (cameraStream) return true
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('这个浏览器不能打开相机。录像会使用演播画面。')
    return false
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    })
    camera.srcObject = cameraStream
    await camera.play()
    cameraButton.textContent = '关闭相机'
    cameraButton.setAttribute('aria-pressed', 'true')
    return true
  } catch {
    setStatus('相机不可用。录像会使用演播画面、英文字幕和英文配音。')
    return false
  }
}

cameraButton.addEventListener('click', async () => {
  if (recording) return
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop())
    cameraStream = null
    camera.srcObject = null
    cameraButton.textContent = '打开相机'
    cameraButton.setAttribute('aria-pressed', 'false')
    return
  }
  await ensureCamera()
})

function drawCover(ctx, video, width, height) {
  const vw = video.videoWidth || width
  const vh = video.videoHeight || height
  const scale = Math.max(width / vw, height / vh)
  const dw = vw * scale
  const dh = vh * scale
  ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh)
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  if (!text) return
  const units = text.includes(' ') ? text.split(' ') : [...text]
  let line = ''
  let cursor = y
  for (const unit of units) {
    const next = line ? `${line}${text.includes(' ') ? ' ' : ''}${unit}` : unit
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, cursor)
      line = unit
      cursor += lineHeight
    } else {
      line = next
    }
  }
  if (line) ctx.fillText(line, x, cursor)
}

function draw() {
  const ctx = stage.getContext('2d')
  const width = stage.width
  const height = stage.height
  ctx.fillStyle = '#14110e'
  ctx.fillRect(0, 0, width, height)
  if (camera.srcObject && camera.readyState >= 2) {
    drawCover(ctx, camera, width, height)
  } else {
    ctx.fillStyle = '#3b2c1d'
    ctx.beginPath()
    ctx.arc(width * 0.5, height * 0.38, 86, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f4efe6'
    ctx.textAlign = 'center'
    ctx.font = '32px serif'
    ctx.fillText('相机未打开', width / 2, height * 0.39)
  }
  ctx.fillStyle = 'rgba(12, 10, 8, 0.78)'
  ctx.fillRect(0, height - 168, width, 168)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#f7f1e6'
  ctx.font = '36px serif'
  wrapText(ctx, englishCaption(state) || 'English captions land here while you speak.', 48, height - 108, width - 96, 42)
  ctx.fillStyle = '#d9cbb8'
  ctx.font = '24px serif'
  wrapText(ctx, mandarinCaption(state), 48, height - 36, width - 96, 30)
  window.requestAnimationFrame(draw)
}

function readyToRecord() {
  return listening || rehearsing || Boolean(mandarinCaption(state) || englishCaption(state))
}

function showTake(blob) {
  window.__lastRecording = blob
  const url = URL.createObjectURL(blob)
  playback.src = url
  download.href = url
  after.hidden = false
  after.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  download.focus()
  mark('record-stop', { bytes: blob.size })
  setStatus(`录像已保存，${Math.round(blob.size / 1024)} KB。`)
}

function disconnectTake(take, { stopCanvas = false } = {}) {
  if (stopCanvas) take.canvasStream?.getTracks().forEach((track) => track.stop())
  if (micForTake) {
    micForTake.getTracks().forEach((track) => track.stop())
    if (micStream === micForTake && !listening) micStream = null
    micForTake = null
  }
  if (recordDest === take.dest) recordDest = null
  if (activeTake === take) activeTake = null
}

async function mixUnrecorded(dest, gen) {
  const clips = state.clauses.filter((clause) => clause.audio && clause.mixedTake == null)
  for (const clause of clips) {
    if (gen !== generation || !recording) return
    await playDecoded(clause.audio, clause, gen, dest, false)
  }
}

async function beginRecording() {
  const gen = generation
  try {
    audio()
    await ensureCamera()
    if (!starting) return
    const ctx = audio()
    const take = {
      chunks: [],
      dest: ctx.createMediaStreamDestination(),
      mime: '',
      recorder: null,
      canvasStream: null,
    }
    takeId += 1
    activeTake = take
    recordDest = take.dest
    let duckFailed = false
    if (duckInput.checked) {
      try {
        micForTake = await ensureMic()
        const source = ctx.createMediaStreamSource(micForTake)
        const gain = ctx.createGain()
        gain.gain.value = 0.22
        source.connect(gain).connect(take.dest)
      } catch {
        duckFailed = true
        setStatus('麦克风没有允许给录像。取消勾选「压低原声」，英文字幕和配音仍会留下。')
      }
    }
    take.canvasStream = stage.captureStream(30)
    const audioTrack = take.dest.stream.getAudioTracks()[0]
    if (audioTrack) take.canvasStream.addTrack(audioTrack)
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
      ? 'video/webm;codecs=vp8,opus'
      : 'video/webm'
    take.mime = mime
    try {
      take.recorder = new MediaRecorder(take.canvasStream, { mimeType: mime })
    } catch (error) {
      disconnectTake(take, { stopCanvas: true })
      recording = false
      throw error
    }
    take.recorder.ondataavailable = (event) => {
      if (event.data.size) take.chunks.push(event.data)
    }
    take.recorder.onstop = () => {
      take.canvasStream?.getTracks().forEach((track) => track.stop())
      const blob = new Blob(take.chunks, { type: take.mime || 'video/webm' })
      take.blob = blob
      window.__takes.push(blob)
      if (activeTake !== take && recording) return
      showTake(blob)
    }
    take.recorder.start(200)
    recording = true
    recordButton.classList.add('is-recording')
    recordButton.textContent = '停止并保存'
    recordFlag.hidden = false
    mark('record-start')
    playbackChain = playbackChain.then(() => mixUnrecorded(take.dest, gen))
    if (!duckFailed) setStatus('正在录像。英文会写进字幕，并在可以合成语音时混进声音。')
  } catch (error) {
    setStatus(error.message || '录像没有开始。')
  } finally {
    starting = false
  }
}

async function stopRecording() {
  const take = activeTake
  if (!take) return
  recording = false
  recordButton.classList.remove('is-recording')
  recordButton.textContent = '开始录像'
  recordFlag.hidden = true
  recordButton.disabled = true
  setStatus('正在把最后一句英文写入录像…')
  await Promise.race([
    playbackChain.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, FLUSH_MS)),
  ])
  if (take.recorder && take.recorder.state === 'recording') {
    try { take.recorder.requestData() } catch { /* already stopping */ }
    take.recorder.stop()
  }
  disconnectTake(take)
  recordButton.disabled = false
}

recordButton.addEventListener('click', () => {
  if (recording) {
    void stopRecording()
    return
  }
  if (starting || !recordGuard.hidden) return
  if (!readyToRecord()) {
    recordGuard.hidden = false
    return
  }
  starting = true
  void beginRecording()
})

recordAnyway.addEventListener('click', () => {
  recordGuard.hidden = true
  if (recording || starting) return
  starting = true
  void beginRecording()
})

recordCancel.addEventListener('click', () => {
  recordGuard.hidden = true
  setStatus('先说中文，或点「排练一句」。')
})

rehearseButton.addEventListener('click', async () => {
  if (rehearsing) return
  audio()
  stopMic()
  rehearsing = true
  revealedCount = 0
  resetSession()
  rehearseButton.setAttribute('aria-pressed', 'true')
  setStatus('正在排练。英文会在这句话说完之前出现。')
  for (let i = 1; i <= SAMPLE.length && rehearsing; i += 1) {
    revealedCount = i
    feed({ partial: SAMPLE.slice(0, i) })
    await new Promise((resolve) => window.setTimeout(resolve, 70))
  }
  rehearseButton.setAttribute('aria-pressed', 'false')
  if (!rehearsing) return
  const tail = commitPartial(state, { force: true })
  render()
  for (const clause of tail) void translateClause(clause, generation)
  rehearsing = false
  mark('rehearsal-done')
})

function providerCopy(next) {
  const translation = {
    deepseek: '翻译走 DeepSeek（使用你的 DEEPSEEK_API_KEY）',
    openai: '翻译走 OpenAI（使用你的 OPENAI_API_KEY）',
    libretranslate: '翻译走 LibreTranslate',
    mymemory: '翻译走公开的 MyMemory，说的话会离开这台机器',
    off: '服务器翻译已关闭',
  }[next.translationProvider] || `翻译：${next.translationProvider}`
  const voice = next.minimaxVoice || 'female-shaonv'
  const clone = next.minimaxClone ? '，并用 MINIMAX_CLONE_AUDIO 复刻你的声音' : ''
  const ready = next.minimaxKey || next.speechPy
    ? '可以混进录像'
    : '还没设置 MINIMAX_API_KEY，这路声音进不了录像'
  return `${translation}。英文语音走 MiniMax，音色 ${voice}${clone}。${ready}。`
}

async function prepareTranslator(next) {
  if (next.translationProvider !== 'mymemory') return
  if (typeof Translator === 'undefined' || !Translator.availability) return
  try {
    const availability = await Translator.availability({ sourceLanguage: 'zh', targetLanguage: 'en' })
    if (availability !== 'available') return
    window.__translator = await Translator.create({ sourceLanguage: 'zh', targetLanguage: 'en' })
    providersEl.textContent = `${providersEl.textContent} 本机 Chrome 翻译模型已优先使用。`
  } catch {
    // The server provider remains the path that actually runs.
  }
}

async function boot() {
  try {
    const response = await fetch('/api/config')
    if (!response.ok) throw new Error('config')
    config = await response.json()
    providersEl.textContent = providerCopy(config)
    void prepareTranslator(config)
  } catch {
    providersEl.textContent = '连不上工作室。在 presentation-studio 目录运行 node server.mjs，然后打开它打印的地址。'
    setStatus('翻译和 MiniMax 暂时不可用。可以先看页面，但排练需要服务器。')
  }
  render()
  draw()
}

void boot()
