'use strict';

/**
 * API Key（bip- 前缀，与 aimemory 的 m0- 区分）：
 * 生成 / 哈希 / 校验。明文只落一次，数据库存 sha256。
 */
const crypto = require('crypto');
const repo = require('../db/repo');

const PREFIX = 'bip-';

function generateApiKey() {
  return PREFIX + crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 创建 key，返回 { token(明文，仅此一次), id, name, created_at } */
function createApiKey(userId, name = 'default') {
  const token = generateApiKey();
  const row = repo.createApiKey({ userId, name, tokenHash: hashToken(token) });
  return {
    token,
    id: row.id,
    name: row.name,
    created_at: row.created_at,
  };
}

function listApiKeys(userId) {
  return repo.listApiKeys(userId).map(({ id, name, created_at }) => ({ id, name, created_at }));
}

function revokeApiKey(id, userId) {
  return repo.revokeApiKey(id, userId);
}

/** 校验 Token bip-xxx，返回 user_id 或 null */
function verify(token) {
  if (!token || !token.startsWith(PREFIX)) return null;
  return repo.findUserIdByTokenHash(hashToken(token));
}

module.exports = { createApiKey, listApiKeys, revokeApiKey, verify, hashToken };
