'use strict';

/**
 * REST /api + Web 会话辅助。
 * - 鉴权：Authorization: Token bip-xxx（API key）或 bip_session cookie（Keycloak 登录会话）
 * - 数据访问强制 user_id 隔离（BIP 凭据、API Key 均按用户）
 */
const express = require('express');
const repo = require('../db/repo');
const tokens = require('../auth/tokens');
const bipcred = require('../auth/bipcred');
const config = require('../config');

const apiRouter = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (!res.headersSent) res.status(500).json({ error: e.message });
  else res.end();
});

/** 从请求解析当前用户：优先 API key，其次 Web 会话 */
function resolveIdentity(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Token\s+(.+)$/i);
  if (m) {
    const userId = tokens.verify(m[1].trim());
    if (userId) return { userId, via: 'token', username: null };
  }
  const sid = req.cookies?.bip_session;
  if (sid) {
    const s = repo.getSession(sid);
    if (s) return { userId: s.user_id, via: 'session', username: s.username || null };
  }
  return null;
}

function requireAuth(req, res, next) {
  const id = resolveIdentity(req);
  if (!id) {
    return res.status(401).json({ error: '未授权：请携带 Authorization: Token bip-xxx 或先登录 Web 平台' });
  }
  req.identity = id;
  next();
}

/** 构造回调地址：PUBLIC_BASE_URL 优先，否则用请求来源 Host */
function buildRedirectUri(req, pathname = '/auth/callback') {
  const base = config.publicBaseUrl || `http://${req.get('host')}`;
  return `${base}${pathname}`;
}

apiRouter.get('/me', wrap(async (req, res) => {
  const id = resolveIdentity(req);
  if (!id) return res.status(401).json({ error: '未授权' });
  res.json({ userId: id.userId, username: id.username, via: id.via });
}));

// ===== BIP 凭据（绑定一次，MCP 工具免密调用）=====

apiRouter.get('/credentials', requireAuth, wrap(async (req, res) => {
  const row = repo.getBipCredentials(req.identity.userId);
  if (!row) return res.json({ username: null, updated_at: null });
  res.json({ username: row.username, updated_at: row.updated_at });
}));

apiRouter.put('/credentials', requireAuth, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !String(username).trim()) return res.status(400).json({ error: 'BIP 账号不能为空' });
  if (!password) return res.status(400).json({ error: 'BIP 密码不能为空' });
  bipcred.setBipCredentials(req.identity.userId, String(username), String(password));
  res.json({ success: true, username: String(username).trim() });
}));

// ===== API Key =====

apiRouter.post('/keys', requireAuth, wrap(async (req, res) => {
  const name = String((req.body || {}).name || 'default').trim().slice(0, 50);
  // 限制重名：同一用户未吊销的密钥名称唯一（吊销后可复用）
  const exists = repo.listApiKeys(req.identity.userId).some((k) => k.name === name);
  if (exists) {
    return res.status(400).json({ error: `密钥名称「${name}」已存在，请换一个名称或先吊销旧密钥` });
  }
  res.status(201).json(tokens.createApiKey(req.identity.userId, name));
}));

apiRouter.get('/keys', requireAuth, wrap(async (req, res) => {
  res.json({ results: tokens.listApiKeys(req.identity.userId) });
}));

apiRouter.post('/keys/:id/revoke', requireAuth, wrap(async (req, res) => {
  if (!tokens.revokeApiKey(req.params.id, req.identity.userId)) {
    return res.status(404).json({ error: '密钥不存在或已吊销' });
  }
  res.json({ success: true });
}));

// ===== 连接码兑换（半自动连接）=====
// 码即凭据：浏览器授权后页面展示短码 → agent 端带码调用本接口换取密钥。
// 码一次性、10 分钟 TTL，兑换后即失效；明文密钥仅在 TTL 窗口内存在于码表。

apiRouter.post('/connect/claim', wrap(async (req, res) => {
  const code = String((req.body || {}).code || '').trim().toUpperCase();
  if (!code) return res.status(400).json({ error: '缺少连接码' });
  const result = repo.consumeConnectCode(code);
  if (!result) {
    return res.status(400).json({ error: '连接码无效、已使用或已过期，请重新打开授权页获取新码' });
  }
  res.json({
    user_id: result.user_id,
    api_key: result.api_key,
    mcp_url: `${config.publicBaseUrl || `http://${req.get('host')}`}/mcp`,
  });
}));

// ===== 设备流连接（零粘贴：发起 → 授权页确认 → 轮询拿 key）=====

// agent 端发起连接请求（匿名，不绑定用户）→ 返回 request_id 供浏览器授权页 + 轮询
apiRouter.post('/connect/start', wrap(async (req, res) => {
  const { request_id } = repo.createConnectRequest();
  res.status(201).json({
    request_id,
    authorize_url: `${config.publicBaseUrl || `http://${req.get('host')}`}/connect?request_id=${request_id}`,
    expires_in: 600,
  });
}));

// agent 端轮询：authorized → { token, key_name }；pending → null；失效/不存在 → { error }
apiRouter.get('/connect/poll', wrap(async (req, res) => {
  const requestId = String(req.query.request_id || '').trim();
  if (!requestId) return res.status(400).json({ error: '缺少 request_id' });
  const r = repo.pollConnectRequest(requestId);
  if (r === 'expired') return res.status(410).json({ error: '授权请求已过期或不存在，请重新发起' });
  if (r === null) return res.json({ status: 'pending' });
  res.json({ status: 'authorized', token: r.token, key_name: r.key_name, api_key_id: r.api_key_id });
}));

// 授权页「确认授权」：绑定当前登录用户 + 生成密钥（命名自动去重）
apiRouter.post('/connect/confirm', requireAuth, wrap(async (req, res) => {
  const { request_id, name } = req.body || {};
  if (!request_id) return res.status(400).json({ error: '缺少 request_id' });
  const r = repo.confirmConnectRequest(String(request_id), req.identity.userId, name);
  if (!r) return res.status(400).json({ error: '授权请求无效、已处理或已过期，请从 agent 端重新发起' });
  res.status(201).json({ token: r.token, key_name: r.key_name, api_key_id: r.api_key_id });
}));

module.exports = { apiRouter, resolveIdentity, buildRedirectUri };
