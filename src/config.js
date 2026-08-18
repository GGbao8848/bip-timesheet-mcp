'use strict';

/**
 * 配置加载：读 .env（缺失则从 .env.example 复制），自动生成 SESSION_SECRET 并写回。
 * 与 aimemory 同构：单端口服务，MCP + REST + Web + Keycloak 全在一个进程。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env');

function loadEnv() {
  if (!fs.existsSync(envPath)) {
    fs.copyFileSync(path.join(root, '.env.example'), envPath);
  }
  const content = fs.readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

loadEnv();

// 会话密钥：缺失或为空时自动生成并写回 .env，保证 pm2 重启后 BIP 凭据可解密、会话不失效
function ensureSessionSecret() {
  if (process.env.SESSION_SECRET) return;
  const secret = crypto.randomBytes(32).toString('hex');
  let content = fs.readFileSync(envPath, 'utf8');
  if (/^\s*SESSION_SECRET\s*=/m.test(content)) {
    content = content.replace(/^\s*SESSION_SECRET\s*=.*$/m, `SESSION_SECRET=${secret}`);
  } else {
    content = `${content.replace(/\s*$/, '')}\nSESSION_SECRET=${secret}\n`;
  }
  fs.writeFileSync(envPath, content);
  process.env.SESSION_SECRET = secret;
}
ensureSessionSecret();

module.exports = {
  root,
  dataDir: path.join(root, 'data'),
  dbPath: path.join(root, 'data', 'bip-timesheet.db'),
  port: parseInt(process.env.PORT || '51889', 10),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
  keycloak: {
    url: (process.env.KEYCLOAK_URL || 'http://localhost:18443').replace(/\/$/, ''),
    realm: process.env.KEYCLOAK_REALM || 'bip-timesheet',
    clientId: process.env.KEYCLOAK_CLIENT_ID || 'bip-timesheet-web',
  },
  sessionSecret: process.env.SESSION_SECRET,
  sessionTtlMs: 7 * 24 * 3600 * 1000, // Web 会话 7 天
  mcpSessionTtlMs: 30 * 60 * 1000, // MCP session 空闲 30 分钟清理
  // Python 核心
  cliTimeoutMs: parseInt(process.env.CLI_TIMEOUT_MS || '300000', 10),
};
