-- CDX API の応答をそのまま保存する。キーは問い合わせ先の URL 接頭辞
CREATE TABLE cdx_cache (
  prefix TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

-- スナップショットから抜き出した本文。Wayback の過去ページは変わらないので期限は設けない
CREATE TABLE snapshot_text (
  timestamp TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (timestamp, url)
);
