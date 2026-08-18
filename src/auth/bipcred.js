'use strict';

/**
 * BIP 凭据加解密：AES-256-GCM，密钥 = sha256(SESSION_SECRET)。
 * 明文只存在于调用瞬间（Web 表单 / MCP 工具入参），落库为密文。
 * 密钥随 .env 的 SESSION_SECRET 持久化——更换 .env 后旧密文将无法解密（需重新绑定）。
 */
const crypto = require('crypto');
const config = require('../config');
const repo = require('../db/repo');

function encKey() {
  return crypto.createHash('sha256').update(config.sessionSecret).digest();
}

function encryptPassword(password) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const enc = Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptPassword(passwordEnc) {
  const [ivB64, tagB64, encB64] = String(passwordEnc).split('.');
  if (!ivB64 || !tagB64 || !encB64) throw new Error('BIP 凭据密文格式错误');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
}

/** 绑定/更新 BIP 凭据（加密落库） */
function setBipCredentials(userId, username, password) {
  if (!userId) throw new Error('缺少用户身份');
  if (!username || !String(username).trim()) throw new Error('BIP 账号不能为空');
  if (!password) throw new Error('BIP 密码不能为空');
  repo.setBipCredentials(userId, String(username).trim(), encryptPassword(password));
}

/** 读取 BIP 凭据明文：{ username, password }；未绑定返回 null */
function getBipCredentials(userId) {
  const row = repo.getBipCredentials(userId);
  if (!row) return null;
  try {
    return { username: row.username, password: decryptPassword(row.password_enc) };
  } catch (e) {
    return { username: row.username, password: null, decryptError: e.message };
  }
}

module.exports = { setBipCredentials, getBipCredentials };
