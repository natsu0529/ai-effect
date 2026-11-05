// HTMLRewriter で過去ページの HTML から本文らしいテキストを抜き出す。
// DOM を組み立てずにストリームで処理し、JS のハンドラが呼ばれる回数を減らして無料プランの CPU 10ms に収める。

export interface Extracted {
  title: string;
  text: string;
}

const MAX_TEXT_CHARS = 20000;
// article・main の中から取れた本文がこれより短ければ、ページ全体から取ったものを使う
const MIN_MAIN_CHARS = 200;
const MIN_MAIN_SHARE = 0.3;

// サイドバーやコメント欄などを、クラス名がその語で始まるか、その語そのものの要素で見分ける。
// 部分一致にすると The Verge の本文を囲む "l-sidebar-fixed" のようなレイアウト用のクラスまで落としてしまう
const SKIP_WORDS = ["sidebar", "comment", "comments", "related", "widget", "share", "breadcrumb", "breadcrumbs", "menu"];

const SKIP_SELECTOR = [
  "script", "style", "noscript", "template", "svg", "iframe", "form", "button", "select",
  "nav", "header", "footer", "aside",
  ...SKIP_WORDS.flatMap((w) => [`[class^="${w}"]`, `[class~="${w}"]`, `[id^="${w}"]`]),
].join(",");

const MAIN_SELECTOR = 'article, main, [role="main"]';

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr",
]);

// 改行を入れる要素。div は大きなページで数千個あり、そのたびに JS を呼ぶと CPU を使い切るので含めない
const BLOCK_SELECTOR = "p, br, tr, dd, dt, blockquote, pre";

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

  // article が見出しまわりしか囲んでいないサイト（The Verge など）もあるので、ページ全体と比べて少なすぎれば使わない
  const mainText = clean(main.join(""));
  const allText = clean(all.join(""));
  const text = mainText.length >= Math.max(MIN_MAIN_CHARS, allText.length * MIN_MAIN_SHARE) ? mainText : allText;
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

// 本文と関係の無いブロック。大きなニュースサイトは埋め込みの JSON や SVG が HTML の大半を占め、
// そのまま HTMLRewriter に渡すとテキストの断片ごとに JS が呼ばれて CPU 10ms を超える
const NON_CONTENT_BLOCKS = /<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi;

// HTMLRewriter に渡す前に HTML を整える。
// UTF-8 のページは文字列にして本文と関係の無いブロックを正規表現で先に落とす（正規表現はネイティブで速い）。
// 古い日本語サイトに多い Shift_JIS や EUC-JP はそのまま渡す。HTMLRewriter は Content-Type の charset で
// 文字コードを判断するので、ヘッダに無ければ meta タグから拾って付け直す
export async function prepareHtml(res: Response): Promise<Response> {
  const buf = await res.arrayBuffer();
  const header = (res.headers.get("content-type") ?? "").match(/charset=["']?([\w-]+)/i)?.[1];
  const head = String.fromCharCode(...new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096)));
  const charset = (header ?? head.match(/<meta[^>]+charset=["']?\s*([\w-]+)/i)?.[1] ?? "utf-8").toLowerCase();
  if (charset !== "utf-8" && charset !== "utf8") {
    return new Response(buf, { headers: { "content-type": `text/html; charset=${charset}` } });
  }
  const html = new TextDecoder().decode(buf).replace(NON_CONTENT_BLOCKS, "");
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
