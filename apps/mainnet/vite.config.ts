import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Local-only page: the user funds one small mainnet tab from their own wallet (WizardConnect, e.g. Paytaca).
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5188, strictPort: true, host: '127.0.0.1' },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
