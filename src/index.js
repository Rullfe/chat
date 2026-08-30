// src/index.js
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response('ok, secret_set=' + (env.BOT_SECRET ? 'yes' : 'NO'));
    }

    // QQ 回调
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

    // 静态资源
    return env.ASSETS.fetch(request);
  },
};

async function handleWebhook(request, env) {
  if (!env.BOT_SECRET) {
    return new Response(JSON.stringify({ error: 'BOT_SECRET not set' }), { status: 500 });
  }

  const body = await request.json();

  // op=13：回调地址验证握手
  if (body.op === 13) {
    const { plain_token, event_ts } = body.d;
    const signature = await calcSig(env.BOT_SECRET, event_ts, plain_token);
    return Response.json({ plain_token, signature });
  }

  // op=0：业务事件
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
  // QQ 规则：secret 循环补齐到 32 字节作为 ed25519 私钥 seed
  let seed = secret;
  while (seed.length < 32) seed += secret;
  seed = seed.slice(0, 32);

  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(seed),
    'Ed25519',
    false,
    ['sign']
  );
  const msg = enc.encode(eventTs + plainToken);
  const sig = await crypto.subtle.sign('Ed25519', key, msg);
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
