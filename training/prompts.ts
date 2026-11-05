// AI 側の記事を書かせるときの依頼文と、出力を人間側の本文と同じ形にそろえる処理。
// Workers AI とサブエージェントの両方で同じものを使う。

import type { HumanDoc } from "./collect-human.ts";

// 実際に AI で記事を作る人の頼み方はさまざまなので、素っ気ない依頼から「人間らしく」まで混ぜる
const JA_TEMPLATES = [
  (t: string, g: string, n: number) => `${g}に載せる記事を書いてください。\nタイトル：「${t}」\n${n}文字程度で、本文だけを出力してください。`,
  (t: string, _g: string, n: number) => `「${t}」というタイトルでブログ記事を書いて。${n}文字くらい。本文だけでいいです。`,
  (t: string, g: string, n: number) => `${g}の記事として「${t}」を書いてください。AIが書いたと分からないよう、書き手の経験や意見がにじむ自然な文章にしてください。${n}文字程度、本文のみ。`,
];

const EN_TEMPLATES = [
  (t: string, g: string, n: number) => `Write an article for a ${g}.\nTitle: "${t}"\nAbout ${n} words. Output only the article body.`,
  (t: string, _g: string, n: number) => `Write a blog post titled "${t}". Around ${n} words, just the post.`,
  (t: string, g: string, n: number) => `Write "${t}" as a piece for a ${g}. Make it read naturally, like a human writer with opinions and experience, not like AI. About ${n} words, body only.`,
];

// 「タイトル | サイト名」「タイトル - サイト名」のサイト名部分を落とす
export function cleanTitle(title: string): string {
  return title.split(/\s+[|｜]\s+|\s+[-–—]\s+(?=[^-–—]{1,30}$)/)[0].trim();
}

export function buildPrompt(doc: HumanDoc, variant: number): string {
  const title = cleanTitle(doc.title);
  if (doc.lang === "en") {
    const words = Math.min(1200, Math.max(300, Math.round(doc.text.split(/\s+/).length / 100) * 100));
    return EN_TEMPLATES[variant % EN_TEMPLATES.length](title, doc.genre, words);
  }
  const chars = Math.min(4000, Math.max(800, Math.round(doc.text.replace(/\s/g, "").length / 100) * 100));
  return JA_TEMPLATES[variant % JA_TEMPLATES.length](title, doc.genre, chars);
}

// Markdown を、HTML から本文を抜き出したときと同じ形（見出しは「## 」、箇条書きは「- 」、1 段落 1 行）にする
export function normalizeOutput(md: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of md.replace(/<think>[\s\S]*?<\/think>/g, "").split("\n")) {
    if (/^\s*```/.test(raw)) { inFence = !inFence; continue; }
    let l = raw.trim();
    if (!inFence) {
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(l)) continue;
      l = l
        .replace(/^#{1,6}\s+/, "## ")
        .replace(/^([*+]|\d+[.)])\s+/, "- ")
        .replace(/^>\s?/, "")
        .replace(/\*\*(.+?)\*\*|__(.+?)__/g, "$1$2")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    }
    l = l.replace(/[\s　]+/g, " ").trim();
    if (l && l !== "-" && l !== "##") lines.push(l);
  }
  return lines.join("\n");
}
