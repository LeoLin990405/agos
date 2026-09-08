// Shared size/count limits for HTTP dispatch and fleet_run.
// Reject oversize input. Never silently truncate.

export const MAX_BODY_BYTES = 512 * 1024
export const MAX_ITEMS = 32
export const MAX_ITEM_CHARS = 8000
export const MAX_TIMEOUT_MS = 3_600_000
export const MAX_LABEL_CHARS = 120
export const MAX_TAG_CHARS = 64

export class InputLimitError extends Error {
  constructor(code, message, { status = 400, detail } = {}) {
    super(message)
    this.name = 'InputLimitError'
    this.code = code
    this.status = status
    this.detail = detail
  }
}

const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

export function assertHttpBodyBytes(byteLength) {
  const bytes = Number(byteLength)
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new InputLimitError('INVALID_BODY', 'body byte length is invalid')
  }
  if (bytes > MAX_BODY_BYTES) {
    throw new InputLimitError('BODY_TOO_LARGE', `body exceeds ${MAX_BODY_BYTES} bytes`, { status: 413 })
  }
  return bytes
}

export function validateFleetItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS) {
    throw new InputLimitError('INVALID_ITEMS', `items must contain 1..${MAX_ITEMS} strings`)
  }
  return items.map((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new InputLimitError('INVALID_ITEM', `items[${index}] must be a non-empty string`)
    }
    if (item.length > MAX_ITEM_CHARS) {
      throw new InputLimitError('ITEM_TOO_LONG', `items[${index}] exceeds ${MAX_ITEM_CHARS} characters`)
    }
    return item
  })
}

export function validateHttpDispatchBody(body) {
  if (!plainObject(body)) throw new InputLimitError('INVALID_BODY', 'body must be a JSON object')
  const items = validateFleetItems(body.items)

  let hosts
  if (body.hosts !== undefined) {
    if (!Array.isArray(body.hosts) || body.hosts.length === 0 || body.hosts.some((host) => typeof host !== 'string' || !host.trim())) {
      throw new InputLimitError('INVALID_HOSTS', 'hosts must be a non-empty array of names')
    }
    hosts = [...new Set(body.hosts.map((host) => host.trim()))]
  }

  let tag
  if (body.tag !== undefined) {
    if (typeof body.tag !== 'string' || !body.tag.trim() || body.tag.length > MAX_TAG_CHARS) {
      throw new InputLimitError('INVALID_TAG', `tag must be a non-empty string of at most ${MAX_TAG_CHARS} characters`)
    }
    tag = body.tag.trim()
  }

  if (body.wake !== undefined && typeof body.wake !== 'boolean') {
    throw new InputLimitError('INVALID_WAKE', 'wake must be boolean')
  }

  let label
  if (body.label !== undefined) {
    if (typeof body.label !== 'string' || !body.label.trim() || body.label.length > MAX_LABEL_CHARS) {
      throw new InputLimitError('INVALID_LABEL', `label must be a non-empty string of at most ${MAX_LABEL_CHARS} characters`)
    }
    label = body.label.trim()
  }

  let timeoutMs
  if (body.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(body.timeoutMs) || body.timeoutMs < 1 || body.timeoutMs > MAX_TIMEOUT_MS) {
      throw new InputLimitError('INVALID_TIMEOUT', `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`)
    }
    timeoutMs = body.timeoutMs
  }

  return { items, hosts, tag, wake: body.wake !== false, label, timeoutMs, pinned: hosts !== undefined }
}
