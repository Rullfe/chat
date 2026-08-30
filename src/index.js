// src/index.js
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response('ok, secret_set=' + (env.BOT_SECRET ? 'yes' : 'NO'));
    }

    if (url.pathname === '/api/qq/webhook' && request.method === 'POST') {
      try {
        return await handleWebhook(request, env);
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e), stack: e.stack }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleWebhook(request, env) {
  if (!env.BOT_SECRET) {
    return new Response(JSON.stringify({ error: 'BOT_SECRET not set' }), { status: 500 });
  }

  const body = await request.json();

  if (body.op === 13) {
    const { plain_token, event_ts } = body.d;
    const signature = await calcSig(env.BOT_SECRET, event_ts, plain_token);
    return Response.json({ plain_token, signature });
  }

  if (body.op === 0) {
    if (body.t === 'GROUP_AT_MESSAGE_CREATE') {
      console.log('group_openid =', body.d.group_openid);
    }
    if (body.t === 'GROUP_ADD_ROBOT') {
      console.log('机器人被拉入群 group_openid =', body.d.group_openid);
    }
  }
  return Response.json({ code: 0 });
}

async function calcSig(secret, eventTs, plainToken) {
  // 1. seed 补齐到 32 字节
  let seed = secret;
  while (seed.length < 32) seed += secret;
  seed = seed.slice(0, 32);

  // 2. 构造 PKCS#8 格式的 Ed25519 私钥（Worker 的 WebCrypto 只认这个）
  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const seedBytes = enc.encode(seed);
  const pkcs8 = new Uint8Array(16 + 32);
  pkcs8.set(pkcs8Header, 0);
  pkcs8.set(seedBytes, 16);

  // 3. 导入私钥并签名
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  const msg = enc.encode(eventTs + plainToken);
  const sig = await crypto.subtle.sign('Ed25519', key, msg);
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
