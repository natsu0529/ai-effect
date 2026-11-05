import { extractText, prepareHtml } from "./extract";

interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
}

const WAYBACK = "https://web.archive.org";
const USER_AGENT = "ai-effect/0.1 (personal research tool; slow polite crawling)";
// 接頭辞ごとの URL 一覧。新しい記事が増えるので 1 週間で取り直す
const CDX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// D1 の 1 行は 2MB まで。timestamp と URL だけなら 8000 件で 1MB 前後に収まる
const CDX_LIMIT = 8000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/api/cdx") return await handleCdx(url, env);
      if (url.pathname === "/api/text") return await handleText(url, env);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<Env>;

async function handleCdx(url: URL, env: Env): Promise<Response> {
  const prefix = normalizePrefix(url.searchParams.get("url") ?? "");
  if (!prefix) return json({ error: "url が不正です" }, 400);

  const hit = await env.DB.prepare("SELECT body, fetched_at FROM cdx_cache WHERE prefix = ?")
    .bind(prefix)
    .first<{ body: string; fetched_at: number }>();
  if (hit && Date.now() - hit.fetched_at < CDX_TTL_MS) {
    return rawJson(hit.body, { "x-cache": "hit" });
  }

  // collapse=urlkey で URL ごとに最初の 1 件だけ残す。最初に保存された時期を公開時期の目安にする
  const q = new URLSearchParams({
    url: prefix,
    matchType: "prefix",
    output: "json",
    fl: "timestamp,original",
    collapse: "urlkey",
    limit: String(CDX_LIMIT),
  });
  q.append("filter", "statuscode:200");
  q.append("filter", "mimetype:text/html");
  const res = await fetch(`${WAYBACK}/cdx/search/cdx?${q}`, { headers: { "user-agent": USER_AGENT } });
  if (!res.ok) return upstreamError(res);

  const body = (await res.text()).trim() || "[]";
  if (!body.startsWith("[")) return json({ error: "CDX API が想定外の応答を返しました" }, 502);
  await env.DB.prepare(
    "INSERT OR REPLACE INTO cdx_cache (prefix, body, fetched_at) VALUES (?, ?, ?)",
  ).bind(prefix, body, Date.now()).run();
  return rawJson(body, { "x-cache": "miss" });
}

async function handleText(url: URL, env: Env): Promise<Response> {
  const ts = url.searchParams.get("ts") ?? "";
  const target = url.searchParams.get("url") ?? "";
  if (!/^\d{14}$/.test(ts) || !/^https?:\/\//i.test(target)) {
    return json({ error: "ts と url を指定してください" }, 400);
  }

  const hit = await env.DB.prepare("SELECT title, text FROM snapshot_text WHERE timestamp = ? AND url = ?")
    .bind(ts, target)
    .first<{ title: string; text: string }>();
  if (hit) return json({ ...hit, cached: true });

  // id_ を付けると Wayback のツールバーやリンク書き換えの無い元の HTML が返る
  const res = await fetch(`${WAYBACK}/web/${ts}id_/${target}`, { headers: { "user-agent": USER_AGENT } });
  if (res.status === 429 || res.status >= 500) return upstreamError(res);

  let extracted = { title: "", text: "" };
  const type = res.headers.get("content-type") ?? "";
  const size = Number(res.headers.get("content-length") ?? 0);
  if (res.ok && type.includes("html") && size <= MAX_HTML_BYTES) {
    extracted = await extractText(await prepareHtml(res));
  }
  // 取れなかったページも空で保存し、同じページを Wayback へ何度も取りに行かないようにする
  await env.DB.prepare(
    "INSERT OR REPLACE INTO snapshot_text (timestamp, url, title, text, fetched_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(ts, target, extracted.title, extracted.text, Date.now()).run();
  return json({ ...extracted, cached: false });
}

// "https://Example.com/blog/" → "example.com/blog/"。CDX の url パラメータはスキームを含めない
function normalizePrefix(input: string): string | null {
  try {
    const u = new URL(/^https?:\/\//i.test(input) ? input : `https://${input.trim()}`);
    if (!u.hostname.includes(".")) return null;
    return u.hostname.toLowerCase().replace(/^www\./, "") + u.pathname;
  } catch {
    return null;
  }
}

// Wayback の混雑（429・503）はブラウザ側で待って再試行させる
function upstreamError(res: Response): Response {
  const status = res.status === 429 ? 429 : 503;
  return json({ error: `Wayback Machine が ${res.status} を返しました`, retryable: true }, status);
}

function json(data: unknown, status = 200): Response {
  return rawJson(JSON.stringify(data), {}, status);
}

function rawJson(body: string, headers: Record<string, string>, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
