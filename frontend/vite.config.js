import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
    proxy: {
      '/api': {
        // Server-side proxy only; browser code uses same-origin /api paths.
        target: process.env.VITE_API_TARGET || 'http://127.0.0.1:8000',
        changeOrigin: false,
        ws: true,
      },
    },
  },
  build: {
    outDir: '../web',
    emptyOutDir: true,
    sourcemap: false,
  },
});
