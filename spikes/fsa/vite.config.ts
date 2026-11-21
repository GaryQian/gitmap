import { defineConfig } from 'vite';
export default defineConfig({ root: __dirname, server: { port: 5183, strictPort: true, fs: { allow: ['..'] } } });
