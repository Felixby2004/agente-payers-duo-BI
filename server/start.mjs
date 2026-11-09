import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { makeApi } from './api.mjs';

try { process.loadEnvFile(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
const dist = fileURLToPath(new URL('../dist', import.meta.url));
await stat(resolve(dist, 'index.html')).catch(() => { throw new Error('Primero ejecuta npm run build.'); });
const api = await makeApi(process.env);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const server = createServer((req, res) => api.middleware(req, res, async () => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const requested = resolve(dist, '.' + pathname);
    if (!requested.startsWith(dist + sep) && requested !== dist) {
      res.writeHead(404); res.end(); return;
    }
    const asset = pathname.startsWith('/assets/') || pathname === '/establo.svg';
    const file = asset ? requested : resolve(dist, 'index.html');
    if (!(await stat(file)).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': asset ? 'public, max-age=3600' : 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch { res.writeHead(404); res.end(); }
}));
const port = Number(process.env.PORT || 5173);
const host = process.env.PUBLIC_URL ? '0.0.0.0' : '127.0.0.1';
server.listen(port, host, () => console.log('El Establo PAYERS · http://localhost:' + port));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(async () => { await api.close(); process.exit(0); }));
