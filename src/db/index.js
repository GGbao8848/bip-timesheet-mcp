'use strict';

/**
 * SQLite 初始化（better-sqlite3，WAL）：API Key / Web 会话 / BIP 凭据 / 连接码 / 设备流请求。
 * 全部 CREATE IF NOT EXISTS 幂等建表；BIP 凭据只存 AES-256-GCM 密文，不落明文。
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- API Key（只存 sha256 哈希，明文不落库）
CREATE TABLE IF NOT EXISTS api_keys (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
-- 硬约束：同一用户未吊销的密钥名称必须唯一（重名创建直接报错；吊销后可复用）
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_name ON api_keys(user_id, name) WHERE revoked_at IS NULL;

-- Web 登录会话（Keycloak 登录成功后建立，HttpOnly cookie 引用 sid）
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  username   TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- BIP 凭据（Keycloak 用户维度绑定，密码 AES-256-GCM 加密后落库）
CREATE TABLE IF NOT EXISTS bip_credentials (
  user_id      TEXT PRIMARY KEY,
  username     TEXT NOT NULL,
  password_enc TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- 连接码（半自动连接：浏览器授权 → 生成短码 + 明文 token 暂存 → 插件兑换写配置）
CREATE TABLE IF NOT EXISTS connect_codes (
  code          TEXT PRIMARY KEY,          -- 短码 XXXX-XXXX
  user_id       TEXT NOT NULL,
  api_key_id    TEXT NOT NULL,
  token_plain   TEXT NOT NULL,             -- 明文 bip-xxx，仅 TTL 窗口内存在
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_connect_codes_user ON connect_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_connect_codes_expiry ON connect_codes(expires_at);

-- 设备流连接请求（零粘贴：agent 发起 → 授权页确认 → 轮询拿 key）
CREATE TABLE IF NOT EXISTS connect_requests (
  request_id    TEXT PRIMARY KEY,          -- 32 位随机（agent 轮询凭据）
  user_id       TEXT,                      -- 确认授权的登录用户（pending 时为空）
  key_name      TEXT,                      -- 授权时命名（可选）
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | authorized | expired
  api_key_id    TEXT,
  token_plain   TEXT,                      -- 明文 bip-xxx，确认后生成
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  confirmed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_connect_requests_user ON connect_requests(user_id);
CREATE INDEX IF NOT EXISTS idx_connect_requests_expiry ON connect_requests(expires_at);
`);

module.exports = db;
