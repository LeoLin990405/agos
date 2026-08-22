/**
 * 会话 id 的短标识:取判别位,不要固定从左边切 8 位。
 *
 * - `session-<uuid>` / 裸 uuid:取 uuid 第一组(8 hex)
 * - 其它名字(preset-child-* 等):取字母数字尾 8 位
 *
 * `.slice(0, 8)` 会把 `session-…` 收成「session-」。
 * 只剥前缀再取前 8 位会让 `preset-child-switch-parent` 与
 * `preset-child-parent` 撞成 `presetch`(真实 62 父会话语料,2026-08-22)。
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export function shortSessionRef(id: string): string {
  const raw = String(id || '')
  const uuid = raw.match(UUID_RE)
  if (uuid) return uuid[0].slice(0, 8)
  const compact = raw.replace(/[^a-zA-Z0-9]/g, '')
  if (compact.length <= 8) return compact || raw.slice(0, 8)
  return compact.slice(-8)
}
