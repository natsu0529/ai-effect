// 文体の特徴量でロジスティック回帰を学習し、web/model.json に書き出す。
// 評価はサイト単位の交差検証（1 サイトずつ外して残りで学習し、外したサイトを当てる）で行う。
// AI 側の記事は、元にした人間側の記事と同じサイトの組に入れる。
//
// node training/train.ts

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { computeFeatures, FEATURES } from "../web/features.ts";
import type { HumanDoc } from "./collect-human.ts";
import type { AiDoc } from "./generate-workersai.ts";

const MIN_CHARS = 300;
const L2 = 0.05;
const ITERATIONS = 3000;
const LEARNING_RATE = 0.2;

interface Sample {
  x: number[];
  y: 0 | 1;
  group: string;
  tag: string;
}

const readJsonl = <T>(path: string): T[] => {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const humans = readJsonl<HumanDoc>("./data/human.jsonl");
const ais = readJsonl<AiDoc>("./data/ai.jsonl");
const sourceOf = new Map(humans.map((h) => [h.id, h.source]));
const keys = FEATURES.map((f) => f.key);
const vec = (text: string) => { const f = computeFeatures(text); return keys.map((k) => f[k]); };
const chars = (s: string) => s.replace(/\s/g, "").length;

const samples: Sample[] = [
  ...humans.filter((h) => chars(h.text) >= MIN_CHARS).map((h): Sample => ({ x: vec(h.text), y: 0, group: h.source, tag: `human:${h.source}` })),
  ...ais.filter((a) => chars(a.text) >= MIN_CHARS && sourceOf.has(a.pairOf)).map((a): Sample => ({
    x: vec(a.text), y: 1, group: sourceOf.get(a.pairOf)!, tag: `${a.generator}:${a.model.split("/").pop()}`,
  })),
];

interface Model {
  mean: number[];
  std: number[];
  weights: number[];
  bias: number;
}

function fit(data: Sample[]): Model {
  const d = keys.length;
  const mean = keys.map((_, j) => data.reduce((s, r) => s + r.x[j], 0) / data.length);
  const std = keys.map((_, j) => Math.sqrt(data.reduce((s, r) => s + (r.x[j] - mean[j]) ** 2, 0) / data.length) || 1);
  const xs = data.map((r) => r.x.map((v, j) => (v - mean[j]) / std[j]));
  // 人間側と AI 側の件数が違っても偏らないよう、クラスごとに重みを付ける
  const pos = data.filter((r) => r.y === 1).length;
  const cw = (y: number) => data.length / (2 * (y ? pos : data.length - pos));
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < ITERATIONS; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    xs.forEach((x, i) => {
      const p = sigmoid(dot(w, x) + b);
      const e = (p - data[i].y) * cw(data[i].y);
      for (let j = 0; j < d; j++) gw[j] += e * x[j];
      gb += e;
    });
    for (let j = 0; j < d; j++) w[j] -= LEARNING_RATE * (gw[j] / data.length + L2 * w[j]);
    b -= LEARNING_RATE * (gb / data.length);
  }
  return { mean, std, weights: w, bias: b };
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const dot = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * b[i], 0);
const predict = (m: Model, x: number[]) => sigmoid(dot(m.weights, x.map((v, j) => (v - m.mean[j]) / m.std[j])) + m.bias);

function auc(scored: { p: number; y: number }[]): number {
  const pos = scored.filter((s) => s.y === 1);
  const neg = scored.filter((s) => s.y === 0);
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a.p > b.p ? 1 : a.p === b.p ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

// 比較用: 学習前のルール（定型表現・接続詞・箇条書き・見出しは多いほど、文の長さのばらつきは小さいほど AI 寄り）
const RULE = { jaPhrases: 1, connectives: 1, enWords: 1, emDash: 1, listRatio: 1, headings: 1, sentenceCv: -1 } as Record<string, number>;
function ruleScores(data: Sample[]): number[] {
  const idx = Object.keys(RULE).map((k) => keys.indexOf(k));
  const m = idx.map((j) => data.reduce((s, r) => s + r.x[j], 0) / data.length);
  const sd = idx.map((j, n) => Math.sqrt(data.reduce((s, r) => s + (r.x[j] - m[n]) ** 2, 0) / data.length) || 1);
  return data.map((r) => idx.reduce((s, j, n) => s + Object.values(RULE)[n] * (r.x[j] - m[n]) / sd[n], 0));
}

const groups = [...new Set(samples.map((s) => s.group))];
console.log(`samples: human ${samples.filter((s) => s.y === 0).length}, ai ${samples.filter((s) => s.y === 1).length}, sites ${groups.length}`);

const cvPreds: { p: number; y: number; tag: string; group: string }[] = [];
for (const g of groups) {
  const model = fit(samples.filter((s) => s.group !== g));
  for (const s of samples.filter((s) => s.group === g)) cvPreds.push({ p: predict(model, s.x), y: s.y, tag: s.tag, group: g });
}
const acc = cvPreds.filter((r) => (r.p >= 0.5 ? 1 : 0) === r.y).length / cvPreds.length;
const cvAuc = auc(cvPreds);
const rule = ruleScores(samples);
console.log(`\nサイト単位の交差検証: AUC ${cvAuc.toFixed(3)}, 正解率 ${(acc * 100).toFixed(1)}%`);
console.log(`学習前のルール:       AUC ${auc(samples.map((s, i) => ({ p: rule[i], y: s.y }))).toFixed(3)}`);

console.log("\n種類ごとの正解率（交差検証）");
const byTag = new Map<string, { ok: number; n: number }>();
for (const r of cvPreds) {
  const t = byTag.get(r.tag) ?? { ok: 0, n: 0 };
  t.n++;
  if ((r.p >= 0.5 ? 1 : 0) === r.y) t.ok++;
  byTag.set(r.tag, t);
}
for (const [tag, t] of [...byTag].sort()) console.log(`  ${tag.padEnd(48)} ${t.ok}/${t.n}`);

const final = fit(samples);
console.log("\n重み（標準化後。正は AI 寄り）");
keys.map((k, j) => [k, final.weights[j]] as const)
  .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
  .forEach(([k, w]) => console.log(`  ${k.padEnd(14)} ${w >= 0 ? "+" : ""}${w.toFixed(3)}`));

const round = (xs: number[]) => xs.map((v) => Number(v.toPrecision(6)));
writeFileSync(new URL("../web/model.json", import.meta.url), JSON.stringify({
  features: keys,
  mean: round(final.mean),
  std: round(final.std),
  weights: round(final.weights),
  bias: Number(final.bias.toPrecision(6)),
  eval: {
    method: "leave-one-site-out",
    auc: Number(cvAuc.toFixed(3)),
    accuracy: Number(acc.toFixed(3)),
    human: samples.filter((s) => s.y === 0).length,
    ai: samples.filter((s) => s.y === 1).length,
    sites: groups.length,
  },
}, null, 2) + "\n");
console.log("\nweb/model.json を書き出しました");
