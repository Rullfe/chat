// src/index.js
import { sign } from '@noble/ed25519';

const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // QQ 回调端点
    if (url.pathname === '/api/qq/webhook' && request.method === 'POST') {
      return handleQQWebhook(request, env);
    }

    // 其他路径交给静态资源
    return env.ASSETS.fetch(request);
  },
};

async function handleQQWebhook(request, env) {
  const body = await request.json();

  // op=13：回调地址验证握手
  if (body.op === 13) {
    const { plain_token, event_ts } = body.d;
    const signature = await signWithSecret(env.BOT_SECRET, event_ts, plain_token);
    return Response.json({ plain_token, signature });
  }

  // op=0：真实业务事件
  if (body.op === 0) {
    const { t, d } = body;
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      console.log('group_openid =', d.group_openid); // ← 你要的群ID
    }
    if (t === 'GROUP_ADD_ROBOT') {
      console.log('机器人被拉入群 group_openid =', d.group_openid);
    }
  }
  return Response.json({ code: 0 });
}

async function signWithSecret(secret, eventTs, plainToken) {
  // QQ 规则：secret 循环补齐到 32 字节作为 ed25519 私钥 seed
  let seed = secret;
  while (seed.length < 32) seed += secret;
  seed = seed.slice(0, 32);

  const privKey = enc.encode(seed);
  const msg = enc.encode(eventTs + plainToken);
  const sig = await sign(msg, privKey);
  return bytesToHex(sig);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}
