/**
 * 会话 id 的短标识:取 uuid 判别位,不要取 `session-` 前缀。
 * `session-ec978a30-…`.slice(0, 8) === 'session-' —— 62 个父会话会渲染成同一串。
 */
export function shortSessionRef(id: string): string {
  const raw = String(id || '')
  const body = raw.startsWith('session-') ? raw.slice('session-'.length) : raw
  const compact = body.replace(/[^a-zA-Z0-9]/g, '')
  if (compact.length >= 8) return compact.slice(0, 8)
  if (compact.length > 0) return compact
  return raw.slice(0, 8)
}
