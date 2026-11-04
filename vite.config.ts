import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const localWorker = 'http://127.0.0.1:8787';
/** Text-size setting (내 정보 › 글자 크기): every pixel font size is multiplied by
 * `--font-scale` (1 = 크게, the original design). Layout, spacing and canvases are untouched. */
const fontScale = {
  postcssPlugin: 'yegoom-font-scale',
  Declaration: {
    'font-size': (declaration: { value: string }) => {
      if (declaration.value.includes('--font-scale')) return;
      declaration.value = declaration.value.replace(/(\d*\.?\d+)px/g, 'calc($1px * var(--font-scale, 1))');
    },
  },
};
export default defineConfig({
  plugins: [react()],
  css: { postcss: { plugins: [fontScale] } },
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
