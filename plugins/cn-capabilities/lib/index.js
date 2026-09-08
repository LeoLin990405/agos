// 国产模型能力插件(持久化):视觉 / 语音 / 生图 / 多模型委派 / ACP 委派。
// 由动态插件 eyes-1 / voic-7 / delg-4 / dkim-8 固化而来。
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { appendFile, mkdir, open as openFile, readdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, join, sep } from 'node:path'
import { formatCodexBarUsage, readCodexBarUsage } from './usage.mjs'
import { composeOptimizeAgentPrompt, composePlanAppendix } from '../../dsh-agos/lib/agent-prompts.js'
import { buildCouncilReviewRecord, councilReviewVerdict } from './council-record.js'
import { parseCouncilVerdict, evaluateCouncilStructure } from './council-parse.mjs'
import { PLAN_NAME, resolvePlanPath, openPlanFile } from './plan-path.mjs'
import { evaluatePlanApproval, planFingerprint } from './plan-approval.mjs'
import {
  createIsolatedAutoresearchWorkspace,
  measureIsolatedBaseline,
  runAutoresearchIteration,
  applyCandidatePatch,
  candidateSourceContext,
  saveAutoresearchArtifacts,
  disposeWorkspace,
} from './autoresearch-workspace.mjs'

const name = 'cn-capabilities'

function snapshotSessionEvents(session) {
  if (typeof session?.snapshotEvents !== 'function') return []
  const events = session.snapshotEvents()
  return Array.isArray(events) ? events : []
}

function ownSessionEvents(session) {
  if (typeof session?.ownEvents !== 'function') return []
  const events = session.ownEvents()
  return Array.isArray(events) ? events : []
}

// dsh-kimicode-swarm(swarm 调度器)**懒加载**,只有 plan_run 的执行阶段用得到。
// 不写成顶层静态 import:那会把本插件 21 个工具的加载绑在一个兄弟插件的可解析性上 ——
// 与文首 webServer 那条教训同类(附加能力不该是全体工具的启动前提)。
// 加载失败只让 plan_run 执行阶段报一条可读错误。两个插件经 node_modules 同一真实路径
// 解析 → 同一个模块实例 → 进度表 PROGRESS 与分派表 CURRENT_CONFIG 都是共享的。
let SWARM = null
const loadSwarm = async () => {
  if (SWARM === null) SWARM = await import('dsh-kimicode-swarm')
  return SWARM
}
// ⚠️ 这个 cordis 版本(4.0.1)的 inject **只认数组**,写成 { required, optional }
// 会被 Inject.resolve 的 Object.keys 分支当成两个服务名("waiting for services:
// required, optional")而永远 pending,插件直接不加载 —— 也就是说,**没有可选 inject**:
// 凡是列进来的都会 gate 住整个插件的激活。
//
// ⚠️ 2026-08-18 校正:webServer 曾经列在这里,理由写的是"web profile 里必然存在,
// 作硬依赖安全"。这个假设在 headless profile 下当场破产 ——
// `@dsh-local/cn-capabilities: pending (waiting for service: webServer)`,整个插件不加载,
// 21 个工具一个都没有。几条 HTTP 路由是附加品,不该是 21 个工具的启动前提。
//
// 当时不敢摘掉是因为记着"不声明 inject 的话 ctx.get 永远返回 undefined"。
// 那条观察本身没错,但归因错了:真因是**时序** —— apply() 跑的时候 webServer 还没被提供,
// 而不是 ctx.get 需要 inject 授权(cordis 的 get 明写着 "without the inject requirement")。
// 正确写法是 `ctx.inject([...], cb)`:服务到位才跑回调,服务消失自动清理 ——
// 这正是宿主自带插件(dsh-agent / dsh-agent-loop 等)的做法。
const inject = ['tools', 'systemPrompt']

const Config = z.object({})

const PY = '/usr/bin/python3'
// 本机默认从 homedir 推导,跨机器部署用环境变量覆盖(不再硬编码用户名路径)。
const VISION_DIR = process.env.DSH_CN_VISION_DIR || join(homedir(), 'Projects', 'dsh-vision')
const OPENCLI_BIN = process.env.DSH_CN_OPENCLI_BIN || join(homedir(), '.npm-global', 'bin', 'opencli')
const KIMI_BIN = process.env.DSH_CN_KIMI_BIN || join(homedir(), '.kimi-code', 'bin', 'kimi')

const uniqueOutputPath = (prefix, extension) => join(tmpdir(), prefix + '-' + randomUUID() + extension)

// ── W2(2026-08-21 多模态输出侧)────────────────────────────────────
// speak / generate_image 的产物从 tmpdir 迁到 ~/.dsh/attachments/cn-media:
// 前端新增的只读路由 /api/cn/media 三道闸的第一道就是「realpath 后必须在
// attachments 根之下」,产物只有落在这里才可播可下;顺带从临时文件变成
// 持久产物(与 cn-vision 的落盘约定一致)。render 返回格式一个字不变。
const MEDIA_DIR = join(homedir(), '.dsh', 'attachments', 'cn-media')
const freshMediaPath = async (prefix, extension) => {
  await mkdir(MEDIA_DIR, { recursive: true })
  return join(MEDIA_DIR, prefix + '-' + randomUUID() + extension)
}

// /api/cn/media 的路径闸(纯函数,node --test 直接测):
//   1) realpath 后必须在 attachments 根之下(挡 ../ 与软链绕行)
//   2) 扩展名白名单(图片 + 音频)
// 返回 { ok, real } —— ok=false 时 real 缺省;调用方据此回 400/403/404。
const MEDIA_ROOT = join(homedir(), '.dsh', 'attachments')
const MEDIA_EXT_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg', '.flac': 'audio/flac',
}
// 图片魔数表(模块级:saveImageAttachment 与 media 闸共用一张,别复制)。
// 只覆盖 store 实际会落盘的光栅格式;音频不嗅(object store 里没有音频)。
const IMAGE_MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
]
const MAGIC_BYTES = 12 // WEBP 判定要看到第 12 字节
const sniffMediaType = (buf) => {
  for (const [magic, type] of IMAGE_MAGIC) {
    if (magic.every((b, i) => buf[i] === b)) return type
  }
  // WEBP = "RIFF" .... "WEBP"
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp'
  return null
}

// W19(TASK-017 第三档):v1 object store 的内容寻址文件(~/.dsh/attachments/v1/objects/<hex[0:2]>/<sha256 hex>)
// 没有扩展名 → 旧闸一律 bad-ext → 归档会话里的图片块回放不了。
// 规则:只有「在 objects 子树下、文件名是裸 64 位 hex、父目录名 == hex[0:2]」才走魔数嗅探;
// objects 子树下任何**带点的**名字(<hex>.png、<hex>.txt.png、<hex>.png.txt)都不是 store 写的 → 拒,
// 不再落回扩展名白名单(否则「双扩展」只是复述白名单)。
const OBJECTS_SUBDIR = join('v1', 'objects')
const OBJECT_HEX_RE = /^[0-9a-f]{64}$/
const ATTACHMENT_ID_RE = /^sha256:([0-9a-f]{64})$/
function isObjectStorePath(real, rootReal) {
  const objectsReal = join(rootReal, OBJECTS_SUBDIR)
  if (!real.startsWith(objectsReal + sep)) return false
  const name = basename(real)
  return OBJECT_HEX_RE.test(name) && basename(dirname(real)) === name.slice(0, 2)
}
function isUnderObjects(real, rootReal) {
  return real.startsWith(join(rootReal, OBJECTS_SUBDIR) + sep)
}
/** attachmentId(`sha256:<hex>`)→ 根内 object 路径;用户输入永远不进文件系统路径的拼接。形状不对 → null。 */
function objectPathForAttachmentId(attachmentId, root) {
  const m = typeof attachmentId === 'string' ? ATTACHMENT_ID_RE.exec(attachmentId) : null
  if (m === null) return null
  return join(root, OBJECTS_SUBDIR, m[1].slice(0, 2), m[1])
}
/** 读头 MAGIC_BYTES 字节;目录(open 成功、read EISDIR)/无权限一律回 null。 */
async function readMagic(real) {
  let fh = null
  try {
    fh = await openFile(real, 'r')
    const buf = Buffer.alloc(MAGIC_BYTES)
    const { bytesRead } = await fh.read(buf, 0, MAGIC_BYTES, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    if (fh !== null) await fh.close().catch(() => {})
  }
}

/**
 * @param {string} requested 宿主机路径(或由 attachmentId 拼出的 object 路径)
 * @param {string} rootReal 附件根 realpath
 * @param {string|undefined} expectedMediaType 调用方声称的 mediaType:**只当期望值校验**,与嗅探/扩展名不等 → 拒;
 *   绝不替代嗅探成为 content-type 来源。
 */
async function resolveMediaPath(requested, rootReal, expectedMediaType) {
  if (typeof requested !== 'string' || requested.trim() === '') return { ok: false, reason: 'missing' }
  const real = await realpath(requested).catch(() => null)
  if (real === null) return { ok: false, reason: 'not-found' }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) return { ok: false, reason: 'outside-root' }
  const expected = typeof expectedMediaType === 'string' && expectedMediaType !== '' ? expectedMediaType.toLowerCase() : undefined
  if (isUnderObjects(real, rootReal)) {
    if (!isObjectStorePath(real, rootReal)) return { ok: false, reason: 'bad-object-name' }
    // 先 stat 再 open:FIFO/设备文件 open() 会挂住 libuv 线程池(对抗验证 2026-08-23)
    const info = await stat(real).catch(() => null)
    if (info === null || !info.isFile()) return { ok: false, reason: 'not-file' }
    const head = await readMagic(real)
    if (head === null) return { ok: false, reason: 'not-file' }
    const sniffed = sniffMediaType(head)
    if (sniffed === null) return { ok: false, reason: 'bad-magic' }
    if (expected !== undefined && expected !== sniffed) return { ok: false, reason: 'media-type-mismatch' }
    return { ok: true, real, mime: sniffed }
  }
  const mime = MEDIA_EXT_MIME[extname(real).toLowerCase()]
  if (mime === undefined) return { ok: false, reason: 'bad-ext' }
  if (expected !== undefined && expected !== mime) return { ok: false, reason: 'media-type-mismatch' }
  return { ok: true, real, mime }
}

function compileProperties(properties) {
  const compiled = {}
  const required = []
  for (const [key, spec] of Object.entries(properties || {})) {
    if (spec.required === true) required.push(key)
    compiled[key] = compileValueSchema(spec)
  }
  return { compiled, required }
}

function compileValueSchema(spec) {
  if (Array.isArray(spec.oneOf)) {
    const { required: _required, oneOf, ...annotations } = spec
    return { ...annotations, oneOf: oneOf.map(compileValueSchema) }
  }
  const { required: _required, properties, items, ...scalar } = spec
  if (spec.type === 'object') {
    const objectProperties = compileProperties(properties)
    return {
      ...scalar,
      properties: objectProperties.compiled,
      ...(objectProperties.required.length > 0 ? { required: objectProperties.required } : {}),
    }
  }
  if (spec.type === 'array' && items !== undefined) {
    return { ...scalar, items: compileValueSchema(items) }
  }
  return scalar
}

function validateValue(spec, value, path) {
  const errors = []
  if (Array.isArray(spec.oneOf)) {
    const matches = spec.oneOf.filter((branch) => validateValue(branch, value, path).length === 0)
    if (matches.length !== 1) errors.push(path + ' must match exactly one schema branch')
    return errors
  }
  if (spec.type === 'string' && typeof value !== 'string') errors.push(path + ' must be a string')
  if (spec.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errors.push(path + ' must be a finite number')
  if (spec.type === 'integer' && (!Number.isInteger(value))) errors.push(path + ' must be an integer')
  if (spec.type === 'boolean' && typeof value !== 'boolean') errors.push(path + ' must be a boolean')
  if (spec.type === 'null' && value !== null) errors.push(path + ' must be null')
  if (spec.type === 'array') {
    if (!Array.isArray(value)) errors.push(path + ' must be an array')
    else if (spec.items) value.forEach((item, index) => errors.push(...validateValue(spec.items, item, path + '[' + index + ']')))
  }
  if (spec.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(path + ' must be an object')
    } else {
      for (const [key, child] of Object.entries(spec.properties || {})) {
        if (!Object.hasOwn(value, key)) {
          if (child.required === true) errors.push(path + '.' + key + ' is required')
        } else {
          errors.push(...validateValue(child, value[key], path + '.' + key))
        }
      }
      if (spec.additionalProperties === false) {
        for (const key of Object.keys(value)) {
          if (!Object.hasOwn(spec.properties || {}, key)) errors.push(path + '.' + key + ' is not allowed')
        }
      }
    }
  }
  if (spec.enum && !spec.enum.includes(value)) errors.push(path + ' must be one of: ' + spec.enum.join(', '))
  if (Object.hasOwn(spec, 'const') && value !== spec.const) errors.push(path + ' must equal ' + JSON.stringify(spec.const))
  return errors
}

function defineTool(options) {
  const parameters = compileProperties(options.parameters)
  const parameterSchema = {
    type: 'object',
    properties: parameters.compiled,
    ...(parameters.required.length > 0
      ? { required: parameters.required }
      : {}),
  }
  return {
    ...options,
    parameters: parameterSchema,
    output: {
      ...options.output,
      schema: compileValueSchema(options.output.schema),
    },
    async execute(args, exec) {
      const errors = validateValue({ type: 'object', properties: options.parameters }, args, '$')
      if (errors.length > 0) throw new Error('invalid arguments: ' + errors.join('; '))
      return options.execute(args, exec)
    },
  }
}

function apply(ctx) {
  const disposers = []
  const reg = (tool) => disposers.push(ctx.tools.register(tool))

  const runPy = async (exec, argv) => {
    const sub = ctx.get('subprocess')
    if (sub === undefined) return { error: 'subprocess 服务不可用' }
    const handle = sub.spawn({
      argv,
      cwd: '/',
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } },
        stderr: { maxBytes: 256 * 1024 },
      },
      graceMs: 5000,
      signal: exec.signal,
    })
    const outcome = await handle.done
    const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null
    const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null
    const text = out && out.text ? out.text.trim() : ''
    if (outcome.exitCode !== 0) {
      return { error: '执行失败(exit ' + String(outcome.exitCode) + '): ' + ((err && err.text) || '无输出') }
    }
    return { text }
  }

  // 把本地图片存进 DSH 的 attachment 服务,拿到可放进 ImageBlock 的持久引用。
  // 用 ctx.get() 而不是写进 inject:attachments 缺失时只降级成纯文字,不会拖垮插件加载。
  // 任何一步失败都返回 null —— 调用方据此回退到"只给文字描述"的老行为。
  // IMAGE_MAGIC / sniffMediaType 已上提到模块作用域(W19 与 media 闸共用一张表)。
  const saveImageAttachment = async (imagePath) => {
    try {
      if (/^https?:\/\//i.test(imagePath)) return null   // 远端 URL 不落盘,交给视觉后端自己取
      const store = ctx.get('attachments')
      if (store === undefined) return null
      const data = await readFile(imagePath)
      const mediaType = sniffMediaType(data)
      if (mediaType === null) return null                // 非受支持的光栅格式,别硬塞
      const limits = store.imageLimits
      if (limits && limits.maxImageBytes && data.byteLength > limits.maxImageBytes) return null
      return await store.saveImage({ data, mediaType, name: basename(imagePath) })
    } catch {
      return null
    }
  }

  // ── 语音输入的宿主路由 POST /api/cn/asr ──────────────────────────────
  // 浏览器把录音 blob 发过来,这里落盘 → ffmpeg 转 wav → speech.py 转写 → 回文本。
  // 为什么要这条路由:ASR 的 key 在服务端,客户端插件拿不到,也不该拿到。
  // 用 ctx.get('webServer') 而非 inject —— 服务缺失时只是没有语音输入,不拖垮插件加载。

  // ── /api/cn/council-records:把评审台账吐给「追踪」页的分歧视图 ────────
  // 为什么不让前端从会话轨迹里解析:轨迹里的工具结果是**渲染后的 markdown**,
  // 按表格文本反解每个模型的原答案,换个 render 就全断。台账是结构化的,稳。
  const councilRecordsRoute = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    return ws.register({
      kind: 'exact',
      path: '/api/cn/council-records',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET') { send(405, { error: 'GET only' }); return }
        try {
          const raw = await readFile(COUNCIL_LOG, 'utf8').catch(() => '')
          const rows = []
          for (const line of raw.split('\n')) {
            if (!line.trim()) continue
            try { rows.push(JSON.parse(line)) } catch {}
          }
          send(200, { records: rows.slice(-30).reverse() })
        } catch (err) {
          send(500, { error: String((err && err.message) || err) })
        }
      },
    })
  }


  // ── /api/cn/plans:让「追踪」页能读写 plan_run 存下的计划 ─────────────
  // plan_run 把计划写成 JSON 就停住,等人看过再批准 —— 但"看过"到"改好"之间
  // 原本只能手动编辑文件。这条路由把那一步搬进界面。
  //
  // ⚠️ 写入必须锁死在 PLAN_DIR 内。这是唯一一个接受客户端传路径并**落盘**的接口,
  // 不做校验就等于把任意文件写入能力挂到了本机 HTTP 上。两道闸:
  //   1) realpath 后必须以 PLAN_DIR + '/' 开头(挡 ../ 与软链绕行)
  //   2) 文件名必须是 plan-<数字>.json(挡掉一切非计划文件)
  //
  // PLAN_DIR 是 plan_run(出计划/写回结果)、exit_plan_mode 批准落盘(A3)与这条路由三方共用的
  // 唯一目录。DSH_CN_PLAN_DIR 只给离线测试指到临时目录用,默认值不变。
  const PLAN_DIR = process.env.DSH_CN_PLAN_DIR || join(homedir(), '.dsh', 'logs', 'plans')
  // 计划 markdown 的第一个标题(与宿主 dsh-plan-mode 的 firstHeading 同一口径)
  const firstHeading = (md) => {
    for (const line of String(md || '').split('\n')) {
      const m = /^#{1,6}\s+(.+?)\s*$/.exec(line)
      if (m) return m[1]
    }
    return ''
  }
  const closePlanHandle = async (opened) => {
    if (opened && opened.handle) try { await opened.handle.close() } catch {}
  }
  const readPlanObject = async (rawPath) => {
    const opened = await openPlanFile({ path: rawPath, planDir: PLAN_DIR, flags: 'r' })
    if (!opened.ok) return opened
    try {
      const text = await opened.handle.readFile('utf8')
      return { ok: true, path: opened.path, name: opened.name, obj: JSON.parse(text) }
    } catch (error) {
      return { ok: false, code: 'READ', message: String((error && error.message) || error) }
    } finally {
      await closePlanHandle(opened)
    }
  }
  const writePlanObject = async (rawPath, obj, { create = false } = {}) => {
    await mkdir(PLAN_DIR, { recursive: true })
    const opened = await openPlanFile({ path: rawPath, planDir: PLAN_DIR, flags: create ? 'wx' : 'w' })
    if (!opened.ok) throw new Error(opened.message || opened.code || 'plan write rejected')
    try {
      await opened.handle.writeFile(JSON.stringify(obj, null, 2), 'utf8')
      return { ok: true, path: opened.path, name: opened.name }
    } finally {
      await closePlanHandle(opened)
    }
  }
  const plansRoute = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    return ws.register({
      kind: 'prefix',
      path: '/api/cn/plans',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        try {
          if (req.method === 'GET') {
            const names = await readdir(PLAN_DIR).catch(() => [])
            const out = []
            for (const n of names.filter((x) => PLAN_NAME.test(x)).sort().reverse().slice(0, 20)) {
              try {
                const got = await readPlanObject(n)
                if (!got.ok) continue
                const obj = got.obj
                // ⚠️ source / markdown / sessionId / approvedAt 必须透传(2026-08-19 补):
                // 之前路由把它们丢了,trace-view「计划」面板读 p.source 判来源、cur.markdown 显示计划全文,
                // 结果所有计划都标成 plan_run、计划全文永远不亮。plan_run 落盘的带 source:'plan_run';
                // exit_plan_mode 批准落盘(A3)的带 source:'plan-mode' + markdown + sessionId + approvedAt。
                out.push({ file: got.path, name: n, goal: String(obj.goal || ''), planner: obj.planner, steps: obj.steps || [],
                  source: typeof obj.source === 'string' ? obj.source : undefined,
                  markdown: typeof obj.markdown === 'string' ? obj.markdown : undefined,
                  sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : undefined,
                  approvedAt: obj.approvedAt,
                  editedAt: obj.editedAt, executedAt: obj.executedAt, executor: obj.executor, reviewer: obj.reviewer, results: obj.results, review: obj.review })
              } catch {}
            }
            send(200, { plans: out })
            return
          }
          if (req.method === 'POST') {
            const chunks = []
            let bytes = 0
            for await (const c of req) {
              bytes += c.length
              if (bytes > 512 * 1024) { send(413, { error: '计划过大' }); return }
              chunks.push(c)
            }
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            const named = resolvePlanPath(body.file, PLAN_DIR)
            if (!named.ok) { send(400, { error: '文件名不合法(只接受 PLAN_DIR 下的 plan-<数字>.json)' }); return }
            const target = named.path
            const steps = Array.isArray(body.steps) ? body.steps : null
            if (!steps || !steps.length) { send(400, { error: '步骤不能为空' }); return }
            // 只保留已知字段,不把客户端传来的任意结构写进盘。
            // type 是 plan-mode 合并后新增的(coder/deep/explore/…,决定派给哪家),面板不编辑它,
            // 但保存时必须原样带回 —— 否则在面板里改一个字就把整份计划的分派信息抹掉了。
            const clean = steps.slice(0, 12).map((st, i) => ({
              id: Number(st.id) || i + 1,
              title: String(st.title || '').slice(0, 200),
              detail: String(st.detail || '').slice(0, 4000),
              dependsOn: (Array.isArray(st.dependsOn) ? st.dependsOn : []).map(Number).filter((n) => Number.isFinite(n)),
              ...(st.type ? { type: String(st.type).slice(0, 40) } : {}),
            }))
            const prevRead = await readPlanObject(target)
            const prev = prevRead.ok && prevRead.obj && typeof prevRead.obj === 'object' ? prevRead.obj : {}
            const written = await writePlanObject(target, { ...prev, goal: String(body.goal || prev.goal || ''), steps: clean, editedAt: new Date().toISOString() })
            if (!written.ok) { send(400, { error: written.message || written.code || '计划写入被拒绝' }); return }
            send(200, { ok: true, file: written.path, steps: clean })
            return
          }
          send(405, { error: 'GET or POST' })
        } catch (err) {
          send(500, { error: String((err && err.message) || err) })
        }
      },
    })
  }

  // ── /api/usage/providers:CodexBar 本地缓存的只读 HTTP 面 ──────────────
  const usageProvidersRoute = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    const dispose = ws.register({
      kind: 'exact',
      path: '/api/usage/providers',
      handler: async (req, res) => {
        const send = (code, object) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(object))
        }
        if (req.method !== 'GET') { send(405, { error: 'GET only' }); return }
        // 只读 CodexBar 已有 SQLite/history 缓存;这里绝不调用 provider 探测接口。
        send(200, await readCodexBarUsage())
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // 裸 `createReadStream(...).pipe(res)` 有两个真会咬人的洞(2026-08-21 验收 P1):
  //   ① 流的 'error' 无监听者 → uncaughtException → **整个 DSH 后端进程退出**。
  //      realpath+stat 通过之后仍可能失败:文件在 stat 与 open 之间被清理、
  //      mode 000 的文件 stat 成功但 open EACCES、fd 耗尽后的 EMFILE。
  //   ② pipe 在 res 被销毁时只 unpipe **不销毁源流**,fd 一直握着。而「中断」
  //      正是这条路由的常规路径:<audio> 每拖一次进度条就 abort 在途 Range 请求。
  // 同 profile 的 dsh-fleet/lib/fleet-artifacts.mjs 早就是这么写的,这里对齐它。
  const streamFile = (res, filePath, options) => {
    const source = options === undefined
      ? createReadStream(filePath)
      : createReadStream(filePath, options)
    let finished = false
    res.once('finish', () => { finished = true })
    res.once('close', () => { if (!finished) { try { source.destroy() } catch {} } })
    source.once('error', () => {
      if (res.headersSent) { try { res.destroy() } catch {} return }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: '读取失败' }))
    })
    source.pipe(res)
  }

  // ── /api/cn/media:speak/generate_image 产物的只读 HTTP 面(W2)──────────
  // 前端拿到的是宿主机文件路径字符串 —— 既播不了也下载不了。这条路由把它变成
  // 可流式播放的 URL。三道闸:① realpath 后必须在 ~/.dsh/attachments 之下
  // ② 扩展名白名单;v1/objects 子树改为「裸 sha256 名 + 魔数嗅探」(W19),&mediaType= 只当期望值校验
  // ③ Range 支持(音频拖进度条)。纯读,零模型成本。
  const mediaRoute = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    const dispose = ws.register({
      kind: 'exact',
      path: '/api/cn/media',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') { send(405, { error: 'GET only' }); return }
        try {
          const url = new URL(req.url || '', 'http://localhost')
          const rootReal = await realpath(MEDIA_ROOT).catch(() => null)
          if (rootReal === null) { send(404, { error: '附件根不存在' }); return }
          // W19:&attachmentId=sha256:<hex> 由服务端拼 object 路径(零用户路径);否则走 &path=。
          const attachmentId = url.searchParams.get('attachmentId')
          let requested
          if (attachmentId !== null) {
            requested = objectPathForAttachmentId(attachmentId, MEDIA_ROOT)
            if (requested === null) { send(400, { error: 'attachmentId 形状不对' }); return }
          } else {
            requested = url.searchParams.get('path') ?? ''
          }
          const expectedMediaType = url.searchParams.get('mediaType') ?? undefined
          const gate = await resolveMediaPath(requested, rootReal, expectedMediaType)
          if (!gate.ok) {
            if (gate.reason === 'not-found' || gate.reason === 'missing' || gate.reason === 'not-file') { send(404, { error: '文件不存在' }); return }
            // 文案按原因分(都 403):调用方要能分清是路径问题还是内容/期望值问题
            const copy = gate.reason === 'bad-magic' ? '对象内容不是受支持的图片'
              : gate.reason === 'media-type-mismatch' ? 'mediaType 与文件内容不符'
              : gate.reason === 'bad-object-name' ? 'object store 下只认内容寻址文件名'
              : '路径不在许可范围内'
            send(403, { error: copy, reason: gate.reason }); return
          }
          const info = await stat(gate.real)
          if (!info.isFile()) { send(404, { error: '不是文件' }); return }
          const size = info.size
          const baseHeaders = {
            'content-type': gate.mime,
            'accept-ranges': 'bytes',
            'cache-control': 'private, max-age=3600',
            'content-disposition': 'inline; filename="' + basename(gate.real).replace(/"/g, '') + '"',
          }
          // ③ Range:bytes=start-end / bytes=start-(音频拖动、预载全靠它)
          const range = typeof req.headers.range === 'string'
            ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range) : null
          if (range) {
            const start = Number(range[1])
            const end = range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
            if (start >= size || end < start) {
              res.writeHead(416, { 'content-range': 'bytes */' + size })
              res.end(); return
            }
            res.writeHead(206, { ...baseHeaders, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 })
            if (req.method === 'HEAD') { res.end(); return }
            streamFile(res, gate.real, { start, end })
            return
          }
          res.writeHead(200, { ...baseHeaders, 'content-length': size })
          if (req.method === 'HEAD') { res.end(); return }
          streamFile(res, gate.real)
        } catch {
          // 原始 fs 错误会带出宿主机绝对路径(ENOENT / ENAMETOOLONG 都把完整
          // 路径写进 message),不进响应体(2026-08-21 验收 P2)。
          send(500, { error: '读取失败' })
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  const asrRoute = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    // WebRoute 的字段是 { kind: 'exact'|'prefix', path, handler } —— **没有 method**,
    // 方法自己在 handler 里判。写成 method 会静默不生效,表现为 404(而 /api/* 的
    // 415「content type must be application/json」是网关的统一拦截,不是你的路由在说话)。
    const dispose = ws.register({
      kind: 'exact',
      path: '/api/cn/asr',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'POST only' }))
          return
        }
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        try {
          // ⚠️ /api/* 命名空间强制 application/json(网关直接 415 掉二进制 body),
          // 所以音频走 JSON + base64:{ audio: "<base64>", mime: "audio/webm" }。
          // base64 膨胀 33%,但语音片段本来就小,可以接受。
          const chunks = []
          let bytes = 0
          for await (const c of req) {
            bytes += c.length
            // 25MB 上限:一分钟 webm 语音约 1MB,足够用;防止把内存打爆
            if (bytes > 25 * 1024 * 1024) { send(413, { error: '音频过大(>25MB)' }); return }
            chunks.push(c)
          }
          if (bytes === 0) { send(400, { error: '空请求' }); return }
          let payload
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            send(400, { error: 'body 必须是 JSON:{audio:base64, mime}' }); return
          }
          if (!payload || typeof payload.audio !== 'string' || payload.audio.length === 0) {
            send(400, { error: '缺少 audio(base64)' }); return
          }
          const ext = /wav/.test(String(payload.mime || '')) ? '.wav'
            : /mp3|mpeg/.test(String(payload.mime || '')) ? '.mp3' : '.webm'
          const raw = join(tmpdir(), 'dsh-asr-' + randomUUID() + ext)
          const wav = raw.replace(/\.[a-z0-9]+$/, '.asr.wav')
          await writeFile(raw, Buffer.from(payload.audio, 'base64'))
          // MediaRecorder 产出的是 webm/opus,小米 ASR 只吃 wav/mp3,必须转
          await new Promise((resolve, reject) => {
            const ff = spawn('/opt/homebrew/bin/ffmpeg',
              ['-loglevel', 'error', '-y', '-i', raw, '-ar', '16000', '-ac', '1', wav])
            ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))))
            ff.on('error', reject)
          })
          const out = await new Promise((resolve) => {
            const py = spawn(PY, [VISION_DIR + '/speech.py', 'transcribe', wav])
            let text = ''
            let err = ''
            py.stdout.on('data', (d) => { text += d })
            py.stderr.on('data', (d) => { err += d })
            py.on('exit', (code) => resolve(code === 0 ? { text: text.trim() } : { error: err.trim() || ('exit ' + code) }))
            py.on('error', (e) => resolve({ error: String(e.message || e) }))
          })
          for (const f of [raw, wav]) { try { await unlink(f) } catch {} }
          send(out.error ? 500 : 200, out)
        } catch (e) {
          send(500, { error: String((e && e.message) || e) })
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // ── /api/cn/vision:composer「+ → 图片」的交叉读图 ─────────────────────
  // 为什么要这条路由:会话主模型多半是 DeepSeek(纯文本),把图当附件塞进去会在发送时
  // 被 apiproxy 以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒掉。这里把图交给本机可用的视觉套餐
  // (see.py 的五家),**三家独立描述 + 第四家看图仲裁**,再把合并描述回给客户端写进草稿。
  // 走 council 同一套思路(隔离作答 → 盲评仲裁 → 落台账),只是评委是 see.py 子进程而非子代理。
  //
  // 主模型自己能看图时(inputModalities 含 image)直接回 { native:true },客户端改走宿主
  // 原生附件流水线 —— 不该替一个能看图的模型转述图片。
  //
  // 修饰性能力,不是工具启动前提:和 asrRoute 一样挂在 ctx.inject(['webServer']) 里。
  const VISION_SAVE_DIR = join(homedir(), '.dsh', 'attachments', 'cn-vision')
  const VISION_PANEL = ['qwen', 'doubao', 'stepfun']
  const VISION_ARBITER_PREFER = ['mimo', 'minimax']
  const VISION_PANEL_Q =
    '详细描述这张图片,供一个看不见图片的模型使用:1) 图上所有文字逐字抄录(含代码/数字/版本号,保持原样);' +
    '2) 布局与结构(区域、表格/图表的行列与数值);3) 颜色、形状、方位;' +
    '4) 若是截图/界面,说明是什么软件、什么状态、有无报错。不确定的地方明确写「不确定」,不要猜。'
  const VISION_MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

  // 会话当前模型能不能原生看图。任何一步拿不到都当**不能**(宁可多转述一次,也别把图
  // 塞给纯文本模型然后在发送时炸)。取模型的方式与宿主 apiproxy 一致:
  // agents.get(sessionId).session.requestHeader().config;没有会话就退回 agent-default-model。
  // ⚠️ 只看得到"最近一次已记录的请求头":用户在下拉里刚换了模型但还没发过消息,这里读到的
  // 仍是上一个 —— 那种情况顶多多转述一次或让宿主在发送时拒一次,不会写坏任何东西。
  const sessionSeesImages = async (sessionId) => {
    try {
      let sel = null
      if (sessionId) {
        const agents = ctx.get('agents')
        const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
        const cfg = agent && agent.session && typeof agent.session.requestHeader === 'function'
          ? (agent.session.requestHeader() || {}).config : undefined
        if (cfg && cfg.provider && cfg.model) sel = { provider: String(cfg.provider), model: String(cfg.model) }
      }
      if (!sel) {
        const dm = ctx.get('agentDefaultModel')
        const cur = dm && typeof dm.currentSelection === 'function' ? dm.currentSelection() : undefined
        if (cur && cur.provider && cur.model) sel = { provider: String(cur.provider), model: String(cur.model) }
      }
      if (!sel) return { native: false, selection: null }
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return { native: false, selection: sel }
      const info = await llm.resolveModelInfo(sel.provider, sel.model)
      const native = !!info && (info.inputModalities === undefined || info.inputModalities.includes('image'))
      return { native, selection: sel }
    } catch (e) {
      console.error('[cn-capabilities/vision] 模型能力判定失败,按纯文本处理:', String((e && e.message) || e))
      return { native: false, selection: null }
    }
  }

  // 跑一次 see.py。不抛:失败以 { ok:false, error } 返回,一家挂掉不该毁掉整场。
  // 超时 kill 掉子进程 —— see.py 自己的 urlopen 是 90s,这里的上限是它的兜底。
  const runSee = (imagePath, question, provider, timeoutMs) => new Promise((resolve) => {
    const t0 = Date.now()
    let out = ''
    let err = ''
    let done = false
    let timer = null
    const finish = (r) => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      resolve({ provider, model: '(see.py)', ms: Date.now() - t0, ...r })
    }
    let py
    try {
      py = spawn(PY, [VISION_DIR + '/see.py', imagePath, question, '--provider', provider], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      finish({ ok: false, text: '', error: String((e && e.message) || e) })
      return
    }
    timer = setTimeout(() => {
      try { py.kill('SIGKILL') } catch {}
      finish({ ok: false, text: '', error: '超时(' + Math.round(timeoutMs / 1000) + 's)未返回' })
    }, timeoutMs)
    py.stdout.on('data', (d) => { if (out.length < 512 * 1024) out += d })
    py.stderr.on('data', (d) => { if (err.length < 64 * 1024) err += d })
    py.on('error', (e) => finish({ ok: false, text: '', error: String((e && e.message) || e) }))
    py.on('close', (code) => {
      const text = out.trim()
      if (code === 0 && text) finish({ ok: true, text, error: '' })
      else finish({ ok: false, text: '', error: (err.trim() || ('exit ' + code)).split('\n').slice(-3).join(' ').slice(0, 500) })
    })
  })

  // 从仲裁原文里抠出第一个平衡的 {...} 并解析。与 council 的 parseVerdict 同一思路,但多做两件事:
  //   1) 数括号时**跳过字符串内部** —— 图片描述里很可能有代码/JSON 截图,里面的 { } 会把
  //      简单计数法带偏;
  //   2) 首次 JSON.parse 失败时,把字符串内部的裸换行/制表符转义后再试一次 —— 模型写长描述
  //      时经常直接换行,严格 JSON 不认,但内容本身是好的,不该因此整份丢掉。
  const escapeCtrlInStrings = (s) => {
    let o = ''
    let inStr = false
    let esc = false
    for (const ch of s) {
      if (!inStr) { if (ch === '"') inStr = true; o += ch; continue }
      if (esc) { o += ch; esc = false; continue }
      if (ch === '\\') { o += ch; esc = true; continue }
      if (ch === '"') { inStr = false; o += ch; continue }
      if (ch === '\n') { o += '\\n'; continue }
      if (ch === '\r') continue
      if (ch === '\t') { o += '\\t'; continue }
      o += ch
    }
    return o
  }
  const parseFirstJsonObject = (raw) => {
    if (!raw) return null
    const t = String(raw).replace(/```(?:json)?/gi, '')
    const i = t.indexOf('{')
    if (i < 0) return null
    let depth = 0
    let inStr = false
    let esc = false
    for (let j = i; j < t.length; j++) {
      const ch = t[j]
      if (inStr) {
        if (esc) esc = false
        else if (ch === '\\') esc = true
        else if (ch === '"') inStr = false
        continue
      }
      if (ch === '"') { inStr = true; continue }
      if (ch === '{') depth++
      else if (ch === '}' && --depth === 0) {
        const slice = t.slice(i, j + 1)
        try { return JSON.parse(slice) } catch {}
        try { return JSON.parse(escapeCtrlInStrings(slice)) } catch { return null }
      }
    }
    return null
  }

  const visionRoute = () => {
    const ws = ctx.get('webServer')
    if (ws === undefined || typeof ws.register !== 'function') return
    const dispose = ws.register({
      kind: 'exact',
      path: '/api/cn/vision',
      handler: async (req, res) => {
        const send = (code, obj) => {
          res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(obj))
        }
        if (req.method !== 'POST') { send(405, { error: 'POST only' }); return }
        const t0 = Date.now()
        try {
          // 与 /api/cn/asr 同理:/api/* 强制 application/json,图片走 JSON + base64。
          // 单张上限 12MB(base64 计),body 再多留 1MB 给 JSON 外壳。
          const chunks = []
          let bytes = 0
          for await (const c of req) {
            bytes += c.length
            if (bytes > 13 * 1024 * 1024) { send(413, { error: '请求过大(>13MB)' }); return }
            chunks.push(c)
          }
          if (bytes === 0) { send(400, { error: '空请求' }); return }
          let payload
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
          } catch {
            send(400, { error: 'body 必须是 JSON:{sessionId?, name, mime, data:base64, question?}' }); return
          }
          if (!payload || typeof payload.data !== 'string' || payload.data.length === 0) {
            send(400, { error: '缺少 data(base64)' }); return
          }
          if (payload.data.length > 12 * 1024 * 1024) { send(400, { error: '图片过大(base64 >12MB)' }); return }
          const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
          const rawName = String(payload.name || 'image')
          const mime = String(payload.mime || '').toLowerCase()
          const question = typeof payload.question === 'string' ? payload.question.trim() : ''

          // 1) 主模型能原生看图 → 不落盘、不转述,让客户端走宿主自己的附件流水线
          const seen = await sessionSeesImages(sessionId)
          if (seen.native) { send(200, { native: true, selection: seen.selection }); return }

          // 2) 落盘到 ~/.dsh/attachments/cn-vision/<紧凑ISO时间>-<净化文件名>
          //    文件名只留 [A-Za-z0-9._-];没扩展名时按 mime 补一个,see.py 与之后的追问都靠这条路径
          const bin = Buffer.from(payload.data, 'base64')
          if (bin.byteLength === 0) { send(400, { error: 'data 不是有效的 base64' }); return }
          const extMatch = rawName.match(/\.([A-Za-z0-9]{1,5})$/)
          let stem = (extMatch ? rawName.slice(0, -extMatch[0].length) : rawName).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80)
          if (!stem) stem = 'image'
          const ext = extMatch ? '.' + extMatch[1].toLowerCase() : (VISION_MIME_EXT[mime] || '')
          const savedName = stem + ext
          const stamp = new Date().toISOString().replace(/[-:.]/g, '')
          const path = join(VISION_SAVE_DIR, stamp + '-' + savedName)
          await mkdir(VISION_SAVE_DIR, { recursive: true })
          await writeFile(path, bin)

          // 3) 三家并行独立描述(彼此不可见)
          const panelQ = VISION_PANEL_Q + (question ? '\n用户特别想知道:' + question : '')
          const answers = await Promise.all(VISION_PANEL.map((p) => runSee(path, panelQ, p, 150000)))
          const okOnes = answers.filter((a) => a.ok)
          const panelBrief = answers.map((a) => ({ provider: a.provider, ok: a.ok, ms: a.ms, ...(a.ok ? {} : { error: a.error }) }))
          if (okOnes.length === 0) {
            send(502, { error: '所有视觉后端都失败', panel: panelBrief, path })
            return
          }

          // 4) 第四家盲评仲裁:它**也看图**,拿到的是匿名的【描述N】,不知道各自出自哪家
          const arbiter = VISION_ARBITER_PREFER.find((p) => !VISION_PANEL.includes(p)) || 'mimo'
          let description = ''
          let disagreements = []
          let flagged = []
          let parsedOk = false
          let inconclusive = false
          let arb = null
          let arbiterUsed = arbiter
          if (okOnes.length < 2) {
            // 只有一份有效描述,无从比对 —— 直接用它,标 inconclusive,不硬凑仲裁
            inconclusive = true
            arbiterUsed = '(未仲裁)'
            description = okOnes[0].text
          } else {
            const sheet = okOnes.map((a, i) => '【描述' + (i + 1) + '】\n' + String(a.text).slice(0, 6000)).join('\n\n')
            const arbQ = sheet + '\n\n以上是 ' + okOnes.length + ' 份对同一张图的独立描述。请你自己看图,输出 JSON(不要围栏):' +
              '{"description":"合并后的一份可靠描述(以你亲眼看到的为准,逐字抄录文字)",' +
              '"disagreements":["描述之间不一致之处及你的判定"],' +
              '"suspect":[描述编号,你判定明显编造/看错的]}'
            arb = await runSee(path, arbQ, arbiter, 150000)
            const extracted = parseCouncilVerdict(arb.ok ? arb.text : '')
            const ev = evaluateCouncilStructure({
              parsed: extracted.parsed,
              panelists: answers,
              kind: 'vision',
              parseReason: extracted.reason,
            })
            parsedOk = ev.parsedOk
            inconclusive = ev.inconclusive === true
            disagreements = ev.disagreements
            if (ev.parsedOk && extracted.parsed && typeof extracted.parsed.description === 'string' && extracted.parsed.description.trim()) {
              description = extracted.parsed.description.trim()
              // 序号 → 厂商名的映射在这一侧做;越界/非数字一律丢掉,不猜
              flagged = (Array.isArray(extracted.parsed.suspect) ? extracted.parsed.suspect : [])
                .map((x) => Number(String(x).replace(/[^0-9]/g, '')))
                .filter((n) => Number.isInteger(n) && n >= 1 && n <= okOnes.length)
                .map((n) => okOnes[n - 1].provider)
                .filter((x, i, arr) => arr.indexOf(x) === i)
            } else if (arb.ok) {
              // 没按完整结构返回:原文当描述用,本次判定不入账
              description = arb.text.trim()
            } else {
              // 仲裁本身挂了:把各家原文原样给出去,别让用户空手而归
              description = '(仲裁 ' + arbiter + ' 失败:' + arb.error + ',以下为各家原始描述)\n\n' + sheet
            }
          }
          const consensus = parsedOk && disagreements.length === 0

          // 5) 落台账。disagreements 必须是独立数组;不要再 join 进 verdict,
          // 否则读侧只能做逐行假比对(TASK-017 W1)。
          const verdict = description.slice(0, 4000)
          try {
            await appendFile(COUNCIL_LOG, JSON.stringify({
              kind: 'vision',
              parsedOk,
              time: new Date().toISOString(),
              question: ('[图] ' + savedName + (question ? ' · ' + question : '')).slice(0, 160),
              hadImages: 1,
              arbiter: arbiterUsed,
              arbiterMetered: false,
              consensus,
              inconclusive,
              panelists: answers.map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, ms: a.ms, error: a.error || undefined, text: String(a.text || '').slice(0, 6000) })),
              verdict,
              disagreements,
              flagged,
              imagePath: path,
            }) + '\n', 'utf8')
          } catch (e) {
            console.error('[cn-capabilities/vision] 台账写入失败:', String((e && e.message) || e))
          }

          // 6) 回给客户端
          send(200, {
            native: false,
            path,
            name: savedName,
            description,
            disagreements,
            flagged,
            panel: panelBrief,
            arbiter: arbiterUsed,
            parsedOk,
            inconclusive,
            ms: Date.now() - t0,
          })
        } catch (e) {
          console.error('[cn-capabilities/vision] 路由异常:', String((e && e.stack) || e))
          send(500, { error: String((e && e.message) || e) })
        }
      },
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // HTTP 路由:有 webServer 才挂,没有(headless)就安静地不挂,工具照常可用
  ctx.inject(['webServer'], () => {
    asrRoute()
    visionRoute()
    councilRecordsRoute()
    plansRoute()
    usageProvidersRoute()
    mediaRoute()
  })

  // ── GLM 视觉理解 MCP 客户端 ──────────────────────────────────────────
  // 智谱给 Coding Plan 用户的 Local MCP Server(@z_ai/mcp-server),接 GLM-4.6V,
  // 走套餐积分不额外收费。8 个工具里 analyze_image 与既有 see_image 重叠,
  // 这里只包装其余 7 个(视频/OCR/报错截图/技术图/图表/UI diff/UI转代码)。
  //
  // ⚠️ 套餐的视觉能力**只能**经这个 MCP 触达 —— 直接把图发给 chat 接口会被
  // 静默丢弃(套餐把 glm-4.6v 自动路由到纯文本的 GLM-5.3)。见官方文档。
  //
  // 进程单例 + 懒启动:npx 冷启约 2 秒,每次调用都新拉会难以忍受;
  // 进程退出时置空,下次调用自动重启。
  let mcpProc = null
  let mcpInit = null
  let mcpSeq = 0
  const mcpPending = new Map()

  const mcpStop = () => {
    if (mcpProc) { try { mcpProc.kill() } catch {} }
    mcpProc = null; mcpInit = null
    for (const [, rej] of mcpPending) { try { rej({ error: { message: 'MCP 进程已退出' } }) } catch {} }
    mcpPending.clear()
  }
  disposers.push(mcpStop)

  const mcpSend = (payload) => mcpProc.stdin.write(JSON.stringify(payload) + '\n')

  const mcpStart = () => {
    if (mcpInit) return mcpInit
    const key = process.env.Z_AI_API_KEY || process.env.GLM_API_KEY
    if (!key) return Promise.reject(new Error('缺少 Z_AI_API_KEY / GLM_API_KEY'))
    mcpProc = spawn('npx', ['-y', '@z_ai/mcp-server@latest'], {
      env: { ...process.env, Z_AI_API_KEY: key, Z_AI_MODE: process.env.Z_AI_MODE || 'ZHIPU' },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    mcpProc.on('exit', mcpStop)
    mcpProc.on('error', mcpStop)
    let buf = ''
    mcpProc.stdout.on('data', (chunk) => {
      buf += chunk.toString()
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          const msg = JSON.parse(line)
          if (msg.id && mcpPending.has(msg.id)) { mcpPending.get(msg.id)(msg); mcpPending.delete(msg.id) }
        } catch {}
      }
    })
    mcpInit = new Promise((resolve, reject) => {
      const id = ++mcpSeq
      const timer = setTimeout(() => { mcpStop(); reject(new Error('MCP 握手超时(90s)')) }, 90000)
      mcpPending.set(id, () => {
        clearTimeout(timer)
        mcpSend({ jsonrpc: '2.0', method: 'notifications/initialized' })
        resolve()
      })
      mcpSend({
        jsonrpc: '2.0', id, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-cn-capabilities', version: '1' } },
      })
    })
    return mcpInit
  }

  // 调一个 MCP 工具,返回纯文本。任何失败都返回可读的错误字符串,不抛。
  const mcpCall = async (toolName, toolArgs, timeoutMs) => {
    try {
      await mcpStart()
    } catch (e) {
      return 'GLM 视觉 MCP 启动失败: ' + String((e && e.message) || e)
    }
    return await new Promise((resolve) => {
      const id = ++mcpSeq
      const timer = setTimeout(() => { mcpPending.delete(id); resolve('GLM 视觉 MCP 调用超时') }, timeoutMs || 180000)
      mcpPending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.error) return resolve('GLM 视觉 MCP 报错: ' + (msg.error.message || JSON.stringify(msg.error)))
        const blocks = (msg.result && msg.result.content) || []
        const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        resolve(text || '（无文本输出）')
      })
      mcpSend({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: toolArgs } })
    })
  }

  // 7 个包装工具。入参 schema 取自运行中 MCP 的 tools/list(2026-08-17 实测),
  // 不照抄官方文档 —— 文档把 analyze_image 写成 image_analysis,是错的。
  const GLM_TOOLS = [
    { name: 'see_video', mcp: 'analyze_video', src: 'video_source', srcDesc: '本地视频绝对路径或 URL(MP4/MOV/M4V,本地最大 8MB)',
      desc: '视频理解:传入本地视频路径,返回场景解析/关键帧/事件要点。走 GLM-4.6V(智谱套餐积分)。', timeout: 300000 },
    { name: 'read_screenshot_text', mcp: 'extract_text_from_screenshot', src: 'image_source', srcDesc: '截图的本地绝对路径或 URL',
      desc: '截图 OCR:从截图里提取文字,专门优化过代码、终端输出、文档。比通用识图更准。', extra: { programming_language: '可选,代码所用语言,提高识别准确度' } },
    { name: 'diagnose_screenshot', mcp: 'diagnose_error_screenshot', src: 'image_source', srcDesc: '报错截图的本地绝对路径或 URL',
      desc: '报错截图诊断:解析错误弹窗/堆栈/日志截图,给出定位与修复建议。', extra: { context: '可选,补充上下文(在做什么、什么环境)' } },
    { name: 'read_diagram', mcp: 'understand_technical_diagram', src: 'image_source', srcDesc: '技术图纸的本地绝对路径或 URL',
      desc: '技术图解读:架构图/流程图/UML/ER 图 → 结构化解读。', extra: { diagram_type: '可选,图的类型,如 architecture/flowchart/uml/er' } },
    { name: 'read_chart', mcp: 'analyze_data_visualization', src: 'image_source', srcDesc: '图表截图的本地绝对路径或 URL',
      desc: '图表解读:仪表盘/统计图 → 趋势、异常与业务要点。', extra: { analysis_focus: '可选,重点关注什么(趋势/异常/对比)' } },
    { name: 'ui_to_code', mcp: 'ui_to_artifact', src: 'image_source', srcDesc: 'UI 截图的本地绝对路径或 URL',
      desc: 'UI 截图转产物:把界面截图转成代码、提示词、设计规范或自然语言描述。',
      required: { output_type: '产物类型,如 code / prompt / design-spec / description' } },
  ]

  for (const t of GLM_TOOLS) {
    const params = {
      [t.src]: { type: 'string', required: true, description: t.srcDesc },
      prompt: { type: 'string', description: '可选,具体想让它分析什么;省略则按工具默认' },
    }
    for (const [k, d] of Object.entries(t.required || {})) params[k] = { type: 'string', required: true, description: d }
    for (const [k, d] of Object.entries(t.extra || {})) params[k] = { type: 'string', description: d }
    reg(defineTool({
      name: t.name,
      description: t.desc,
      parameters: params,
      output: {
        schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false },
        render: (a, v) => [{ type: 'text', text: v.result }],
      },
      timeoutMs: t.timeout || 180000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const callArgs = { [t.src]: String(args[t.src]), prompt: String(args.prompt || '请详细分析') }
        for (const k of Object.keys({ ...(t.required || {}), ...(t.extra || {}) })) {
          if (args[k] !== undefined) callArgs[k] = String(args[k])
        }
        return { result: await mcpCall(t.mcp, callArgs, t.timeout) }
      },
    }))
  }

  // ui_diff_check 参数形状不同(两张图),单独注册
  reg(defineTool({
    name: 'ui_diff',
    description: 'UI 对比:给两张界面截图,识别视觉差异与实现偏差。用于设计稿与实现的验收。',
    parameters: {
      expected: { type: 'string', required: true, description: '期望效果(设计稿)的本地绝对路径或 URL' },
      actual: { type: 'string', required: true, description: '实际实现截图的本地绝对路径或 URL' },
      prompt: { type: 'string', description: '可选,重点比什么' },
    },
    output: {
      schema: { type: 'object', properties: { result: { type: 'string', required: true } }, additionalProperties: false },
      render: (a, v) => [{ type: 'text', text: v.result }],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args) {
      return {
        result: await mcpCall('ui_diff_check', {
          expected_image_source: String(args.expected),
          actual_image_source: String(args.actual),
          prompt: String(args.prompt || '对比两张截图,列出视觉差异与实现偏差'),
        }),
      }
    },
  }))

  // ── see_image:五源视觉 ──────────────────────────────────────────────
  reg(defineTool({
    name: 'see_image',
    description: "给纯文本模型装上'眼睛':传入一张本地图片的绝对路径或 http(s) 图片 URL,返回视觉模型对图片内容的文字描述。五后端:provider 默认 qwen(Qwen-VL 百炼),可选 stepfun(Step-3.7-Flash)、mimo(小米 mimo-v2.5)、doubao(豆包 seed-1.6)、minimax(MiniMax-M3)。当用户要求'看'/'识别'/'描述'/'读取'一张图片时使用。",
    parameters: {
      image: { type: 'string', required: true, description: '本地图片绝对路径或 http(s) 图片 URL' },
      question: { type: 'string', description: '可选,针对图片的具体问题;省略则默认详细描述' },
      provider: { type: 'string', enum: ['qwen', 'stepfun', 'mimo', 'doubao', 'minimax'], description: '视觉后端,默认 qwen' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          description: { type: 'string', required: true },
          attachment: { type: 'object', description: '图片在 attachment 服务里的持久引用;仅本地图片且保存成功时存在' },
        },
        additionalProperties: false,
      },
      // 主模型能看图时,把图片原件也一并放进上下文(原生 ImageBlock),而不只是文字转述;
      // 主模型是纯文本时,LLM 层的 text-only 降级会自动把图片块去掉,文字描述仍在。
      render: (a, v) => {
        const blocks = []
        if (v.attachment) blocks.push({ type: 'image', attachment: v.attachment })
        blocks.push({ type: 'text', text: v.description })
        return blocks
      },
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const provider = ['stepfun', 'mimo', 'doubao', 'minimax'].includes(args.provider) ? args.provider : 'qwen'
      const argv = [PY, VISION_DIR + '/see.py', String(args.image)]
      if (args.question) argv.push(String(args.question))
      argv.push('--provider', provider)
      const r = await runPy(exec, argv)
      if (r.error) return { description: r.error }
      const attachment = await saveImageAttachment(String(args.image))
      return attachment ? { description: r.text, attachment } : { description: r.text }
    },
  }))

  // speak:全系统唯一 TTS 入口。TASK-017 误删工具定义(当时以为有 HTTP 路由;
  // 实际只有 /api/cn/asr 与 /api/cn/media)。transcribe / delegate_kimi 删除保留。
  reg(defineTool({
    name: 'speak',
    description: '文字转语音:把文本合成音频文件并保存到本地(wav)。默认用小米 mimo TTS(Token Plan 套餐内)。当用户要求朗读、播放、说出来或生成语音时使用。',
    parameters: {
      text: { type: 'string', required: true, description: '要朗读的文本' },
      provider: { type: 'string', description: 'TTS 后端:mimo(默认,支持克隆/设计) 或 minimax' },
      voice: { type: 'string', description: '音色 id;mimo 默认 mimo_default;minimax 默认 female-shaonv' },
      instruction: { type: 'string', description: '语气/风格指令(可选,仅 mimo)' },
      clone: { type: 'string', description: '音色克隆样本音频路径(mp3/wav),仅 mimo' },
      design: { type: 'string', description: '音色设计:一句话描述想要的音色,仅 mimo' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', properties: { path: { type: 'string', required: true } }, additionalProperties: false },
          { type: 'object', properties: { error: { type: 'string', required: true } }, additionalProperties: false },
        ],
      },
      render: (a, v) => [{ type: 'text', text: 'error' in v ? v.error : ('语音已生成: ' + v.path) }],
    },
    timeoutMs: 180000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const outPath = await freshMediaPath('dsh-speak', '.wav')
      const argv = [PY, VISION_DIR + '/speech.py', 'speak', String(args.text), '--out', outPath]
      if (args.provider) argv.push('--provider', String(args.provider))
      if (args.voice) argv.push('--voice', String(args.voice))
      if (args.instruction) argv.push('--instruction', String(args.instruction))
      if (args.clone) argv.push('--clone', String(args.clone))
      if (args.design) argv.push('--design', String(args.design))
      const r = await runPy(exec, argv)
      return r.error ? { error: r.error } : { path: outPath }
    },
  }))

  // ── generate_image:豆包 Seedream 生图 ──────────────────────────────
  reg(defineTool({
    name: 'generate_image',
    description: '文生图:传入提示词,用豆包 Seedream(火山方舟 Agent Plan 套餐内)生成图片并保存到本地,返回图片路径。当用户要求\'画\'/\'生成图片\'/\'作图\'时使用。',
    parameters: {
      prompt: { type: 'string', required: true, description: '图片描述(中文/英文均可)' },
      size: { type: 'string', description: '尺寸,默认 1920x1920(Agent Plan 要求至少 3686400 像素)' },
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', properties: { path: { type: 'string', required: true } }, additionalProperties: false },
          { type: 'object', properties: { error: { type: 'string', required: true } }, additionalProperties: false },
        ],
      },
      render: (a, v) => [{ type: 'text', text: 'error' in v ? v.error : ('图片已生成: ' + v.path) }],
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const outPath = await freshMediaPath('dsh-gen', '.png')
      const r = await runPy(exec, [
        PY,
        VISION_DIR + '/gen.py',
        String(args.prompt),
        '--size',
        String(args.size || '1920x1920'),
        '--out',
        outPath,
      ])
      return r.error ? { error: r.error } : { path: outPath }
    },
  }))

  const HOME = homedir()
  // provider → 默认模型。**必须与 ~/.dsh/settings.yaml 的 llm-pi-ai.providers.<id>.models 首项一致。**
  // 原来写在 delegate_task 的 execute 内部;council 也要用,所以提到模块级共享。
  // ⚠️ 省略 model 时 DSH 会沿用会话当前 model id 去打新 provider,直接报 UNKNOWN_MODEL
  //   (2026-08-17 由 Loki 遥测抓到),所以这张表不能省。
const PROVIDER_DEFAULT_MODEL = {
        'qwen': 'qwen3.8-max',
        'doubao': 'doubao-seed-evolving',
        'minimax-cn': 'MiniMax-M3',
        'xiaomi-token-plan-sgp': 'mimo-v2.5-pro',
        'stepfun': 'step-3.7-flash',
        'deepseek-official': 'deepseek-v4-flash',
      }

  // ── delegate_task:子代理多模型委派 ─────────────────────────────────
  reg(defineTool({
    name: 'delegate_task',
    description: '把子任务委派给指定国产模型的子代理执行(子代理看不到本对话历史,只看到任务文本)。可用 provider: deepseek-official/qwen/doubao/minimax-cn/xiaomi-token-plan-sgp/stepfun。当需要让不同模型并行处理、或验证某模型能力时使用。传 images 可让子代理原生看图(同一张图分发给多家交叉识别)。',
    parameters: {
      task: { type: 'string', required: true, description: '给子代理的完整任务描述(自包含)' },
      provider: { type: 'string', description: '模型 provider 路由,如 qwen / doubao / minimax-cn / xiaomi-token-plan-sgp / stepfun / deepseek-official;默认 qwen' },
      model: { type: 'string', description: '具体模型 id;省略则用该 provider 的默认模型' },
      images: {
        type: 'array',
        items: { type: 'string' },
        description: '要一并交给子代理的**本地图片绝对路径**(png/jpg/webp/gif),最多 8 张。给了之后子代理会用它自己的模型直接看图,不必再调 see_image 绕一圈。仅对声明了 image 输入的模型有效(qwen/doubao/minimax-cn/stepfun/xiaomi 都支持)。',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          reply: { type: 'string', required: true },
          provider: { type: 'string', required: true },
          model: { type: 'string', required: true },
        },
        additionalProperties: false,
      },
      render: (a, v) => [{ type: 'text', text: '[' + v.provider + '/' + v.model + '] ' + v.reply }],
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return { reply: 'subagents 服务不可用', provider: '', model: '' }
      const provider = String(args.provider || 'qwen')
      // ⚠️ 省略 model 时必须补上该 provider 的默认模型。
      // 只传 { provider } 的话,DSH 会沿用**会话当前的 model id**(如 deepseek-v4-flash)
      // 去打新 provider,直接报 UNKNOWN_MODEL:
      //   pi-ai provider "doubao" has no configured model "deepseek-v4-flash"
      // 2026-08-17 由 Loki 遥测抓到 —— 指定 model 能成功、省略必挂,默认路径是坏的。
      // 下表须与 ~/.dsh/settings.yaml 的 llm-pi-ai.providers.<id>.models 首项保持一致。
      const model = args.model ? String(args.model) : PROVIDER_DEFAULT_MODEL[provider]
      // 原生传图(2026-08-18):DSH 的 prompt 是内容块数组,图像块形状为
      //   { type: 'image', attachment: ImageAttachmentRef }
      // ref 由 ctx.get('attachments').saveImage() 产生(saveImageAttachment 已封装)。
      // 这样子代理是**用它自己模型的眼睛**看图,而不是去调 see_image 读别人的描述 ——
      // 后者多一跳、且看图的是视觉后端而非该子代理本身。
      const imageArgs = Array.isArray(args.images) ? args.images.slice(0, 8) : []
      const imageBlocks = []
      const imageSkipped = []
      for (const raw of imageArgs) {
        const att = await saveImageAttachment(String(raw))
        if (att) imageBlocks.push({ type: 'image', attachment: att })
        else imageSkipped.push(String(raw))   // 不存在/非光栅/超限 —— 明说,不静默吞掉
      }
      let run
      try {
        // DSH 0.1.0-rc.6: subagents.start(name, request) 两参数 API
        run = await subagents.start('spawn', {
          parent: exec.agent,
          prompt: [{ type: 'text', text: String(args.task) }, ...imageBlocks],
          signal: exec.signal,
          label: provider + '/' + (model || 'default'),
          agentOptions: model ? { provider, model } : { provider },  // model 现在几乎总有值(见上表)
        })
      } catch (e) {
        return { reply: '委派失败: ' + String((e && e.message) || e), provider, model: model || 'default' }
      }
      try {
        const res = await run.result
        const text = res.output.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
        if (!text) return { reply: '子代理结束(' + res.stopReason + '),无文本输出', provider, model: model || 'default' }
        const skipNote = imageSkipped.length
        ? '[注意] 这些图片未能附上(不存在/非受支持格式/超出大小限制):' + imageSkipped.join(', ') + '\n'
        : ''
      return { reply: skipNote + text, provider, model: model || 'default' }
      } finally {
        await run.dispose()
      }
    },
  }))

  // ── council:多模型交叉核验 + 战绩台账 ──────────────────────────────
  // 为什么要有这个工具:2026-08-18 实测中,doubao 在一道视觉题上把口令编造成
  // SWARM-VISION-7F3K9P、方位也说反了 —— 它是被"三家独立作答 + 第四家仲裁"抓住的。
  // 但那次流程是手写 prompt 拼出来的;日常随手一问不会有人去搭,于是错误就直接进结论。
  // 所以把它固化成一个工具:**隔离作答 → 结构化对照 → 独立仲裁 → 落战绩台账**。
  //
  // 隔离是真的:每个评委走 subagents.start('spawn'),spawn 的语义是"全新子 Agent、
  // 零父上下文",评委之间互相看不见,也看不到本对话历史。
  // (对比:生态里的 review-workflow 只注册了一个 skill,189 行、零 subagents 调用,
  //  它的"角色隔离"是写给模型的指令,不是代码强制的。)
  const COUNCIL_LOG = process.env.DSH_CN_COUNCIL_LOG || HOME + '/.dsh/logs/council-record.jsonl'

  // 单个评委:起一个隔离子代理,量出耗时,失败不抛(一家挂掉不该毁掉整场)
  // ── 真实 token 用量 ─────────────────────────────────────────────────
  // 子代理的结果对象只有 output/stopReason,不带用量;但 `run.localAgent` 是**进程内的
  // 子代理实例**(服务层原样返回 run,未做包装),它的 session.ownEvents() 里每条
  // assistant/message 都挂着真实 usage。所以不用猜 id、不用读会话文件。
  //
  // ⚠️ 必须在 dispose 之前取。spawn 出来的子代理是全新会话、零父级上下文、只跑一轮,
  // 所以整个 events 都属于这一次运行,可以直接全量求和。
  //
  // ⚠️ 只报 token,**不换算金额**。绝大多数国产家走套餐(边际成本为零,算钱是假精确),
  // 按量计费那家的单价又不该由我写死在代码里 —— 编一个数字比不报更糟。
  const usageOf = (run) => {
    try {
      const ev = ownSessionEvents(run?.localAgent?.session)
      if (ev.length === 0) return null
      let inp = 0, out = 0, cache = 0, think = 0, n = 0
      for (const e of ev) {
        const u = e && e.data && e.data.usage
        if (!u) continue
        n++
        inp += Number(u.inputTokens) || 0
        out += Number(u.outputTokens) || 0
        cache += Number(u.cacheReadTokens) || 0
        think += Number(u.reasoningTokens) || 0
      }
      return n ? { in: inp, out, cache, think, msgs: n } : null
    } catch { return null }   // 拿不到就是拿不到,返回 null,由调用方显示"用量不可得"
  }

  // opts.noTools:把子代理的全局工具层清空(toolFilter.allow=[] → 一个都不给)。
  //
  // ⚠️ 这条是 2026-08-18 实测出来的必需项,不是洁癖。评审员默认继承**全套工具**,
  // 于是问一个"从哪个 macOS 版本引入"这种事实题,三家里有两家直接开了研究会:
  // 一家 33 次工具调用(web_search 17 + web_fetch 13 + browser_open 1)跑了 412 秒还没停,
  // 一家 15 次 254 秒,只有一家 0 次工具 9.3 秒答完 —— 那家才是 council 想要的行为。
  // 慢只是表症。真正的问题是**交叉验证失效**:三家都去读同一批网页的话,
  // 拿到的是"同一批来源的三份摘要",不是三个独立判断,比对出来的一致性毫无意义。
  // 评审员要的就是各自凭已有知识作答 —— 要查资料是委派任务(delegate_task)的活。
  //
  // opts.timeoutMs:单个评审员的墙钟上限。没有它的话,一个跑飞的评审员能把整场评审拖住。
  const runPanelist = async (exec, provider, model, prompt, imageBlocks, opts = {}) => {
    const t0 = Date.now()
    let run
    try {
      run = await subagentsService().start('spawn', {
        parent: exec.agent,
        prompt: [{ type: 'text', text: prompt }, ...imageBlocks],
        signal: exec.signal,
        label: 'council:' + provider,
        agentOptions: model ? { provider, model } : { provider },
        ...(opts.noTools ? { toolFilter: { allow: [] } } : {}),
      })
    } catch (e) {
      return { provider, model, ok: false, text: '', error: String((e && e.message) || e), ms: Date.now() - t0 }
    }
    let timer
    try {
      const limit = Number(opts.timeoutMs) || 0
      const res = limit > 0
        ? await Promise.race([
            run.result,
            new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('超时(' + Math.round(limit / 1000) + 's)未返回')), limit) }),
          ])
        : await run.result
      const text = res.output.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
      const usage = usageOf(run)   // 必须在 finally 的 dispose 之前
      return { provider, model, ok: !!text, text, error: text ? '' : ('无文本输出(' + res.stopReason + ')'), ms: Date.now() - t0, usage }
    } catch (e) {
      return { provider, model, ok: false, text: '', error: String((e && e.message) || e), ms: Date.now() - t0 }
    } finally {
      if (timer) clearTimeout(timer)
      try { await run.dispose() } catch {}
    }
  }
  const subagentsService = () => ctx.get('subagents')

  // ── 战绩台账的读取与统计 ───────────────────────────────────────────
  // 只有把每次核验的结果**读回来**,路由才可能从"按各家宣传排"变成"按实际表现排"。
  const readLedger = async () => {
    try {
      const raw = await readFile(COUNCIL_LOG, 'utf8')
      return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
    } catch { return [] }   // 文件还不存在 = 没有历史,不是错误
  }
  const providerStats = (rows) => {
    const m = new Map()
    for (const r of rows) {
      // ⚠️ 交叉读图(kind:'vision')的评委是 see.py 的视觉后端('mimo'/'minimax' 等名字),
      // 不是 council 的子代理 provider —— 混进来会让 pickPanel 选出一个 subagents 不认识的
      // provider(PROVIDER_DEFAULT_MODEL 里查不到 → 直接失败)。台账共用一个文件是为了
      // 「分歧」面板能一起显示,战绩排位只看文字评审。
      if (r.kind === 'vision') continue
      for (const p of r.panelists || []) {
        const e = m.get(p.provider) || { provider: p.provider, runs: 0, ok: 0, flagged: 0, ms: [] }
        e.runs++
        if (p.ok) e.ok++
        if (p.ok && typeof p.ms === 'number') e.ms.push(p.ms)
        // ⚠️ 只在仲裁**按格式返回**时才计编造 —— 解析失败那次的判定不可信,不能入账
        if (r.parsedOk && Array.isArray(r.flagged) && r.flagged.includes(p.provider)) e.flagged++
        m.set(p.provider, e)
      }
    }
    return [...m.values()].map((e) => {
      const sorted = e.ms.slice().sort((a, b) => a - b)
      const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null
      const okRate = e.runs ? e.ok / e.runs : 0
      const flagRate = e.runs ? e.flagged / e.runs : 0
      // 编造比单纯失败严重得多:失败你看得见,编造会被当成答案用。所以罚分翻倍。
      return { ...e, okRate, flagRate, medianMs: med, score: okRate - 2 * flagRate }
    })
  }
  // 按量计费的家。其余都在套餐内,边际成本为零。
  const METERED = new Set(['deepseek-official'])

  // 选评委:样本够就按战绩挑,但**永远留一个探索位**给样本最少的那家 ——
  // 否则某家因为一次失手就被永久除名,台账会把自己的偏见固化下来。
  const SEASONED_MIN = 2   // 与界面战绩表的门槛同一个常量口径
  const pickPanel = (stats, all, want) => {
    const MIN_SAMPLES = 4
    const seasoned = stats.filter((x) => x.runs >= SEASONED_MIN)
    if (seasoned.length < 2 || stats.reduce((n, x) => n + x.runs, 0) < MIN_SAMPLES) return null
    const ranked = seasoned.slice().sort((a, b) => b.score - a.score || (a.medianMs || 1e9) - (b.medianMs || 1e9))
    const chosen = ranked.slice(0, Math.max(1, want - 1)).map((x) => x.provider)
    // ⚠️ 探索位**跳过按量计费的家**(2026-08-18 实测:它撞上了 deepseek-official,
    // 静默花掉一次真金白银的调用)。探索的目的是"给没试过的家一个机会",
    // 而这个机会不该由钱来买单 —— 套餐内还有没试过的家时,轮不到付费家。
    // 套餐内全部试过了才允许探索付费家,那时它就是唯一剩下的新信息。
    const byRuns = all.map((p) => stats.find((x) => x.provider === p) || { provider: p, runs: 0 })
      .sort((a, b) => a.runs - b.runs)
    // 探索位给**样本最少**的那家;同分档内才偏好套餐。
    //
    // ⚠️ 两版都错过:
    //   v1 直接跳过按量家 → 它永远进不来
    //   v2 回退条件写成"套餐内全部入选后",而每轮只选 2 个、套餐内有 5 家,
    //      那个分支根本到不了 —— 等于 v1 换了个写法
    // 正确的判据是**同分档**:先取候选里场次最少的那一档,在这一档内偏好套餐;
    // 只有当最少那一档全是按量家时才选它。这样它既不会被除名,
    // 也不会在还有更少样本的免费家时抢位。
    const candidates = byRuns.filter((x) => !chosen.includes(x.provider))
    const minRuns = candidates.length ? candidates[0].runs : 0
    const tier = candidates.filter((x) => x.runs === minRuns)
    const explorer = tier.find((x) => !METERED.has(x.provider)) || tier[0]
    if (explorer) chosen.push(explorer.provider)
    return chosen.slice(0, want)
  }

  reg(defineTool({
    name: 'council',
    description: '多模型交叉核验:把同一个问题**并行**发给若干家国产模型的隔离子代理(彼此不可见),收齐答案后交给一个仲裁模型判定一致性与是否有人编造,并把结果记入战绩台账。当答案的正确性重要、或你怀疑某个模型可能幻觉时使用;比单问一家可靠得多。可传 images 让各家原生看图。',
    parameters: {
      question: { type: 'string', required: true, description: '要各家独立回答的问题(自包含,子代理看不到本对话)' },
      panel: { type: 'array', items: { type: 'string' }, description: "评委 provider 列表,默认 ['qwen','minimax-cn','doubao'];可选 stepfun/xiaomi-token-plan-sgp/deepseek-official" },
      arbiter: { type: 'string', description: '仲裁 provider,默认 stepfun(裁判基准 9/9 且最快)。会自动避开评委名单里的家' },
      images: { type: 'array', items: { type: 'string' }, description: '本地图片绝对路径,一并发给每个评委(原生看图)' },
      verify: { type: 'boolean', description: '准仲裁联网查证再判「谁在编造」。默认 false —— 评委一律无工具、凭已有知识独立作答,这样比对的才是三个独立判断而不是同一批网页的三份摘要。开了会慢很多(实测 7 分钟级)。' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', required: true },
          consensus: { type: 'boolean', required: true },
          answers: { type: 'array', required: true, items: { type: 'object' } },
          arbiter: { type: 'string', required: true },
          arbiterMetered: { type: 'boolean', description: '仲裁这家是按量计费而非套餐覆盖' },
          inconclusive: { type: 'boolean', description: '有效答案不足两份,未能进行交叉核验(既非一致也非分歧)' },
          cost: { type: 'object', description: '真实 token 用量,按计费性质分栏;不换算金额' },
          panelSource: { type: 'string' },
        },
        additionalProperties: true,
      },
      render: (a, v) => {
        const rows = (v.answers || []).map(
          (x) => '| ' + x.provider + ' | ' + (x.ok ? String(x.text).replace(/\n+/g, ' ').slice(0, 90) : '⚠️ ' + x.error) + ' | ' + Math.round(x.ms / 100) / 10 + 's |',
        )
        return [{
          type: 'text',
          text: (v.inconclusive ? '🚫 未能核验' : v.consensus ? '✅ 各家一致' : '⚠️ 存在分歧') +
            (v.inconclusive ? '' : '(仲裁 ' + v.arbiter + (v.arbiterMetered ? ' ⚠️按量计费' : '') +
            (v.panelSource ? ' · 评委来源:' + v.panelSource : '') + ')') + '\n\n' +
            '| 评委 | 答案 | 耗时 |\n|---|---|---|\n' + rows.join('\n') +
            (v.cost ? '\n\n**用量**  ' +
              (v.cost.plan.providers.length
                ? '套餐内 ' + v.cost.plan.providers.join('/') + ':入 ' + v.cost.plan.in.toLocaleString() +
                  ' / 出 ' + v.cost.plan.out.toLocaleString() + ' tok(边际成本 0)'
                : '') +
              (v.cost.metered.providers.length
                ? (v.cost.plan.providers.length ? ' · ' : '') + '⚠️ 按量 ' + v.cost.metered.providers.join('/') +
                  ':入 ' + v.cost.metered.in.toLocaleString() + ' / 出 ' + v.cost.metered.out.toLocaleString() + ' tok'
                : '') +
              (v.cost.unknown.length ? ' · 用量不可得:' + v.cost.unknown.join('/') : '')
              : '') +
            '\n\n**仲裁结论**\n' + v.verdict,
        }]
      },
    },
    timeoutMs: 600000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subagents = subagentsService()
      if (subagents === undefined) return { verdict: 'subagents 服务不可用', consensus: false, answers: [], arbiter: '' }

      const ALL_PROVIDERS = ['qwen', 'minimax-cn', 'doubao', 'stepfun', 'xiaomi-token-plan-sgp', 'deepseek-official']
      const DEFAULT_PANEL = ['qwen', 'minimax-cn', 'doubao']
      let panelSource = '调用方指定'
      let panel = Array.isArray(args.panel) && args.panel.length ? args.panel.map(String) : null
      if (!panel) {
        const stats = providerStats(await readLedger())
        const picked = pickPanel(stats, ALL_PROVIDERS, 3)
        if (picked) { panel = picked; panelSource = '按台账战绩(含一个探索位)' }
        else { panel = DEFAULT_PANEL; panelSource = '默认名单(台账样本不足)' }
      }
      panel = panel.slice(0, 6)
      // 仲裁必须不在评委里 —— 自己评自己的答案没有意义。
      //
      // ⚠️ 顺序按**计费方式**排,不是按能力排:前五家都在套餐内(边际成本为零),
      // 按量计费的 deepseek-official 垫底。2026-08-18 实测发现过一次:stepfun 被排进评委席后,
      // 「避开评委」这条规则直接把仲裁落到了 deepseek-official —— 账单从零变成有,
      // 而调用方完全不知情。仲裁只是读几段文本做判断,任何一家套餐模型都够用,
      // 没有理由为它掏钱;真需要它的时候显式传 arbiter 即可。
      const prefer = ['stepfun', 'xiaomi-token-plan-sgp', 'minimax-cn', 'doubao', 'qwen', 'deepseek-official']
      let arbiter = String(args.arbiter || '')
      if (!arbiter || panel.includes(arbiter)) arbiter = prefer.find((p) => !panel.includes(p)) || 'stepfun'

      const imageArgs = Array.isArray(args.images) ? args.images.slice(0, 8) : []
      const imageBlocks = []
      for (const raw of imageArgs) {
        const att = await saveImageAttachment(String(raw))
        if (att) imageBlocks.push({ type: 'image', attachment: att })
      }

      const q = String(args.question)
      // 提示词必须和事实一致:工具层已被清空,还写「必要时查证」只会让它空转一轮再放弃。
      // 「不确定就直说」这句是重点 —— 拿不到工具的模型如果被逼着给确定答案,就会开始编。
      const panelPrompt = q + '\n\n(独立作答:你看不到其他模型的回答,也看不到原对话。'
        + '**你没有任何工具,不要尝试联网或读文件,凭你已有的知识回答。**'
        + '不确定的地方明确写"不确定",不要猜一个具体数字充数。只给结论与必要依据,不要复述题目。)'
      const answers = await Promise.all(
        panel.map((p) => runPanelist(exec, p, PROVIDER_DEFAULT_MODEL[p], panelPrompt, imageBlocks, { noTools: true, timeoutMs: 150000 })),
      )

      const ok = answers.filter((a) => a.ok)
      if (ok.length < 2) {
        // 少于两份有效答案就无从比对 —— 直说,不硬凑一个"一致"
        // ⚠️ 这里**不能**只把 consensus 设成 false 就返回 —— 渲染会把它显示成
        // 「⚠️ 存在分歧」,而真实情况是"根本没法比对"。把"未能判定"显示成"有分歧",
        // 等于凭空造出一个并不存在的结论,比不显示更糟。用单独的 inconclusive 标记。
        // 整条丢弃会让 inconclusive 场次从 okRate 分母消失(TASK-019 W6)。
        const verdict = '有效答案不足 ' + ok.length + '/' + answers.length + ',无法交叉核验。失败原因见各行。'
        try {
          await appendFile(COUNCIL_LOG, JSON.stringify(buildCouncilReviewRecord({
            parsedOk: false,
            question: q,
            hadImages: imageBlocks.length,
            arbiter: '(未仲裁)',
            arbiterMetered: false,
            consensus: false,
            inconclusive: true,
            panelists: answers.map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, ms: a.ms, error: a.error || undefined, text: String(a.text || '').slice(0, 6000), usage: a.usage || undefined })),
            verdict,
            disagreements: [],
            flagged: [],
          })) + '\n', 'utf8')
        } catch {}
        return {
          verdict,
          consensus: false, inconclusive: true, answers, arbiter: '(未仲裁)',
        }
      }

      // ⚠️ 盲评:卷面**不写厂商名**,只写「答案N」。
      // 2026-08-18 实测抓到的问题 —— 仲裁点名编造时给的理由里有一条是
      // 「'xiaomi-token-plan-sgp' 名称格式异常,不像已知公开模型名」:
      // 它在评判**信使而不是消息**。把厂商名放进卷面,等于邀请仲裁带品牌成见打分,
      // 而这套机制的全部意义是让内容自己说话。所以卷面匿名,仲裁按序号点名,回来我再映射。
      const sheet = ok.map((a, i) => '【答案' + (i + 1) + '】\n' + a.text).join('\n\n')
      // ⚠️ 仲裁必须输出**结构化 JSON**。第一版让它写自由文本,再用正则去捞"谁编造",
      // 换个说法就抓不到 —— 台账里的 flagged 因此不可信。判定结果要入账,就不能靠猜措辞。
      const arbPrompt =
        '下面是若干个模型对**同一个问题**的独立回答。问题是:\n' + q + '\n\n' + sheet +
        '\n\n只输出一个 JSON 对象,不要任何其他文字、不要代码围栏:\n' +
        '{"consensus": true|false, "disagreements": ["分歧点1", ...], ' +
        '"suspect": [更可能编造的答案**序号**(数字,如 1、2),没有就空数组], ' +
        '"reason": "判据一句话", "conclusion": "你认为最可信的结论"}\n' +
        '判据只看内容本身(如凭空插入字符、与多数明显冲突);' +
        '**不要因为某个答案更长或语气更肯定就采信它**。' +
        '你看不到这些答案出自哪个模型,也不需要知道 —— 只评内容。'
      // 仲裁默认**不给工具**:它的职责是判断这几份答案彼此是否自洽,不是自己去查真值。
      // 但「谁在编造」这一项确实靠查证更准 —— 2026-08-18 那次仲裁翻了外部资料后,
      // 准确点名了两家的杜撰用法,代价是 435 秒且不可复现。所以做成开关:
      // 默认便宜快速,verify=true 时才准它查,由调用方按这次评审值不值这个时间来定。
      const deepVerify = args.verify === true
      const arb = await runPanelist(exec, arbiter, PROVIDER_DEFAULT_MODEL[arbiter], arbPrompt, [],
        deepVerify ? { timeoutMs: 480000 } : { noTools: true, timeoutMs: 120000 })
      const extracted = parseCouncilVerdict(arb.ok ? arb.text : '')
      const parsed = extracted.parsed
      const ev = evaluateCouncilStructure({
        parsed,
        panelists: answers,
        kind: 'review',
        parseReason: extracted.reason,
      })
      // suspect 只认真实存在的评委名 —— 模型偶尔会编一个不在名单里的名字
      // 序号 → 厂商名的映射在**我这一侧**做:仲裁只知道"答案2有问题",
      // 落进台账的才是真正的厂商名。序号越界或不是数字的一律丢掉,不猜。
      const flagged = ev.parsedOk && parsed && Array.isArray(parsed.suspect)
        ? parsed.suspect
            .map((x) => Number(String(x).replace(/[^0-9]/g, '')))
            .filter((n) => Number.isInteger(n) && n >= 1 && n <= ok.length)
            .map((n) => ok[n - 1].provider)
            .filter((x, i, arr) => arr.indexOf(x) === i)
        : []
      const disagreements = ev.disagreements
      const consensus = ev.consensus
      const verdict = councilReviewVerdict({
        arbOk: arb.ok,
        arbError: arb.error,
        arbText: arb.text,
        parsed,
        consensus,
        flagged,
        parsedOk: ev.parsedOk,
        structureReason: ev.reason,
      })

      // ── 战绩台账:谁答了、谁挂了、谁被判编造、各自多久 ──────────────
      // 只有把每次核验的结果落盘,路由才可能从"按宣传排"变成"按实际表现排"。
      // kind + 独立 disagreements:与 vision 路径同口径(TASK-018 W1)。
      // 新记录缺这两个字段时,台账页会说「本条记录早于该字段」—— 那是假解释。
      try {
        await appendFile(COUNCIL_LOG, JSON.stringify(buildCouncilReviewRecord({
          parsedOk: ev.parsedOk,
          question: q,
          hadImages: imageBlocks.length,
          arbiter,
          arbiterMetered: METERED.has(arbiter),
          consensus,
          inconclusive: ev.inconclusive,
          // text 是给「分歧视图」对照用的答案原文。截到 6000 字:
          // 台账是本机日志,不外发;但没有上限的话一条记录能顶到几百 KB,读取端会被拖垮。
          panelists: answers.map((a) => ({ provider: a.provider, model: a.model, ok: a.ok, ms: a.ms, error: a.error || undefined, text: String(a.text || '').slice(0, 6000), usage: a.usage || undefined })),
          verdict,
          disagreements,
          flagged,
          structureReason: ev.reason,
        })) + '\n', 'utf8')
      } catch {}

      // 用量汇总。按**计费性质**分栏,而不是混成一个总数 ——
      // 套餐内那些 token 的边际成本是零,和按量计费的 token 加在一起会给人错误的量级感。
      const allRuns = [...answers, { provider: arbiter, usage: arb.usage }]
      const cost = { plan: { in: 0, out: 0, providers: [] }, metered: { in: 0, out: 0, providers: [] }, unknown: [] }
      for (const r of allRuns) {
        const bucket = METERED.has(r.provider) ? cost.metered : cost.plan
        if (!r.usage) { cost.unknown.push(r.provider); continue }
        bucket.in += r.usage.in
        bucket.out += r.usage.out
        if (!bucket.providers.includes(r.provider)) bucket.providers.push(r.provider)
      }
      return { verdict, consensus, inconclusive: !ev.parsedOk || ev.inconclusive, answers, arbiter, panelSource, arbiterMetered: METERED.has(arbiter), cost }
    },
  }))

  // ── plan_run:计划 / 执行 / 验收 三段分离,三段可以是不同厂商 ──────────
  // 借鉴 Codex 的 update_plan(可见的计划状态机)与 Claude 的 plan mode(先给人看再执行)。
  // 放到多模型场景里,真正的价值是**三段可以用不同的模型**:
  //   贵而强的出计划 → 便宜的批量执行 → 另一家验收(执行者自己验自己没有意义)
  //
  // ⚠️ 最重要的一条设计:**不带 approve 时只出计划、绝不执行**。
  // 计划是给人看和改的交接物;自动执行一个没人看过的计划,正是 plan mode 要防的事。
  //
  // 2026-08-19 计划模式合并(计划 21 的 A4):执行阶段改走 swarm 调度器(runNormalizedBatch)。
  //   · 波次 = 对 dependsOn 做 Kahn 分层;每一波跑一个批次,行合并进同一张进度表
  //     (publishProgress),前端 swarm 卡片已给 plan_run 注册了 toolview,实时行/结算行直接能画;
  //   · 步骤带 type 时按 swarm 的 modelMapping(resolveModelForType,分派表唯一真源)选厂商,
  //     没 type 或表里没有的用 executor —— 别处再抄一份表就会漂移;
  //   · 计划可以直接以 JSON 传入(plan-mode 批准后的 ```dsh-plan 块就是这么来的);
  //     没有 planFile 时先落盘到 PLAN_DIR(与 exit_plan_mode 批准时 A3 落的同一份计划按步骤签名去重复用),
  //     追踪页的计划面板才看得见;
  //   · 两个阶段的返回都是**字符串**:计划阶段是 markdown(卡片没有行,退回显示原文);
  //     执行阶段是 civ_run 同款 <agent_swarm_result> XML + markdown 摘要,presentationMeta 解析成行。
  // PLAN_DIR 定义在 plansRoute 上方(与路由、A3 三方共用同一个)。

  const clipText = (s, n) => { const t = String(s ?? ''); return t.length > n ? t.slice(0, n) + '…' : t }
  // 子代理偶尔把提示里的 <system-reminder> 原样吐回(civ 实测 minimax 干过);进了上游注入/验收只会污染
  const stripReminders = (s) => String(s ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '').trim()

  // 步骤宽松校验:id 唯一(数字/字符串都行,按 String 比较,缺省用序号)、dependsOn 只留指向存在步骤的、
  // 自依赖丢弃、超过 12 步截断。丢掉什么都记进 notes,写进输出让人看见,不静默。
  const normalizePlanSteps = (raw) => {
    const notes = []
    const seen = new Set()
    const steps = []
    const list = Array.isArray(raw) ? raw : []
    if (list.length > 12) notes.push('步骤超过 12 个,只执行前 12 个')
    list.slice(0, 12).forEach((st, i) => {
      if (!st || typeof st !== 'object') { notes.push('第 ' + (i + 1) + ' 项不是步骤对象,已丢弃'); return }
      let id = st.id
      if (id === undefined || id === null || id === '') id = i + 1
      if (typeof id === 'string' && /^\d+$/.test(id.trim())) id = Number(id.trim())
      if (typeof id !== 'number') id = String(id)
      const key = String(id)
      if (seen.has(key)) { notes.push('步骤 id ' + key + ' 重复,已丢弃后者'); return }
      seen.add(key)
      steps.push({
        id,
        title: String(st.title || ('步骤' + key)).slice(0, 200),
        detail: String(st.detail || st.title || '').slice(0, 4000),
        dependsOn: Array.isArray(st.dependsOn) ? st.dependsOn.slice() : [],
        ...(st.type ? { type: String(st.type).slice(0, 40) } : {}),
      })
    })
    for (const st of steps) {
      const keep = []
      for (const d of st.dependsOn) {
        const k = String(d)
        if (k === String(st.id)) { notes.push('步骤 ' + st.id + ' 依赖自己,已忽略'); continue }
        const target = steps.find((x) => String(x.id) === k)
        if (!target) { notes.push('步骤 ' + st.id + ' 依赖不存在的 ' + k + ',已忽略'); continue }
        if (!keep.includes(target.id)) keep.push(target.id)
      }
      st.dependsOn = keep
    }
    return { steps, notes }
  }

  // Kahn 分层:每一波 = 所有依赖都已在前面波里的步骤(波内并行,波间串行)。
  // 有环时剩下的全部塞进最后一波一起跑(它们的上游结论会标"未产出"),并把 cyclic 标出来。
  const planWaves = (steps) => {
    const byKey = new Map(steps.map((s) => [String(s.id), s]))
    const remaining = new Set(byKey.keys())
    const waves = []
    let cyclic = false
    while (remaining.size) {
      const wave = [...remaining].filter((k) => byKey.get(k).dependsOn.every((d) => !remaining.has(String(d)))).map((k) => byKey.get(k))
      if (!wave.length) { cyclic = true; waves.push([...remaining].map((k) => byKey.get(k))); break }
      waves.push(wave)
      for (const s of wave) remaining.delete(String(s.id))
    }
    return { waves, cyclic }
  }

  // 从结果 XML 里读回 <plan …/> 标签(presentationMeta 用;与 civ 的 parseCivXml 同一写法)
  const parsePlanTag = (xml) => {
    const m = /<plan ([^>]*)\/>/.exec(String(xml ?? ''))
    if (!m) return null
    const out = {}
    const re = /(\w+)="([^"]*)"/g
    let a
    while ((a = re.exec(m[1])) !== null) out[a[1]] = a[2].replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')
    for (const k of ['steps', 'waves']) if (out[k] !== undefined) out[k] = Number(out[k])
    return out
  }

  // 计划的"步骤签名":id/title/detail/dependsOn/type 逐字相同才算同一份。
  // 用途:plan-mode 批准时 A3 已把 dsh-plan 块落盘,模型下一步再把同一段 JSON 传给 plan_run ——
  // 不去重就是同一份计划两个文件(一份有 markdown 没结果、一份有结果没 markdown),追踪页会看到两条。
  const stepsSignature = (steps) => JSON.stringify((Array.isArray(steps) ? steps : []).map((s) => [
    String((s && s.id) ?? ''), String((s && s.title) ?? ''), String((s && s.detail) ?? ''),
    (s && Array.isArray(s.dependsOn) ? s.dependsOn : []).map(String), s && s.type ? String(s.type) : '',
  ]))
  const findMatchingPlanFile = async (steps, sessionId) => {
    const sig = stepsSignature(steps)
    const names = (await readdir(PLAN_DIR).catch(() => [])).filter((n) => PLAN_NAME.test(n)).sort().reverse().slice(0, 20)
    for (const n of names) {
      try {
        const got = await readPlanObject(n)
        if (got.ok && got.obj && got.obj.sessionId === sessionId && !got.obj.executedAt && stepsSignature(got.obj.steps) === sig) {
          return { file: PLAN_DIR + '/' + n, obj: got.obj }
        }
      } catch {}
    }
    return null
  }

  const renderPlanTable = (steps, file, headline) => {
    const rows = (steps || []).map((x) => '| ' + x.id + ' | ' + String(x.title || '') + ' | ' + ((x.dependsOn || []).join(',') || '—') + ' | ' + (x.type || '—') + ' |')
    return '📋 ' + headline + '\n\n| # | 步骤 | 依赖 | type |\n|---|---|---|---|\n' + rows.join('\n') +
      (file
        ? '\n\n存盘:`' + file + '`\n看过/改过之后,带 `approve=true, planFile="' + file + '"` 再调一次才会执行。'
        : '\n\n带 `approve=true` 再调一次才会执行。')
  }

  reg(defineTool({
    name: 'plan_run',
    description: '把一个目标拆成「计划→执行→验收」三段,每段可指定不同厂商模型。**第一次调用只产出计划并存盘,不执行**;人看过(可改)之后,带 approve=true 与 planFile(或 plan=计划 JSON 原文)再调一次才会执行。执行阶段走 swarm 调度器:按 dependsOn 拓扑分波并行,步骤带 type(coder/deep/explore/review/reason/docs/fast)时按 swarm 分派表选厂商,否则用 executor;最后由另一家模型对照目标验收,结果写回计划文件。适合多步骤、想让人在中间把关的任务;计划模式(exit_plan_mode)批准后附带 dsh-plan 块的计划也由这里执行。',
    parameters: {
      goal: { type: 'string', description: '要达成的目标(出计划阶段必填;执行阶段可省略,取计划文件里的)' },
      planner: { type: 'string', description: '出计划的 provider,默认 deepseek-official' },
      executor: { type: 'string', description: '执行每一步的默认 provider,默认 qwen(步骤带 type 且分派表命中时以分派表为准)' },
      reviewer: { type: 'string', description: '验收的 provider,默认 minimax-cn;会自动避开 executor' },
      approve: { type: 'boolean', description: '为 true 才执行。默认 false = 只出计划' },
      planFile: { type: 'string', description: '执行阶段传入之前存盘的计划文件路径' },
      plan: { type: 'string', description: '直接传入(可能被人改过的)计划 JSON 原文,形如 {"steps":[{"id":1,"title":"…","detail":"…","dependsOn":[],"type":"coder"}]};优先于 planFile。不带 planFile 时会先存盘再执行' },
    },
    output: {
      // 两个阶段都返回字符串:执行阶段是 <agent_swarm_result> XML + markdown(与 civ_run 同款),
      // 前端 swarm 卡片经 presentationMeta 画行;计划阶段是纯 markdown,解析出零行,卡片退回显示原文。
      schema: { type: 'string' },
      render: (_a, v) => [{ type: 'text', text: v }],
      presentationMeta: (args, value) => {
        const tag = parsePlanTag(value)
        // SWARM 只在执行阶段被加载;计划阶段没有 <subagent> 行,不需要它
        const rows = SWARM ? SWARM.parseResultsXml(String(value ?? '')) : []
        const goal = String((tag && tag.goal) || (args && args.goal) || (args && args.planFile ? basename(String(args.planFile)) : '') || '')
        return {
          description: '[plan] ' + goal + (tag ? '' : ' · 尚未执行'),
          xml: value,
          assessment: null,
          plan: tag,
          subagents: rows.map((r) => ({
            index: r.task.index, item: r.task.item ?? null, type: r.task.type ?? null,
            model: r.task.model?.model ?? null, status: r.status, state: r.state ?? null,
            agentId: r.agentId ?? null, error: r.error ?? null, result: r.result ?? null,
            modelLabel: r.modelLabel ?? null, toolCalls: r.toolCalls ?? 0,
            toolList: r.toolList ?? null, elapsedMs: r.elapsedMs ?? 0, offsetMs: r.offsetMs ?? 0,
            alive: r.alive === true, stopped: r.stopped === true,
          })),
        }
      },
    },
    timeoutMs: 1800000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const subagents = subagentsService()
      if (subagents === undefined) return '❌ subagents 服务不可用'
      const planner = String(args.planner || 'deepseek-official')
      const executor = String(args.executor || 'qwen')
      let reviewer = String(args.reviewer || 'minimax-cn')
      // 执行者不能给自己验收 —— 换一家,换不动就明说
      if (reviewer === executor) reviewer = ['minimax-cn', 'stepfun', 'doubao', 'qwen'].find((x) => x !== executor) || reviewer

      // ── 读入计划:plan(JSON 字符串;程序化调用也接受对象)优先于 planFile ──
      let planObj = null
      // ⚠️ 安全(审计 2026-08-20):planFile 是模型可控的路径,原来既读又写回(mkdir+writeFile)→ 任意文件覆盖。
      // 与 /api/cn/plans 同一道闸 planPathOk:只认 PLAN_DIR 内的 plan-<数字>.json,别的路径一律拒绝并说明。
      let planFile = ''
      if (args.planFile) {
        const named = resolvePlanPath(String(args.planFile), PLAN_DIR)
        if (!named.ok) return '❌ planFile 只能是 ' + PLAN_DIR + '/plan-<数字>.json(出计划阶段存盘的那个路径);不接受其它目录或文件名:' + String(args.planFile)
        planFile = named.path
      }
      if (args.plan !== undefined && args.plan !== null && args.plan !== '') {
        planObj = typeof args.plan === 'string' ? parseFirstJsonObject(args.plan)
          : (typeof args.plan === 'object' && !Array.isArray(args.plan) ? args.plan : null)
        if (!planObj) return '❌ plan 不是合法 JSON(需要 {"steps":[{"id":1,"title":"…","detail":"…","dependsOn":[]}]})'
      }
      let planFromFile = null
      if (!planObj && planFile) {
        const got = await readPlanObject(planFile)
        planObj = got.ok ? got.obj : null
        if (!planObj) return '❌ 读不到计划文件:' + planFile
        planFromFile = planObj
      }

      // ── 阶段一:出计划(不执行) ────────────────────────────────────
      if (!planObj) {
        if (!args.goal) return '❌ 出计划阶段必须给 goal'
        // 计划者不禁工具(拆步骤时看一眼工作区是合理的),只压墙钟上限
        const pr = await runPanelist(exec, planner, PROVIDER_DEFAULT_MODEL[planner],
          '把下面这个目标拆成可独立执行的步骤。目标:\n' + String(args.goal) +
          '\n\n只输出 JSON,不要围栏不要解释:\n' +
          '{"steps":[{"id":1,"title":"一句话步骤名","detail":"给执行者的自包含指令(它看不到目标和其他步骤)","dependsOn":[],"type":"coder"}]}\n' +
          '要求:步骤 ≤ 8 个;能并行的就不要写依赖;detail 必须自包含;type 按动作性质从 coder/deep/explore/review/reason/docs/fast 里选,拿不准就省略。', [], { timeoutMs: 240000 })
        if (!pr.ok) return '❌ 出计划失败: ' + pr.error
        const obj = parseFirstJsonObject(pr.text)
        if (!obj || !Array.isArray(obj.steps) || !obj.steps.length) {
          return '❌ 计划未按 JSON 返回,原文:\n' + pr.text.slice(0, 600)
        }
        const file = PLAN_DIR + '/plan-' + Date.now() + '.json'
        try {
          await writePlanObject(file, { goal: String(args.goal), planner, source: 'plan_run', steps: obj.steps }, { create: true })
        } catch (error) { return '❌ 计划保存失败: ' + String(error.message || error) }
        return renderPlanTable(obj.steps, file, '计划已生成(**尚未执行**)')
      }

      // ── 阶段二:执行(必须显式 approve + 当前会话的 exit_plan_mode 宿主证据) ──
      if (args.approve !== true) {
        return renderPlanTable(planObj.steps || [], planFile, '已读到计划但**未获批准** —— 带 approve=true 才会执行')
      }
      // approve:true / approvedAt / 文件存在都不是授权。必须有本会话
      // exit_plan_mode 成功 tool/call+tool/result，且 dsh-plan 步骤指纹仍匹配。
      const session = exec.agent && exec.agent.session
      const sessionId = session && typeof session.id === 'string' ? session.id : ''
      const gate = evaluatePlanApproval({
        sessionId,
        plan: planObj,
        approvalRecord: planFromFile || planObj,
        hostEvent: sessionId
          ? { sessionId, events: ownSessionEvents(session) }
          : null,
      })
      if (!gate.ok) {
        if (!planFromFile && !planFile) {
          const file = PLAN_DIR + '/plan-' + Date.now() + '.json'
          try {
            await writePlanObject(file, { goal: String(args.goal || planObj.goal || ''), planner: String(planObj.planner || 'plan-mode'), source: String(planObj.source || 'plan-mode'), steps: planObj.steps }, { create: true })
            planFile = file
          } catch (error) { return '❌ 计划保存失败: ' + String(error.message || error) }
        }
        const why = gate.code === 'UNWIRED'
          ? '未接线/本会话没有 exit_plan_mode 批准对'
          : '批准无效(' + (gate.reason || gate.code) + ')'
        return renderPlanTable(planObj.steps || [], planFile, '计划已存盘但**未执行**:' + why + ' —— 请在当前会话用计划模式批准后再带 `approve=true, planFile="' + planFile + '"` 再调一次。approve=true / approvedAt / 文件存在单独都不构成授权。')
      }
      let swarm
      try { swarm = await loadSwarm() } catch (e) {
        return '❌ 无法加载 swarm 调度器(dsh-kimicode-swarm):' + String((e && e.message) || e)
      }
      const t0 = Date.now()
      const { steps, notes } = normalizePlanSteps(planObj.steps)
      if (!steps.length) return '❌ 计划里没有可执行的步骤' + (notes.length ? '(' + notes.join(';') + ')' : '')

      // 计划 JSON 直传且没有 planFile:先落盘,追踪页的计划面板才看得见。
      // exit_plan_mode 批准时(A3)可能刚落过同一份 —— 步骤签名一致且没跑过就复用那份,不重复建档。
      let matched = null
      if (!planFile) matched = await findMatchingPlanFile(planObj.steps, sessionId)
      const fileObj = matched ? matched.obj : null
      // 直传的计划 JSON 通常只有 steps(dsh-plan 块就是这样):目标取参数/匹配到的文件,
      // 计划者/来源没写就记 plan-mode(计划模式批准是直传的主路径);plan_run 自己出的计划文件里带 planner/source
      const goalGiven = String(args.goal || planObj.goal || (fileObj && fileObj.goal) || '').trim()
      const goal = goalGiven || '(未提供目标,按各步骤标题验收)'
      const plannerLabel = String(planObj.planner || (fileObj && fileObj.planner) || 'plan-mode')
      const source = String(planObj.source || (fileObj && fileObj.source) || 'plan-mode')
      if (!planFile) {
        if (matched) planFile = matched.file
        else {
          planFile = PLAN_DIR + '/plan-' + Date.now() + '.json'
          try {
            await writePlanObject(planFile, { goal: goalGiven, planner: plannerLabel, source, steps, sessionId }, { create: true })
          } catch (e) { return '❌ 计划落盘失败，未执行:' + String((e && e.message) || e) }
        }
      }

      // 波次与行序:行 index = 步骤在"波次展平"里的位置(1 起),跨波保持稳定,进度表按它合并
      const { waves, cyclic } = planWaves(steps)
      if (cyclic) notes.push('依赖成环,成环的步骤放在最后一波一起执行(它们拿不到彼此的结论)')
      const flat = waves.flat()
      const keyOf = (st) => String(st.id)
      const byKey = new Map(steps.map((s) => [keyOf(s), s]))
      const rowIndex = new Map(flat.map((s, i) => [keyOf(s), i + 1]))
      const keyByIndex = new Map(flat.map((s, i) => [i + 1, keyOf(s)]))
      // 派给谁:步骤有 type 且 swarm 分派表命中 → 表里的厂商;否则 executor 的默认模型。
      // resolveModelForType 是 2026-08-19 才加进 swarm 的导出;老副本(如 profile 漂移时的 web 侧)没有它,
      // 那就整体回落到 executor,而不是让整个 plan_run 炸掉 —— 分派只是优化,执行才是目的。
      const resolveType = typeof swarm.resolveModelForType === 'function' ? swarm.resolveModelForType : () => undefined
      const modelOf = (st) => {
        const m = st.type ? resolveType(st.type) : undefined
        if (m && m.model) return m
        return { provider: executor, model: PROVIDER_DEFAULT_MODEL[executor] }
      }
      const itemOf = (st) => '#' + st.id + ' ' + st.title
      const parentSessionId = exec.agent?.session?.id ?? exec.agent?.id
      const ROWS = new Map()
      for (const st of flat) {
        const m = modelOf(st)
        ROWS.set(keyOf(st), { index: rowIndex.get(keyOf(st)), item: itemOf(st), type: st.type ?? null, provider: m.provider ?? null, model: m.model ?? null, status: 'queued', toolCalls: 0, toolList: null, elapsedMs: 0, agentId: null, alive: false, stopped: false })
      }
      const publish = () => swarm.publishProgress(exec.callId, [...ROWS.values()].sort((a, b) => a.index - b.index), parentSessionId)
      publish()

      // ⚠️ 调度器内部经 ctx.subagents(属性)取服务,而本插件的 inject 只有 tools ——
      // cordis 4 对未 inject 的服务走属性访问会抛 "cannot get property … without inject"
      // (ctx.get 才是"without the inject requirement"的那条路)。所以给它一个只含它用到的
      // 两样东西的壳:subagents 与 get。civ 不需要这一层是因为它把 subagents 写进了 inject。
      const swarmCtx = { subagents, get: (n) => ctx.get(n) }
      const baseName = basename(planFile || 'plan.json')
      const done = new Map()   // key → { id, title, ok, status, text, error, ms, provider, model, agentId, toolCalls, toolList }
      for (const wave of waves) {
        if (exec.signal?.aborted) break
        const tasks = wave.map((st) => {
          // 上游结论**注入下游**。dependsOn 不只是先后顺序:每个上游步骤的产出以「上游结论」段落
          // 拼进下游提示词;上游失败/未跑时明写"未产出",让下游知道该绕开而不是当作没有依赖。
          const deps = st.dependsOn.map((d) => ({ d, r: done.get(String(d)) }))
          const upstream = deps.length
            ? '\n\n【上游结论(你依赖的步骤已完成,以下是它们的产出,可直接使用)】\n' +
              deps.map(({ d, r }) => '— 步骤' + d + '「' + ((r && r.title) || (byKey.get(String(d)) || {}).title || '') + '」:' +
                (r ? (r.ok ? clipText(r.text, 3000) : '(未产出:' + (r.error || '失败') + ')') : '(未产出:该步骤未执行)')).join('\n\n')
            : ''
          return {
            index: rowIndex.get(keyOf(st)),
            kind: 'spawn',
            item: itemOf(st),
            prompt: String(st.detail || st.title) + upstream + '\n\n输出你负责部分的结论(自包含)。',
            type: st.type,
            model: modelOf(st),
            resumeAgentId: undefined,
            description: 'plan:' + baseName + ':' + st.id,
          }
        })
        const collect = {}
        await swarm.runNormalizedBatch(swarmCtx, exec, { description: 'plan_run:' + goal.slice(0, 60), tasks }, {
          keepAlive: false,
          collect,
          onRows: (rows) => {
            for (const r of rows) {
              const key = keyByIndex.get(r.index)
              if (key && ROWS.has(key)) ROWS.set(key, { ...ROWS.get(key), ...r, item: ROWS.get(key).item })
            }
            publish()
          },
        })
        for (const r of collect.rows ?? []) {
          const key = keyByIndex.get(r.task.index)
          const st = byKey.get(key)
          if (!st) continue
          const ok = r.status === 'completed'
          done.set(key, {
            id: st.id, title: st.title, ok, status: r.status,
            text: ok ? stripReminders(r.result ?? '') : '',
            error: ok ? '' : String(r.error ?? 'error'),
            ms: r.elapsedMs ?? 0, provider: r.task.model?.provider, model: r.task.model?.model,
            agentId: r.agentId, toolCalls: r.toolCalls ?? 0,
            toolList: Array.isArray(r.tools) && r.tools.length ? r.tools.map((t) => t.name + '×' + t.n).join(',') : null,
          })
        }
      }

      // ── 阶段三:验收(换一家) ──────────────────────────────────────
      const sheet = flat.map((st) => {
        const r = done.get(keyOf(st))
        return '【步骤' + st.id + ' ' + st.title + '】' + (r ? (r.ok ? r.text : '(失败:' + r.error + ')') : '(未执行)')
      }).join('\n\n')
      const rev = await runPanelist(exec, reviewer, PROVIDER_DEFAULT_MODEL[reviewer],
        '目标是:\n' + goal + '\n\n下面是各步骤的执行结果:\n' + sheet +
        '\n\n请判断:目标是否达成?哪些步骤有问题?简短给结论,不要复述内容。', [], { noTools: true, timeoutMs: 180000 })
      const reviewText = rev.ok ? stripReminders(rev.text) : ('验收失败: ' + rev.error)

      // 把这次执行的结果写回计划文件 —— 计划从"打算做什么"变成"做过什么、结果如何"。
      // 不另开一个结果文件:计划和它的执行记录分开存,看的人就得自己对上号,
      // 而它们本来就是同一件事的两面。键名保持不变(追踪页计划面板按这些键读)。
      const results = flat.map((st) => {
        const r = done.get(keyOf(st))
        return r
          ? { id: st.id, ok: r.ok, ms: r.ms, error: r.ok ? undefined : r.error, provider: r.provider ?? null, model: r.model ?? null, text: clipText(r.text, 3000) }
          : { id: st.id, ok: false, ms: 0, error: '未执行', provider: null, model: null, text: '' }
      })
      let persistenceWarning = ''
      if (planFile) {
        let opened
        try {
          opened = await openPlanFile({ path: planFile, planDir: PLAN_DIR, flags: 'r+' })
          if (!opened.ok) throw new Error(opened.message || opened.code)
          const prev = JSON.parse(await opened.handle.readFile('utf8'))
          if (planFingerprint(prev) !== gate.fingerprint || (prev.sessionId && prev.sessionId !== sessionId)) throw new Error('计划在执行期间已改变，旧结果未写入新计划')
          const updated = {
            ...prev,
            goal: prev.goal || goalGiven,
            steps: Array.isArray(prev.steps) && prev.steps.length ? prev.steps : steps,
            source: prev.source || source,
            executedAt: new Date().toISOString(),
            executor, reviewer,
            results,
            review: clipText(reviewText, 4000),
          }
          const bytes = Buffer.from(JSON.stringify(updated, null, 2))
          await opened.handle.truncate(0)
          let written = 0
          while (written < bytes.length) {
            const part = await opened.handle.write(bytes, written, bytes.length - written, written)
            if (!part.bytesWritten) throw new Error('计划写入未完成')
            written += part.bytesWritten
          }
        } catch (error) {
          persistenceWarning = '结果未持久化: ' + String(error.message || error)
        } finally { await closePlanHandle(opened) }
      }

      // ── 输出:swarm 同款 <subagent> 行 + 一条 <plan/> 标签 + markdown 摘要 ──
      const esc = swarm.escapeXml
      const wallMs = Date.now() - t0
      const nOk = results.filter((r) => r.ok).length
      const lines = ['<agent_swarm_result>', '<summary>' + (nOk === results.length ? 'completed' : 'partial') + ': ' + nOk + '/' + results.length + ' steps, ' + waves.length + ' waves, ' + Math.round(wallMs / 1000) + 's</summary>']
      for (const st of flat) {
        const key = keyOf(st)
        const r = done.get(key)
        const row = ROWS.get(key)
        const outcome = r ? (r.status === 'aborted' ? 'aborted' : (r.ok ? 'completed' : 'failed')) : 'aborted'
        const prov = r ? r.provider : row?.provider
        const mod = r ? r.model : row?.model
        const who = (prov || mod) ? ' model="' + esc(String(prov ?? '') + (mod ? '/' + mod : '')) + '"' : ''
        const body = r ? (r.ok ? r.text : r.error) : 'not started'
        lines.push('<subagent' + (r?.agentId ? ' agent_id="' + esc(String(r.agentId)) + '"' : '') +
          ' item="' + esc(itemOf(st)) + '"' + who + ' state="' + (r ? 'started' : 'not_started') + '"' +
          (r?.ms ? ' ms="' + Math.round(r.ms) + '"' : '') +
          (r?.toolCalls ? ' tool_calls="' + r.toolCalls + '"' : '') +
          (r?.toolList ? ' tools="' + esc(r.toolList) + '"' : '') +
          ' outcome="' + outcome + '">' + esc(clipText(body, 12000)) + '</subagent>')
      }
      const planAttrs = {
        file: planFile, steps: flat.length, waves: waves.length, review_ok: rev.ok ? '1' : '0',
        reviewer, executor, planner: plannerLabel, source, cyclic: cyclic ? '1' : '0',
        goal: clipText(goal, 200), notes: clipText(notes.join(';'), 300),
        persisted: persistenceWarning ? '0' : '1', persistence_error: persistenceWarning,
      }
      lines.push('<plan ' + Object.entries(planAttrs).map(([k, v]) => k + '="' + esc(String(v ?? '')) + '"').join(' ') + '/>')
      lines.push('</agent_swarm_result>')

      const table = flat.map((st) => {
        const r = done.get(keyOf(st))
        const who = r ? String(r.provider ?? '') + (r.model ? '/' + r.model : '') : (ROWS.get(keyOf(st))?.provider ?? '')
        return '| ' + st.id + ' | ' + st.title + ' | ' + who + ' | ' + (r ? (r.ok ? '✅' : '❌ ' + clipText(r.error, 120)) : '⏹ 未执行') + ' | ' + Math.round((r?.ms || 0) / 100) / 10 + 's |'
      })
      const md = '\n\n🚀 **计划执行完毕**(' + waves.length + ' 波 · ' + nOk + '/' + results.length + ' 步成功)\n' +
        (persistenceWarning ? '\n⚠️ ' + persistenceWarning + '\n' : '') +
        (notes.length ? '\n校验:' + notes.join(';') + '\n' : '') +
        '\n| # | 步骤 | 派给 | 结果 | 耗时 |\n|---|---|---|---|---|\n' + table.join('\n') +
        '\n\n**验收(' + reviewer + ')**\n' + reviewText +
        '\n\n(计划 ' + plannerLabel + ' · 执行 ' + executor + ' · 验收 ' + reviewer + ' · 文件 ' + planFile + ')'
      return lines.join('\n') + md
    },
  }))

  // ── 计划模式 ↔ 权限预设联动(A2)+ 已批准计划落盘(A3)──────────────────
  // 原生 plan-mode 做壳(审批卡、exit_plan_mode、plan/mode 事件一律不动),这里只**旁听**会话事件:
  //   A2:进入计划模式 → 预设切到 read-only(记住原来的);退出 → 若仍是 read-only 就切回去。
  //       计划模式的"只读"此前只是写给模型的提示,这一步让沙箱真的只读。
  //   A3:exit_plan_mode 被批准(tool/result 非 isError)→ 从计划 markdown 里抠 ```dsh-plan 块,
  //       落盘到 PLAN_DIR(与 plan_run 同一目录、同一形状),追踪页计划面板可见,plan_run 复用不重建。
  //
  // 事件形状(宿主源码核对过,不是猜的):
  //   plan/mode      data = { active }                                  dsh-plan-mode/lib/index.js:353,368
  //   tool/call      data = { turn, step, callId, name, arguments }      dsh-agent-loop/lib/index.js:293-299
  //                  ⚠️ arguments 是模型原始 JSON **字符串**(流式拼出来的),要自己 JSON.parse
  //   tool/result    data = { turn, step, message, error?, meta? }       dsh-agent-loop/lib/index.js:308-317
  //                  message.content[0] = { type:'tool-result', toolCallId, content, isError }   dsh-llm/lib/index.js:202-215
  //                  批准 = 该 callId 的 tool/result 且 isError !== true(exit_plan_mode 拒绝时 execute 抛错 → isError:true)
  //   permission/preset data = { preset }                                dsh-permission-presets/lib/index.js:274
  //
  // ⚠️ session/event 是在 session.append() 的发布边界**里面同步**派发的(dsh-session/lib/index.js:1452,1472),
  // 此时再 append(pp.set 会 append permission/preset 等)会被宿主以
  // "session append cannot reenter while another append is being published" 拒绝。
  // 所以一切写操作推到微任务之后。pp.set 引发的后续事件再进这个 handler 时,类型不是 plan/mode,开头就被放过。
  const PLAN_REMEMBER = new Map()      // sessionId → 进入计划模式前的预设名
  const PLAN_EXIT_CALLS = new Map()    // sessionId + ':' + callId → exit_plan_mode 的计划 markdown
  const PLAN_PERSISTED = new Set()     // 已落盘过的 callId 键(不重复写)
  const deferWrite = (label, fn) => queueMicrotask(() => {
    try { fn() } catch (e) { console.error('[cn-capabilities/plan] ' + label + ' 失败:', String((e && e.message) || e)) }
  })
  const onPlanModeEvent = (session, event) => {
    const active = !!(event.data && event.data.active)
    const pp = ctx.get('permissionPresets')
    if (pp === undefined) return
    const sid = session.id
    if (active) {
      const cur = pp.current(session)
      if (cur === 'read-only') return
      PLAN_REMEMBER.set(sid, cur)
      deferWrite('进入计划模式切 read-only', () => pp.set(session, 'read-only'))
      return
    }
    const prev = PLAN_REMEMBER.get(sid)
    PLAN_REMEMBER.delete(sid)
    // 'custom' 不是可切换的预设名(pp.set 会抛),进入前就是 custom 的就不动它
    if (!prev || prev === 'custom') return
    deferWrite('退出计划模式恢复 ' + prev, () => {
      // 人在计划模式里手动改过预设(不再是 read-only)→ 尊重人的选择,不覆盖
      if (pp.current(session) === 'read-only') pp.set(session, prev)
    })
  }
  const onToolCallEvent = (session, event) => {
    const d = event.data || {}
    if (d.name !== 'exit_plan_mode' || !d.callId) return
    let a = d.arguments
    if (typeof a === 'string') { try { a = JSON.parse(a) } catch { a = null } }
    const plan = a && typeof a === 'object' && typeof a.plan === 'string' ? a.plan : ''
    if (plan) PLAN_EXIT_CALLS.set(session.id + ':' + d.callId, plan)
  }
  const onToolResultEvent = (session, event) => {
    if (!PLAN_EXIT_CALLS.size) return
    const msg = event.data && event.data.message
    const block = msg && Array.isArray(msg.content) ? msg.content.find((c) => c && c.type === 'tool-result') : null
    const callId = (block && block.toolCallId) || (msg && msg.source && msg.source.callId) || ''
    if (!callId) return
    const key = session.id + ':' + callId
    const plan = PLAN_EXIT_CALLS.get(key)
    if (plan === undefined) return
    PLAN_EXIT_CALLS.delete(key)
    if (!block || block.isError === true || event.data?.error) return
    if (PLAN_PERSISTED.has(key)) return
    PLAN_PERSISTED.add(key)
    const m = /```dsh-plan\s*\n([\s\S]*?)```/.exec(plan)
    if (!m) return                                       // 不可并行的计划不附块 → 与原生行为完全一致,什么都不做
    let obj = null
    try { obj = JSON.parse(m[1]) } catch { obj = parseFirstJsonObject(m[1]) }
    const steps = obj && Array.isArray(obj.steps) ? obj.steps : null
    if (!steps || !steps.length) return
    const file = PLAN_DIR + '/plan-' + Date.now() + '.json'
    writePlanObject(file, {
      goal: firstHeading(plan), planner: 'plan-mode', source: 'plan-mode', sessionId: session.id,
      approvedAt: new Date().toISOString(), markdown: plan, steps,
    }, { create: true })
      .catch((e) => console.error('[cn-capabilities/plan] 已批准计划落盘失败:', String((e && e.message) || e)))
  }
  // 计划模式的「本机附加」以**独立的一段系统提示**接在原生 plan 段之后(order 51,紧跟宿主的 50),
  // **不覆盖** dsh-plan-mode 的 config.section。
  // ⚠️ 为什么不走 cordis.patch.yml 覆盖 section:dsh-plan-mode 在构造函数里 `this.section = resolveConfig(config).section`
  //    抓一次就不再读(2026-08-19 实测);而用户层 overlay 的 config 改动是在插件**构造完之后**才应用的,
  //    改 section 只更新 dump-config 的配置树、不更新活插件 —— dump 有附加、真跑没有。禁用+插入同名实例也不行
  //    (插入在构造后应用 → 新实例根本不加载)。所以改成加法:自己再挂一段,只在计划模式激活时输出。
  const PLAN_APPENDIX = composePlanAppendix()
  // 折叠会话里的 plan/mode 事件,拿到"此刻是否在计划模式"(与 dsh-plan-mode 的 foldPlanMode 同口径:取最后一次)
  const planActive = (events) => {
    if (!Array.isArray(events)) return false
    let active = false
    for (const e of events) if (e && e.type === 'plan/mode') active = !!(e.data && e.data.active)
    return active
  }
  const planAppendixSection = () => {
    const sp = ctx.get('systemPrompt')
    if (!sp || typeof sp.section !== 'function') return
    const off = sp.section({
      name: 'plugin:civ-plan-appendix',
      order: 51,   // 紧跟宿主 plan:policy(order 50)
      text: (context) => (context && context.agent && planActive(snapshotSessionEvents(context.agent.session)) ? PLAN_APPENDIX : ''),
    })
    if (typeof off === 'function') disposers.push(off)
  }
  planAppendixSection()

  const planPermissionLinkage = () => {
    if (typeof ctx.on !== 'function') return
    const off = ctx.on('session/event', (session, event) => {
      try {
        const type = event && event.type
        if (type === 'plan/mode') onPlanModeEvent(session, event)
        else if (type === 'tool/call') onToolCallEvent(session, event)
        else if (type === 'tool/result') onToolResultEvent(session, event)
      } catch (e) {
        console.error('[cn-capabilities/plan] session/event 处理失败:', String((e && e.message) || e))
      }
    })
    if (typeof off === 'function') disposers.push(off)
  }
  planPermissionLinkage()

  // ── council_stats:把台账摊开给人看 ────────────────────────────────
  // 路由一旦开始按战绩选人,人就必须能查"凭什么" —— 否则它就是个不可解释的黑箱。
  reg(defineTool({
    name: 'council_stats',
    description: '查看多模型交叉核验的战绩台账:各 provider 的参与次数、成功率、被判编造次数、中位耗时与综合得分(council 的默认评委名单就是按这个选的)。当你想知道"哪家更靠谱"或"为什么选了这几家"时使用。',
    parameters: {},
    output: {
      schema: { type: 'object', properties: { total: { type: 'number', required: true }, rows: { type: 'array', required: true, items: { type: 'object' } } }, additionalProperties: true },
      render: (a, v) => {
        if (!v.total) return [{ type: 'text', text: '台账还是空的 —— 先跑几次 council 再来看。' }]
        const rows = v.rows.map((r) =>
          '| ' + r.provider + ' | ' + r.runs + ' | ' + Math.round(r.okRate * 100) + '% | ' + r.flagged +
          ' | ' + (r.medianMs ? Math.round(r.medianMs / 100) / 10 + 's' : '—') + ' | ' + r.score.toFixed(2) + ' |')
        return [{ type: 'text', text: '共 ' + v.total + ' 次核验\n\n| provider | 参与 | 成功率 | 被判编造 | 中位耗时 | 得分 |\n|---|---|---|---|---|---|\n' + rows.join('\n') + '\n\n得分 = 成功率 − 2×编造率(编造比失败严重:失败你看得见,编造会被当答案用)' }]
      },
    },
    isConcurrencySafe: () => true,
    async execute() {
      const rows = providerStats(await readLedger()).sort((a, b) => b.score - a.score)
      const all = await readLedger()
      return { total: all.length, rows }
    },
  }))

  // delegate_kimi 工具定义已删(TASK-017):394 会话零调用,ACP 实现文件保留。

  // ── opencli_browser:通过 OpenCLI 浏览器桥驱动已登录 Chrome ──────────
  reg(defineTool({
    name: 'opencli_browser',
    description: "通过 OpenCLI 浏览器桥驱动已登录的 Chrome:打开页面、提取文本、执行 JS、点击、输入、截图。复用 Chrome 登录态(小红书/B站/谷歌等已登录站点直接可用)。action: open(打开URL)/ extract(提取页面文本)/ eval(执行JS)/ state(页面状态)/ click(点击CSS选择器)/ type(向选择器输入文本)/ screenshot(截图)。当用户要求'打开网页'/'浏览'/'抓取网页'/'点页面'时使用。",
    parameters: {
      action: {
        type: 'string',
        enum: ['open', 'extract', 'eval', 'state', 'click', 'type', 'screenshot'],
        required: true,
        description: '浏览器操作',
      },
      url: { type: 'string', description: 'action=open 时的 URL' },
      js: { type: 'string', description: 'action=eval 时的 JS 表达式(如 document.title)' },
      selector: { type: 'string', description: 'action=click/type 时的 CSS 选择器' },
      text: { type: 'string', description: 'action=type 时输入的文字' },
    },
    output: {
      schema: { type: 'object', properties: { result: { type: 'string' } }, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: v.error ? v.error : v.result }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sub = ctx.get('subprocess')
      if (sub === undefined) return { error: 'subprocess 服务不可用' }
      const action = String(args.action || 'open')
      const argv = [OPENCLI_BIN, 'browser', 'dsh', action]
      if (action === 'open' && args.url) argv.push(String(args.url))
      if (action === 'eval' && args.js) argv.push(String(args.js))
      if (action === 'click' && args.selector) argv.push('--selector', String(args.selector))
      if (action === 'type') {
        if (args.selector) argv.push('--selector', String(args.selector))
        if (args.text) argv.push(String(args.text))
      }
      argv.push('--window', 'background')
      const handle = sub.spawn({
        argv,
        cwd: '/',
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 6 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        signal: exec.signal,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null
      const text = out && out.text ? out.text.trim() : ''
      if (outcome.exitCode !== 0) {
        return { error: 'opencli 失败(exit ' + String(outcome.exitCode) + '): ' + ((err && err.text) || '无输出') }
      }
      if (!text) return { error: 'opencli 无输出' }
      return { result: text }
    },
  }))

  // ── opencli_run:通用执行任意 OpenCLI 命令 ────────────────────────────
  reg(defineTool({
    name: 'opencli_run',
    description: '通用执行 OpenCLI 命令:传入 opencli 参数数组,返回命令输出。如 ["arxiv","recent","cs.LG","--limit","10"] 执行 opencli arxiv recent cs.LG --limit 10。用于适配器命令(bilibili/xiaohongshu/zhihu/arxiv 等站点)与外部 CLI(gh/docker)。当需要一个 opencli_browser 未覆盖的 opencli 能力时使用。',
    parameters: {
      args: {
        type: 'array',
        items: { type: 'string' },
        required: true,
        description: 'opencli 子命令参数数组(不含 opencli 本身)',
      },
      format: {
        type: 'string',
        enum: ['auto', 'json', 'csv', 'md', 'yaml', 'table'],
        description: '输出格式,可选',
      },
      app: {
        type: 'string',
        description: '可选,要驱动的桌面 app 名(如 codex / antigravity / cursor / trae-cn)。提供时自动注入 OPENCLI_CDP_ENDPOINT 连接已运行的 app(如 opencli codex ask "任务")',
      },
      cdp_port: {
        type: 'number',
        description: '可选,app 的 CDP 调试端口,默认 9229',
      },
    },
    output: {
      schema: { type: 'object', properties: { result: { type: 'string' } }, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: v.error ? v.error : v.result }],
    },
    timeoutMs: 300000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sub = ctx.get('subprocess')
      if (sub === undefined) return { error: 'subprocess 服务不可用' }
      const list = Array.isArray(args.args) ? args.args.map(String) : []
      if (list.length === 0) return { error: '需要 args 参数数组' }
      const argv = [OPENCLI_BIN, ...list]
      if (args.format && args.format !== 'auto') argv.push('-f', String(args.format))
      const spawnEnv = {}
      if (args.app) {
        const port = Number(args.cdp_port) || 9229
        spawnEnv.OPENCLI_CDP_ENDPOINT = 'http://127.0.0.1:' + port
      }
      const handle = sub.spawn({
        argv,
        cwd: '/',
        env: Object.keys(spawnEnv).length ? spawnEnv : undefined,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 6 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 5000,
        signal: exec.signal,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null
      const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null
      const text = out && out.text ? out.text.trim() : ''
      if (outcome.exitCode !== 0) {
        return { error: 'opencli 失败(exit ' + String(outcome.exitCode) + '): ' + ((err && err.text) || '无输出') }
      }
      if (!text) return { error: 'opencli 无输出' }
      return { result: text }
    },
  }))

  // ── autoresearch:Karpathy 式自主迭代循环(修改委派给国产模型子代理) ──
  reg(defineTool({
    name: 'autoresearch',
    description: 'Karpathy 式自主迭代优化循环:给定目标(goal)+ 验证命令(verify,输出一个数字指标),循环让国产模型子代理做一次原子修改 → 验证 → 改进则保留(commit)否则回滚(discard)→ 记录日志。默认在 ~/Projects/OpenCLI 下运行。当用户要求"自主优化 X / 提升某指标 / 自动迭代改进"时使用。',
    parameters: {
      goal: { type: 'string', required: true, description: '优化目标,如"提升浏览器命令通过率到 59/59"' },
      verify: { type: 'string', required: true, description: '可信验证命令，在独立的基线副本叠加候选源代码后执行。stdout 必须输出 METRIC=数字 或 {"metric":数字}（metric 参数可指定字段）。测试/评分/配置不得由候选修改。' },
      scope: { type: 'string', description: '可修改文件范围(逗号分隔 glob,可选)' },
      metric: { type: 'string', description: '指标名,默认 metric' },
      direction: { type: 'string', enum: ['higher', 'lower'], description: '优化方向,默认 higher' },
      iterations: { type: 'integer', description: '迭代轮数,默认 5' },
      cwd: { type: 'string', description: '工作目录,默认 ~/Projects/OpenCLI' },
      provider: { type: 'string', description: '修改子代理的模型 provider,默认 qwen' },
      model: { type: 'string', description: '修改子代理的模型 id,默认 qwen3.8-max' },
    },
    output: {
      schema: { type: 'object', properties: { report: { type: 'string' } }, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: v.error ? v.error : v.report }],
    },
    timeoutMs: 1800000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const subagents = ctx.get('subagents')
      if (subagents === undefined) return { error: 'subagents 服务不可用' }

      const cwd = String(args.cwd || process.env.HOME + '/Projects/OpenCLI')
      const goal = String(args.goal || '')
      const verify = String(args.verify || '')
      if (!goal || !verify) return { error: '需要 goal 和 verify 参数' }
      const scope = args.scope ? String(args.scope) : 'src/**,lib/**,app/**,pkg/**,clis/**'
      const sourceAllowlist = scope.split(',').map((s) => s.trim()).filter(Boolean)
      const metric = String(args.metric || 'metric')
      const direction = args.direction === 'lower' ? 'lower' : 'higher'
      const iterations = Math.max(1, Math.min(20, Number(args.iterations) || 5))
      const provider = String(args.provider || 'qwen')
      const model = args.model ? String(args.model) : 'qwen3.8-max'
      const metricSpec = { field: metric }

      const workspace = await createIsolatedAutoresearchWorkspace({
        sourceRepo: cwd,
        sourceAllowlist,
      })
      if (!workspace.ok) {
        return { error: '隔离工作区创建失败: ' + (workspace.error || 'unknown') }
      }

      const lines = []
      const outcome = { report: '' }
      const iterationRecords = []
      const artifactDir = join(process.env.DSH_CN_AUTORESEARCH_RESULT_DIR || join(homedir(), '.dsh', 'logs', 'autoresearch'), randomUUID())
      try {
        const measured = await measureIsolatedBaseline({
          workspace,
          verifyCmd: verify,
          metricSpec,
          signal: exec.signal,
        })
        const baseMetric = measured.ok ? measured.metric : NaN
        lines.push('目标: ' + goal)
        lines.push('候选在临时隔离仓评估，原仓保持不变；成功修改导出为补丁。')
        lines.push('指标: ' + metric + '(' + direction + ') | baseline: ' + (measured.ok ? baseMetric : '解析失败:' + (measured.status || measured.reason || '')))
        if (!measured.ok) { lines.push('[停止: baseline 指标无法解析]'); return outcome }

        let best = baseMetric
        let log = []

        for (let i = 1; i <= iterations; i++) {
          const ctxText = composeOptimizeAgentPrompt({
            goal,
            metric,
            best,
            baseMetric,
            direction,
            scope,
            recentLog: log.length ? log.join('; ') : '(无)',
          }) + '\n你没有工具。根据以下源文件，只输出一个标准 unified diff（a/ 与 b/ 路径），不要执行命令或修改文件。禁止修改测试、评分或验证材料。\n'
            + await candidateSourceContext(workspace)

          let run
          try {
            run = await subagents.start('spawn', {
              parent: exec.agent,
              prompt: [{ type: 'text', text: ctxText }],
              signal: exec.signal,
              label: 'autoresearch-' + i,
              toolFilter: { allow: [] },
              agentOptions: model ? { provider, model } : { provider },
            })
          } catch (e) {
            lines.push('第' + i + '轮委派失败: ' + String((e && e.message) || e))
            break
          }
          let res
          try { res = await run.result } finally { await run.dispose() }
          if (exec.signal?.aborted || res.stopReason !== 'completed') {
            lines.push('第' + i + '轮未完整产出候选: ' + (res.stopReason || 'unknown'))
            break
          }
          const rawPatch = res.output.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
          const patch = rawPatch.replace(/^```(?:diff|patch)?\s*\n/, '').replace(/\n```\s*$/, '')
          const applied = await applyCandidatePatch(workspace, patch)
          if (!applied.ok) {
            lines.push('第' + i + '轮候选被拒绝: ' + applied.reason)
            iterationRecords.push({ status: 'patch-rejected', reason: applied.reason })
            continue
          }

          // 子代理只改 isolatedDir;提交/回滚/指标都在隔离仓内完成,源仓 HEAD 不动。
          const iter = await runAutoresearchIteration({
            workspace,
            verifyCmd: verify,
            direction,
            metricSpec,
            signal: exec.signal,
            commitMessage: 'autoresearch iter ' + i,
          })
          iterationRecords.push(iter)
          const val = Number.isFinite(iter.metric) ? iter.metric : NaN
          if (iter.status === 'improved') {
            best = iter.metric
            log.push('iter' + i + ':' + iter.metric + '(改进)')
            lines.push('第' + i + '轮 ✅ ' + metric + ' ' + best)
          } else if (iter.status === 'cancelled') {
            lines.push('第' + i + '轮 取消')
            break
          } else {
            log.push('iter' + i + ':' + (isNaN(val) ? 'N/A' : val) + '(' + (iter.status || '丢弃') + ')')
            lines.push('第' + i + '轮 ❌ ' + (iter.reason || iter.status || '无改进') + (iter.rolledBack ? ',已回滚' : ''))
          }
        }

        lines.push('最终 ' + metric + ': ' + best + '(baseline ' + baseMetric + ',共 ' + iterations + ' 轮)')
        return outcome
      } catch (error) {
        lines.push('已停止: ' + String(error.message || error))
        return outcome
      } finally {
        let exported = false
        try {
          const saved = await saveAutoresearchArtifacts(workspace, artifactDir, { goal, report: lines.join('\n'), iterations: iterationRecords })
          lines.push('补丁: ' + saved.patchPath, '验收记录: ' + saved.manifestPath)
          exported = true
        } catch (error) {
          lines.push('导出失败，保留候选仓: ' + workspace.isolatedDir + ' (' + String(error.message || error) + ')')
        }
        if (exported) {
          const disposed = await disposeWorkspace(workspace).catch((error) => ({ originalIntact: false, cleanupError: String(error) }))
          if (!disposed.originalIntact) lines.push('注意: 检测到原仓在运行期间发生变化，请检查外部并发修改。')
          if (disposed.cleanupError) lines.push('临时仓清理失败: ' + disposed.cleanupError)
        }
        outcome.report = lines.join('\n')
      }
    },
  }))

  // ── swarm_run:Agent Swarm 编排器(模型/ACP/桌面app 三类成员) ─────────
  reg(defineTool({
    name: 'swarm_run',
    description: "Agent Swarm 编排器:把一个任务派给多个成员并行/链式执行并汇总。成员类型:model(国产模型子代理,如 {\"type\":\"model\",\"provider\":\"qwen\"})/ acp(ACP 协议 agent,如 {\"type\":\"acp\",\"bin\":\"kimi\"} 或 codex-acp)/ app(桌面 app,如 {\"type\":\"app\",\"name\":\"codex\",\"port\":9229})。mode: parallel(并行 fan-out,默认)/ chain(链式 handoff,前一个输出交给下一个)。当用户要求'多智能体协作'/'swarm'/'多 agent 处理同一任务'时使用。",
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '给 swarm 的任务描述' },
        members: { type: 'string', description: '成员 JSON 数组字符串,如 [{\"type\":\"model\",\"provider\":\"qwen\"},{\"type\":\"model\",\"provider\":\"doubao\"},{\"type\":\"acp\",\"bin\":\"kimi\"},{\"type\":\"app\",\"name\":\"codex\",\"port\":9229}]' },
        mode: { type: 'string', description: 'parallel(默认)/ chain' },
        cwd: { type: 'string', description: '工作目录,可选' },
      },
    },
    output: {
      schema: { type: 'object', properties: { report: { type: 'string' } }, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: v.error ? v.error : v.report }],
    },
    timeoutMs: 900000,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const sub = ctx.get('subprocess')
      const subagents = ctx.get('subagents')
      if (sub === undefined || subagents === undefined) return { error: 'subprocess/subagents 服务不可用' }
      const task = String(args.task || '')
      if (!task) return { error: '需要 task' }
      let members = []
      try {
        members = JSON.parse(String(args.members || '[]'))
      } catch (e) {
        return { error: 'members 不是合法 JSON: ' + String((e && e.message) || e) }
      }
      if (!Array.isArray(members) || members.length === 0) return { error: 'members 需要至少一个成员' }
      const mode = args.mode === 'chain' ? 'chain' : 'parallel'
      const cwd = String(args.cwd || process.env.HOME)

      const runAcp = async (member, prompt) => {
        const bin = member.bin === 'codex-acp' ? VISION_DIR + '/node_modules/.bin/codex-acp' : KIMI_BIN
        const argv = ['node', VISION_DIR + '/acp-client.mjs', prompt, '--bin', bin, '--cwd', cwd]
        const handle = sub.spawn({
          argv,
          cwd: VISION_DIR,
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } }, stderr: { maxBytes: 256 * 1024 } },
          graceMs: 5000,
          signal: exec.signal,
        })
        const outcome = await handle.done
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null
        const text = out && out.text ? out.text.trim() : ''
        if (outcome.exitCode !== 0 || !text) {
          return '(失败: ' + ((err && err.text) || '无输出') + ')'.slice(0, 150)
        }
        return text
      }

      const runApp = async (member, prompt) => {
        const name = String(member.name || 'codex')
        const port = Number(member.port) || 9229
        const argv = [OPENCLI_BIN, name, 'ask', prompt]
        const handle = sub.spawn({
          argv,
          cwd: '/',
          env: { OPENCLI_CDP_ENDPOINT: 'http://127.0.0.1:' + port },
          stdio: { stdin: 'ignore', stdout: { maxBytes: 4 * 1024 * 1024, spill: { maxBytes: 8 * 1024 * 1024 } }, stderr: { maxBytes: 256 * 1024 } },
          graceMs: 5000,
          signal: exec.signal,
        })
        const outcome = await handle.done
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0) : null
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0) : null
        const text = out && out.text ? out.text.trim() : ''
        if (outcome.exitCode !== 0 || !text) {
          return '(失败: ' + ((err && err.text) || '无输出') + ')'.slice(0, 150)
        }
        return text
      }

      const runModel = async (member, prompt) => {
        const provider = String(member.provider || 'qwen')
        const model = member.model ? String(member.model) : undefined
        let run
        try {
          run = await subagents.start('spawn', {
            parent: exec.agent,
            prompt: [{ type: 'text', text: prompt }],
            signal: exec.signal,
            label: 'swarm-' + provider,
            agentOptions: model ? { provider, model } : { provider },  // model 现在几乎总有值(见上表)
          })
        } catch (e) {
          return '(委派失败: ' + String((e && e.message) || e) + ')'
        }
        const res = await run.result
        await run.dispose()
        const text = res.output.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
        return text || '(无输出:' + res.stopReason + ')'
      }

      const label = (m, i) => {
        if (m.type === 'app') return 'app/' + (m.name || 'codex')
        if (m.type === 'acp') return 'acp/' + (m.bin || 'kimi')
        return 'model/' + (m.provider || 'qwen') + (m.model ? ':' + m.model : '')
      }

      const lines = []
      lines.push('swarm ' + mode + ' | 成员: ' + members.map(label).join(', '))
      lines.push('任务: ' + task.slice(0, 120))

      if (mode === 'chain') {
        let current = task
        for (let i = 0; i < members.length; i++) {
          const m = members[i]
          const prompt = i === 0 ? current : '这是上一步的结果:\n' + current + '\n\n请基于它继续完成任务: ' + task
          let out
          if (m.type === 'acp') out = await runAcp(m, prompt)
          else if (m.type === 'app') out = await runApp(m, prompt)
          else out = await runModel(m, prompt)
          lines.push('  [' + label(m, i) + '] → ' + out.slice(0, 200))
          current = out
        }
      } else {
        const results = await Promise.all(members.map(async (m, i) => {
          if (m.type === 'acp') return { label: label(m, i), out: await runAcp(m, task) }
          if (m.type === 'app') return { label: label(m, i), out: await runApp(m, task) }
          return { label: label(m, i), out: await runModel(m, task) }
        }))
        for (const r of results) lines.push('  [' + r.label + '] ' + r.out.slice(0, 250))
      }
      return { report: lines.join('\n') }
    },
  }))

  // ── codexbar_usage:CodexBar 配额用量查询 ───────────────────────────
  reg(defineTool({
    name: 'codexbar_usage',
    description: "查询 CodexBar 记录的 AI 服务配额用量(Codex Pro / Claude / Antigravity / Kimi / Manus / MiniMax / GLM / StepFun / Doubao / Qwen / DeepSeek 余额)。读取 CodexBar 缓存与 history,返回各 provider 的最新使用率、剩余额度与重置时间。当用户问'用量'/'额度'/'配额'/'CodexBar'/'还剩多少'时使用。",
    parameters: {},
    output: {
      schema: { type: 'object', properties: { report: { type: 'string', required: true } }, additionalProperties: false },
      render: (a, v) => [{ type: 'text', text: v.report }],
    },
    timeoutMs: 20000,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      return { report: formatCodexBarUsage(await readCodexBarUsage()) }
    },
  }))

  return () => { disposers.forEach((d) => d()) }
}

export { Config, apply, inject, name, resolveMediaPath, MEDIA_ROOT, objectPathForAttachmentId, isObjectStorePath, ownSessionEvents, snapshotSessionEvents, sniffMediaType }
