// Minimal proxy server: serves the static web client and bridges browser
// WebSocket connections to xAI's realtime voice agent, injecting the
// Authorization header server-side so the API key never reaches the browser.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

try {
  process.loadEnvFile(); // Node 20.6+: load .env into process.env, if present
} catch {
  // No .env file (e.g. on a host that injects env vars directly) - that's fine.
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const XAI_API_KEY = process.env.XAI_API_KEY;
const AGENT_ID = process.env.XAI_AGENT_ID || 'agent_aO77hWH5RND6FnJu';

if (!XAI_API_KEY) {
  console.error('Missing XAI_API_KEY environment variable');
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }

  const reqPath = req.url === '/' ? '/index.html' : req.url;
  const filePath = path.join(PUBLIC_DIR, path.normalize(reqPath).replace(/^(\.\.[/\\])+/, ''));

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (client) => {
  const upstream = new WebSocket(`wss://api.x.ai/v1/realtime?agent_id=${AGENT_ID}`, {
    headers: { Authorization: `Bearer ${XAI_API_KEY}` },
  });

  const pendingFromClient = [];

  upstream.on('open', () => {
    for (const { data, isBinary } of pendingFromClient) {
      upstream.send(data, { binary: isBinary });
    }
    pendingFromClient.length = 0;
  });

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });

  upstream.on('close', (code, reason) => {
    if (client.readyState === WebSocket.OPEN) client.close(1000, reason.toString());
  });

  upstream.on('error', (err) => {
    console.error('Upstream error:', err.message);
    if (client.readyState === WebSocket.OPEN) client.close(1011, 'Upstream error');
  });

  client.on('message', (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    } else {
      pendingFromClient.push({ data, isBinary });
    }
  });

  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });

  client.on('error', () => upstream.close());
});

server.listen(PORT, HOST, () => {
  console.log(`Voice agent web client running at http://${HOST}:${PORT}`);
});
