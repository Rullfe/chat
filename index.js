export default {
  async fetch(request, env, ctx) {
    if (request.method !== "POST") {
      return Response.json({ok:false});
    }
    const payload = await request.json();
    if(payload.event === "PING") return Response.json({challenge:payload.challenge});

    const eventType = payload.t;
    const d = payload.d;
    // 打印完整事件日志到worker日志面板
    console.log("【完整事件】",JSON.stringify(d,null,2));
    return Response.json({code:0});
  }
}
