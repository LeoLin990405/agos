import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = '@dsh-local/mcp-bridge'
export const MCP_PROTOCOL_VERSION = '2025-03-26'
export const MCP_PATH = '/mcp'

const MAX_BODY_BYTES = 1024 * 1024
const PROJCACHE = join(homedir(), '.dsh', 'storages', 'session_projcache.json')
const unwrap = (value) => value && typeof value === 'object' && 'val' in value ? value.val : value
const cleanText = (value) => typeof value === 'string' ? value : ''
const cleanNumber = (value) => Number.isFinite(value) ? value : null

export const MCP_TOOLS = Object.freeze([
  {
    name: 'agos_sessions',
    description: 'List DSH sessions from the local AgOS session projection cache. Read-only and does not call a model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agos_prompt',
    description: 'Send text to a DSH session. This is the ONLY MCP tool here that starts real model work and consumes model quota. Without session_id it creates a new session with the cordis preset.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', minLength: 1 },
        cwd: { type: 'string', minLength: 1 },
        text: { type: 'string', minLength: 1 },
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'agos_result',
    description: 'Read the last assistant text for a swarm agent through the existing local /api/swarm/result route. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { agent_id: { type: 'string', minLength: 1 } },
      required: ['agent_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'agos_swarm_status',
    description: 'Read the existing DSH swarm progress snapshot. Read-only and does not call a model.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'agos_memory_search',
    description: 'Search local memory graph node ids and descriptions, returning at most 50 minimal records. Read-only.',
    inputSchema: {
      type: 'object',
      properties: { q: { type: 'string', minLength: 1 } },
      required: ['q'],
      additionalProperties: false,
    },
  },
])

/** Read the same projection cache used by /api/agos/overview and trace-view. */
export async function readAgosSessions(file = PROJCACHE) {
  try {
    const root = JSON.parse(await readFile(file, 'utf8'))
    const table = root?.tables?.sessions
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('sessions table is unavailable')
    const sessions = []
    for (const [sessionId, entry] of Object.entries(table)) {
      if (!entry || typeof entry !== 'object') continue
      const identity = entry.identity && typeof entry.identity === 'object' ? entry.identity : {}
      const rows = entry.rows && typeof entry.rows === 'object' ? entry.rows : {}
      const metadata = unwrap(rows.sessionListMetadata) || {}
      sessions.push({
        session_id: sessionId,
        title: cleanText(unwrap(rows.title)),
        cwd: cleanText(identity.cwd),
        created_at: cleanNumber(identity.createdAt),
        updated_at: cleanNumber(metadata.updatedAt),
      })
    }
    sessions.sort((a, b) => (b.updated_at || b.created_at || 0) - (a.updated_at || a.created_at || 0))
    return { sessions, source: 'session-projcache' }
  } catch (error) {
    return { sessions: [], source: 'session-projcache', error: String(error?.message ?? error) }
  }
}

function requireObject(value, label = 'arguments') {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  return value
}

function requireString(value, name) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) throw new TypeError(`${name} is required`)
  return text
}

function sessionPresetFrom(inspected) {
  const selected = Array.isArray(inspected?.events)
    ? inspected.events.findLast((event) => event?.type === 'agent-preset/selected')?.data?.agentPreset
    : undefined
  return cleanText(selected) || cleanText(inspected?.meta?.agentPreset) || 'cordis'
}

function sessionCwd(inspected, requested) {
  const stored = cleanText(inspected?.meta?.cwd)
  if (requested && stored && resolve(requested) !== resolve(stored)) {
    throw new Error(`session cwd conflict: requested ${resolve(requested)}, existing ${resolve(stored)}`)
  }
  return stored || requested || homedir()
}

/** Build the only model-consuming adapter. Tests replace this whole function. */
export function createAgosPrompt(ctx) {
  return async (raw) => {
    const args = requireObject(raw)
    const text = requireString(args.text, 'text')
    const requestedId = args.session_id === undefined ? '' : requireString(args.session_id, 'session_id')
    const requestedCwd = args.cwd === undefined ? '' : requireString(args.cwd, 'cwd')
    const cwd = requestedCwd ? (isAbsolute(requestedCwd) ? resolve(requestedCwd) : resolve(homedir(), requestedCwd)) : homedir()
    const agents = ctx.get('agents')
    const defaults = ctx.get('agentDefaultModel')
    const presets = ctx.get('agentPresets')
    if (!agents || typeof agents.create !== 'function' || typeof agents.get !== 'function') throw new Error('DSH agents service is unavailable')
    if (!defaults || typeof defaults.currentSelection !== 'function') throw new Error('DSH default model service is unavailable')
    if (!presets || typeof presets.resolve !== 'function' || typeof presets.mount !== 'function') throw new Error('DSH agent preset service is unavailable')

    const selection = defaults.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setupFor = async (presetId) => {
      const preset = await presets.resolve(presetId)
      return {
        presetId: preset.id,
        setup: async (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
          await presets.mount(agentCtx, preset.id)
        },
      }
    }

    let agent = requestedId ? agents.get(requestedId) : undefined
    let created = false
    let resumed = false
    if (!agent && requestedId) {
      const persistence = ctx.get('sessionPersistence')
      if (!persistence || typeof persistence.inspect !== 'function' || typeof agents.resume !== 'function') {
        throw new Error(`session ${requestedId} is not live and cannot be resumed`)
      }
      const inspected = await persistence.inspect(requestedId)
      sessionCwd(inspected, requestedCwd ? cwd : '')
      const composition = await setupFor(sessionPresetFrom(inspected))
      agent = (await agents.resume({
        resumeSessionId: requestedId,
        agentOptions,
        setup: composition.setup,
      })).agent
      resumed = true
    }
    if (!agent) {
      const sessionId = `session-${randomUUID()}`
      const composition = await setupFor('cordis')
      agent = (await agents.create({
        sessionId,
        meta: { cwd, agentPreset: composition.presetId },
        agentOptions,
        setup: composition.setup,
      })).agent
      created = true
      if (typeof agent.whenIdle === 'function') await agent.whenIdle()
    }
    if (!agent || typeof agent.followup !== 'function') throw new Error('DSH session does not accept prompts')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    return { session_id: cleanText(agent.session?.id) || requestedId, accepted: true, created, resumed }
  }
}

async function defaultInternalJson(path, env) {
  const origin = env?.origin
  if (!origin) throw new Error('local DSH webServer origin is unavailable')
  const response = await fetch(new URL(path, origin), {
    method: 'GET',
    headers: { accept: 'application/json' },
  })
  const body = await response.text()
  let value
  try { value = body ? JSON.parse(body) : {} }
  catch { throw new Error(`internal route ${path} returned invalid JSON`) }
  if (!response.ok) throw new Error(`internal route ${path} failed (${response.status}): ${cleanText(value?.error) || response.statusText}`)
  return value
}

const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] })

export function createMcpRuntime(ctx, options = {}) {
  const readSessions = options.readSessions || (() => readAgosSessions(options.projcache))
  const prompt = options.prompt || createAgosPrompt(ctx)
  const internalJson = options.internalJson || defaultInternalJson
  return {
    tools: MCP_TOOLS,
    async callTool(name, rawArgs, env = {}) {
      const args = requireObject(rawArgs)
      if (name === 'agos_sessions') return result(await readSessions())
      if (name === 'agos_prompt') return result(await prompt(args))
      if (name === 'agos_result') {
        const agentId = requireString(args.agent_id, 'agent_id')
        return result(await internalJson(`/api/swarm/result?agentId=${encodeURIComponent(agentId)}`, env))
      }
      if (name === 'agos_swarm_status') return result(await internalJson('/api/swarm/progress', env))
      if (name === 'agos_memory_search') {
        const query = requireString(args.q, 'q').toLocaleLowerCase()
        const graph = await internalJson('/api/memory/graph', env)
        const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
        const matches = nodes.filter((node) => {
          const haystack = `${cleanText(node?.id)}\n${cleanText(node?.description)}`.toLocaleLowerCase()
          return haystack.includes(query)
        }).slice(0, 50).map((node) => ({
          id: cleanText(node?.id),
          description: cleanText(node?.description),
          type: cleanText(node?.type),
        }))
        return result({ q: args.q, nodes: matches })
      }
      throw new Error(`unknown tool: ${name}`)
    },
  }
}

class RpcError extends Error {
  constructor(code, message, data) {
    super(message)
    this.code = code
    this.data = data
  }
}

function rpcError(id, error) {
  return {
    jsonrpc: '2.0',
    id: id ?? null,
    error: {
      code: Number.isInteger(error?.code) ? error.code : -32603,
      message: cleanText(error?.message) || 'Internal error',
      ...(error?.data === undefined ? {} : { data: error.data }),
    },
  }
}

async function dispatch(runtime, request, env) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    throw new RpcError(-32600, 'Invalid Request')
  }
  const id = request.id
  if (request.method === 'notifications/initialized') return undefined
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'dsh-mcp-bridge', version: '0.1.0' },
      },
    }
  }
  if (request.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: runtime.tools } }
  }
  if (request.method === 'tools/call') {
    const params = requireObject(request.params, 'params')
    const toolName = requireString(params.name, 'params.name')
    try {
      return { jsonrpc: '2.0', id, result: await runtime.callTool(toolName, params.arguments, env) }
    } catch (error) {
      return {
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true },
      }
    }
  }
  throw new RpcError(-32601, `Method not found: ${request.method}`)
}

async function readJsonBody(req) {
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new RpcError(-32600, 'Request body exceeds 1 MiB')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new RpcError(-32700, 'Parse error') }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function sendSse(res, body) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  res.write(`event: message\ndata: ${JSON.stringify(body)}\n\n`)
  res.end()
}

export function createMcpHandler(runtime) {
  return async (req, res) => {
    const pathname = new URL(req.url || MCP_PATH, 'http://localhost').pathname.replace(/\/$/, '') || '/'
    if (pathname !== MCP_PATH) { sendJson(res, 404, { error: 'not found' }); return }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'POST only' }))
      return
    }
    let request
    let response
    try {
      request = await readJsonBody(req)
      const port = req.socket?.localPort
      response = await dispatch(runtime, request, { origin: port ? `http://127.0.0.1:${port}` : undefined })
    } catch (error) {
      response = rpcError(request?.id, error)
    }
    if (response === undefined) { res.writeHead(202); res.end(); return }
    if (String(req.headers.accept || '').includes('text/event-stream')) sendSse(res, response)
    else sendJson(res, 200, response)
  }
}

export function apply(ctx) {
  const runtime = createMcpRuntime(ctx)
  const handler = createMcpHandler(runtime)
  const disposers = []
  ctx.inject(['webServer'], (scope) => {
    const webServer = scope.get('webServer')
    if (!webServer || typeof webServer.register !== 'function') return
    const dispose = webServer.register({ kind: 'prefix', path: MCP_PATH, handler })
    if (typeof dispose === 'function') disposers.push(dispose)
  })
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch {}
    }
  }
}

export default apply
