// 文体の特徴量と、サイト自身の ChatGPT 公開前の記事を基準にした「AIっぽさ指数」を計算する。
// 指数 0 は基準期間の平均、1 は基準期間のばらつき（標準偏差）1 つ分だけ AI 寄りという意味。

export const CHATGPT_RELEASE = Date.UTC(2022, 10, 30);

interface FeatureDef {
  key: string;
  label: string;
  // +1 は値が大きいほど AI 寄り、-1 は小さいほど AI 寄り
  direction: 1 | -1;
  // 基準期間で値がほぼ 0 のときに標準偏差の代わりに使う下限
  minScale: number;
  compute: (t: Prepared) => number;
}

interface Prepared {
  text: string;
  chars: number;
  lines: string[];
  sentences: string[];
}

const JA_PHRASES = [
  "することができます", "することが可能です", "と言えるでしょう", "といえるでしょう", "ではないでしょうか",
  "重要です", "重要なのは", "重要な役割", "ポイントです", "について解説します", "を解説します",
  "をご紹介します", "を紹介します", "見ていきましょう", "詳しく解説", "まとめると", "さまざまな",
  "効果的に", "効果的な", "スムーズに", "可能性があります", "注意が必要です", "おすすめです",
  "活用することで", "役立ちます", "欠かせません", "大切です", "具体的には",
];

const JA_CONNECTIVES = [
  "さらに", "また", "まず", "次に", "最後に", "つまり", "このように", "一方で", "具体的には",
  "特に", "そのため", "加えて", "結論として", "要するに",
];

const EN_WORDS = [
  "delve", "tapestry", "furthermore", "moreover", "additionally", "crucial", "pivotal", "seamless",
  "seamlessly", "leverage", "landscape", "realm", "navigate", "navigating", "robust", "comprehensive",
  "foster", "underscore", "underscores", "showcase", "showcasing", "elevate", "embark", "ever-evolving",
  "in conclusion", "it's important to note", "it is important to note", "in today's",
];
const EN_PATTERN = new RegExp(`\\b(${EN_WORDS.map((w) => w.replace(/[-']/g, "\\$&")).join("|")})\\b`, "gi");

const per1000 = (count: number, t: Prepared) => (count / Math.max(t.chars, 1)) * 1000;

const countAll = (text: string, needles: string[]) =>
  needles.reduce((n, s) => n + text.split(s).length - 1, 0);

export const FEATURES: FeatureDef[] = [
  {
    key: "jaPhrases",
    label: "定型表現（日本語）/千字",
    direction: 1,
    minScale: 0.5,
    compute: (t) => per1000(countAll(t.text, JA_PHRASES), t),
  },
  {
    key: "connectives",
    label: "接続詞で始まる文の割合",
    direction: 1,
    minScale: 0.03,
    compute: (t) => {
      if (t.sentences.length === 0) return 0;
      const hits = t.sentences.filter((s) => JA_CONNECTIVES.some((c) => s.startsWith(c + "、") || s.startsWith(c + "，"))).length;
      return hits / t.sentences.length;
    },
  },
  {
    key: "enWords",
    label: "AIに多い英単語/千字",
    direction: 1,
    minScale: 0.3,
    compute: (t) => per1000((t.text.match(EN_PATTERN) ?? []).length, t),
  },
  {
    key: "emDash",
    label: "em ダッシュ（—）/千字",
    direction: 1,
    minScale: 0.3,
    compute: (t) => per1000((t.text.match(/—/g) ?? []).length, t),
  },
  {
    key: "listRatio",
    label: "箇条書きの行の割合",
    direction: 1,
    minScale: 0.05,
    compute: (t) => (t.lines.length ? t.lines.filter((l) => l.startsWith("- ")).length / t.lines.length : 0),
  },
  {
    key: "headings",
    label: "見出し/千字",
    direction: 1,
    minScale: 0.3,
    compute: (t) => per1000(t.lines.filter((l) => l.startsWith("## ")).length, t),
  },
  {
    // 人の文章は文の長さがばらつきやすく、AI の文章は揃いやすい
    key: "sentenceCv",
    label: "文の長さのばらつき（変動係数）",
    direction: -1,
    minScale: 0.08,
    compute: (t) => {
      const lens = t.sentences.map((s) => s.length);
      if (lens.length < 3) return 0;
      const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
      const sd = Math.sqrt(lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length);
      return mean ? sd / mean : 0;
    },
  },
];

function prepare(text: string): Prepared {
  const lines = text.split("\n");
  const body = lines.filter((l) => !l.startsWith("## ")).map((l) => l.replace(/^- /, "")).join("\n");
  const sentences = body
    .split(/(?<=[。！？!?])|\n|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5);
  return { text, chars: text.replace(/\s/g, "").length, lines, sentences };
}

export type FeatureValues = Record<string, number>;

export function computeFeatures(text: string): FeatureValues {
  const t = prepare(text);
  return Object.fromEntries(FEATURES.map((f) => [f.key, f.compute(t)]));
}

export interface Baseline {
  // 基準に使った記事の条件。ChatGPT 公開前の記事が足りないときは最初の期間で代用する
  kind: "pre-chatgpt" | "earliest";
  count: number;
  mean: FeatureValues;
  scale: FeatureValues;
}

const MIN_BASELINE = 3;

export function buildBaseline(items: { date: number; features: FeatureValues }[]): Baseline | null {
  if (items.length < MIN_BASELINE) return null;
  let kind: Baseline["kind"] = "pre-chatgpt";
  let base = items.filter((i) => i.date < CHATGPT_RELEASE);
  if (base.length < MIN_BASELINE) {
    kind = "earliest";
    base = [...items].sort((a, b) => a.date - b.date).slice(0, Math.max(MIN_BASELINE, Math.floor(items.length / 3)));
  }
  const mean: FeatureValues = {};
  const scale: FeatureValues = {};
  for (const f of FEATURES) {
    const vals = base.map((i) => i.features[f.key]);
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length);
    mean[f.key] = m;
    scale[f.key] = Math.max(sd, f.minScale);
  }
  return { kind, count: base.length, mean, scale };
}

export function aiIndex(features: FeatureValues, baseline: Baseline): number {
  const zs = FEATURES.map((f) => {
    const z = (f.direction * (features[f.key] - baseline.mean[f.key])) / baseline.scale[f.key];
    // 1 つの特徴量だけが極端に振れて指数を支配しないように抑える
    return Math.max(-3, Math.min(3, z));
  });
  return zs.reduce((a, b) => a + b, 0) / zs.length;
}
