export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return Response.json({ ok: false, msg: "only accept post" }, { status: 405 });
    }

    const payload = await request.json();

    // QQ Webhook PING‑Challenge回调验证
    if (payload.event === "PING") {
      return Response.json({ challenge: payload.challenge });
    }

    const eventType = payload.t;
    const d = payload.d;

    // 只处理群消息事件
    if (eventType !== "GROUP_MESSAGE_CREATE") {
      return Response.json({ code: 0 });
    }

    // 过滤机器人自己发送消息
    if (d.author.bot) {
      return Response.json({ code: 0 });
    }

    const botOpenId = await env.QwenKV.get("bot_openid");
    const rawContent = d.content ?? "";

    // 没有@本机器人直接结束
    if (!rawContent.includes(`<@${botOpenId}>`)) {
      return Response.json({ code: 0 });
    }

    // 删除@标记，清理多余空白
    let userPrompt = rawContent.replace(new RegExp(`<@${botOpenId}>`, "g"), "").trim();
    if (!userPrompt) {
      return Response.json({ code: 0 });
    }

    // ----------------限流逻辑：同一用户60秒最多10次----------------
    const userId = d.author.member_openid;
    const now = Math.floor(Date.now() / 1000);
    const rateKey = `rl:${userId}`;
    const rateRaw = await env.QwenKV.get(rateKey);
    let rateState = rateRaw ? JSON.parse(rateRaw) : { ts: now, count: 0 };

    // 超过60秒窗口重置计数
    if (now - rateState.ts > 60) {
      rateState = { ts: now, count: 0 };
    }
    rateState.count += 1;

    // 超过10次直接丢弃消息，不调用AI
    if (rateState.count > 10) {
      await env.QwenKV.put(rateKey, JSON.stringify(rateState));
      return Response.json({ code: 0 });
    }
    await env.QwenKV.put(rateKey, JSON.stringify(rateState));
    // ----------------------------------------------------------------

    // ctx.waitUntil：后台异步跑任务，规避QQ强制5秒http超时
    ctx.waitUntil((async () => {
      try {
        const qqAppId = await env.QwenKV.get("QQ_APPID");
        const qqAppSecret = await env.QwenKV.get("QQ_APPSECRET");
        const qwenApiKey = await env.QwenKV.get("QWEN_API_KEY");

        // 获取QQ访问凭证
        const tokenRes = await fetch("https://bots.qq.com/app/getAppAccessToken", {
          method: "POST",
          headers: { "Content‑Type": "application/json" },
          body: JSON.stringify({ appId: qqAppId, appSecret: qqAppSecret })
        });
        const tokenData = await tokenRes.json();
        const accessToken = tokenData.access_token;

        // 请求千问AI
        const aiResp = await fetch("https://dashscope‑intl.aliyuncs.com/api/v1/services/aigc/text‑generation/generation", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${qwenApiKey}`,
            "Content‑Type": "application/json"
          },
          body: JSON.stringify({
            model: "qwen3.8‑flash",
            input: { messages: [{ role: "user", content: userPrompt }] },
            parameters: { temperature: 0.7 }
          })
        });

        const aiResult = await aiResp.json();
        let replyText = aiResult.output.text.slice(0, 1990);

        // QQ接口发送回复至群聊
        await fetch(`https://api.bot.qq.com/v1/groups/${d.group_openid}/messages`, {
          method: "POST",
          headers: {
            "Authorization": `QQBot ${accessToken}`,
            "Content‑Type": "application/json"
          },
          body: JSON.stringify({
            content: replyText,
            msg_id: d.id
          })
        });

      } catch (err) {
        console.error("后台任务异常", err);
      }
    })());

    // QQ Webhook必须立刻返回200
    return Response.json({ code: 0 });
  }
};
