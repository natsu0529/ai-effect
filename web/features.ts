// 学習済みモデルに渡す文体の特徴量。ブラウザで記事ごとに計算するので、正規表現と数え上げだけで作る。
// 学習側（training/train.ts）も同じ関数を使い、特徴量の定義がずれないようにする。

export interface Prepared {
  text: string;
  chars: number;
  lines: string[];
  paragraphs: string[];
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

const count = (text: string, re: RegExp) => (text.match(re) ?? []).length;
const countAll = (text: string, needles: string[]) => needles.reduce((n, s) => n + text.split(s).length - 1, 0);
const per1000 = (n: number, t: Prepared) => (n / Math.max(t.chars, 1)) * 1000;
const ratio = (n: number, d: number) => (d ? n / d : 0);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const cv = (xs: number[]) => {
  if (xs.length < 3) return 0;
  const m = mean(xs);
  return m ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m : 0;
};

export interface FeatureDef {
  key: string;
  label: string;
  compute: (t: Prepared) => number;
}

export const FEATURES: FeatureDef[] = [
  { key: "jaPhrases", label: "定型表現/千字", compute: (t) => per1000(countAll(t.text, JA_PHRASES), t) },
  {
    key: "connectives",
    label: "接続詞で始まる文の割合",
    compute: (t) => ratio(t.sentences.filter((s) => JA_CONNECTIVES.some((c) => s.startsWith(c + "、"))).length, t.sentences.length),
  },
  { key: "enWords", label: "AIに多い英単語/千字", compute: (t) => per1000(count(t.text, EN_PATTERN), t) },
  { key: "emDash", label: "emダッシュ/千字", compute: (t) => per1000(count(t.text, /—/g), t) },
  { key: "listRatio", label: "箇条書きの行の割合", compute: (t) => ratio(t.lines.filter((l) => l.startsWith("- ")).length, t.lines.length) },
  { key: "headings", label: "見出し/千字", compute: (t) => per1000(t.lines.filter((l) => l.startsWith("## ")).length, t) },
  { key: "sentenceCv", label: "文の長さの変動係数", compute: (t) => cv(t.sentences.map((s) => s.length)) },
  { key: "sentenceLen", label: "文の平均文字数", compute: (t) => mean(t.sentences.map((s) => s.length)) / 100 },
  { key: "paragraphLen", label: "段落の平均文字数", compute: (t) => mean(t.paragraphs.map((p) => p.length)) / 100 },
  { key: "paragraphCv", label: "段落の長さの変動係数", compute: (t) => cv(t.paragraphs.map((p) => p.length)) },
  {
    key: "desuMasu",
    label: "です・ます調の文の割合",
    compute: (t) => ratio(t.sentences.filter((s) => /(です|ます|でしょう|ません|ました|ください)[。！？!?]?$/.test(s)).length, t.sentences.length),
  },
  {
    key: "plainEnding",
    label: "だ・である調の文の割合",
    compute: (t) => ratio(t.sentences.filter((s) => /(だ|である|だった|ない|た|る)[。！？!?]?$/.test(s)).length, t.sentences.length),
  },
  { key: "firstPerson", label: "一人称/千字", compute: (t) => per1000(count(t.text, /私|僕|俺|筆者|自分|うち|\b(I|I'm|I've|my|me)\b/g), t) },
  { key: "quotes", label: "カギカッコ/千字", compute: (t) => per1000(count(t.text, /「/g), t) },
  { key: "parens", label: "丸カッコ/千字", compute: (t) => per1000(count(t.text, /[（(]/g), t) },
  { key: "exclaim", label: "！？/千字", compute: (t) => per1000(count(t.text, /[！？!?]/g), t) },
  { key: "colloquial", label: "くだけた表現/千字", compute: (t) => per1000(count(t.text, /笑|w{2,}|ｗ|…|〜|ー！|って|じゃん|けど|よね|かな/g), t) },
  { key: "colon", label: "コロン/千字", compute: (t) => per1000(count(t.text, /[：:]/g), t) },
  { key: "digits", label: "数字/千字", compute: (t) => per1000(count(t.text, /[0-9０-９]+/g), t) },
  { key: "katakana", label: "カタカナの割合", compute: (t) => ratio(count(t.text, /[ァ-ヶー]/g), t.chars) },
  { key: "jaRatio", label: "かな漢字の割合", compute: (t) => ratio(count(t.text, /[぀-ヿ一-鿿]/g), t.chars) },
];

export function prepare(text: string): Prepared {
  const lines = text.split("\n");
  const paragraphs = lines.filter((l) => !l.startsWith("## ") && !l.startsWith("- ") && l.length >= 20);
  const body = lines.filter((l) => !l.startsWith("## ")).map((l) => l.replace(/^- /, "")).join("\n");
  const sentences = body
    .split(/(?<=[。！？!?])|\n|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 5);
  return { text, chars: text.replace(/\s/g, "").length, lines, paragraphs, sentences };
}

export type FeatureValues = Record<string, number>;

export function computeFeatures(text: string): FeatureValues {
  const t = prepare(text);
  return Object.fromEntries(FEATURES.map((f) => [f.key, f.compute(t)]));
}
