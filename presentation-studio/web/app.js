import {
  commitPartial,
  createSession,
  englishCaption,
  ingest,
  mandarinCaption,
  readRecognitionResults,
  setClauseEnglish,
  setProvisional,
} from '/lib/session.mjs'

const SAMPLE = '各位好，我是林中岳。今天演示同声传译。我说中文，英文会同时出来，然后我们录像。'

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

const trace = []
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
let audioCtx = null
let recordDest = null
let recorder = null
let chunks = []
let recording = false
let speakChain = Promise.resolve()

window.__trace = trace
window.__studio = {
  feed,
  sample: SAMPLE,
  caption: () => ({ mandarin: mandarinCaption(state), english: englishCaption(state) }),
  revealed: () => revealedCount,
}

function mark(kind, extra = {}) {
  trace.push({ kind, t: performance.now(), revealed: revealedCount, ...extra })
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

function resetSession() {
  generation += 1
  window.clearTimeout(silenceTimer)
  window.clearTimeout(provisionalTimer)
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

async function requestTranslation(text) {
  mark('interpret-start', { source: text })
  if (window.__translator) {
    const english = String(await window.__translator.translate(text)).trim()
    mark('interpret-done', { source: text, english })
    return english
  }
  const response = await fetch('/api/interpret', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(12000),
  })
  const english = (await response.text()).trim()
  if (!response.ok) throw new Error(english || 'Translation failed')
  mark('interpret-done', { source: text, english })
  return english
}

async function translateProvisional(source, token) {
  try {
    const english = await requestTranslation(source)
    if (token !== provisionalToken) return
    if (setProvisional(state, source, english)) render()
  } catch (error) {
    setStatus(error.message)
  }
}

async function translateClause(clause, gen) {
  try {
    if (!clause.english) {
      const english = await requestTranslation(clause.source)
      if (gen !== generation) return
      setClauseEnglish(state, clause.id, english)
      render()
    }
    enqueueSpeak(clause, gen)
  } catch (error) {
    setStatus(error.message)
  }
}

function enqueueSpeak(clause, gen) {
  speakChain = speakChain
    .then(() => speakClause(clause, gen))
    .catch((error) => setStatus(error.message))
}

async function speakClause(clause, gen) {
  if (gen !== generation || clause.spoken || !clause.english) return
  const response = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clause.english }),
    signal: AbortSignal.timeout(15000),
  })
  if (response.ok) {
    const bytes = await response.arrayBuffer()
    await playBuffer(bytes)
    clause.spoken = true
    mark('spoken', { english: clause.english })
    setStatus('英文正在播出。')
    return
  }
  await speakWithSynthesis(clause.english)
  clause.spoken = true
  mark('spoken-browser', { english: clause.english })
  setStatus('浏览器在朗读英文。这段声音不会混进录像，除非本机 espeak-ng 或 OPENAI_API_KEY 可用。')
}

function playBuffer(bytes) {
  const ctx = audio()
  return ctx.decodeAudioData(bytes.slice(0)).then((buffer) => new Promise((resolve) => {
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(ctx.destination)
    if (recordDest) source.connect(recordDest)
    source.onended = () => resolve()
    source.start()
  }))
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
    setStatus(`语音识别：${event.error}`)
  }
  recognition.onend = () => {
    if (!listening) return
    try { recognition.start() } catch { /* Chrome restarts can overlap a live session. */ }
  }
  recognition.start()
  listening = true
  speakButton.setAttribute('aria-pressed', 'true')
  speakButton.textContent = '停止聆听'
  setStatus('正在听中文。英文会在你还在说的时候出现。')
  mark('listen-start')
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
    const committed = commitPartial(state)
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

async function startRecording() {
  audio()
  await ensureCamera()
  const ctx = audio()
  recordDest = ctx.createMediaStreamDestination()
  if (duckInput.checked) {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
      const source = ctx.createMediaStreamSource(micStream)
      const gain = ctx.createGain()
      gain.gain.value = 0.22
      source.connect(gain).connect(recordDest)
    } catch {
      setStatus('原声没有进入录像，将保留英文字幕和英文配音。')
    }
  }
  const canvasStream = stage.captureStream(30)
  const audioTrack = recordDest.stream.getAudioTracks()[0]
  if (audioTrack) canvasStream.addTrack(audioTrack)
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')
    ? 'video/webm;codecs=vp8,opus'
    : 'video/webm'
  chunks = []
  recorder = new MediaRecorder(canvasStream, { mimeType: mime })
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data)
  }
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' })
    window.__lastRecording = blob
    const url = URL.createObjectURL(blob)
    playback.src = url
    download.href = url
    after.hidden = false
    mark('record-stop', { bytes: blob.size })
    setStatus(`录像已保存，${Math.round(blob.size / 1024)} KB。`)
  }
  recorder.start(200)
  recording = true
  recordButton.classList.add('is-recording')
  recordButton.textContent = '停止并保存'
  recordFlag.hidden = false
  mark('record-start')
  setStatus('正在录像。英文会写进字幕，并在可以合成语音时混进声音。')
}

function stopRecording() {
  recording = false
  recordButton.classList.remove('is-recording')
  recordButton.textContent = '开始录像'
  recordFlag.hidden = true
  if (recorder && recorder.state !== 'inactive') recorder.stop()
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop())
    micStream = null
  }
  recordDest = null
}

recordButton.addEventListener('click', async () => {
  if (recording) {
    stopRecording()
    return
  }
  try {
    await startRecording()
  } catch (error) {
    setStatus(error.message)
  }
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
  const tail = commitPartial(state)
  render()
  for (const clause of tail) void translateClause(clause, generation)
  rehearsing = false
  rehearseButton.setAttribute('aria-pressed', 'false')
  mark('rehearsal-done')
})

function providerCopy(config) {
  const translation = {
    deepseek: '翻译走 DeepSeek（使用你的 DEEPSEEK_API_KEY）',
    openai: '翻译走 OpenAI（使用你的 OPENAI_API_KEY）',
    libretranslate: '翻译走 LibreTranslate',
    mymemory: '翻译走公开的 MyMemory，说的话会离开这台机器',
    off: '服务器翻译已关闭',
  }[config.translationProvider] || `翻译：${config.translationProvider}`
  const speech = {
    espeak: '英文语音由本机 espeak-ng 合成，可以混进录像',
    openai: '英文语音走 OpenAI，可以混进录像',
    browser: '英文语音由浏览器朗读，不会混进录像',
  }[config.ttsProvider] || `语音：${config.ttsProvider}`
  return `${translation}。${speech}。`
}

async function prepareTranslator() {
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

const config = await fetch('/api/config').then((response) => response.json())
providersEl.textContent = providerCopy(config)
render()
draw()
void prepareTranslator()
