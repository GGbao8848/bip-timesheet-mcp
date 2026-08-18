// HTTP 冒烟测试（含 token 鉴权）：
//   1) 无 token initialize → 期望 401（MCP 完整 token 认证）
//   2) 带 token initialize → 拿会话 → tools/list（12 个）
//   3) bip_scan（未绑定凭据）→ 期望「未绑定 BIP 凭据」错误（不再需要逐次传账号密码）
//   4) bip_set_credentials 绑定凭据 → 成功
//   5) 吊销测试密钥 → DELETE 关闭会话
// 用法：node scripts/test-http.mjs
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
// 端口避开本机 Windows Hyper-V 排除段（51863-52162）
const PORT = 52399;
const URL = `http://127.0.0.1:${PORT}/mcp`;

function parseSse(text) {
  const events = [];
  let cur = [];
  for (const line of text.split("\n")) {
    if (line === "") {
      if (cur.length) {
        events.push(JSON.parse(cur.join("\n")));
        cur = [];
      }
      continue;
    }
    if (line.startsWith("data:")) cur.push(line.slice(5).replace(/^ /, ""));
  }
  if (cur.length) events.push(JSON.parse(cur.join("\n")));
  return events;
}

async function post(json, headers = {}) {
  const h = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
    ...headers,
  };
  const res = await fetch(URL, { method: "POST", headers: h, body: JSON.stringify(json) });
  const sid = res.headers.get("mcp-session-id");
  const text = await res.text();
  if (!text.trim()) return { status: res.status, sid, last: null };
  const events = parseSse(text);
  // 非 SSE 响应（如 401 直接返回 JSON）走普通 JSON 解析
  const last = events.length ? events[events.length - 1] : JSON.parse(text);
  return { status: res.status, sid, last };
}

const child = spawn(process.execPath, ["src/index.js"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let booted = false;
const onOut = (s) => {
  if (s.includes("已启动")) booted = true;
};
child.stdout.on("data", (d) => onOut(d.toString()));
child.stderr.on("data", (d) => {
  const s = d.toString();
  process.stderr.write(s);
  onOut(s);
});
child.on("exit", (code) => {
  if (code !== 0 && !booted) process.exit(code ?? 1);
});

// 等服务器就绪
for (let i = 0; i < 60 && !booted; i++) {
  await new Promise((r) => setTimeout(r, 250));
}
if (!booted) {
  console.error("❌ 服务器未在预期时间内就绪");
  process.exit(1);
}

let failed = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " | " + detail : ""}`);
  if (!ok) failed++;
};

const testUser = `test-user-${Date.now()}`;
const tokens = require("../src/auth/tokens.js");
const createdKeys = [];

try {
  // 1. 无 token initialize → 401
  const r0 = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-test", version: "1.0" } },
  });
  const code0 = r0.last?.error?.code;
  report("无 token → 401", r0.status === 401 && code0 === -32000, `HTTP ${r0.status}, err=${code0}`);

  // 2. 带 token initialize → 会话 + tools/list
  const key = tokens.createApiKey(testUser, "http-test");
  createdKeys.push(key.id);
  const auth = { Authorization: `Token ${key.token}` };
  const r1 = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-test", version: "1.0" } },
  }, auth);
  report("带 token initialize → 200 + 会话", r1.status === 200 && !!r1.sid, `HTTP ${r1.status}, server=${r1.last?.result?.serverInfo?.name}`);

  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, { "Mcp-Session-Id": r1.sid });
  const r2 = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, { "Mcp-Session-Id": r1.sid });
  const names = r2.last?.result?.tools?.map((t) => t.name) ?? [];
  report("tools/list → 12 个工具", names.length === 12 && names.includes("bip_preview") && names.includes("bip_set_credentials"), `${names.length} 个`);

  // 3. bip_scan 无参（未绑定凭据）→ 期望明确报错（schema 已无 username/password）
  const r3 = await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bip_scan", arguments: {} } }, { "Mcp-Session-Id": r1.sid });
  const text3 = r3.last?.result?.content?.[0]?.text ?? "";
  report("bip_scan(未绑定凭据) → 引导报错", !!r3.last?.result?.isError && text3.includes("未绑定 BIP 账号密码"), text3.slice(0, 60));

  // 4. bip_set_credentials 绑定凭据 → 成功
  const r4 = await post(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "bip_set_credentials", arguments: { username: "test-bip-user", password: "test-pass" } } },
    { "Mcp-Session-Id": r1.sid }
  );
  const text4 = r4.last?.result?.content?.[0]?.text ?? "";
  report("bip_set_credentials → 成功", !r4.last?.result?.isError && text4.includes("已绑定"), text4.slice(0, 60));

  // 5. 吊销测试密钥（经 REST，token 认证）
  const rev = await fetch(`http://127.0.0.1:${PORT}/api/keys/${key.id}/revoke`, { method: "POST", headers: auth });
  report("吊销密钥（REST token 认证）", rev.status === 200, `HTTP ${rev.status}`);

  // 6. 吊销后原 token 再初始化 → 401
  const r5 = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "http-test", version: "1.0" } },
  }, auth);
  report("吊销后原 token → 401", r5.status === 401, `HTTP ${r5.status}`);

  // 7. 关闭会话
  const del = await fetch(URL, { method: "DELETE", headers: { "Mcp-Session-Id": r1.sid } });
  report("delete session", del.status === 200 || del.status === 204, `HTTP ${del.status}`);

  // 8. GET /health + GET /mcp 探测
  const health = await fetch(`http://127.0.0.1:${PORT}/health`);
  const probe = await fetch(URL);
  report("GET /health + GET /mcp 探测", health.status === 200 && probe.status === 200, `health=${health.status}, probe=${probe.status}`);
} catch (e) {
  console.error("❌", e);
  failed++;
} finally {
  // 清理：尝试吊销可能残留的密钥
  try {
    const tokens2 = require("../src/auth/tokens.js");
    for (const id of createdKeys) tokens2.revokeApiKey(id, testUser);
  } catch (e) {}
  // 先让子进程的 stdio 管道关闭再退出，避免 Windows libuv 的 handle 断言噪音
  child.kill();
  await new Promise((r) => setTimeout(r, 150));
}

console.log(failed === 0 ? "=== HTTP 冒烟测试全部通过 ===" : `=== ${failed} 项失败 ==="`);
process.exit(failed === 0 ? 0 : 1);
