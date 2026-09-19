import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In development the Go API runs on :8080; everything under /api is
// forwarded there with the prefix stripped. In production the API serves
// the built bundle itself and the same /api prefix is handled in Go.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'node',
  },
});
