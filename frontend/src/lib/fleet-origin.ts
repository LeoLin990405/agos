export interface FleetOriginOptions {
  /** Tests and non-Vite callers can state the mode explicitly. */
  dev?: boolean
  location?: Pick<Location, 'port'>
}

/**
 * `/fleet/*` is intentionally outside Vite's `/api` proxy. Development UI
 * servers therefore target dsh directly; the production build stays same-origin.
 */
export function resolveFleetOrigin(options: FleetOriginOptions = {}): string {
  const currentLocation = options.location ?? (typeof location === 'undefined' ? undefined : location)
  const dev = options.dev ?? (currentLocation?.port === '3092' || currentLocation?.port === '4173')
  return dev ? 'http://127.0.0.1:3091' : ''
}

export type FleetArtifactDownloadKind = 'file' | 'tgz'

export function fleetArtifactDownloadUrl(
  kind: FleetArtifactDownloadKind,
  host: string,
  runId: string,
  path?: string,
  options?: FleetOriginOptions,
): string {
  const query = new URLSearchParams({ host, run: runId })
  if (kind === 'file') {
    if (path === undefined || path === '') throw new TypeError('file artifact downloads require a path')
    query.set('path', path)
  }
  return `${resolveFleetOrigin(options)}/fleet/artifact/${kind}?${query.toString()}`
}
