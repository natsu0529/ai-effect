// 期間ごとの平均を折れ線、記事ごとの値を点で描く SVG の時系列グラフ

export const CHATGPT_RELEASE = Date.UTC(2022, 10, 30);

export interface PeriodPoint {
  label: string;
  mid: number;
  mean: number;
  count: number;
}

export interface ArticlePoint {
  date: number;
  percent: number;
  title: string;
  waybackUrl: string;
}

const SVG_NS = "http://www.w3.org/2000/svg";
const HEIGHT = 340;
const PAD = { top: 28, right: 20, bottom: 36, left: 44 };

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  parent?.appendChild(node);
  return node;
}

export function renderChart(
  host: HTMLElement,
  tooltip: HTMLElement,
  periods: PeriodPoint[],
  articles: ArticlePoint[],
  range: [number, number],
  // ChatGPT 公開前の記事の平均。人間の文章をどれだけ AI と誤判定しがちかの目安として横線を引く
  reference: number | null,
) {
  host.replaceChildren();
  const width = Math.max(host.clientWidth, 320);
  const svg = el("svg", { viewBox: `0 0 ${width} ${HEIGHT}`, width, height: HEIGHT, role: "img" }, host);
  svg.setAttribute("aria-label", "推定AI度の推移");

  const x = (t: number) => PAD.left + ((t - range[0]) / (range[1] - range[0])) * (width - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + ((100 - v) / 100) * (HEIGHT - PAD.top - PAD.bottom);

  // 目盛りと横の補助線
  for (let v = 0; v <= 100; v += 20) {
    el("line", { x1: PAD.left, x2: width - PAD.right, y1: y(v), y2: y(v), class: "grid" }, svg);
    const t = el("text", { x: PAD.left - 8, y: y(v) + 4, "text-anchor": "end", class: "tick" }, svg);
    t.textContent = `${v}%`;
  }
  if (reference !== null) {
    el("line", { x1: PAD.left, x2: width - PAD.right, y1: y(reference), y2: y(reference), class: "axis-zero" }, svg);
  }

  const startYear = new Date(range[0]).getUTCFullYear();
  const endYear = new Date(range[1]).getUTCFullYear();
  for (let yr = startYear; yr <= endYear; yr++) {
    const t = Date.UTC(yr, 0, 1);
    if (t < range[0] || t > range[1]) continue;
    const label = el("text", { x: x(t), y: HEIGHT - PAD.bottom + 20, "text-anchor": "middle", class: "tick" }, svg);
    label.textContent = String(yr);
    el("line", { x1: x(t), x2: x(t), y1: HEIGHT - PAD.bottom, y2: HEIGHT - PAD.bottom + 5, class: "grid" }, svg);
  }

  // ChatGPT 公開日の縦線
  if (CHATGPT_RELEASE > range[0] && CHATGPT_RELEASE < range[1]) {
    const cx = x(CHATGPT_RELEASE);
    el("line", { x1: cx, x2: cx, y1: PAD.top - 8, y2: HEIGHT - PAD.bottom, class: "release" }, svg);
    // 2021 年ごろに始まったサイトでは縦線が右寄りになるので、ラベルを線の左に置いてはみ出さないようにする
    const leftSide = cx > width * 0.6;
    const t = el("text", { x: leftSide ? cx - 6 : cx + 6, y: PAD.top - 12, "text-anchor": leftSide ? "end" : "start", class: "release-label" }, svg);
    t.textContent = "ChatGPT 公開（2022年11月）";
  }

  const show = (html: string, cx: number, cy: number) => {
    tooltip.innerHTML = html;
    tooltip.hidden = false;
    const box = host.getBoundingClientRect();
    const left = Math.min(Math.max(cx - tooltip.offsetWidth / 2, 0), box.width - tooltip.offsetWidth);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${cy - tooltip.offsetHeight - 12}px`;
  };
  const hide = () => { tooltip.hidden = true; };

  // 記事ごとの点
  for (const a of articles) {
    const g = el("g", { class: "article" }, svg);
    el("circle", { cx: x(a.date), cy: y(a.percent), r: 4, class: "article-dot" }, g);
    const hit = el("circle", { cx: x(a.date), cy: y(a.percent), r: 9, class: "hit" }, g);
    hit.addEventListener("pointerenter", () =>
      show(`<strong>${escapeHtml(a.title || "(無題)")}</strong><br>${fmtDate(a.date)}・推定AI度 ${a.percent.toFixed(0)}%`, x(a.date), y(a.percent)));
    hit.addEventListener("pointerleave", hide);
    hit.addEventListener("click", () => window.open(a.waybackUrl, "_blank", "noopener"));
  }

  // 期間ごとの平均の折れ線
  const pts = periods.filter((p) => p.count > 0);
  if (pts.length > 1) {
    el("path", { d: pts.map((p, i) => `${i ? "L" : "M"}${x(p.mid)},${y(p.mean)}`).join(""), class: "mean-line" }, svg);
  }
  for (const p of pts) {
    el("circle", { cx: x(p.mid), cy: y(p.mean), r: 5, class: "mean-dot" }, svg);
    const hit = el("circle", { cx: x(p.mid), cy: y(p.mean), r: 12, class: "hit" }, svg);
    hit.addEventListener("pointerenter", () =>
      show(`<strong>${p.label}</strong><br>平均 ${p.mean.toFixed(0)}%（${p.count} 記事）`, x(p.mid), y(p.mean)));
    hit.addEventListener("pointerleave", hide);
  }
}

export function fmtDate(t: number): string {
  const d = new Date(t);
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
