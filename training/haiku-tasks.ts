// Claude Code の Haiku サブエージェントに記事を書かせるための依頼を、束ごとのファイルに分けて書き出す。
// サブエージェントは束のファイルを読み、依頼ごとに training/data/haiku-out/<id>.md を書く。
// 書き終わったら `node training/haiku-tasks.ts import` で ai.jsonl に取り込む。
//
// node training/haiku-tasks.ts [束の数]
// node training/haiku-tasks.ts import

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { HumanDoc } from "./collect-human.ts";
import type { AiDoc } from "./generate-workersai.ts";
import { buildPrompt, cleanTitle, normalizeOutput } from "./prompts.ts";

const DATA = new URL("./data/", import.meta.url);
const TASKS = new URL("./haiku-tasks/", DATA);
const OUTDIR = new URL("./haiku-out/", DATA);

const readJsonl = <T>(name: string): T[] => {
  const url = new URL(name, DATA);
  return existsSync(url) ? readFileSync(url, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const humans = readJsonl<HumanDoc>("human.jsonl");
const done = new Set(readJsonl<AiDoc>("ai.jsonl").filter((d) => d.generator === "claude-haiku").map((d) => d.pairOf));
// Workers AI と依頼文の型がかぶらないよう、variant をずらす
const variantOf = (i: number) => (i + 1) % 3;

if (process.argv[2] === "import") {
  let n = 0;
  for (const [i, doc] of humans.entries()) {
    const file = new URL(`a${doc.id.slice(1)}.md`, OUTDIR);
    if (done.has(doc.id) || !existsSync(file)) continue;
    const ai: AiDoc = {
      id: `a${doc.id.slice(1)}`, pairOf: doc.id, generator: "claude-haiku", model: "claude-haiku",
      variant: variantOf(i), lang: doc.lang, title: cleanTitle(doc.title),
      text: normalizeOutput(readFileSync(file, "utf8")),
    };
    appendFileSync(new URL("ai.jsonl", DATA), JSON.stringify(ai) + "\n");
    n++;
  }
  console.log(`imported ${n}`);
} else {
  const batches = Number(process.argv[2] ?? 4);
  mkdirSync(TASKS, { recursive: true });
  mkdirSync(OUTDIR, { recursive: true });
  for (const f of readdirSync(TASKS)) writeFileSync(new URL(f, TASKS), "[]");
  const todo = humans
    .map((doc, i) => ({ id: `a${doc.id.slice(1)}`, prompt: buildPrompt(doc, variantOf(i)), human: doc.id }))
    .filter((t) => !done.has(t.human) && !existsSync(new URL(`${t.id}.md`, OUTDIR)));
  for (let b = 0; b < batches; b++) {
    const items = todo.filter((_, i) => i % batches === b).map(({ id, prompt }) => ({ id, prompt }));
    writeFileSync(new URL(`batch-${b}.json`, TASKS), JSON.stringify(items, null, 2));
    console.log(`batch-${b}.json: ${items.length}`);
  }
}
