// 人間側の教師データを集める。2022年1月より前に保存されたスナップショットだけを使うので、
// 中身は ChatGPT 公開前に書かれたものと確定できる。取得は公開中の Worker 経由で行い、キャッシュを共有する。
//
// node training/collect-human.ts [件数/サイト]

import { appendFileSync, existsSync, readFileSync } from "node:fs";

const API = process.env.API ?? "https://ai-effect.uk6nys.workers.dev";
const OUT = new URL("./data/human.jsonl", import.meta.url);
const CUTOFF = "20220101000000";
const MIN_CHARS = 600;
const PER_SOURCE = Number(process.argv[2] ?? 12);

// genre は AI 側の記事を書かせるときに「どんな媒体の記事か」として渡す
export const SOURCES = [
  { prefix: "blog.jxck.io/entries/", genre: "Web技術の個人ブログ", lang: "ja" },
  { prefix: "techblog.zozo.com/entry/", genre: "企業の技術ブログ", lang: "ja" },
  { prefix: "engineering.mercari.com/blog/entry/", genre: "企業の技術ブログ", lang: "ja" },
  { prefix: "gigazine.net/news/2019", genre: "ITニュースサイト", lang: "ja" },
  { prefix: "nlab.itmedia.co.jp/nl/articles/2010/", genre: "エンタメ・ネット話題のニュースサイト", lang: "ja" },
  { prefix: "www.itmedia.co.jp/business/articles/2006/", genre: "ビジネスニュースサイト", lang: "ja" },
  { prefix: "dailyportalz.jp/kiji/", genre: "体験レポート・読み物サイト", lang: "ja" },
  { prefix: "p-shirokuma.hatenadiary.com/entry/2020", genre: "社会や暮らしについての個人エッセイブログ", lang: "ja" },
  { prefix: "www.lifehacker.jp/2020/", genre: "仕事術・ライフハックのWebメディア", lang: "ja" },
  { prefix: "www.theverge.com/2021/", genre: "technology news site", lang: "en" },
  { prefix: "blog.codinghorror.com/", genre: "personal programming blog", lang: "en" },
];

export interface HumanDoc {
  id: string;
  source: string;
  genre: string;
  lang: string;
  url: string;
  ts: string;
  title: string;
  text: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson<T>(path: string): Promise<T> {
  for (const wait of [0, 5000, 15000, 30000, 60000]) {
    await sleep(wait);
    const res = await fetch(API + path);
    if (res.ok) return res.json() as Promise<T>;
    if (res.status !== 429 && res.status !== 503) throw new Error(`HTTP ${res.status} ${await res.text()}`);
  }
  throw new Error(`gave up: ${path}`);
}

function looksLikeArticle(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.search) return false;
  const path = u.pathname.replace(/\/(index\.(html?|php))?$/i, "");
  if (path.split("/").filter(Boolean).length < 2 && !/\d{4}/.test(path)) return false;
  if (/\.(jpe?g|png|gif|svg|css|js|xml|rss|atom|json|pdf|zip|txt|gz|br|md)$/i.test(path)) return false;
  if (/\.amp\.html?$/i.test(path) || /\/amp\/?$/i.test(path)) return false;
  return !/\/(tag|tags|category|categories|author|page|archive|archives|feed|search)(\/|$)/i.test(path);
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const done = new Set<string>(
  existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).url) : [],
);

for (const src of SOURCES) {
  let have = 0;
  for (const url of done) if (url.replace(/^https?:\/\/(www\.)?/, "").startsWith(src.prefix.replace(/^www\./, ""))) have++;
  if (have >= PER_SOURCE) { console.log(`skip ${src.prefix} (${have})`); continue; }

  let rows: string[][];
  try {
    rows = (await getJson<string[][]>(`/api/cdx?url=${encodeURIComponent(src.prefix)}`)).slice(1);
  } catch (e) {
    console.log(`cdx failed ${src.prefix}: ${(e as Error).message}`);
    continue;
  }
  const seen = new Set<string>();
  const candidates = rows
    .filter(([ts, url]) => ts < CUTOFF && looksLikeArticle(url))
    .filter(([, url]) => {
      const key = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/(\/index)?(\.html?)?\/?$/i, "").toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => hash(a[1]) - hash(b[1]));
  console.log(`${src.prefix}: ${rows.length} rows, ${candidates.length} candidates`);

  for (const [ts, url] of candidates) {
    if (have >= PER_SOURCE) break;
    if (done.has(url)) continue;
    try {
      const r = await getJson<{ title: string; text: string; cached: boolean }>(
        `/api/text?ts=${ts}&url=${encodeURIComponent(url)}`);
      if (!r.cached) await sleep(1200);
      if (r.text.replace(/\s/g, "").length < MIN_CHARS) continue;
      const doc: HumanDoc = {
        id: `h${hash(url).toString(36)}`, source: src.prefix, genre: src.genre, lang: src.lang,
        url, ts, title: r.title, text: r.text,
      };
      appendFileSync(OUT, JSON.stringify(doc) + "\n");
      done.add(url);
      have++;
      console.log(`  + ${r.title.slice(0, 50)}`);
    } catch (e) {
      console.log(`  ! ${url}: ${(e as Error).message}`);
    }
  }
}
