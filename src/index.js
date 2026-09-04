// src/index.js
// QQ 群机器人 + AI 中转 Worker
// 流程：QQ群@机器人 -> Webhook 收到 GROUP_AT_MESSAGE_CREATE -> 调 AI 生成回复 -> 回推群
// 密钥全部走环境变量（Cloudflare 后台设置，勿写进代码/仓库）
// 必需：QQ_APP_ID, QQ_APP_SECRET, AI_API_KEY；可选：AI_BASE_URL, AI_MODEL

const enc = new TextEncoder();
let tokenCache = { token: null, expiresAt: 0 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '/health') {
      return Response.json({
        ok: true,
        qq_secret_set: !!env.QQ_APP_SECRET,
        ai_key_set: !!env.AI_API_KEY,
        ai_base: env.AI_BASE_URL || '(default: dashscope-intl)',
        ai_model: env.AI_MODEL || '(default: qwen-plus)',
      });
    }

    if (url.pathname === '/api/qq/webhook' && request.method === 'POST') {
      try {
        return await handleWebhook(request, env, ctx);
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e), stack: e.stack }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response('not found', { status: 404 });
  },
};

async function handleWebhook(request, env, ctx) {
  if (!env.QQ_APP_SECRET) {
    return new Response(JSON.stringify({ error: 'QQ_APP_SECRET not set' }), { status: 500 });
  }
  const body = await request.json();

  // op=13：回调地址验证握手
  if (body.op === 13) {
    const { plain_token, event_ts } = body.d;
    const signature = await calcSig(env.QQ_APP_SECRET, event_ts, plain_token);
    return Response.json({ plain_token, signature });
  }

  // op=0：业务事件（异步处理，快速返回）
  if (body.op === 0) {
    ctx.waitUntil(handleEvent(body, env).catch((e) => console.error('handleEvent error', e)));
  }
  return Response.json({ code: 0 });
}

async function handleEvent(body, env) {
  const t = body.t;
  const d = body.d;
  console.log('收到事件', t);

  if (t === 'GROUP_AT_MESSAGE_CREATE') {
    const groupOpenId = d.group_openid;
    const memberOpenId = d.author?.member_openid;
    const userContent = (d.content || '').trim();
    console.log('群@消息', { groupOpenId, memberOpenId, userContent });

    let aiReply;
    try {
      aiReply = await askAI(env, userContent);
    } catch (e) {
      console.error('AI 调用失败', e);
      aiReply = '抱歉，AI 服务暂时不可用。';
    }
    await sendGroupMessage(env, groupOpenId, memberOpenId, aiReply);
  }

  if (t === 'GROUP_ADD_ROBOT') {
    console.log('机器人被拉入群', d.group_openid);
  }
}

// OpenAI 兼容的 AI 调用
async function askAI(env, userContent) {
  const baseUrl = (env.AI_BASE_URL || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const model = env.AI_MODEL || 'qwen-plus';

  const res = await fetch(baseUrl + '/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + env.AI_API_KEY,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是群聊机器人，请用简洁、友好、自然的中文回答群成员的问题。' },
        { role: 'user', content: userContent },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('AI HTTP ' + res.status + ': ' + text.slice(0, 300));
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '（AI 未返回内容）';
}

async function getAccessToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token;
  const res = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: env.QQ_APP_ID, clientSecret: env.QQ_APP_SECRET }),
  });
  if (!res.ok) throw new Error('getAppAccessToken HTTP ' + res.status);
  const data = await res.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = Date.now() + (Number(data.expires_in) - 60) * 1000;
  return data.access_token;
}

async function sendGroupMessage(env, groupOpenId, memberOpenId, text) {
  const token = await getAccessToken(env);
  const content = memberOpenId ? `<@${memberOpenId}> ${text}` : text;
  const res = await fetch(`https://api.sgroup.qq.com/v2/groups/${groupOpenId}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': 'QQBot ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  const data = await res.json().catch(() => null);
  console.log('群消息发送结果', res.status, JSON.stringify(data));
  if (!res.ok) throw new Error('sendGroupMessage failed ' + res.status + ' ' + JSON.stringify(data));
  return data;
}

// WebCrypto Ed25519 签名（免第三方依赖）
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
