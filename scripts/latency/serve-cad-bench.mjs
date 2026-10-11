// Static file server for scripts/latency/cad-bench.html.
// Serves the CADAM repo root so Worker modules and public/ wheels resolve.
//
// Usage: node scripts/latency/serve-cad-bench.mjs [port]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CADAM_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const PORT = Number(process.argv[2] ?? 8744);
const BENCH_PATH = '/scripts/latency/cad-bench.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.whl': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.map': 'application/json',
};

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const filePath = path.join(CADAM_ROOT, urlPath);

  if (!filePath.startsWith(CADAM_ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': ext === '.whl' ? 'public, max-age=3600' : 'no-store',
    });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`CAD latency bench: http://localhost:${PORT}${BENCH_PATH}`);
  console.log(`Repo root: ${CADAM_ROOT}`);
});
