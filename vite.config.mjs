import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => ({
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  plugins: [{
    name: 'establo-api',
    async configureServer(server) {
      const { makeApi } = await import('./server/api.mjs');
      const api = await makeApi({ ...loadEnv(mode, process.cwd(), ''), ...process.env });
      server.middlewares.use(api.middleware);
      server.httpServer.once('close', () => api.close().catch(console.error));
    },
  }],
}));
