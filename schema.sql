-- ua-proxy D1 schema
-- 手动执行一次，以后不用再管
--
--   wrangler d1 execute ua-proxy-prod --remote --file=./schema.sql
--
-- 本地测试库（可选）：
--   wrangler d1 execute ua-proxy-prod --local --file=./schema.sql

-- ============================================================
-- 配置表
--   k='main' → {"prompt","mode","ua","upstream","suffix","suffixOn"}
--   k='auth' → {"adminHash","sessionSecret"}
--
-- 为什么一行存整个 JSON：D1 按行数计费，不按字节。
-- 15KB 提示词和 50 字节都是一行读。拆成五列就是五次读。
-- ============================================================
CREATE TABLE IF NOT EXISTS cfg (
  k  TEXT PRIMARY KEY NOT NULL,
  v  TEXT NOT NULL,
  ts INTEGER NOT NULL
);

-- ============================================================
-- 上游密钥池
--   secret 明文存。能读到这个库的人已经能改你的 Worker，
--   加密挡不住他，只会让你自己多记一个密码。
-- ============================================================
CREATE TABLE IF NOT EXISTS upstream_keys (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  label   TEXT    NOT NULL DEFAULT '',
  secret  TEXT    NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  ts      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_keys_enabled ON upstream_keys(enabled);

-- ============================================================
-- 访问日志（可选，默认不写）
--   开日志后每个请求多一次写。D1 免费版 10 万行写/天，
--   一天一万请求就吃掉 10%。只在排查问题时开。
-- ============================================================
CREATE TABLE IF NOT EXISTS hits (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  ts   INTEGER NOT NULL,
  ip   TEXT    NOT NULL DEFAULT '',
  path TEXT    NOT NULL DEFAULT '',
  code INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_hits_ts ON hits(ts);
