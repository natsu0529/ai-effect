# ai-effect

サイトの文章が、いつからどれだけ AI っぽくなったかを、Wayback Machine の過去ページで時系列に可視化するツールです。Cloudflare Workers の無料プランで動きます。

## 仕組み

1. ブラウザで URL（例: `example.com/blog/`）を入力する
2. Worker が Wayback Machine の CDX API から、その接頭辞の下にある URL と初回保存日の一覧を取る（D1 に 1 週間キャッシュ）
3. ブラウザが半年ごとに記事を数件ずつ選び、1 件ずつ Worker に本文を頼む
4. Worker が `web.archive.org/web/{timestamp}id_/{url}` から元の HTML を取り、HTMLRewriter で本文を抜き出す（D1 に恒久キャッシュ）
5. ブラウザが文体の特徴量を計算し、ChatGPT 公開前（2022年11月以前）の記事の平均を 0 とした「AIっぽさ指数」を折れ線グラフにする

重い計算をブラウザ側に置き、Worker は中継とキャッシュだけにしているので、無料プランの CPU 10ms とサブリクエスト 50 回の制限に収まります。

## 開発

Node.js 22 以上が必要です（`.nvmrc` は 24）。

```bash
npm install
npm run db:migrate:local
npm run dev
```

## デプロイ

```bash
npx wrangler login
npx wrangler d1 create ai-effect
```

表示された `database_id` を `wrangler.jsonc` に書き込み、続けて次を実行します。

```bash
npm run db:migrate:remote
npm run deploy
```

## 指数の読み方

- 指数 0 はそのサイト自身の ChatGPT 公開前の記事の平均、1 は基準のばらつき（標準偏差）1 つ分だけ AI 寄りという意味です
- 特徴量の定義は `web/score.ts` にあります
- 日付は Wayback Machine に初めて保存された日で、実際の公開日より遅れることがあります
- 個々の記事が AI で書かれたかどうかを判定するものではありません
