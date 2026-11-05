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

公開先は https://ai-effect.uk6nys.workers.dev です。

```bash
npx wrangler login
npm run db:migrate:remote
npm run deploy
```

別の Cloudflare アカウントに置く場合は、先に `npx wrangler d1 create ai-effect` で D1 を作り、表示された `database_id` を `wrangler.jsonc` に書き込みます。

## 推定AI度の読み方

- 記事ごとに、文体の特徴量（`web/features.ts`）からロジスティック回帰（`web/model.json`）で AI らしさを確率として出します
- グラフの横線は、そのサイトの ChatGPT 公開前の記事の平均です。人間の文章でもこの程度は出るので、ここからの変化を見ます
- 日付は URL に含まれる日付、無ければ Wayback Machine に初めて保存された日です
- 個々の記事が AI で書かれたと断定するものではありません

## モデルの学習

人間側は、9 サイトの 2022年1月より前に保存されたスナップショットです。AI 側は、その記事と同じタイトル・媒体で LLM に書かせた記事です（Workers AI の Qwen3 30B-A3B・gpt-oss-20b・Mistral Small 3.1 と、Claude Haiku）。サイト単位の交差検証で AUC 0.962、正解率 90.9% でした。

集めた本文は他サイトの記事なので、リポジトリには入れていません（`training/data/` は `.gitignore` 済み）。作り直す手順は次のとおりです。

```bash
node training/collect-human.ts 12
npx wrangler dev -c training/wrangler.jsonc --port 8788
node training/generate-workersai.ts
node training/haiku-tasks.ts 4
node training/haiku-tasks.ts import
node training/train.ts
```

`haiku-tasks.ts 4` は依頼を 4 つの束に分けて `training/data/haiku-tasks/` に書き出します。Claude Code の Haiku サブエージェントに束ごとに記事を書かせ、`training/data/haiku-out/` に保存してから `import` で取り込みます。
