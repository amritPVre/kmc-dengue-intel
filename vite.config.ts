import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// base './' keeps asset paths relative so the build can be hosted under any path
// (State Data Centre, Vercel, or a static artifact).
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'supabase/functions/_shared'),
    },
  },
  build: {
    chunkSizeWarningLimit: 1600,
  },
});
