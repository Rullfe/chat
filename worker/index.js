export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access‑Control‑Allow‑Origin": "*",
      "Access‑Control‑Allow‑Methods": "POST,OPTIONS",
      "Access‑Control‑Allow‑Headers": "Content‑Type,X‑Access‑Token"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({error:"Only POST allowed"}),
        {status:405, headers:{...corsHeaders,"Content‑Type":"application/json"}})
    }

    const clientToken = request.headers.get("X‑Access‑Token");
    const correctToken = await env.QwenKV.get("ACCESS_TOKEN");
    if (!clientToken || clientToken !== correctToken) {
      return new Response(JSON.stringify({error:"Unauthorized"}),
        {status:401, headers:{...corsHeaders,"Content‑Type":"application/json"}})
    }

    let body;
    try {
      body = await request.json();
    } catch(e) {
      return new Response(JSON.stringify({error:"Bad JSON body"}),
        {status:400,headers:{...corsHeaders,"Content‑Type":"application/json"}})
    }

    const apiKey = await env.QwenKV.get("QWEN_API_KEY");
    if(!apiKey){
      return new Response(JSON.stringify({error:"Backend key not configured"}),
        {status:500,headers:{...corsHeaders,"Content‑Type":"application/json"}})
    }

    const qwenPayload = {
      model: "qwen3.8‑flash",
      input:{
        messages: body.messages
      },
      parameters:{
        temperature: body.temperature ?? 0.7,
        incremental_output: !!body.stream
      }
    };

    const qwenResp = await fetch("https://dashscope‑intl.aliyuncs.com/api/v1/services/aigc/text‑generation/generation",{
      method:"POST",
      headers:{
        "Authorization":`Bearer ${apiKey}`,
        "Content‑Type":"application/json"
      },
      body: JSON.stringify(qwenPayload)
    });

    return new Response(qwenResp.body,{
      status: qwenResp.status,
      headers:{
        ...corsHeaders,
        "Content‑Type": qwenResp.headers.get("content‑type") || "application/json"
      }
    })
  }
}
