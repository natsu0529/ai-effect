import { renderChart, fmtDate, escapeHtml, type ArticlePoint, type PeriodPoint } from "./chart";
import { aiIndex, buildBaseline, computeFeatures, FEATURES, type Baseline, type FeatureValues } from "./score";

interface Article {
  ts: string;
  url: string;
  date: number;
  period: string;
  title?: string;
  text?: string;
  features?: FeatureValues;
  status: "pending" | "ok" | "short" | "duplicate" | "failed";
}

// これより短い本文は一覧ページや削除済みページとみなして判定から外す
const MIN_TEXT_CHARS = 300;
// Wayback へ実際に取りに行った後だけ待つ。キャッシュから返ったときは待たない
const POLITE_DELAY_MS = 1200;
const CDX_LIMIT = 8000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>("form");
const statusEl = $("status");
const progressEl = $<HTMLProgressElement>("progress");
const resultEl = $("result");
const chartEl = $("chart");
const tooltipEl = $("tooltip");
const noteEl = $("note");
const periodTable = $("period-table");
const articleTable = $("article-table");

let runId = 0;
let lastRender: (() => void) | null = null;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const params = {
    url: String(data.get("url") ?? "").trim(),
    fromYear: Number(data.get("from")),
    perPeriod: Number(data.get("per")),
  };
  history.replaceState(null, "", `?${new URLSearchParams({ url: params.url, from: String(params.fromYear), per: String(params.perPeriod) })}`);
  void run(params, ++runId);
});

window.addEventListener("resize", () => lastRender?.());

// URL のクエリから前回の条件を復元し、そのまま実行する
const initial = new URLSearchParams(location.search);
if (initial.get("url")) {
  (form.elements.namedItem("url") as HTMLInputElement).value = initial.get("url")!;
  if (initial.get("from")) (form.elements.namedItem("from") as HTMLSelectElement).value = initial.get("from")!;
  if (initial.get("per")) (form.elements.namedItem("per") as HTMLSelectElement).value = initial.get("per")!;
  form.requestSubmit();
}

async function run(params: { url: string; fromYear: number; perPeriod: number }, id: number) {
  resultEl.hidden = true;
  setStatus("Wayback Machine から保存済みの URL 一覧を取得しています（大きなサイトだと 1 分ほどかかります）…");
  progressEl.hidden = true;

  let rows: string[][];
  try {
    rows = await getJson<string[][]>(`/api/cdx?url=${encodeURIComponent(params.url)}`, id);
  } catch (e) {
    if (id === runId) setStatus(`URL 一覧を取得できませんでした: ${(e as Error).message}`);
    return;
  }
  if (id !== runId) return;

  const range: [number, number] = [Date.UTC(params.fromYear, 0, 1), Date.now()];
  const articles = sample(rows.slice(1), range, params.perPeriod);
  if (articles.length === 0) {
    setStatus("期間内に記事らしいページが見つかりませんでした。/blog/ のように記事が並ぶ階層の URL を試してください。");
    return;
  }

  const notes: string[] = [];
  if (rows.length - 1 >= CDX_LIMIT) {
    notes.push(`保存済みの URL が多く、先頭の ${CDX_LIMIT} 件だけを対象にしました。/blog/ などに絞ると偏りが減ります。`);
  }
  notes.push("日付は URL に含まれる日付、無ければ Wayback Machine に初めて保存された日です。後者は実際の公開日より遅れることがあります。");

  progressEl.hidden = false;
  progressEl.max = articles.length;
  progressEl.value = 0;
  resultEl.hidden = false;

  const render = () => draw(articles, range, notes);
  lastRender = render;

  for (const [i, a] of articles.entries()) {
    if (id !== runId) return;
    setStatus(`本文を取得しています（${i + 1} / ${articles.length}）: ${a.url}`);
    try {
      const res = await getJson<{ title: string; text: string; cached: boolean }>(
        `/api/text?ts=${a.ts}&url=${encodeURIComponent(a.url)}`, id);
      a.title = res.title;
      a.text = res.text;
      if (res.text.replace(/\s/g, "").length < MIN_TEXT_CHARS) {
        a.status = "short";
      } else if (articles.some((b) => b !== a && b.status === "ok" && b.text === res.text)) {
        a.status = "duplicate";
      } else {
        a.features = computeFeatures(res.text);
        a.status = "ok";
      }
      if (!res.cached) await sleep(POLITE_DELAY_MS);
    } catch {
      a.status = "failed";
    }
    progressEl.value = i + 1;
    render();
  }
  if (id !== runId) return;
  const ok = articles.filter((a) => a.status === "ok").length;
  setStatus(`完了: ${articles.length} ページ中 ${ok} ページを判定しました。`);
  progressEl.hidden = true;
}

// URL 一覧を半年ごとに分け、各期間から記事らしいページを決まった数だけ選ぶ。
// 選び方は URL のハッシュで決まるので、同じ条件で再実行すればキャッシュがそのまま効く
function sample(rows: string[][], range: [number, number], perPeriod: number): Article[] {
  const byPeriod = new Map<string, Article[]>();
  const seen = new Set<string>();
  for (const [ts, url] of rows) {
    if (!ts || !url || !looksLikeArticle(url)) continue;
    // http と https、末尾の / や .html の有無だけが違う URL は同じ記事とみなす
    const key = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/(\/index)?(\.html?)?\/?$/i, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const captured = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8));
    const date = dateFromPath(url, captured) ?? captured;
    if (date < range[0] || date > range[1]) continue;
    const period = periodOf(date);
    const list = byPeriod.get(period) ?? [];
    list.push({ ts, url, date, period, status: "pending" });
    byPeriod.set(period, list);
  }
  const picked: Article[] = [];
  for (const list of byPeriod.values()) {
    list.sort((a, b) => hash(a.url) - hash(b.url));
    picked.push(...list.slice(0, perPeriod));
  }
  return picked.sort((a, b) => a.date - b.date);
}

function looksLikeArticle(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.search) return false;
  const path = u.pathname.replace(/\/(index\.(html?|php))?$/i, "");
  if (path === "") return false;
  if (/\.(jpe?g|png|gif|svg|css|js|xml|rss|atom|json|pdf|zip|txt|gz|br|md)$/i.test(path)) return false;
  if (/\.amp\.html?$/i.test(path)) return false;
  if (/\/(tag|tags|category|categories|author|page|archive|archives|feed|search|wp-json|wp-admin|wp-content|amp|login|cart)(\/|$)/i.test(path)) return false;
  return true;
}

// /2023/04/05/ や /entries/2023-04-05/ のようにパスに日付を含むブログは、初回保存日よりそちらが正確
function dateFromPath(url: string, captured: number): number | null {
  const m = new URL(url).pathname.match(/(?:^|\/)(20\d{2})[-/](0[1-9]|1[0-2])(?:[-/](0[1-9]|[12]\d|3[01]))?(?=[-/.]|$)/);
  if (!m) return null;
  const date = Date.UTC(+m[1], +m[2] - 1, m[3] ? +m[3] : 1);
  // 保存日より後の日付はパスの数字が日付ではないとみなす
  return date <= captured ? date : null;
}

function periodOf(date: number): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${d.getUTCMonth() < 6 ? "H1" : "H2"}`;
}

function periodBounds(period: string): { label: string; mid: number } {
  const [year, half] = period.split("-");
  const startMonth = half === "H1" ? 0 : 6;
  return { label: `${year}年${half === "H1" ? "前半" : "後半"}`, mid: Date.UTC(+year, startMonth + 3, 1) };
}

function draw(articles: Article[], range: [number, number], notes: string[]) {
  const scored = articles.filter((a): a is Article & { features: FeatureValues } => a.status === "ok" && !!a.features);
  const baseline = buildBaseline(scored);
  const lines = [...notes];
  if (!baseline) {
    noteEl.innerHTML = notes.map((n) => `<p>${escapeHtml(n)}</p>`).join("") + "<p>判定できた記事が 3 件を超えると指数を表示します。</p>";
    renderTables(articles, null, []);
    return;
  }
  if (baseline.kind === "earliest") {
    lines.unshift(`ChatGPT 公開前の記事が少ないため、古い順に ${baseline.count} 記事を基準にしました。指数は「最初の時期からの変化」を表します。`);
  } else {
    lines.unshift(`ChatGPT 公開前の ${baseline.count} 記事を基準（指数 0）にしました。指数 1 は基準のばらつき 1 つ分だけ AI 寄りという意味です。`);
  }
  noteEl.innerHTML = lines.map((n) => `<p>${escapeHtml(n)}</p>`).join("");

  const points: ArticlePoint[] = scored.map((a) => ({
    date: a.date,
    index: aiIndex(a.features, baseline),
    title: a.title ?? "",
    waybackUrl: waybackUrl(a),
  }));
  const periods = new Map<string, number[]>();
  scored.forEach((a, i) => periods.set(a.period, [...(periods.get(a.period) ?? []), points[i].index]));
  const periodPoints: PeriodPoint[] = [...periods.entries()]
    .map(([p, vals]) => ({ ...periodBounds(p), mean: vals.reduce((x, y) => x + y, 0) / vals.length, count: vals.length }))
    .sort((a, b) => a.mid - b.mid);

  renderChart(chartEl, tooltipEl, periodPoints, points, range);
  renderTables(articles, baseline, periodPoints);
}

function renderTables(articles: Article[], baseline: Baseline | null, periods: PeriodPoint[]) {
  periodTable.innerHTML = `<thead><tr><th>期間</th><th>平均指数</th><th>記事数</th></tr></thead><tbody>${
    periods.map((p) => `<tr><td>${p.label}</td><td class="num">${p.mean.toFixed(2)}</td><td class="num">${p.count}</td></tr>`).join("")
  }</tbody>`;

  const head = FEATURES.map((f) => `<th title="${escapeHtml(f.label)}">${escapeHtml(f.label)}</th>`).join("");
  articleTable.innerHTML = `<thead><tr><th>保存日</th><th>ページ</th><th>指数</th>${head}</tr></thead><tbody>${
    articles.map((a) => {
      const idx = baseline && a.features ? aiIndex(a.features, baseline).toFixed(2) : statusLabel(a.status);
      const cells = FEATURES.map((f) => `<td class="num">${a.features ? a.features[f.key].toFixed(2) : ""}</td>`).join("");
      const name = escapeHtml(a.title || a.url);
      return `<tr><td>${fmtDate(a.date)}</td><td class="page"><a href="${escapeHtml(waybackUrl(a))}" target="_blank" rel="noopener">${name}</a></td><td class="num">${idx}</td>${cells}</tr>`;
    }).join("")
  }</tbody>`;
}

function statusLabel(s: Article["status"]): string {
  return { pending: "取得待ち", ok: "", short: "本文が短い", duplicate: "重複", failed: "取得失敗" }[s];
}

function waybackUrl(a: Article): string {
  return `https://web.archive.org/web/${a.ts}/${a.url}`;
}

// Wayback が混雑しているとき（429・503）は間隔を広げながら再試行する
async function getJson<T>(path: string, id: number): Promise<T> {
  const waits = [5000, 15000, 30000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(path);
    if (res.ok) return res.json() as Promise<T>;
    const body = await res.json().catch(() => ({})) as { error?: string; retryable?: boolean };
    if (!body.retryable || attempt >= waits.length || id !== runId) throw new Error(body.error ?? `HTTP ${res.status}`);
    setStatus(`Wayback Machine が混雑しています。${waits[attempt] / 1000} 秒待って再試行します…`);
    await sleep(waits[attempt]);
  }
}

function setStatus(s: string) {
  statusEl.textContent = s;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
