import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  base: '/agos/', // dsh-agos 插件在 :3091/agos/ 下 serve 本产物(同源,无需代理)
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@deepseek-ai/dsh-brand': path.resolve(__dirname, './src/contract/shims/brand.ts'),
      '@deepseek-ai/dsh-llm': path.resolve(__dirname, './src/contract/shims/llm.ts'),
      '@deepseek-ai/dsh-llm/brand': path.resolve(__dirname, './src/contract/shims/llm-brand.ts'),
      '@deepseek-ai/dsh-llm/types': path.resolve(__dirname, './src/contract/shims/llm-types.ts'),
      '@deepseek-ai/dsh-session/types': path.resolve(__dirname, './src/contract/shims/session-types.ts'),
      '@deepseek-ai/dsh-session-projection/types': path.resolve(__dirname, './src/contract/shims/session-projection-types.ts'),
      '@deepseek-ai/dsh-attachment': path.resolve(__dirname, './src/contract/shims/attachment.ts'),
      '@deepseek-ai/dsh-jobs/brand': path.resolve(__dirname, './src/contract/shims/jobs-brand.ts'),
      '@deepseek-ai/dsh-tools/presentation': path.resolve(__dirname, './src/contract/shims/tools-presentation.ts'),
      '@deepseek-ai/dsh-user-approval/types': path.resolve(__dirname, './src/contract/shims/user-approval-types.ts'),
      '@deepseek-ai/dsh-user-questions/types': path.resolve(__dirname, './src/contract/shims/user-questions-types.ts'),
    },
  },
  server: {
    // Desktop shell and host-integration only talk to 127.0.0.1. Vite's
    // default localhost bind is IPv6-only on this machine ([::1]:3092),
    // which makes http://127.0.0.1:3092/agos/ ECONNREFUSED.
    host: '127.0.0.1',
    port: 3092,
    // 同源代理到本机 dsh(:3091):/api 全部(含两条 WS)——绕开宿主的 cross-site 栅栏
    proxy: { '/api': dshProxy() },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: { '/api': dshProxy() },
  },
});

/** 代理到本机 dsh。changeOrigin 只改 Host;宿主信任栅栏还核对 Origin 头,
 *  浏览器 POST 会带 Origin: http://localhost:4173 → 403,必须改写成与 Host 同源。 */
function dshProxy() {
  return {
    target: 'http://127.0.0.1:3091',
    changeOrigin: true,
    ws: true,
    configure(proxy: { on(event: string, cb: (proxyReq: import('http').ClientRequest) => void): void }) {
      const rewrite = (proxyReq: import('http').ClientRequest): void => {
        proxyReq.setHeader('origin', 'http://127.0.0.1:3091');
      };
      proxy.on('proxyReq', rewrite);
      proxy.on('proxyReqWs', rewrite);
    },
  };
}
