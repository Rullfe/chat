/**
 * 本地演示服务：预览前端界面效果（无真实后端，返回演示数据）
 * 用法： node test/preview-server.mjs
 * 然后浏览器打开 http://127.0.0.1:8321 ，任意填用户名/密码即可进入（演示模式不校验）
 */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

let keys = [
  { id: 'demo-1', name: '中转站 A', endpoint: 'https://api.lk888.ai/v1/skills/balance', method: 'GET', balancePath: 'balance', unit: '算力', apiKeyMask: 'sk-1234...abcd', createdAt: Date.now() - 86400000, lastCheckedAt: Date.now() - 60000, balance: 128.5, lastError: null },
  { id: 'demo-2', name: 'OpenAI', endpoint: 'https://api.openai.com/v1/dashboard/billing/credit_grants', method: 'GET', balancePath: 'total_granted', unit: 'USD', apiKeyMask: 'sk-xxxx...9999', createdAt: Date.now() - 172800000, lastCheckedAt: Date.now() - 60000, balance: 25.31, lastError: null },
  { id: 'demo-3', name: '失败示例', endpoint: 'https://api.example.com/v1/balance', method: 'GET', balancePath: 'balance', unit: '', apiKeyMask: 'sk-bad...0000', createdAt: Date.now() - 3600000, lastCheckedAt: Date.now() - 60000, balance: null, lastError: 'HTTP 401 无效的 API Key' },
];

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const send = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
const authed = (req) => (req.headers['authorization'] || '').startsWith('Bearer ');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  if (!url.pathname.startsWith('/api/')) {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const p = path.join(publicDir, file);
    if (!p.startsWith(publicDir)) { res.writeHead(403); res.end(); return; }
    fs.readFile(p, (err, data) => {
      if (err) { res.writeHead(404); res.end('404'); return; }
      res.writeHead(200, { 'Content-Type': mime[path.extname(p)] || 'text/plain' });
      res.end(data);
    });
    return;
  }

  // 演示模式：登录/注册直接放行
  if (url.pathname === '/api/auth/login' || url.pathname === '/api/auth/register') {
    return send(res, 200, { ok: true, token: 'demo-token', username: 'demo' });
  }
  if (!authed(req)) return send(res, 401, { error: '未登录' });
  if (url.pathname === '/api/auth/me') return send(res, 200, { username: 'demo' });
  if (url.pathname === '/api/auth/logout') return send(res, 200, { ok: true });

  if (url.pathname === '/api/keys' && req.method === 'GET') return send(res, 200, { keys });
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    keys = keys.map((k) => ({ ...k, lastCheckedAt: Date.now() }));
    return send(res, 200, { refreshedAt: Date.now(), keys });
  }
  const single = url.pathname.match(/^\/api\/keys\/([^/]+)\/refresh$/);
  if (single && req.method === 'POST') {
    const k = keys.find((x) => x.id === single[1]);
    if (!k) return send(res, 404, { error: '不存在' });
    k.lastCheckedAt = Date.now();
    return send(res, 200, { ok: true, key: k });
  }
  const del = url.pathname.match(/^\/api\/keys\/([^/]+)$/);
  if (del && req.method === 'DELETE') {
    keys = keys.filter((x) => x.id !== del[1]);
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/api/keys' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const b = JSON.parse(body || '{}');
      const key = {
        id: 'demo-' + Date.now(), name: b.name || '未命名', endpoint: b.endpoint, method: b.method || 'GET',
        balancePath: b.balancePath || 'balance', unit: b.unit || '', apiKeyMask: (b.apiKey || '').slice(0, 6) + '...' + (b.apiKey || '').slice(-4),
        createdAt: Date.now(), lastCheckedAt: Date.now(), balance: 99, lastError: null,
      };
      keys.push(key);
      send(res, 200, { ok: true, key });
    });
    return;
  }
  send(res, 404, { error: '接口不存在' });
}).listen(8321, () => console.log('演示服务已启动: http://127.0.0.1:8321'));
