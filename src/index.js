// src/index.js
import { sign } from '@noble/ed25519';

const enc = new TextEncoder();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/qq/webhook' && request.method === 'POST') {
      return handleQQWebhook(request, env);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleQQWebhook(request, env) {
  const body = await request.json();
  // op=13 握手验证
  if (body.op === 13) {
    const { plain_token, event_ts } = body.d;
    const signature = await signWithSecret(env.BOT_SECRET, event_ts, plain_token);
    return Response.json({ plain_token, signature });
  }

  // 业务事件
  if (body.op === 0) {
    const { t, d } = body;
    if (t === 'GROUP_AT_MESSAGE_CREATE') {
      console.log('group_openid =', d.group_openid);
    }
    if (t === 'GROUP_ADD_ROBOT') {
      console.log('group_openid =', d.group_openid);
    }
  }
  return Response.json({ code: 0 });
}

async function signWithSecret(clientSecret, eventTs, plainToken) {
  // --------【修复关键点：移除循环填充seed！直接使用secret原始UTF8字节】--------
  const seedBytes = enc.encode(clientSecret);
  const messageRaw = eventTs + plainToken;
  const msgBytes = enc.encode(messageRaw);
  const sig = await sign(msgBytes, seedBytes);
  return bytesToHex(sig);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
