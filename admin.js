import path from 'path';
import { statSync, createReadStream } from 'fs';

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.svg': return 'image/svg+xml';
    case '.txt': return 'text/plain; charset=utf-8';
    default: return 'application/octet-stream';
  }
}

export function handleAdmin(req, res) {
  // Map /__admin to public/index.html, and /__admin/* to public/*
  const rel = req.url === '/__admin' || req.url === '/__admin/' ? '/index.html' : req.url.replace('/__admin', '');
  const filePath = path.join(process.cwd(), 'public', rel);
  try {
    const s = statSync(filePath);
    res.writeHead(200, { 'Content-Type': getMime(filePath) });
    createReadStream(filePath).pipe(res);
    return true;
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
    return false;
  }
}
