import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const port = Number(process.argv[2] ?? 8746);

http
  .createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url ?? '/').split('?')[0]);
    const filePath = path.join(root, urlPath);
    if (!filePath.startsWith(root)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    fs.readFile(filePath, (error, content) => {
      if (error) {
        response.writeHead(404).end(`Not found: ${urlPath}`);
        return;
      }
      const extension = path.extname(filePath);
      const contentType =
        extension === '.html'
          ? 'text/html; charset=utf-8'
          : extension === '.mjs' || extension === '.js'
            ? 'text/javascript; charset=utf-8'
            : extension === '.wasm'
              ? 'application/wasm'
              : 'application/octet-stream';
      response.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store',
      });
      response.end(content);
    });
  })
  .listen(port, () => {
    console.log(
      `Assembly fingerprint spike: http://localhost:${port}/scripts/incremental-meshing/fingerprint-spike.html`,
    );
  });
