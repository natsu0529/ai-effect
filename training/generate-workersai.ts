// 人間側の記事と同じタイトル・媒体で、Workers AI のモデルに記事を書かせる。
// 先に `npx wrangler dev -c training/wrangler.jsonc --port 8788` で生成用の Worker を起動しておく。
//
// node training/generate-workersai.ts

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import type { HumanDoc } from "./collect-human.ts";
import { buildPrompt, cleanTitle, normalizeOutput } from "./prompts.ts";

const GENERATOR = process.env.GENERATOR ?? "http://localhost:8788";
const HUMAN = new URL("./data/human.jsonl", import.meta.url);
const OUT = new URL("./data/ai.jsonl", import.meta.url);
const MODELS = [
  "@cf/qwen/qwen3-30b-a3b-fp8",
  "@cf/openai/gpt-oss-20b",
  "@cf/mistralai/mistral-small-3.1-24b-instruct",
];

export interface AiDoc {
  id: string;
  pairOf: string;
  generator: "workers-ai" | "claude-haiku";
  model: string;
  variant: number;
  lang: string;
  title: string;
  text: string;
}

const readJsonl = <T>(url: URL): T[] =>
  existsSync(url) ? readFileSync(url, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

const humans = readJsonl<HumanDoc>(HUMAN);
const done = new Set(readJsonl<AiDoc>(OUT).filter((d) => d.generator === "workers-ai").map((d) => d.pairOf));

// 1 件に 1 分ほどかかるので、何件かずつ同時に頼む
const CONCURRENCY = 4;
const queue = [...humans.entries()].filter(([, doc]) => !done.has(doc.id));
let quotaExhausted = false;

async function worker() {
  for (let next = queue.shift(); next && !quotaExhausted; next = queue.shift()) {
    const [i, doc] = next;
    const model = MODELS[i % MODELS.length];
    const variant = Math.floor(i / MODELS.length) % 3;
    const res = await fetch(GENERATOR, {
      method: "POST",
      body: JSON.stringify({ model, prompt: buildPrompt(doc, variant), maxTokens: 4000 }),
    });
    const body = await res.json() as { text?: string; error?: string };
    if (!res.ok || !body.text) {
      console.log(`! ${doc.id} ${model}: ${body.error ?? "empty"}`);
      // 無料枠を使い切ったら、その日はそれ以上続けても失敗するだけなので止める
      if (/daily free allocation|4006|quota/i.test(body.error ?? "")) quotaExhausted = true;
      continue;
    }
    const text = normalizeOutput(body.text);
    const ai: AiDoc = {
      id: `w${doc.id.slice(1)}`, pairOf: doc.id, generator: "workers-ai", model, variant,
      lang: doc.lang, title: cleanTitle(doc.title), text,
    };
    appendFileSync(OUT, JSON.stringify(ai) + "\n");
    console.log(`+ ${model.split("/").pop()} v${variant} ${ai.title.slice(0, 40)} (${text.length})`);
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));
