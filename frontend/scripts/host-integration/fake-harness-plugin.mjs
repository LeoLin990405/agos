/**
 * Fake provider + fake tool for the AgOS real-host integration harness.
 *
 * This is a genuine cordis plugin mounted into a genuine pinned host (dsh
 * 0.1.2-rc.1) through a `--patch` overlay. Everything it fakes is the MODEL and
 * the TOOL BODY; the host, the agent loop, the approval seam, the session log,
 * the api-gateway and the /api/remote.mux transport are all the real thing.
 *
 * Zero paid model tokens: the only registered LLM provider is `agos-fake`,
 * whose adapter emits scripted chunks from local state and performs no network
 * I/O of any kind. The real DeepSeek adapter is disabled by the same overlay
 * and its credential is stripped from the child environment.
 *
 * This file is copied into the throwaway profile directory at boot so that its
 * `@deepseek-ai/*` imports resolve through the profile's module fallback.
 */
import { readFileSync } from 'node:fs'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'agos-fake-harness'
export const inject = ['llm', 'tools']

const PROVIDER = 'agos-fake'
const MODEL = 'agos-fake-1'
const TOOL_NAME = 'agos_fake_action'

/**
 * Read the harness control file. The test process rewrites it between
 * scenarios, so it is read fresh on every model call and every tool body.
 * @returns the control document, or defaults when absent/unparsable.
 */
function control() {
  const path = process.env.AGOS_FAKE_SCRIPT
  if (path === undefined) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

/** Deterministic, monotonically increasing tool-call ids. */
let callSeq = 0

/**
 * Decide the next scripted assistant response from the request the real agent
 * loop assembled. A turn whose latest message is a user prompt answers with a
 * tool call (which the ask-gate turns into a real approval waterfall); a turn
 * that already carries this tool's result answers with plain text and stops.
 * @param options - the real GenerateOptions the loop built.
 * @returns the scripted response shape.
 */
function planResponse(options) {
  const script = control()
  const messages = Array.isArray(options.messages) ? options.messages : []
  // A tool result is a USER-role message carrying a `tool-result` block (the
  // harness message vocabulary has no 'tool' role), so the block is what makes
  // a turn already-answered. Counting roles instead loops the tool forever.
  const toolResults = messages.reduce((total, message) => total + (Array.isArray(message?.content)
    ? message.content.filter((block) => block?.type === 'tool-result').length
    : 0), 0)
  // `noTool` builds transcript history quickly: plain text answers only, so no
  // approval gate interrupts the loop while a long session log is assembled.
  const wantsTool = script.noTool !== true && toolResults === 0 && options.purpose === undefined
  if (!wantsTool) return { kind: 'text', text: `完成:合成回复 #${toolResults}` }
  return { kind: 'tool-call', label: script.toolLabel ?? 'synthetic-action' }
}

/** The fake provider adapter: scripted chunks, no network, no credentials. */
class FakeAdapter extends LlmAdapter {
  providerInfo(provider) {
    return { id: provider, name: 'AgOS Fake Provider (no network)' }
  }

  listModels() {
    return Promise.resolve([{ provider: PROVIDER, id: MODEL, name: 'AgOS Fake Model', inputModalities: ['text'] }])
  }

  resolveModel(provider, model) {
    return Promise.resolve({
      provider,
      id: model,
      name: 'AgOS Fake Model',
      context: { contextWindow: 131072 },
      defaultMaxTokens: 2048,
    })
  }

  async *stream(options) {
    // A session-title call must not produce a tool call; it gets short text.
    if (options.purpose === 'session-title') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: '合成会话' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: '合成会话' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const plan = planResponse(options)
    if (plan.kind === 'tool-call') {
      callSeq += 1
      const id = `agos-fake-call-${callSeq}`
      const args = JSON.stringify({ label: plan.label })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id, name: TOOL_NAME, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: TOOL_NAME, arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 8, totalTokens: 16 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: plan.text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: plan.text } }
    yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4, totalTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/**
 * Mount the fake provider, the fake tool, and the ask-gate that routes the
 * tool through the host's real approval seam.
 * @param ctx - the cordis context supplied by the loader.
 */
export function apply(ctx) {
  ctx.llm.registerAdapter([PROVIDER], new FakeAdapter())

  ctx.tools.register(defineTool({
    name: TOOL_NAME,
    description: 'Synthetic privileged action used only by the AgOS host-integration harness.',
    parameters: {
      label: { type: 'string', required: true, description: 'Synthetic label echoed back in the result.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          label: { type: 'string', required: true },
          performed: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `synthetic action performed: ${value.label}` }],
    },
    execute: async (args) => ({ label: args.label, performed: true }),
  }))

  // The ask-gate: the real approval seam turns this into an approval/request
  // waterfall, forwarded to the browser over the real $events stream.
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== TOOL_NAME) return next()
    return { kind: 'ask', reason: '合成特权动作需要人工放行(harness)' }
  })

  ctx.logger?.info?.('agos-fake-harness: fake provider %s and fake tool %s mounted', PROVIDER, TOOL_NAME)
}
