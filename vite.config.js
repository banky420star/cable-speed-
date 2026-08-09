import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev mode: `npm run dev` (Vite on :5173) proxies /api to the Node server
// (`npm run api` on :8787). Production: `npm start` builds and serves
// everything from the Node server on :8787.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
});
