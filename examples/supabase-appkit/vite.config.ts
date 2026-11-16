import { defineConfig } from 'vite';

export default defineConfig({
  // The linked package has its own node_modules; keep one copy of these.
  resolve: { dedupe: ['@wagmi/core', 'viem'] },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false },
    },
  },
});
