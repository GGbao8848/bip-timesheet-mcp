'use strict';

/**
 * MCP 端点（Streamable HTTP）：挂载在 Express 的 /mcp 路径。
 * - 鉴权：Authorization: Token bip-xxx → user_id（会话建立时校验，失败 401）
 * - 每个连接（mcp-session-id）缓存独立的 Server+Transport 实例并复用：
 *   保证 SDK 内部初始化状态连续，同时 userId 闭包注入实现租户隔离
 */
const crypto = require('crypto');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { createServer } = require('./tools');
const tokens = require('../auth/tokens');
const config = require('../config');

// mcpSessionId -> { userId, server, transport, lastSeen }
const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - config.mcpSessionTtlMs;
  for (const [sid, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(sid);
  }
}, 60_000).unref();

function resolveUser(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Token\s+(.+)$/i);
  if (!m) return null;
  return tokens.verify(m[1].trim());
}

function newSession(userId) {
  const sid = crypto.randomUUID();
  const server = createServer(userId);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => sid,
    onsessioninitialized: () => {
      sessions.set(sid, { userId, server, transport, lastSeen: Date.now() });
    },
  });
  transport.onclose = () => {
    sessions.delete(sid);
  };
  return { sid, server, transport };
}

async function handle(req, res, session) {
  session.lastSeen = Date.now();
  try {
    await session.transport.handleRequest(req, res, req.body ?? undefined);
  } catch (e) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: `内部错误: ${e.message}` }, id: null });
    } else {
      res.end();
    }
  }
}

async function createSession(req, res) {
  const userId = resolveUser(req);
  if (!userId) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32000, message: '缺少或无效的 API Key：请在 Authorization 头携带 Token bip-xxx' } });
    return;
  }
  const s = newSession(userId);
  await s.server.connect(s.transport);
  await handle(req, res, s);
}

async function existingSession(req, res) {
  const sid = req.headers['mcp-session-id'];
  const s = sessions.get(sid);
  if (!s) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32000, message: '会话不存在或已过期，请重新发起连接（去掉 mcp-session-id 头）' } });
    return;
  }
  await handle(req, res, s);
}

async function handleMcpRequest(req, res) {
  if (req.headers['mcp-session-id']) {
    await existingSession(req, res);
  } else {
    await createSession(req, res);
  }
}

/** DELETE /mcp：显式关闭会话（transport 内部会响应并触发 onclose 清理） */
async function handleMcpDelete(req, res) {
  const sid = req.headers['mcp-session-id'];
  const s = sessions.get(sid);
  if (!s) {
    res.status(404).json({ error: '会话不存在' });
    return;
  }
  await handle(req, res, s);
  sessions.delete(sid);
  try {
    await s.server.close();
  } catch {
    /* 已关闭 */
  }
}

module.exports = { handleMcpRequest, handleMcpDelete };
