import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const localWorker = 'http://127.0.0.1:8787';
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: localWorker,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (upstream, request) => {
            // Vite is the development app's origin. Rewrite only verified
            // same-origin requests for the separate local Worker process.
            // Cross-site or missing origins remain rejected by the Worker.
            if (request.headers.origin === `http://${request.headers.host}`) {
              upstream.setHeader('Origin', localWorker);
            }
          });
        },
      },
    },
  },
  build: { outDir: 'dist', sourcemap: false },
});
