'use strict';

/**
 * 数据访问层（better-sqlite3 同步 API）。
 * 与 aimemory 同构：API Key / Web 会话 / 连接码 / 设备流 + 新增 BIP 凭据。
 * 所有查询强制 user_id 隔离。
 */
const crypto = require('crypto');
const db = require('./index');

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

// ============ API Key ============

function createApiKey({ userId, name = 'default', tokenHash }) {
  const row = {
    id: uuid(),
    user_id: userId,
    name,
    token_hash: tokenHash,
    created_at: now(),
    revoked_at: null,
  };
  db.prepare(
    'INSERT INTO api_keys (id, user_id, name, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(row.id, row.user_id, row.name, row.token_hash, row.created_at, row.revoked_at);
  return row;
}

function listApiKeys(userId) {
  return db
    .prepare(
      'SELECT id, user_id, name, created_at, revoked_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC'
    )
    .all(userId);
}

function findUserIdByTokenHash(tokenHash) {
  const row = db
    .prepare('SELECT user_id FROM api_keys WHERE token_hash = ? AND revoked_at IS NULL')
    .get(tokenHash);
  return row ? row.user_id : null;
}

function revokeApiKey(id, userId) {
  const res = db
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL')
    .run(now(), id, userId);
  return res.changes > 0;
}

// ============ Web 会话 ============

function createSession(id, userId, ttlMs, username = null) {
  const ts = now();
  db.prepare(
    'INSERT INTO sessions (id, user_id, username, created_at, expires_at) VALUES (?, ?, ?, ?, ?)'
  ).run(id, userId, username, ts, new Date(Date.now() + ttlMs).toISOString());
}

function getSession(id) {
  return db.prepare('SELECT * FROM sessions WHERE id = ? AND expires_at > ?').get(id, now());
}

function deleteSession(id) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

function cleanupSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
}

// ============ BIP 凭据（AES-256-GCM 密文，由 auth/bipcred 加解密） ============

function setBipCredentials(userId, username, passwordEnc) {
  db.prepare(
    `INSERT INTO bip_credentials (user_id, username, password_enc, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username = excluded.username, password_enc = excluded.password_enc, updated_at = excluded.updated_at`
  ).run(userId, username, passwordEnc, now());
}

function getBipCredentials(userId) {
  return db
    .prepare('SELECT username, password_enc FROM bip_credentials WHERE user_id = ?')
    .get(userId);
}

// ============ 连接码（半自动连接）============

const CODE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 生成 XXXX-XXXX 格式短码（去掉易混淆字符 I/O/0/1） */
function generateConnectCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const seg = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${seg()}-${seg()}`;
}

/** 连接码模式：创建连接请求（生成密钥+短码） */
function createLegacyConnectRequest(userId) {
  const active = db
    .prepare('SELECT * FROM connect_codes WHERE user_id = ? AND consumed_at IS NULL AND expires_at > ?')
    .get(userId, now());
  if (active) {
    return { code: active.code, api_key: active.token_plain, user_id: userId };
  }
  const ts = now();
  // 生成一次 token：明文入码表（TTL 窗口），哈希入 api_keys（持久）
  const { token, id: keyId } = require('../auth/tokens').createApiKey(userId, 'connect');
  const code = generateConnectCode();
  db.prepare(
    `INSERT INTO connect_codes (code, user_id, api_key_id, token_plain, created_at, expires_at, consumed_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`
  ).run(code, userId, keyId, token, ts, new Date(Date.now() + CODE_TTL_MS).toISOString());
  return { code, api_key: token, user_id: userId };
}

/** 兑换连接码：一次性 + TTL 校验；成功返回 { user_id, api_key, mcp_url }，失败返回 null */
function consumeConnectCode(code) {
  const row = db.prepare('SELECT * FROM connect_codes WHERE code = ?').get(code);
  if (!row) return null;
  if (row.consumed_at) return null;
  if (row.expires_at <= now()) return null;
  db.prepare('UPDATE connect_codes SET consumed_at = ? WHERE code = ?').run(now(), code);
  return { user_id: row.user_id, api_key: row.token_plain, api_key_id: row.api_key_id };
}

/** 清理过期 / 已消费的码（明文随之删除，不留痕） */
function cleanupConnectCodes() {
  db.prepare('DELETE FROM connect_codes WHERE consumed_at IS NOT NULL OR expires_at <= ?').run(now());
}

// ============ 设备流连接（零粘贴）============

const REQ_TTL_MS = 10 * 60 * 1000; // 10 分钟

/** 生成 32 位随机请求 id（agent 轮询凭据） */
function generateRequestId() {
  return crypto.randomBytes(24).toString('hex');
}

/** 创建设备流连接请求（匿名 pending，不建 key）；返回 { request_id } */
function createConnectRequest() {
  const requestId = generateRequestId();
  const ts = now();
  db.prepare(
    `INSERT INTO connect_requests (request_id, user_id, status, created_at, expires_at)
     VALUES (?, NULL, 'pending', ?, ?)`
  ).run(requestId, ts, new Date(Date.now() + REQ_TTL_MS).toISOString());
  return { request_id: requestId };
}

/** 确认授权：绑定当前登录用户 + 生成 API Key（命名自动去重）；返回 { token, key_name } */
function confirmConnectRequest(requestId, userId, name) {
  const row = db.prepare('SELECT * FROM connect_requests WHERE request_id = ?').get(requestId);
  if (!row) return null;
  if (row.status !== 'pending') return null;
  if (row.user_id && row.user_id !== userId) return null; // 已被他人绑定
  if (row.expires_at <= now()) {
    db.prepare("UPDATE connect_requests SET status='expired' WHERE request_id=?").run(requestId);
    return null;
  }
  const safeName = (name || '').trim().slice(0, 50) || 'zcode';
  const keyName = uniqueApiKeyName(userId, safeName);
  const { token, id: keyId } = require('../auth/tokens').createApiKey(userId, keyName);
  db.prepare(
    `UPDATE connect_requests SET status='authorized', user_id=?, key_name=?, api_key_id=?, token_plain=?, confirmed_at=? WHERE request_id=?`
  ).run(userId, keyName, keyId, token, now(), requestId);
  return { token, key_name: keyName, api_key_id: keyId };
}

/** 轮询授权状态：authorized 返回 { token, key_name }，pending 返回 null，过期返回 'expired' */
function pollConnectRequest(requestId) {
  const row = db.prepare('SELECT * FROM connect_requests WHERE request_id = ?').get(requestId);
  if (!row) return 'expired';
  if (row.status === 'authorized') {
    return { token: row.token_plain, key_name: row.key_name, api_key_id: row.api_key_id };
  }
  if (row.expires_at <= now()) {
    db.prepare("UPDATE connect_requests SET status='expired' WHERE request_id=?").run(requestId);
    return 'expired';
  }
  return null;
}

/** 清理过期/已确认的请求（明文随之删除） */
function cleanupConnectRequests() {
  db.prepare("DELETE FROM connect_requests WHERE status != 'pending' OR expires_at <= ?").run(now());
}

/** 唯一化 API Key 名称（重名自动加 -2/-3…） */
function uniqueApiKeyName(userId, base) {
  const exists = db
    .prepare("SELECT name FROM api_keys WHERE user_id=? AND revoked_at IS NULL AND name=?")
    .get(userId, base);
  if (!exists) return base;
  let i = 2;
  while (db.prepare("SELECT 1 FROM api_keys WHERE user_id=? AND revoked_at IS NULL AND name=?").get(userId, `${base}-${i}`)) i++;
  return `${base}-${i}`;
}

module.exports = {
  createApiKey,
  listApiKeys,
  findUserIdByTokenHash,
  revokeApiKey,
  createSession,
  getSession,
  deleteSession,
  cleanupSessions,
  setBipCredentials,
  getBipCredentials,
  createLegacyConnectRequest,
  consumeConnectCode,
  cleanupConnectCodes,
  createConnectRequest,
  confirmConnectRequest,
  pollConnectRequest,
  cleanupConnectRequests,
  uniqueApiKeyName,
};
