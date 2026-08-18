'use strict';

/**
 * Keycloak 对接（集中在本模块，业务代码一律从 auth/ 导入）：
 * - OIDC 发现端点（缓存 1h）
 * - JWKS 公钥离线验签（iss / aud / exp）
 * - Web 登录：授权码 + PKCE
 * 与 aimemory 同构（仅 client/realm 由配置决定）。
 */
const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const config = require('../config');

let discoveryCache = null;
let discoveryAt = 0;
let keySetCache = null;

const KC = config.keycloak;
const issuer = `${KC.url}/realms/${KC.realm}`;

async function getDiscovery(force = false) {
  const now = Date.now();
  if (!force && discoveryCache && now - discoveryAt < 3600_000) return discoveryCache;
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Keycloak 发现端点失败: ${res.status} ${url}`);
  discoveryCache = await res.json();
  discoveryAt = now;
  return discoveryCache;
}

async function getKeySet() {
  if (keySetCache) return keySetCache;
  const d = await getDiscovery();
  keySetCache = createRemoteJWKSet(new URL(d.jwks_uri));
  return keySetCache;
}

/** 离线验签 Keycloak access_token，返回 JWT payload；失败抛错 */
async function verifyAccessToken(token) {
  const d = await getDiscovery();
  const ks = await getKeySet();
  const { payload } = await jwtVerify(token, ks, {
    issuer: d.issuer,
    audience: [KC.clientId, 'account'],
    algorithms: ['RS256'],
  });
  return payload;
}

/** 把 Keycloak claims 映射成应用侧用户模型 */
function toUser(payload) {
  return {
    id: payload.sub,
    username: payload.preferred_username || payload.sub,
    email: payload.email || '',
    name: payload.name || payload.preferred_username || payload.sub,
  };
}

/** 构造授权码 + PKCE 登录 URL；返回 { url, state, verifier } */
async function buildAuthorizeUrl(redirectUri) {
  const d = await getDiscovery();
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', KC.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString(), state, verifier };
}

/** 用授权码 + code_verifier 换 token，返回 access_token 及解析后的用户 */
async function exchangeCode(redirectUri, code, verifier) {
  const d = await getDiscovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: KC.clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Keycloak 换 token 失败: ${res.status} ${body.slice(0, 300)}`);
  }
  const tokens = await res.json();
  const payload = await verifyAccessToken(tokens.access_token);
  return { user: toUser(payload), tokens };
}

/** 登出：Keycloak end_session 地址（可拼接 id_token_hint 与 post_logout_redirect_uri） */
async function buildLogoutUrl(redirectUri, idTokenHint) {
  const d = await getDiscovery();
  const url = new URL(d.end_session_endpoint);
  url.searchParams.set('post_logout_redirect_uri', redirectUri);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  return url.toString();
}

module.exports = {
  getDiscovery,
  verifyAccessToken,
  toUser,
  buildAuthorizeUrl,
  exchangeCode,
  buildLogoutUrl,
};
