// functions/api/qq/webhook.js
import { ed25519 } from '@noble/ed25519';

const enc = new TextEncoder();

export async function onRequestPost({ request, env }) {
  const body = await request.json();

  // op=13：回调地址验证握手（必须实现，否则保存失败）
  if (body.op === 13) {
    const { plain_token, event_ts } = body.d;
    const signature = signWithSecret(env.BOT_SECRET, event_ts, plain_token);
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

function signWithSecret(secret, eventTs, plainToken) {
  // seed 补齐到 32 字节（循环复制 secret）
  let seed = secret;
  while (seed.length < 32) seed += secret;
  seed = seed.slice(0, 32);

  const privKey = enc.encode(seed);                  // 32字节seed = ed25519私钥
  const msg = enc.encode(eventTs + plainToken);
  const sig = ed25519.sign(msg, privKey);
  return bytesToHex(sig);
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
