/**
 * W2 输出侧媒体派生(纯函数,可测;零模型调用)。
 *
 * 两条来源:
 * ① fold W1 保住的非 text 块(resultBlocks / user blocks)——attachment 引用
 *   走 session.attachment RPC,path 走 /api/cn/media。
 * ② speak / generate_image 的结果文本(宿主 render 约定「音频已生成: <path>」
 *   「图片已生成: <path>」)——只读解析,不写回、不改工具。
 * 数据零编造:派生不出来就是空数组,UI 不渲染任何占位。
 */
import type { ResultBlock } from '@/fold/model'

export interface MediaRef {
  kind: 'image' | 'audio'
  /** 列表渲染稳定 key。 */
  key: string
  name: string | undefined
  mediaType: string | undefined
  /** 宿主 attachments 持久引用(session.attachment RPC 取原件)。 */
  attachmentId: string | undefined
  /** 宿主机文件路径(/api/cn/media 三道闸后供文件)。 */
  path: string | undefined
  /** 远程 URL(契约里允许的第三形态,原样使用)。 */
  url: string | undefined
  width: number | undefined
  height: number | undefined
}

const IMAGE_BLOCK_TYPES = new Set(['image'])
const AUDIO_BLOCK_TYPES = new Set(['audio'])

/** speak / generate_image 的 render 文本形态(cn-capabilities 宿主约定)。 */
const AUDIO_PATH_RE = /音频已生成[:：]\s*(\S+)/
const IMAGE_PATH_RE = /图片已生成[:：]\s*(\S+)/

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const AUDIO_EXTS = new Set(['.wav', '.mp3', '.m4a', '.ogg', '.flac'])

/** 从路径推断媒体类;认不出扩展名返回 undefined(不猜)。 */
export function mediaKindFromPath(path: string): 'image' | 'audio' | undefined {
  const dot = path.lastIndexOf('.')
  if (dot < 0) return undefined
  const ext = path.slice(dot).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (AUDIO_EXTS.has(ext)) return 'audio'
  return undefined
}

function refFromBlock(block: ResultBlock, index: number): MediaRef | undefined {
  const kind = IMAGE_BLOCK_TYPES.has(block.type) ? 'image'
    : AUDIO_BLOCK_TYPES.has(block.type) ? 'audio'
    : undefined
  if (kind === undefined) return undefined
  const attachmentId = block.attachment?.attachmentId
  const source = attachmentId ?? block.path ?? block.url
  if (source === undefined) return undefined
  return {
    kind,
    key: `${block.type}:${index}:${source}`,
    name: block.name ?? block.attachment?.name,
    mediaType: block.mediaType ?? block.attachment?.mediaType,
    attachmentId,
    path: block.path,
    url: block.url,
    width: block.attachment?.width,
    height: block.attachment?.height,
  }
}

/** 非 text 块 → 媒体引用(未知块类型跳过)。 */
export function mediaFromResultBlocks(blocks: readonly ResultBlock[] | undefined): MediaRef[] {
  if (blocks === undefined) return []
  const out: MediaRef[] = []
  for (const [index, block] of blocks.entries()) {
    const ref = refFromBlock(block, index)
    if (ref !== undefined) out.push(ref)
  }
  return out
}

export interface ToolMediaSource {
  readonly name: string
  readonly resultText?: string | undefined
  readonly resultBlocks?: readonly ResultBlock[] | undefined
}

/**
 * 工具条目 → 媒体引用。先看结构化块,再按工具名解析 render 文本里的产物路径;
 * 同一路径去重。失败文本(含「错误」/isError 路径)不会被误判成媒体。
 */
export function mediaFromTool(tool: ToolMediaSource): MediaRef[] {
  const out = mediaFromResultBlocks(tool.resultBlocks)
  const seen = new Set(out.map((r) => r.path ?? r.attachmentId ?? r.url))
  const text = tool.resultText ?? ''
  const pushPath = (kind: 'image' | 'audio', path: string): void => {
    if (seen.has(path)) return
    seen.add(path)
    out.push({
      kind, key: `${kind}:path:${path}`, name: path.split(/[/\\]/).pop(),
      mediaType: undefined, attachmentId: undefined, path, url: undefined,
      width: undefined, height: undefined,
    })
  }
  if (tool.name === 'speak') {
    const m = AUDIO_PATH_RE.exec(text)
    if (m?.[1] !== undefined && mediaKindFromPath(m[1]) === 'audio') pushPath('audio', m[1])
  } else if (tool.name === 'generate_image') {
    const m = IMAGE_PATH_RE.exec(text)
    if (m?.[1] !== undefined && mediaKindFromPath(m[1]) === 'image') pushPath('image', m[1])
  }
  return out
}

/** /api/cn/media 的取件 URL(纯拼接;三道闸在服务端)。 */
export function mediaRouteUrl(path: string): string {
  return `/api/cn/media?path=${encodeURIComponent(path)}`
}
