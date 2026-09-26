import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// In development the Go API runs on :8080; everything under /api is
// forwarded there with the prefix stripped. In production the API serves
// the built bundle itself and the same /api prefix is handled in Go.
//
// The share cards are not under /api, in production or here, so they
// are forwarded as they stand. Without this the map's warm-up fetch of
// its own card lands on Vite and comes back as index.html.
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
      '/og/movie/': {
        target: 'http://localhost:8080',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'node',
  },
});
