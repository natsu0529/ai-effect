// 学習データ作成用に Workers AI を呼ぶだけの Worker。公開せず `wrangler dev` でだけ動かす。
// AI バインディングはローカル開発でも Cloudflare 側で実行され、無料枠を使い切るとエラーになる。

interface Env {
  AI: Ai;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== "POST") return new Response("POST {model, prompt, maxTokens}", { status: 405 });
    const { model, prompt, maxTokens } = await req.json<{ model: string; prompt: string; maxTokens: number }>();
    try {
      const input = model.startsWith("@cf/openai/gpt-oss")
        ? { input: prompt, reasoning: { effort: "low" }, max_output_tokens: maxTokens }
        : { messages: [{ role: "user", content: prompt }], max_tokens: maxTokens };
      const out = await env.AI.run(model as keyof AiModels, input as never);
      const text = pickText(out);
      // 本文が見つからないときは、形を調べられるように応答をそのまま返す
      return Response.json(text ? { text } : { text, raw: out });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;

// モデルによって応答の形が違うので、本文が入りうる場所を順に探す
function pickText(out: unknown): string {
  const o = out as Record<string, any>;
  if (typeof o?.response === "string") return o.response;
  if (typeof o?.output_text === "string") return o.output_text;
  if (o?.choices?.[0]?.message?.content) return o.choices[0].message.content;
  if (Array.isArray(o?.output)) {
    return o.output
      .filter((p: any) => p.type === "message")
      .flatMap((p: any) => p.content ?? [])
      .map((c: any) => c.text ?? "")
      .join("");
  }
  return "";
}
