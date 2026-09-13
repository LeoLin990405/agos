/**
 * RPC method registry and signature-derived generics — AgOS membrane, aligned
 * to DSH 0.1.2-rc.1. Keys are the exact wire path segments (POST /api/<key>),
 * slash-separated in 0.1.2. The membrane mirrors only the methods AgOS calls;
 * the wire also carries requestId inside session/prompt's payload.
 */

import type { SessionsApi } from './sessions.ts'
import type { AgentPresetsApi } from './agent-presets.ts'
import type { SkillsApi } from './skills.ts'
import type { SettingsApi } from './settings.ts'
import type { CredentialsApi } from './credentials.ts'
import type { LlmApi } from './llm.ts'
import type { RpcResponse } from './rpc.ts'

/** Method name → method signature. Signatures are the single source of truth. */
export interface RpcMethodMap {
  'session/list': SessionsApi['list']
  'session/search': SessionsApi['search']
  'session/create': SessionsApi['create']
  'session/page': SessionsApi['page']
  'session/modelCatalog': SessionsApi['modelCatalog']
  'session/selectModel': SessionsApi['selectModel']
  'session/rename': SessionsApi['rename']
  'session/prompt': SessionsApi['prompt']
  'session/attachment': SessionsApi['attachment']
  'session/canOpenWorkspacePath': SessionsApi['canOpenWorkspacePath']
  'session/openWorkspacePath': SessionsApi['openWorkspacePath']
  'agentPresets/list': AgentPresetsApi['list']
  'skills/list': SkillsApi['list']
  'settings/describe': SettingsApi['describe']
  'settings/openSettingsDocument': SettingsApi['openSettingsDocument']
  'settings/mutate': SettingsApi['mutate']
  'credentials/describe': CredentialsApi['describe']
  'llm/listProviders': LlmApi['listProviders']
  'llm/listConfigurableProviders': LlmApi['listConfigurableProviders']
}

/** Business request payload of method K. */
export type RequestPayload<K extends keyof RpcMethodMap> = Parameters<RpcMethodMap[K]>[0]['payload']

/** Business return value of method K. */
export type ResponseValue<K extends keyof RpcMethodMap> =
  Awaited<ReturnType<RpcMethodMap[K]>> extends RpcResponse<infer T> ? T : never
