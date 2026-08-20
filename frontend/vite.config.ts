import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
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
    port: 3092,
  },
});
