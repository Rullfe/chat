/**
 * API 余额查询面板 —— Worker 后端核心逻辑
 *
 * 零依赖，全部使用 Web 标准 API（Request/Response/WebCrypto/KV）。
 * 通过 createApp() 注入依赖（KV、加密密钥、静态资源、fetch 实现），
 * 既可直接运行于 Cloudflare Workers，也便于本地 mock 测试。
 */

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8' };
const SESSION_TTL = 60 * 60 * 24 * 7;        // 登录态有效期：7 天
const MAX_KEYS = 50;                          // 每个用户最多 50 个 key
const QUERY_TIMEOUT_MS = 12000;               // 余额查询超时
const PASSWORD_MIN = 6;
const USERNAME_RE = /^[a-zA-Z0-9_]{3,32}$/;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- 基础工具 ---------------- */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function b64encode(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64decode(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomToken(bytes = 32) {
  return b64encode(crypto.getRandomValues(new Uint8Array(bytes)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function genId() {
  return Date.now().toString(36) + '-' + randomToken(6);
}

/** 按点号路径从 JSON 中取值，支持数字下标，如 data.balance / result.items.0.value */
function extractPath(obj, path) {
  if (!path) return undefined;
  return String(path).split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

/** 明文 key 脱敏，只保留前后片段 */
function maskKey(apiKey) {
  const s = String(apiKey || '');
  if (s.length <= 8) return s.slice(0, 2) + '***';
  return s.slice(0, 6) + '...' + s.slice(-4);
}

/* ---------------- 加密 / 哈希（WebCrypto） ---------------- */

export function createCrypto(encryptionKey) {
  let cachedKey = null;

  async function key() {
    if (cachedKey) return cachedKey;
    const raw = b64decode(encryptionKey);
    cachedKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return cachedKey;
  }

  /** AES-256-GCM 加密，格式 b64(iv):b64(ciphertext)，AAD 绑定用户名防跨用户替换 */
  async function encrypt(plain, aad) {
    const k = await key();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      k,
      enc.encode(plain)
    );
    return `${b64encode(iv)}:${b64encode(new Uint8Array(ct))}`;
  }

  async function decrypt(payload, aad) {
    const k = await key();
    const [ivB64, ctB64] = String(payload).split(':');
    const iv = b64decode(ivB64);
    const ct = b64decode(ctB64);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: enc.encode(aad) },
      k,
      ct
    );
    return dec.decode(plain);
  }

  async function hashPassword(password, salt) {
    const material = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
      material,
      256
    );
    return b64encode(new Uint8Array(bits));
  }

  return { encrypt, decrypt, hashPassword };
}

/* ---------------- 余额查询 ---------------- */

/**
 * 查询单个 key 的余额。
 * record 含 endpoint / method / headerTemplate / balancePath / unit / apiKeyEnc / owner
 * 返回 { ok:true, balance, unit?, raw? } 或 { ok:false, error }
 */
export async function queryBalance(record, crypt, fetchImpl, timeoutMs = QUERY_TIMEOUT_MS) {
  let apiKey;
  try {
    apiKey = await crypt.decrypt(record.apiKeyEnc, record.owner);
  } catch {
    return { ok: false, error: '本地解密失败，key 可能已损坏' };
  }

  const url = record.endpoint;
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, error: '查询接口 URL 不是合法的 http(s) 地址' };
  }

  const headers = { Accept: 'application/json' };
  if (record.headerTemplate && String(record.headerTemplate).trim()) {
    for (const line of String(record.headerTemplate).split('\n')) {
      const idx = line.indexOf(':');
      if (idx > 0) {
        const name = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim().replace(/\{key\}/g, apiKey);
        if (name) headers[name] = value;
      }
    }
  } else {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  let res;
  try {
    res = await fetchImpl(url, {
      method: record.method === 'POST' ? 'POST' : 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const name = e && e.name;
    if (name === 'TimeoutError') return { ok: false, error: '请求超时（' + (timeoutMs / 1000) + 's）' };
    return { ok: false, error: '网络请求失败：' + (e && e.message ? e.message : '未知错误') };
  }

  const text = await res.text().catch(() => '');
  let body = null;
  try { body = JSON.parse(text); } catch { /* 非 JSON 响应 */ }

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    const e = body;
    if (e) msg = e.error?.message || e.error || e.message || e.msg || msg;
    if (!body && text && text.length < 200) msg = text;
    return { ok: false, error: msg };
  }

  const path = record.balancePath || 'balance';
  const val = extractPath(body, path);
  if (val === undefined || val === null || Number.isNaN(Number(val))) {
    return { ok: false, error: `无法解析余额：字段 "${path}" 不存在或不是数字` };
  }

  const result = { ok: true, balance: Number(val) };
  // 用户未填单位时，尝试从响应中自动识别
  if (!record.unit && body) {
    const autoUnit = body.unit || body.currency || body.balance_unit;
    if (autoUnit && typeof autoUnit === 'string') result.unit = autoUnit;
  }
  return result;
}

/* ---------------- 应用主体 ---------------- */

export function createApp({ kv, encryptionKey, assets, fetchImpl = globalThis.fetch, queryTimeoutMs = QUERY_TIMEOUT_MS }) {
  const crypt = createCrypto(encryptionKey);
  const query = (record) => queryBalance(record, crypt, fetchImpl, queryTimeoutMs);

  /* ---- 用户与会话 ---- */

  async function register(username, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await crypt.hashPassword(password, salt);
    const existing = await kv.get(`user:${username}`);
    if (existing) return json({ error: '用户名已被注册' }, 409);
    await kv.put(`user:${username}`, JSON.stringify({ hash, salt: b64encode(salt), createdAt: Date.now() }));
    return json({ ok: true });
  }

  async function login(username, password) {
    const raw = await kv.get(`user:${username}`);
    if (!raw) return json({ error: '用户名或密码错误' }, 401);
    const user = JSON.parse(raw);
    const salt = b64decode(user.salt);
    const hash = await crypt.hashPassword(password, salt);
    if (hash !== user.hash) return json({ error: '用户名或密码错误' }, 401);

    const token = randomToken(32);
    await kv.put(`session:${token}`, username, { expirationTtl: SESSION_TTL });
    return json({ ok: true, token, username });
  }

  async function currentUser(request) {
    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (!token) return null;
    const username = await kv.get(`session:${token}`);
    return username || null;
  }

  async function logout(request) {
    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    if (token) await kv.delete(`session:${token}`);
    return json({ ok: true });
  }

  /* ---- key 管理 ---- */

  async function getKeys(username) {
    const raw = await kv.get(`keys:${username}`);
    return raw ? JSON.parse(raw) : [];
  }

  async function saveKeys(username, keys) {
    await kv.put(`keys:${username}`, JSON.stringify(keys));
  }

  /** 输出给前端的脱敏字段（绝不返回明文 key） */
  function publicKey(k) {
    return {
      id: k.id,
      name: k.name,
      endpoint: k.endpoint,
      method: k.method || 'GET',
      balancePath: k.balancePath || 'balance',
      unit: k.unit || '',
      apiKeyMask: k.apiKeyMask,
      createdAt: k.createdAt,
      lastCheckedAt: k.lastCheckedAt,
      balance: k.balance == null ? null : k.balance,
      lastError: k.lastError || null,
    };
  }

  /* ---- 路由 ---- */

  async function handle(request, pathname) {
    const method = request.method;

    // 未知 API 路径直接 404（在鉴权之前，语义更准确）
    const known = /^\/api\/(auth\/(register|login|logout|me)|keys(\/[^/]+(\/refresh)?)?|refresh)$/;
    if (!known.test(pathname)) {
      return json({ error: '接口不存在' }, 404);
    }

    /* 认证 */
    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { username, password } = body;
      if (!USERNAME_RE.test(username || '')) return json({ error: '用户名需为 3-32 位字母/数字/下划线' }, 400);
      if (typeof password !== 'string' || password.length < PASSWORD_MIN) return json({ error: `密码至少 ${PASSWORD_MIN} 位` }, 400);
      return register(username, password);
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      return login(body.username || '', body.password || '');
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      return logout(request);
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const username = await currentUser(request);
      if (!username) return json({ error: '未登录' }, 401);
      return json({ username });
    }

    /* 以下接口均需登录 */
    const username = await currentUser(request);
    if (!username) return json({ error: '未登录' }, 401);

    /* 获取 key 列表（含缓存的余额，页面加载时先展示再刷新） */
    if (pathname === '/api/keys' && method === 'GET') {
      const keys = await getKeys(username);
      return json({ keys: keys.map(publicKey) });
    }

    /* 添加 key：必须先校验查询成功，否则拒绝保存 */
    if (pathname === '/api/keys' && method === 'POST') {
      const body = await request.json().catch(() => ({}));
      const { name, endpoint, method: reqMethod, headerTemplate, balancePath, unit, apiKey } = body;

      if (typeof apiKey !== 'string' || !apiKey.trim()) return json({ error: '请填写 API Key' }, 400);
      if (typeof endpoint !== 'string' || !/^https?:\/\/.+/i.test(endpoint.trim())) {
        return json({ error: '请填写合法的查询接口 URL（http/https）' }, 400);
      }
      if (typeof balancePath !== 'string' || !balancePath.trim()) {
        return json({ error: '请填写余额字段路径，如 balance 或 data.balance' }, 400);
      }

      const keys = await getKeys(username);
      if (keys.length >= MAX_KEYS) {
        return json({ error: `最多只能添加 ${MAX_KEYS} 个 key` }, 400);
      }

      const record = {
        id: genId(),
        name: (name || '').trim() || '未命名',
        endpoint: endpoint.trim(),
        method: reqMethod === 'POST' ? 'POST' : 'GET',
        headerTemplate: (headerTemplate || '').trim(),
        balancePath: balancePath.trim(),
        unit: (unit || '').trim(),
        apiKeyEnc: await crypt.encrypt(apiKey.trim(), username),
        apiKeyMask: maskKey(apiKey.trim()),
        owner: username,
        createdAt: Date.now(),
        lastCheckedAt: null,
        balance: null,
        lastError: null,
      };

      // 关键：添加前先真实查询一次，失败则不允许添加
      const test = await query(record);
      if (!test.ok) {
        return json({ error: '校验失败，无法添加：' + test.error }, 400);
      }
      record.balance = test.balance;
      record.lastCheckedAt = Date.now();
      if (test.unit) record.unit = test.unit;

      keys.push(record);
      await saveKeys(username, keys);
      return json({ ok: true, key: publicKey(record) });
    }

    /* 删除 key */
    if (pathname.startsWith('/api/keys/') && method === 'DELETE') {
      const id = decodeURIComponent(pathname.slice('/api/keys/'.length));
      const keys = await getKeys(username);
      const next = keys.filter((k) => k.id !== id);
      if (next.length === keys.length) return json({ error: 'key 不存在' }, 404);
      await saveKeys(username, next);
      return json({ ok: true });
    }

    /* 刷新单个 key 的余额 */
    if (pathname.startsWith('/api/keys/') && pathname.endsWith('/refresh') && method === 'POST') {
      const id = decodeURIComponent(pathname.slice('/api/keys/'.length, -'/refresh'.length));
      const keys = await getKeys(username);
      const idx = keys.findIndex((k) => k.id === id);
      if (idx < 0) return json({ error: 'key 不存在' }, 404);
      const r = await query(keys[idx]);
      if (r.ok) {
        keys[idx].balance = r.balance;
        keys[idx].lastError = null;
        if (r.unit) keys[idx].unit = r.unit;
      } else {
        keys[idx].balance = null;
        keys[idx].lastError = r.error;
      }
      keys[idx].lastCheckedAt = Date.now();
      await saveKeys(username, keys);
      return json({ ok: true, key: publicKey(keys[idx]) });
    }

    /* 刷新全部 key 的余额（并行），前端刷新按钮与页面加载均调用此接口 */
    if (pathname === '/api/refresh' && method === 'POST') {
      const keys = await getKeys(username);
      const results = await Promise.all(keys.map(async (k) => {
        const r = await query(k);
        if (r.ok) {
          k.balance = r.balance;
          k.lastError = null;
          if (r.unit) k.unit = r.unit;
        } else {
          k.balance = null;
          k.lastError = r.error;
        }
        k.lastCheckedAt = Date.now();
        return k;
      }));
      await saveKeys(username, results);
      return json({ ok: true, refreshedAt: Date.now(), keys: results.map(publicKey) });
    }

    return json({ error: '接口不存在' }, 404);
  }

  return async function fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // 非 API 请求交给静态资源（前端页面）处理
      if (assets && typeof assets.fetch === 'function') {
        return assets.fetch(request);
      }
      return json({ error: 'Not Found' }, 404);
    }
    try {
      return await handle(request, url.pathname);
    } catch (e) {
      return json({ error: '服务器内部错误：' + (e && e.message ? e.message : 'unknown') }, 500);
    }
  };
      }
