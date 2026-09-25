/**
 * 本地模拟验证（无需部署，无需真实网络）
 *  - mock KV（Map 实现）
 *  - mock 多个「余额平台」：lk888 风格(Bearer)、OpenAI 风格(x-api-key)、慢接口、坏 key
 *  - 验证：注册/登录/鉴权、加密存储（KV 无明文）、添加前置校验、上限50、
 *          列表脱敏、刷新全部/单个、删除、静态资源托管
 *
 * 运行： node test/mock-test.mjs
 */
import { createApp } from '../src/app.js';

let pass = 0, fail = 0;
function assert(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

/* ---------- mock KV ---------- */
class MockKV {
  constructor() { this.map = new Map(); }
  async get(k) { return this.map.has(k) ? this.map.get(k) : null; }
  async put(k, v) { this.map.set(k, v); }
  async delete(k) { this.map.delete(k); }
}
const kv = new MockKV();

/* ---------- mock 静态资源 ---------- */
const mockAssets = {
  fetch: async () => new Response('<!DOCTYPE html><html><body>index-page</body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
};

/* ---------- mock 余额平台 ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function mkFetchImpl(timeoutMs) {
  const routes = {
    'https://api.lk888.ai/v1/skills/balance': async (opts) => {
      const auth = opts.headers['Authorization'] || opts.headers['authorization'] || '';
      if (!auth.startsWith('Bearer sk-good-888')) {
        return new Response(JSON.stringify({ error: { message: '无效的 API Key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ balance: 3.99, unit: '算力' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    'https://api.openai.com/v1/dashboard/billing/credit_grants': async (opts) => {
      const key = opts.headers['x-api-key'] || '';
      if (key !== 'sk-good-openai') {
        return new Response(JSON.stringify({ error: { message: 'bad key' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({ total_granted: 25.5, total_used: 3.5 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    'https://api.slow.com/v1/balance': async (opts) => {
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        opts.signal && opts.signal.addEventListener('abort', () => { clearTimeout(t); reject(opts.signal.reason); });
      });
      return new Response(JSON.stringify({ balance: 1 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
  return async (url, opts) => {
    const r = routes[url];
    if (!r) return new Response(JSON.stringify({ error: { message: 'not found' } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    return r(opts);
  };
}

const ENCRYPTION_KEY = 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE='; // 32 字节 0x01 的 base64
const app = createApp({ kv, encryptionKey: ENCRYPTION_KEY, assets: mockAssets, fetchImpl: mkFetchImpl(1500), queryTimeoutMs: 1500 });
const BASE = 'https://panel.example.com';

async function req(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = 'Bearer ' + token;
  return app(new Request(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined }));
}

/* ================= 测试开始 ================= */
console.log('\n[1] 静态资源托管');
{
  const r = await req('/');
  assert(r.status === 200 && (await r.text()).includes('index-page'), 'GET / 返回前端页面');
  const r404 = await req('/api/none');
  assert(r404.status === 404, '未知 API 返回 404');
}

console.log('\n[2] 注册 / 登录 / 鉴权');
let token = '';
{
  const r = await req('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  assert(r.status === 200, '注册成功');
  const r2 = await req('/api/auth/register', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  assert(r2.status === 409, '重复注册被拒(409)');
  const r3 = await req('/api/auth/register', { method: 'POST', body: { username: 'ab', password: 'secret123' } });
  assert(r3.status === 400, '非法用户名被拒(400)');
  const r4 = await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'wrong' } });
  assert(r4.status === 401, '错误密码登录被拒(401)');
  const r5 = await req('/api/auth/login', { method: 'POST', body: { username: 'alice', password: 'secret123' } });
  assert(r5.status === 200, '正确密码登录成功');
  const d = await r5.json();
  token = d.token;
  assert(!!token, '登录返回 token');
  const r6 = await req('/api/keys');
  assert(r6.status === 401, '未登录访问受保护接口被拒(401)');
}

console.log('\n[3] 添加 key：前置校验（成功才可添加）');
let lkId = '';
{
  // 成功：lk888 风格
  const r = await req('/api/keys', {
    method: 'POST', token,
    body: {
      name: '中转站-888',
      endpoint: 'https://api.lk888.ai/v1/skills/balance',
      method: 'GET',
      headerTemplate: 'Authorization: Bearer {key}',
      balancePath: 'balance',
      unit: '',
      apiKey: 'sk-good-888',
    },
  });
  assert(r.status === 200, '合法 key 添加成功(预校验通过)');
  const d = await r.json();
  lkId = d.key.id;
  assert(d.key.balance === 3.99, '添加时已取到余额 3.99');
  assert(d.key.apiKeyMask === 'sk-goo...-888', '返回的是脱敏 key(' + d.key.apiKeyMask + ')');

  // 失败：坏 key → 不允许添加
  const bad = await req('/api/keys', {
    method: 'POST', token,
    body: {
      name: '坏key',
      endpoint: 'https://api.lk888.ai/v1/skills/balance',
      headerTemplate: 'Authorization: Bearer {key}',
      balancePath: 'balance',
      apiKey: 'sk-bad-key',
    },
  });
  assert(bad.status === 400, '坏 key 添加被拒(400)，校验失败不入库');
  assert((await bad.json()).error.includes('校验失败'), '拒绝原因包含"校验失败"');

  // 成功：OpenAI 风格（自定义请求头 x-api-key + 自定义字段路径）
  const oa = await req('/api/keys', {
    method: 'POST', token,
    body: {
      name: 'OpenAI',
      endpoint: 'https://api.openai.com/v1/dashboard/billing/credit_grants',
      headerTemplate: 'x-api-key: {key}',
      balancePath: 'total_granted',
      unit: 'USD',
      apiKey: 'sk-good-openai',
    },
  });
  assert(oa.status === 200, '自定义请求头平台添加成功');
  assert((await oa.json()).key.balance === 25.5, '自定义路径取到余额 25.5');

  // 字段路径错误 → 拒绝
  const wp = await req('/api/keys', {
    method: 'POST', token,
    body: {
      endpoint: 'https://api.lk888.ai/v1/skills/balance',
      headerTemplate: 'Authorization: Bearer {key}',
      balancePath: 'data.money',
      apiKey: 'sk-good-888',
    },
  });
  assert(wp.status === 400, '字段路径错误被拒(400)');
}

console.log('\n[4] 加密存储：KV 中不出现明文');
{
  const raw = await kv.get('keys:alice');
  assert(raw && !raw.includes('sk-good-888') && !raw.includes('sk-good-openai'), 'KV 中不含明文 key');
  assert(raw && raw.includes('apiKeyEnc'), 'KV 中以加密密文存储(apiKeyEnc)');
}

console.log('\n[5] 列表 / 刷新');
{
  const r = await req('/api/keys', { token });
  const d = await r.json();
  assert(r.status === 200 && d.keys.length === 2, '列表返回 2 个 key');
  assert(d.keys.every((k) => !k.apiKeyEnc), '列表响应不含加密字段/明文');
  assert(d.keys.every((k) => k.apiKeyMask && !k.apiKeyMask.includes('sk-good')), '列表响应只含脱敏 key');

  // 刷新全部
  const rf = await req('/api/refresh', { method: 'POST', token });
  const rfD = await rf.json();
  assert(rf.status === 200 && rfD.keys.length === 2, '刷新全部返回 2 个 key');
  const lk = rfD.keys.find((k) => k.id === lkId);
  assert(lk && lk.balance === 3.99 && lk.lastError === null, '刷新后余额更新为 3.99');

  // 单刷
  const one = await req('/api/keys/' + lkId + '/refresh', { method: 'POST', token });
  assert(one.status === 200 && (await one.json()).key.balance === 3.99, '单个 key 刷新成功');
}

console.log('\n[6] 删除 / 上限 50');
{
  // 先加满到 50（已有 2 个，再加 48 个）
  for (let i = 0; i < 48; i++) {
    const r = await req('/api/keys', {
      method: 'POST', token,
      body: {
        name: 'fill-' + i,
        endpoint: 'https://api.lk888.ai/v1/skills/balance',
        headerTemplate: 'Authorization: Bearer {key}',
        balancePath: 'balance',
        apiKey: 'sk-good-888',
      },
    });
    if (r.status !== 200) { console.log('  ✗ 填充第 ' + i + ' 个失败 ' + r.status); fail++; break; }
  }
  const over = await req('/api/keys', {
    method: 'POST', token,
    body: {
      endpoint: 'https://api.lk888.ai/v1/skills/balance',
      headerTemplate: 'Authorization: Bearer {key}',
      balancePath: 'balance',
      apiKey: 'sk-good-888',
    },
  });
  assert(over.status === 400 && (await over.json()).error.includes('50'), '第 51 个被拒(400)，提示上限 50');

  const del = await req('/api/keys/' + lkId, { method: 'DELETE', token });
  assert(del.status === 200, '删除成功');
  const list = await (await req('/api/keys', { token })).json();
  assert(list.keys.length === 49, '删除后剩 49 个');
  const delBad = await req('/api/keys/no-such-id', { method: 'DELETE', token });
  assert(delBad.status === 404, '删除不存在的 id 返回 404');
}

console.log('\n[7] 慢接口超时容错');
{
  const r = await req('/api/keys', {
    method: 'POST', token,
    body: {
      name: '慢',
      endpoint: 'https://api.slow.com/v1/balance',
      headerTemplate: 'Authorization: Bearer {key}',
      balancePath: 'balance',
      apiKey: 'sk-good-888',
    },
  });
  assert(r.status === 400, '超时接口添加被拒(400)');
}

console.log('\n[8] 退出登录');
{
  const r = await req('/api/auth/logout', { method: 'POST', token });
  assert(r.status === 200, '退出成功');
  const after = await req('/api/keys', { token });
  assert(after.status === 401, '退出后旧 token 失效(401)');
}

console.log('\n========== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ==========');
process.exit(fail > 0 ? 1 : 0);
