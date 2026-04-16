const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8090;
const BASE = __dirname;

const MIME = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
};

http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/') url = '/viewer.html';

  // API: list trajectory detail
  if (url.startsWith('/api/trajectory/')) {
    const id = url.replace('/api/trajectory/', '');
    const fp = path.join(BASE, 'trajectories', id, 'trajectory.json');
    if (fs.existsSync(fp)) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      fs.createReadStream(fp).pipe(res);
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  const fp = path.join(BASE, url);
  if (!fp.startsWith(BASE)) { res.writeHead(403); res.end(); return; }
  if (!fs.existsSync(fp)) { res.writeHead(404); res.end('Not found'); return; }

  const ext = path.extname(fp);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
  fs.createReadStream(fp).pipe(res);
}).listen(PORT, () => console.log(`Atlas Data Viewer on http://localhost:${PORT}`));
