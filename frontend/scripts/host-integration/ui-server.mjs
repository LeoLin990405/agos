/**
 * Serve the REAL AgOS SPA (src/main.tsx → App → ChatPage) from a Vite dev
 * server and relay `/api` to the REAL pinned host.
 *
 * Why a relay is required, and what it does and does not fake:
 * - The production build is served by the host itself, so `location.origin`
 *   and the host origin coincide. This harness may not run `npm run build`
 *   (the controller owns frontend/dist), so the SPA is served by Vite on its
 *   own port while the host listens on another.
 * - `frontend/src/stores/live.ts` creates its client as `createAgosClient({})`,
 *   which in a browser resolves the base to `location.origin`. The relay is
 *   what makes that same-origin `/api` reach the real host, so the SPA code
 *   under test is byte-identical to production — no baseUrl override, no
 *   mocked fetch, no stubbed WebSocket.
 * - The relay forwards bytes. It does not synthesize envelopes, frames, or
 *   values: every response and every mux frame is produced by the real host.
 * - It performs exactly two rewrites, both required by the host's own
 *   browser-trust fence: `Host`/`Origin` are set to the host authority (the
 *   signed session cookie is authority-bound), and the real cookie minted by
 *   the real launch-token exchange is attached. This is the same authority the
 *   host would see if it served the page itself.
 */
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { FRONTEND_ROOT } from './host-env.mjs';

/**
 * Start the SPA origin for one run.
 * @param options - ui port and the live host handle to relay to.
 * @returns the server handle with its origin and disposer.
 */
export async function startUiServer({ uiPort, host }) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'agos-host-integration-vite-'))
  const target = host.base
  const attach = (proxyReq) => {
    // The fence compares Origin against Host, and the session cookie is bound
    // to the host authority; both must speak for the host, not the relay.
    proxyReq.setHeader('origin', target)
    proxyReq.setHeader('cookie', host.cookieHeader)
  }

  const server = await createServer({
    configFile: false,
    root: FRONTEND_ROOT,
    cacheDir,
    base: '/',
    plugins: [react()],
    resolve: { alias: { '@': path.join(FRONTEND_ROOT, 'src') } },
    logLevel: 'error',
    server: {
      host: '127.0.0.1',
      port: uiPort,
      strictPort: true,
      // HMR would open a second WebSocket on this origin and compete for the
      // upgrade path; a deterministic test wants only the host's mux socket.
      hmr: false,
      proxy: {
        '/api': {
          target,
          changeOrigin: true,
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyReq', attach)
            proxy.on('proxyReqWs', attach)
          },
        },
      },
    },
  })

  await server.listen()
  const origin = `http://127.0.0.1:${uiPort}`

  return {
    origin,
    async stop() {
      try { await server.close() } finally { await rm(cacheDir, { recursive: true, force: true }) }
    },
  }
}
