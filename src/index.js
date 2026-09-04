// src/index.js
const enc = new TextEncoder();

// 暂存最近一次收到的群消息（同 isolate 内有效）
let lastEvent = null;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === '/health' && request.method === 'GET') {
      return new Response('ok, secret_set=' + (env.BOT_SECRET ? 'yes' : 'NO'));
    }

    // 查看最近一次群事件（方便拿 group_openid）
    if (url.pathname === '/last-group' && request.method === 'GET') {
      return Response.json(lastEvent || { message: '还没有收到群事件，请先在群里 @ 机器人' });
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

    // 静态资源（ASSETS 未绑定时返回 404 而非崩溃）
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('not found', { status: 404 });
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
    // 暂存事件，方便通过 /last-group 查看
    lastEvent = {
      t: body.t,
      group_openid: body.d?.group_openid,
      author: body.d?.author,
      content: body.d?.content,
      timestamp: new Date().toISOString(),
    };

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
  let seed = secret;
  while (seed.length < 32) seed += secret;
  seed = seed.slice(0, 32);

  const pkcs8Header = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
    0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
  ]);
  const seedBytes = enc.encode(seed);
  const pkcs8 = new Uint8Array(16 + 32);
  pkcs8.set(pkcs8Header, 0);
  pkcs8.set(seedBytes, 16);

  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']);
  const msg = enc.encode(eventTs + plainToken);
  const sig = await crypto.subtle.sign('Ed25519', key, msg);
  return bytesToHex(new Uint8Array(sig));
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
