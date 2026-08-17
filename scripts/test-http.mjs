// HTTP 冒烟测试：自起服务器 → initialize 拿会话 → tools/list → tools/call(bip_scan) → 关闭。
// 用法：npm run build && node scripts/test-http.mjs
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const PORT = 51899;
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

async function post(json, sessionId) {
  const headers = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  const res = await fetch(URL, { method: "POST", headers, body: JSON.stringify(json) });
  const sid = res.headers.get("mcp-session-id");
  const events = parseSse(await res.text());
  return { sid, last: events[events.length - 1] };
}

const child = spawn(process.execPath, ["dist/index.js", "--transport", "http"], {
  cwd: root,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});
let booted = false;
child.stderr.on("data", (d) => {
  const s = d.toString();
  process.stderr.write(s);
  if (s.includes("就绪")) booted = true;
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

try {
  // 1. initialize
  const init = await post({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "http-test", version: "1.0" } },
  });
  console.log("initialize → server:", init.last?.result?.serverInfo?.name, "| session:", init.sid ? "有" : "无");
  if (!init.sid) {
    console.error("❌ 未拿到 Mcp-Session-Id");
    process.exit(1);
  }

  // 2. notifications/initialized + tools/list
  await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, init.sid);
  const list = await post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, init.sid);
  const names = list.last?.result?.tools?.map((t) => t.name) ?? [];
  console.log(`tools/list → ${names.length} 个: ${names.join(", ")}`);

  // 3. tools/call bip_scan（无凭据 → 期望参数校验拦截返回错误）
  const call = await post(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bip_scan", arguments: {} } },
    init.sid
  );
  const isErr = !!call.last?.result?.isError;
  const contentText = JSON.stringify(call.last?.result?.content ?? "").slice(0, 100);
  console.log(`bip_scan(无凭据) → isError=${isErr} | ${contentText}`);
  if (!isErr) {
    console.error("❌ 预期 bip_scan 无凭据时返回错误（参数校验拦截）");
    process.exit(1);
  }

  // 4. 关闭会话
  const del = await fetch(URL, { method: "DELETE", headers: { "Mcp-Session-Id": init.sid } });
  console.log(`delete session → HTTP ${del.status}`);
  console.log("✅ HTTP OK");
} catch (e) {
  console.error("❌", e);
  process.exit(1);
} finally {
  child.kill();
}
