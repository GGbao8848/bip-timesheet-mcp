'use strict';

/**
 * bip-timesheet-mcp 主入口（与 aimemory 同构：单 Express 进程，一个端口承载全部能力）。
 *
 *   POST /mcp        MCP Streamable HTTP（Authorization: Token bip-xxx，会话建立时鉴权）
 *   GET  /mcp        探测（幂等返回 capabilities）
 *   /api/*           REST：/me /credentials /keys /connect/*
 *   /auth/*          Keycloak 登录（授权码 + PKCE，服务器端）
 *   /connect         设备流授权页（agent 零粘贴拿 key）
 *   /slo-logout      Keycloak front-channel 登出（iframe 加载）
 *   /                静态 Web SPA（登录 / BIP 凭据 / 接入密钥 / 接入指南）
 *   /health /skill/* 公开
 *
 * BIP 交互：spawn python/report.py（BIP_USERNAME/BIP_PASSWORD 环境变量，不进 argv）。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const AdmZip = require('adm-zip');
const config = require('./config');
const repo = require('./db/repo');
const { handleMcpRequest, handleMcpDelete } = require('./mcp/server');
const { resolvePython } = require('./mcp/tools');
const keycloak = require('./auth/keycloak');
const web = require('./web/routes');

const SKILL_DIR = path.join(config.root, 'skill');
const SKILL_MD = path.join(SKILL_DIR, 'SKILL.md');
const SKILL_ID = '自动报工';
const MCP_PATH = '/mcp';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());

// ===== 静态管理页面 =====
app.use(express.static(path.join(__dirname, 'web', 'static')));

// ===== MCP 端点（Streamable HTTP，token 鉴权在会话建立时完成）=====
app.post(MCP_PATH, handleMcpRequest);
app.delete(MCP_PATH, handleMcpDelete);
// Streamable HTTP 客户端可能用 GET 探测（部分实现），幂等返回提示
app.get(MCP_PATH, (_req, res) =>
  res.status(200).json({ jsonrpc: '2.0', result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } }, id: null })
);

// ===== REST /api（统一鉴权：Token API key 或 Web 会话 cookie）=====
app.use('/api', web.apiRouter);

// ===== Keycloak 登录流程 =====
// ?next= 支持站内跳转（如 /connect）：回调后落到目标页，用于半自动连接授权
app.get('/auth/login', async (req, res) => {
  try {
    const next = typeof req.query.next === 'string' && req.query.next.startsWith('/') && !req.query.next.includes('//') ? req.query.next : '/';
    const redirectUri = web.buildRedirectUri(req);
    const { url, state, verifier } = await keycloak.buildAuthorizeUrl(redirectUri);
    res.cookie('bip_kc_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('bip_kc_verifier', verifier, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.cookie('bip_kc_next', next, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000 });
    res.redirect(url);
  } catch (e) {
    res.status(500).send(`登录发起失败: ${e.message}`);
  }
});

app.get('/auth/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;
    if (error) return res.status(400).send(`Keycloak 登录失败: ${error}`);
    if (state !== req.cookies?.bip_kc_state) return res.status(400).send('state 校验失败（防 CSRF）');
    const redirectUri = web.buildRedirectUri(req);
    const { user, tokens: kcTokens } = await keycloak.exchangeCode(redirectUri, code, req.cookies.bip_kc_verifier);
    const sid = crypto.randomBytes(24).toString('hex');
    repo.createSession(sid, user.id, config.sessionTtlMs, user.username);
    res.cookie('bip_session', sid, {
      httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs,
    });
    // 保存 Keycloak id_token（HttpOnly，仅用于登出时拼 end_session 参数）
    if (kcTokens.id_token) {
      res.cookie('bip_kc_id_token', kcTokens.id_token, {
        httpOnly: true, sameSite: 'lax', maxAge: config.sessionTtlMs,
      });
    }
    res.clearCookie('bip_kc_state');
    res.clearCookie('bip_kc_verifier');
    // 支持 /auth/login?next= 跳转（半自动连接落在 /connect）；否则首页带 logged=1 标记
    // （前端据此避免「回跳首页后又跳登录」的死循环）
    const next = req.cookies?.bip_kc_next || '/';
    res.clearCookie('bip_kc_next');
    res.redirect(next === '/connect' ? '/connect' : '/?logged=1');
  } catch (e) {
    res.status(500).send(`登录回调失败: ${e.message}`);
  }
});

app.get('/auth/logout', async (req, res) => {
  const sid = req.cookies?.bip_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('bip_session');
  }
  res.clearCookie('bip_kc_id_token');
  // 跳到 Keycloak 登出页（携带 id_token），再回首页
  const kcLogout = await keycloak.buildLogoutUrl(web.buildRedirectUri(req, '/'), req.cookies?.bip_kc_id_token);
  res.redirect(kcLogout);
});

// ===== 设备流授权页 =====
// agent 端发起连接 → 浏览器打开 /connect?request_id=xxx → SSO 登录 → 点「确认授权」
// （可给 token 命名）→ agent 轮询 /api/connect/poll 拿到密钥，全程零粘贴复制。
app.get('/connect', (req, res) => {
  const id = web.resolveIdentity(req);
  if (!id) return res.redirect('/auth/login?next=/connect');
  const requestId = typeof req.query.request_id === 'string' ? req.query.request_id : '';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  res.type('html').send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>自动报工 · 连接授权</title>
<style>
  :root { --bg:#0b0f17; --surface:#131a29; --surface-2:#1a2336; --border:#243049;
          --text:#e8ecf4; --muted:#8a94a8; --accent:#4c8dff; --ok:#34d399; --danger:#f87171;
          --mono:ui-monospace,Menlo,Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         background:radial-gradient(600px 300px at 70% -10%, rgba(76,141,255,.08), transparent 60%), var(--bg);
         font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; color:var(--text); }
  .card { width:100%; max-width:480px; margin:24px; padding:34px 30px; background:var(--surface);
          border:1px solid var(--border); border-radius:16px; box-shadow:0 10px 30px rgba(0,0,0,.35); }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 20px; color:var(--muted); font-size:13px; }
  .who { display:flex; align-items:center; gap:8px; color:var(--ok); font-size:13px; margin-bottom:22px; }
  .who .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 8px rgba(52,211,153,.6); }
  .reqbox { font-family:var(--mono); font-size:13px; background:var(--surface-2); border:1px solid var(--border);
            border-radius:8px; padding:10px 12px; color:var(--accent); word-break:break-all; margin-bottom:18px; }
  label { display:block; font-size:12px; color:var(--muted); margin:14px 0 6px; }
  input[type=text] { width:100%; background:var(--surface-2); border:1px solid var(--border); border-radius:8px;
                     color:var(--text); padding:9px 12px; font-size:13px; font-family:inherit; }
  input:focus { outline:none; border-color:var(--accent); box-shadow:0 0 0 3px rgba(76,141,255,.12); }
  .btn { width:100%; border:none; background:var(--accent); color:#fff; border-radius:8px;
         padding:11px 0; font-size:14px; font-weight:600; cursor:pointer; margin-top:18px; font-family:inherit; }
  .btn:hover { background:#3a6fd8; }
  .btn:disabled { opacity:.5; cursor:not-allowed; }
  .err { color:var(--danger); font-size:12.5px; margin-top:10px; display:none; }
  .done { display:none; text-align:center; padding:16px 0; }
  .done .ok { color:var(--ok); font-size:18px; font-weight:700; }
  .done .hint { color:var(--muted); font-size:13px; margin-top:8px; }
</style>
</head>
<body>
  <div class="card">
    <h1 id="title">连接授权</h1>
    <p class="sub">为你的 agent 授权访问自动报工（BIP 工时填报）服务。</p>
    <div class="who"><span class="dot"></span><span>已通过统一登录平台确认身份：${esc(id.username || id.userId.slice(0, 8))}</span></div>

    <div id="form-area">
      <label>连接请求</label>
      <div class="reqbox" id="reqbox">${requestId ? esc(requestId.slice(0, 8)) + '…' : '（缺少请求标识，请从 agent 端重新发起）'}</div>
      <label>密钥名称（可选，重名自动加后缀）</label>
      <input type="text" id="key-name" placeholder="如 zcode / claude-code" maxlength="50" />
      <button class="btn" id="confirm-btn" ${requestId ? '' : 'disabled'}>确认授权</button>
      <p class="err" id="err"></p>
    </div>

    <div class="done" id="done">
      <div class="ok">✓ 已授权，可回到 agent 继续</div>
      <div class="hint">密钥已自动发送到你的 agent，无需复制粘贴。本页可关闭。</div>
    </div>
  </div>
  <script>
    const requestId = ${JSON.stringify(requestId)};
    const doneEl = document.getElementById('done');
    const formEl = document.getElementById('form-area');
    document.getElementById('confirm-btn').onclick = async () => {
      const btn = document.getElementById('confirm-btn');
      btn.disabled = true; btn.textContent = '授权中…';
      const errEl = document.getElementById('err'); errEl.style.display = 'none';
      try {
        const r = await fetch('/api/connect/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_id: requestId, name: document.getElementById('key-name').value.trim() }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || '授权失败');
        formEl.style.display = 'none';
        doneEl.style.display = 'block';
        const origin = new URLSearchParams(location.search).get('origin') || '';
        if (origin && window.opener) {
          try { window.opener.postMessage({ type: 'bip-connect-confirmed' }, origin); } catch (e) {}
        }
        setTimeout(() => { try { window.close(); } catch (e) {} }, 1200);
      } catch (e) {
        errEl.textContent = e.message; errEl.style.display = 'block';
        btn.disabled = false; btn.textContent = '确认授权';
      }
    };
  </script>
</body>
</html>`);
});

// ===== 单点登出（SLO）：Keycloak front-channel logout iframe 加载本端点 =====
// Keycloak 在某 client 登出（end_session）后，会以 iframe 加载本 realm 下所有配置了
// frontChannelLogoutUri 的 client 的对应 URL（浏览器带 cookie 请求）——本端点据此清除
// 本地会话 cookie，实现「在其它应用登出 → 本服务也退出」。必须返回 200（iframe 要求）。
app.get('/slo-logout', (req, res) => {
  const sid = req.cookies?.bip_session;
  if (sid) {
    repo.deleteSession(sid);
    res.clearCookie('bip_session');
  }
  res.clearCookie('bip_kc_id_token');
  res.clearCookie('bip_kc_state');
  res.clearCookie('bip_kc_verifier');
  res.status(200).type('text/plain').send('ok');
});

// ===== 健康检查 + 配套技能下载 =====
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    name: '自动报工',
    pid: process.pid,
    python: resolvePython(),
    maxConcurrentCli: require('./queue').maxConcurrentCli(),
    keycloak: `${config.keycloak.url}/realms/${config.keycloak.realm}`,
  });
});

// 技能 zip 包下载：<技能名>.zip，解压后即为 skill 目录（中文名用 RFC 5987 filename* 编码）
app.get('/skill/download', (_req, res) => {
  if (!fs.existsSync(SKILL_MD)) {
    res.status(404).send('配套技能 skill/SKILL.md 不存在（请检查服务器部署目录）');
    return;
  }
  const zip = new AdmZip();
  zip.addLocalFolder(SKILL_DIR, SKILL_ID);
  const buf = zip.toBuffer();
  const zipFileName = `${SKILL_ID}.zip`;
  res
    .set('Content-Type', 'application/zip')
    .set(
      'Content-Disposition',
      `attachment; filename="auto-report.zip"; filename*=UTF-8''${encodeURIComponent(zipFileName)}`
    )
    .send(buf);
});

// 单文件预览/另存
app.get('/skill/SKILL.md', (_req, res) => {
  if (!fs.existsSync(SKILL_MD)) {
    res.status(404).send('配套技能 skill/SKILL.md 不存在（请检查服务器部署目录）');
    return;
  }
  res.type('text/markdown; charset=utf-8').sendFile(SKILL_MD);
});

// ===== 启动 =====
repo.cleanupSessions();
repo.cleanupConnectCodes();
repo.cleanupConnectRequests();
setInterval(() => repo.cleanupSessions(), 3600_000).unref();
setInterval(() => repo.cleanupConnectCodes(), 600_000).unref();
setInterval(() => repo.cleanupConnectRequests(), 600_000).unref();

app.listen(config.port, '0.0.0.0', () => {
  console.log(`[bip-timesheet-mcp] MCP + API + Web 已启动: http://0.0.0.0:${config.port}`);
  console.log(`[bip-timesheet-mcp] MCP 端点: http://<内网IP>:${config.port}/mcp （Authorization: Token bip-xxx）`);
  console.log(`[bip-timesheet-mcp] Keycloak: ${config.keycloak.url}/realms/${config.keycloak.realm}`);
  console.log(`[bip-timesheet-mcp] python: ${resolvePython()}`);
});
