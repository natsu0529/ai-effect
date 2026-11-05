// HTMLRewriter で過去ページの HTML から本文らしいテキストを抜き出す。
// DOM を組み立てずにストリームで処理するので、無料プランの CPU 10ms に収まりやすい。

export interface Extracted {
  title: string;
  text: string;
}

const MAX_TEXT_CHARS = 20000;
// article・main の中から取れた本文がこれより短ければ、ページ全体から取ったものを使う
const MIN_MAIN_CHARS = 200;

const SKIP_SELECTOR = [
  "script", "style", "noscript", "template", "svg", "iframe", "form", "button", "select",
  "nav", "header", "footer", "aside",
  '[class*="sidebar"]', '[id*="sidebar"]',
  '[class*="comment"]', '[id*="comment"]',
  '[class*="related"]', '[class*="widget"]', '[class*="share"]',
  '[class*="breadcrumb"]', '[class*="menu"]', '[id*="menu"]',
].join(",");

const MAIN_SELECTOR = 'article, main, [role="main"]';

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

const BLOCK_SELECTOR ="p, div, section, br, tr, dd, dt, blockquote, pre, table";

export async function extractText(res: Response): Promise<Extracted> {
  let skipDepth = 0;
  let mainDepth = 0;
  let title = "";
  let inTitle = false;
  const all: string[] = [];
  const main: string[] = [];

  const push = (s: string) => {
    if (skipDepth > 0) return;
    all.push(s);
    if (mainDepth > 0) main.push(s);
  };

  // onEndTag を登録できるのは閉じタグを持つ要素だけ。img などの空要素では例外になる
  const track = (el: Element, onEnd: () => void): boolean => {
    if (VOID_ELEMENTS.has(el.tagName)) return false;
    try {
      el.onEndTag(onEnd);
      return true;
    } catch {
      return false;
    }
  };

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el) {
        inTitle = true;
        track(el, () => { inTitle = false; });
      },
      text(t) {
        if (inTitle) title += t.text;
      },
    })
    .on(SKIP_SELECTOR, {
      element(el) {
        if (track(el, () => { skipDepth--; })) skipDepth++;
      },
    })
    .on(MAIN_SELECTOR, {
      element(el) {
        if (track(el, () => { mainDepth--; })) mainDepth++;
      },
    })
    .on(BLOCK_SELECTOR, { element() { push("\n"); } })
    .on("li", { element() { push("\n- "); } })
    .on("h1, h2, h3, h4, h5, h6", { element() { push("\n## "); } })
    .onDocument({
      text(t) {
        if (!inTitle) push(t.text);
      },
    });

  // 変換結果は使わず、ハンドラを動かすためだけに最後まで読む
  await rewriter.transform(res).arrayBuffer();

  const mainText = clean(main.join(""));
  const text = mainText.length >= MIN_MAIN_CHARS ? mainText : clean(all.join(""));
  return { title: decodeEntities(title).replace(/\s+/g, " ").trim(), text };
}

function clean(raw: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const line of decodeEntities(raw).split("\n")) {
    const l = line.replace(/[\s　]+/g, " ").trim();
    // 見出しや箇条書きの記号だけが残った行と、メニューなどで繰り返される行を落とす
    if (l === "" || l === "-" || l === "##" || seen.has(l)) continue;
    seen.add(l);
    lines.push(l);
  }
  return lines.join("\n").slice(0, MAX_TEXT_CHARS);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", copy: "©",
};

// HTMLRewriter はテキスト中の文字参照を展開しないので、よく出るものだけ自前で戻す
function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

// 古い日本語サイトは Shift_JIS や EUC-JP が多い。HTMLRewriter は Content-Type の charset で
// 文字コードを判断するので、ヘッダに無ければ meta タグから拾って付け直す
export async function withCharset(res: Response): Promise<Response> {
  const type = res.headers.get("content-type") ?? "text/html";
  if (/charset=/i.test(type)) return res;
  const buf = await res.arrayBuffer();
  const head = String.fromCharCode(...new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096)));
  const m = head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i);
  const charset = m ? m[1] : "utf-8";
  return new Response(buf, { headers: { "content-type": `text/html; charset=${charset}` } });
}
