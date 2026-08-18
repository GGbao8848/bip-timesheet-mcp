'use strict';

/* 自动报工（bip-timesheet-mcp）管理平台前端逻辑（原生 JS，无构建） */

const $ = (sel) => document.querySelector(sel);

let currentUser = null;   // { userId, via, username }
let selectedKey = null;   // 当前 MCP JSON 里使用的密钥（默认第一个）
let keyToken = null;      // 新生成密钥的明文（仅存前端内存，刷新即失）

// ===== 工具 =====

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 2600);
}

// 兼容复制：安全上下文（HTTPS/localhost）用 navigator.clipboard；
// 内网 HTTP（http://IP:端口）下 clipboard API 不可用 → 降级为隐藏 textarea + execCommand
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok ? Promise.resolve() : Promise.reject(new Error('复制失败（浏览器限制）'));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('未登录');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

// ===== 登录状态 =====

async function init() {
  // 单点登录（SSO）：始终先经 Keycloak 校验——同浏览器已在其他应用登录 → 免密回跳；
  // 未登录 → 显示 Keycloak 登录页。这保证 bip_session 与当前 Keycloak SSO 用户一致。
  const q = new URLSearchParams(window.location.search);
  if (q.get('logged') !== '1') {
    window.location.replace('/auth/login'); // 走 Keycloak；回调会带 /?logged=1 回来
    return;
  }
  // 刚从 Keycloak 回跳：清掉标记，避免刷新后又跳登录
  history.replaceState({}, '', '/');
  try {
    currentUser = await api('/api/me');
    if (currentUser.userId) showApp();
    else showLogin();
  } catch { showLogin(); }
}

function showLogin() {
  window.location.href = '/auth/login';
}

function showApp() {
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  const who = currentUser.username || currentUser.userId.slice(0, 8);
  $('#user-name').textContent = who;
  loadCredentials();
  loadKeys();
}

// ===== 视图切换（侧边栏导航）=====

const VIEW_META = {
  credentials: { title: 'BIP 凭据', sub: '绑定一次，所有报工工具免密调用' },
  keys: { title: '接入密钥', sub: '生成密钥，把自动报工接进你的 agent' },
  guide: { title: '接入指南', sub: 'MCP 接入步骤与工具说明' },
};

function switchView(name) {
  if (!VIEW_META[name]) return;
  document.querySelectorAll('.view').forEach((v) => v.classList.remove('view-active'));
  document.getElementById(`view-${name}`).classList.add('view-active');
  document.querySelectorAll('.nav-item').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === name)
  );
  $('#view-title').textContent = VIEW_META[name].title;
  $('#view-sub').textContent = VIEW_META[name].sub;
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ===== 主题（暗/亮）=====

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('bip-theme', t); } catch (e) {}
}

function initThemeToggle() {
  const btn = $('#theme-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme;
    applyTheme(cur === 'light' ? 'dark' : 'light');
  });
}

// ===== BIP 凭据 =====

async function loadCredentials() {
  const status = $('#cred-status');
  try {
    const d = await api('/api/credentials');
    if (d.username) {
      status.className = 'status-line ok';
      status.innerHTML = `<span class="dot"></span><span>已绑定 BIP 账号：<code>${esc(d.username)}</code>（更新于 ${esc(new Date(d.updated_at).toLocaleString())}）</span>`;
      $('#cred-username').value = d.username;
    } else {
      status.className = 'status-line empty';
      status.innerHTML = '<span class="dot"></span><span>尚未绑定 BIP 账号密码，保存后 agent 报工无需再传账号密码。</span>';
    }
  } catch (e) {
    status.className = 'status-line empty';
    status.innerHTML = `<span class="dot"></span><span>${esc(e.message)}</span>`;
  }
}

$('#cred-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('#cred-username').value.trim();
  const password = $('#cred-password').value;
  if (!username) return toast('BIP 账号不能为空');
  const hasExisting = $('#cred-status').className.includes('ok');
  if (!password && !hasExisting) return toast('首次绑定必须填写 BIP 密码');
  try {
    await api('/api/credentials', { method: 'PUT', body: JSON.stringify({ username, password }) });
    $('#cred-password').value = '';
    toast('凭据已保存（加密存储）');
    loadCredentials();
  } catch (e2) { toast(e2.message); }
});

// ===== API Key =====

async function loadKeys() {
  try {
    const data = await api('/api/keys');
    // 刷新后明文丢失；若之前选的密钥仍在，保持选中，否则取第一个
    if (selectedKey && !data.results.some((k) => k.id === selectedKey.id)) {
      selectedKey = null;
      keyToken = null;
    }
    if (!selectedKey) selectedKey = data.results[0] || null;
    renderKeys(data.results);
    renderJson();
  } catch (e) { toast(e.message); }
}

function renderKeys(keys) {
  $('#key-list').innerHTML = keys.length
    ? keys.map((k) => `
      <li class="key-item">
        <div>
          <span class="key-name">${esc(k.name)}</span>
          <span class="muted">· ${esc(new Date(k.created_at).toLocaleDateString())}</span>
          <button class="link-btn ${selectedKey && selectedKey.id === k.id ? 'active' : ''}" data-use="${esc(k.id)}">用于配置</button>
        </div>
        <button class="btn btn-ghost danger" data-revoke="${esc(k.id)}">吊销</button>
      </li>`).join('')
    : '<li class="muted">暂无密钥，先生成一个。</li>';
  document.querySelectorAll('[data-use]').forEach((b) => {
    b.onclick = () => {
      const k = keys.find((x) => x.id === b.dataset.use);
      if (k) {
        selectedKey = k;
        keyToken = null; // 切换密钥后不再记得旧明文
        renderKeys(keys);
        renderJson();
      }
    };
  });
  document.querySelectorAll('[data-revoke]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('吊销后该密钥立即失效，确定？')) return;
      try {
        await api(`/api/keys/${b.dataset.revoke}/revoke`, { method: 'POST' });
        toast('已吊销');
        loadKeys();
      } catch (e2) { toast(e2.message); }
    };
  });
}

$('#key-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#key-name').value.trim() || 'default';
  try {
    const k = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name }) });
    keyToken = k.token;
    selectedKey = { id: k.id, name: k.name, created_at: k.created_at };
    $('#new-key').classList.remove('hidden');
    $('#new-key-value').textContent = k.token;
    $('#copy-new-key').dataset.token = k.token;
    $('#key-name').value = '';
    loadKeys(); // 刷新列表并渲染 JSON（JSON 将带上真实 Token）
  } catch (e2) { toast(e2.message); }
});

$('#copy-new-key').addEventListener('click', (e) => {
  const token = e.target.dataset.token;
  if (!token) return;
  copyText(token).then(() => toast('密钥已复制'));
});

// ===== MCP 配置 JSON =====

function baseUrl() {
  return location.origin;
}

function renderJson() {
  const json = {
    mcpServers: {
      'bip-work-hour-reporting': {
        type: 'http',
        url: `${baseUrl()}/mcp`,
        headers: {},
      },
    },
  };
  if (keyToken) {
    // 有明文（刚生成/本会话内创建）→ 生成可直接使用的完整配置
    json.mcpServers['bip-work-hour-reporting'].headers = { Authorization: `Token ${keyToken}` };
    $('#copy-json').textContent = '复制 JSON（含密钥）';
  } else if (selectedKey) {
    // 无明文 → 占位符提示
    json.mcpServers['bip-work-hour-reporting'].headers = { Authorization: 'Token <在此粘贴你的 bip-xxx 密钥>' };
    $('#copy-json').textContent = '复制 JSON 模板';
  } else {
    // 无任何密钥 → 空 headers 模板
    $('#copy-json').textContent = '复制 JSON 模板';
  }
  $('#mcp-json').textContent = JSON.stringify(json, null, 2);
  // 手动模式字段（与通用 MCP 客户端「自定义连接器」表单一一对应）
  $('#manual-url').textContent = `${baseUrl()}/mcp`;
  $('#manual-header-name').textContent = 'Authorization';
  if (keyToken) {
    $('#manual-header-value').textContent = `Token ${keyToken}`;
  } else if (selectedKey) {
    $('#manual-header-value').textContent = 'Token <在此粘贴你的 bip-xxx 密钥>';
  } else {
    $('#manual-header-value').textContent = 'Token bip-xxx（先生成一个密钥）';
  }
}

// MCP 配置格式切换（JSON / 手动）
document.querySelectorAll('[data-mcp-seg]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('[data-mcp-seg]').forEach((x) => {
      const on = x === b;
      x.classList.toggle('active', on);
      x.setAttribute('aria-selected', String(on));
    });
    const manual = b.dataset.mcpSeg === 'manual';
    $('#json-config').classList.toggle('hidden', manual);
    $('#manual-config').classList.toggle('hidden', !manual);
  };
});

// 手动模式字段复制
document.querySelectorAll('[data-copy]').forEach((b) => {
  b.onclick = () => {
    copyText($(`#${b.dataset.copy}`).textContent).then(() => toast('已复制'));
  };
});

$('#copy-json').addEventListener('click', async () => {
  if (!selectedKey && !keyToken) return toast('请先生成一个密钥');
  if (!keyToken) return toast('密钥明文只显示一次：请生成新密钥后复制，或在 JSON 中手动填入 Token');
  renderJson(); // 手动模式切回来时也确保复制的是最新内容
  copyText($('#mcp-json').textContent).then(() => {
    toast('已复制完整 MCP 配置 JSON');
  });
});

initThemeToggle();
init();
