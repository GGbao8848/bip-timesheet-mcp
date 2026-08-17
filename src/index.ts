// BIP 工时填报 MCP 服务（bip-timesheet-mcp）
// -----------------------------------------------------------------------------
// 把 skill 的 CLI 核心（python/report.py 及配套模块）封装为 MCP 工具。
// BIP 内部配置（地址 / AES 密钥 / 公司）全部封装在服务器端 python/ 目录，
// 分发给用户的 skill 只描述 MCP 工具，不接触任何敏感信息。
//
// 用法：
//   npm run setup                     # 首次：建 python/.venv 并装依赖
//   npm run dev                       # 默认 both：HTTP(:51889/mcp) + stdio
//   npm run dev -- --transport http   # 仅 HTTP
//   npm run dev -- --transport stdio  # 仅 stdio（桌面客户端本机 MCP）
// 端口用 PORT 覆盖；Python 解释器用 PYTHON_BIN 覆盖；服务器级凭据用 BIP_USERNAME/BIP_PASSWORD。
//
// 设计要点：
//   - 凭证（BIP 账号密码）通过子进程环境变量 BIP_USERNAME/BIP_PASSWORD 传递，
//     绝不进入 argv，避免在进程列表/日志中泄密。
//   - 所有 CLI 调用经全局队列串行执行 —— BIP 并发登录会互相踢下线，必须串行。
//   - 每个会话独立 McpServer+transport（McpServer 只能 connect 一次）。
// -----------------------------------------------------------------------------
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import AdmZip from "adm-zip";
import { serializedByUser, withConcurrencyLimit, maxConcurrentCli } from "./queue.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // 项目根
const PYTHON_DIR = join(ROOT, "python"); // 核心脚本目录（服务器端）
const REPORT_SCRIPT = join(PYTHON_DIR, "report.py");
const PORT = Number(process.env.PORT ?? 51889); // 避开 mcp-demo 的 51888
const MCP_PATH = "/mcp";
const CLI_TIMEOUT_MS = Number(process.env.CLI_TIMEOUT_MS ?? 300_000); // 单次 CLI 调用上限
const SKILL_DIR = join(ROOT, "skill"); // 配套用户技能目录（零内部代码，供下载分发）
const SKILL_MD = join(SKILL_DIR, "SKILL.md");
const SKILL_ID = "自动报工"; // 技能显示名 / zip 内顶层目录名 / 下载文件名

// ── Python 解释器探测：PYTHON_BIN > python/.venv 内 > PATH ──
function resolvePython(): string {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython =
    process.platform === "win32"
      ? join(PYTHON_DIR, ".venv", "Scripts", "python.exe")
      : join(PYTHON_DIR, ".venv", "bin", "python");
  if (existsSync(venvPython)) return venvPython;
  return "python";
}

// ── 本机可达 IP 探测：优先物理网卡 + 私有网段，剔除虚拟网卡/回环/链路本地 ──
function getLocalIps(): string[] {
  const ifaces = os.networkInterfaces();
  const isVirtual = (name: string) =>
    /virtual|vmware|vbox|vethernet|wsl|tailscale|zerotier|docker|hyper|loopback|tunnel|bluetooth|\btap\b|\btun\b/i.test(name);
  const entries: { name: string; address: string }[] = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && !a.internal) entries.push({ name, address: a.address });
    }
  }
  const score = (c: { name: string; address: string }) => {
    let s = 0;
    if (isVirtual(c.name)) s += 10; // 虚拟适配器（VMware/VBox/Hyper-V/WSL 等）往后排
    if (/^169\.254\./.test(c.address)) s += 20; // 无 DHCP 的链路本地地址
    if (/^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\./.test(c.address)) s -= 1; // 私有网段优先
    return s;
  };
  return [...new Set(entries.sort((a, b) => score(a) - score(b)).map((c) => c.address))];
}

function primaryIp(): string {
  return getLocalIps()[0] ?? "localhost";
}

// ── 子进程执行核心 CLI ──
interface CliOptions {
  username?: string;
  password?: string;
}
interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

function runCli(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const py = resolvePython();
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf-8" };
  if (opts.username) childEnv.BIP_USERNAME = opts.username;
  if (opts.password) childEnv.BIP_PASSWORD = opts.password;

  return new Promise((resolve, reject) => {
    // -W ignore::SyntaxWarning：report.py 顶部文档字符串有转义序列，3.12 会刷警告到 stderr 污染输出
    const child = spawn(py, ["-W", "ignore::SyntaxWarning", REPORT_SCRIPT, ...args], {
      env: childEnv,
      cwd: PYTHON_DIR,
      windowsHide: true,
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ stdout, stderr, code: null, timedOut: true });
    }, CLI_TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}

// ── 统一工具出口：串行执行 + 格式化输出 ──
interface Cred {
  username?: string;
  password?: string;
}
async function cli(args: string[], cred: Cred) {
  let r: CliResult;
  try {
    // per-账号串行（同一 BIP 账号排队，防止并发登录互踢）+ 全局并发上限（保护本机）
    r = await serializedByUser(cred.username, () => withConcurrencyLimit(() => runCli(args, cred)));
  } catch (e) {
    return {
      content: [{ type: "text" as const, text: `❌ 无法启动 Python 核心: ${(e as Error).message}\n（请确认已运行 npm run setup 且 PYTHON_BIN 指向可用的 python）` }],
      isError: true,
    };
  }
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push(`(stderr) ${r.stderr.trim()}`);
  const text = parts.join("\n") || "(无输出)";

  if (r.timedOut) {
    return {
      content: [{ type: "text" as const, text: `⏱️ 执行超过 ${Math.round(CLI_TIMEOUT_MS / 1000)}s 已终止（可设置 CLI_TIMEOUT_MS 调大）。已输出:\n${text}` }],
      isError: true,
    };
  }
  if (r.code !== 0) {
    return { content: [{ type: "text" as const, text }], isError: true };
  }
  return { content: [{ type: "text" as const, text }] };
}

// 各工具共用的必填凭据参数：每个用户必须传自己的 BIP 账号密码，
// 服务器端不提供任何默认凭据（多用户各自鉴权，服务器不存明文密码）。
const CRED = {
  username: z.string().describe("BIP 账号（每个用户自己的）"),
  password: z.string().describe("BIP 密码（每个用户自己的）"),
};

// ── 工具注册 ──
function createServer(): McpServer {
  const server = new McpServer({
    name: "自动报工",
    version: "1.0.0",
  });

  // 1. 扫描考勤（只读）
  server.tool(
    "bip_scan",
    "扫描最近30天考勤，返回四类明细：待报工（可报）、已报工、考勤异常（需手动指定工时）、无考勤。不提交任何数据。",
    { ...CRED },
    async ({ username, password }) => cli(["--scan"], { username, password })
  );

  // 2. 查询已提交报工单（只读）
  server.tool(
    "bip_submitted",
    "查询已提交报工单及审批状态。可选按日期 / 审批状态码 / 单号筛选。审批状态码：1待提交 2已撤销 4审批中 8审批通过 16反审核 32已驳回。注意接口只返回最近一批（约20条）。",
    {
      ...CRED,
      date: z.string().describe("报工日期 YYYY-MM-DD（可选）").optional(),
      audit_status: z.string().describe("审批状态码筛选，如 4（审批中）").optional(),
      doc_no: z.string().describe("按单号筛选，如 RPT20260701001").optional(),
    },
    async ({ username, password, date, audit_status, doc_no }) => {
      const args = ["--submitted"];
      if (date) args.push("-d", date);
      if (audit_status) args.push("--audit-status", audit_status);
      if (doc_no) args.push("--doc-no", doc_no);
      return cli(args, { username, password });
    }
  );

  // 3. 查询可选任务/阶段列表（只读）
  server.tool(
    "bip_list_phases",
    "查询指定工作类别的可选任务/阶段列表。部门工作无需项目；项目工时/销售支持必须提供 project_id。任务/阶段支持 ID 或名称模糊匹配。",
    {
      ...CRED,
      work_type: z.enum(["部门工作", "项目工时", "销售支持"]).describe("工作类别"),
      project_id: z.string().describe("项目号或名称关键词（项目工时/销售支持必填）").optional(),
      date: z.string().describe("查询日期 YYYY-MM-DD（可选，默认前一天）").optional(),
    },
    async ({ username, password, work_type, project_id, date }) => {
      const args = ["--list-phases", "-w", work_type];
      if (project_id) args.push("--project-id", project_id);
      if (date) args.push("-d", date);
      return cli(args, { username, password });
    }
  );

  // 4. 生成报工表单数据
  server.tool(
    "bip_form_data",
    "生成报工表单数据：日期行（待报工/考勤异常日，带考勤工时）、工作类别、常用任务、历史项目、最近报工模式。输出以【表单数据】...【表单数据结束】包裹的 JSON，agent 据此渲染表单卡片供用户确认。",
    {
      ...CRED,
      date: z.string().describe("指定待报工日期 YYYY-MM-DD（可选，默认取最近待报日/异常日）").optional(),
      work_type: z.string().describe("工作类别（可选，默认部门工作）").optional(),
    },
    async ({ username, password, date, work_type }) => {
      const args = ["--form-data"];
      if (date) args.push("-d", date);
      if (work_type) args.push("-w", work_type);
      return cli(args, { username, password });
    }
  );

  // 5. 单日报工
  server.tool(
    "bip_report",
    "执行单日（或单任务）报工：获取考勤 → 匹配项目/阶段 → 提交 → 发起审批 → 更新状态。任务/项目支持 ID 或名称关键词模糊匹配。content 必须使用用户原话。",
    {
      ...CRED,
      date: z.string().describe("报工日期 YYYY-MM-DD（可选，默认前一天）").optional(),
      work_type: z.enum(["部门工作", "项目工时", "销售支持"]).describe("工作类别"),
      phase_id: z.string().describe("任务/阶段 ID 或名称关键词（必填）"),
      content: z.string().describe("报工内容（必须使用用户原话）"),
      project_id: z.string().describe("项目号或名称关键词（项目工时/销售支持必填）").optional(),
      hours: z.number().describe("手动覆盖工时（考勤异常时必填）").optional(),
      cost_org: z.string().describe("成本部门 ID（可选）").optional(),
    },
    async ({ username, password, date, work_type, phase_id, content, project_id, hours, cost_org }) => {
      const args = ["-w", work_type, "--phase-id", phase_id, "-c", content];
      if (date) args.push("-d", date);
      if (project_id) args.push("--project-id", project_id);
      if (hours !== undefined) args.push("--hours", String(hours));
      if (cost_org) args.push("--cost-org", cost_org);
      return cli(args, { username, password });
    }
  );

  // 6. 批量自动报工
  server.tool(
    "bip_auto_report",
    "批量自动报工所有待报工日期（最近30天）。所有日期使用相同阶段和内容，不同任务需分开报。考勤异常日会跳过，需手动指定 hours 单独报工。",
    {
      ...CRED,
      work_type: z.enum(["部门工作", "项目工时", "销售支持"]).describe("工作类别"),
      content: z.string().describe("报工内容（必须使用用户原话）"),
      phase_id: z.string().describe("任务/阶段 ID 或名称关键词").optional(),
      project_id: z.string().describe("项目号或名称关键词（项目工时/销售支持必填）").optional(),
      hours: z.number().describe("手动覆盖工时（可选）").optional(),
    },
    async ({ username, password, work_type, content, phase_id, project_id, hours }) => {
      const args = ["--auto", "-w", work_type, "-c", content];
      if (phase_id) args.push("--phase-id", phase_id);
      if (project_id) args.push("--project-id", project_id);
      if (hours !== undefined) args.push("--hours", String(hours));
      return cli(args, { username, password });
    }
  );

  // 7. 拆分报工
  server.tool(
    "bip_split_report",
    "拆分报工（单日多任务，单 DocNo 多明细）。items 为管道分隔字符串数组，格式：部门工作=『类别|任务|内容|标准工时|加班工时』(5段)；项目类=『类别|项目ID|任务|内容|标准工时|加班工时』(6段)。可重复多条。",
    {
      ...CRED,
      date: z.string().describe("报工日期 YYYY-MM-DD（可选，默认前一天）").optional(),
      items: z.array(z.string()).describe("拆分明细，如 [\"部门工作|skill开发|月结处理|6|0\", \"部门工作|T02|课题讨论|0|2\"]"),
    },
    async ({ username, password, date, items }) => {
      const args = [];
      if (date) args.push("-d", date);
      for (const item of items) args.push("--item", item);
      return cli(args, { username, password });
    }
  );

  // 8. 删除报工单
  server.tool(
    "bip_delete_doc",
    "删除指定报工单。审批中(4)会自动先撤销再删除；审批通过(8)拒绝删除。",
    {
      ...CRED,
      doc_no: z.string().describe("报工单单号，如 RPT20260701001"),
    },
    async ({ username, password, doc_no }) => cli(["--delete-doc", doc_no], { username, password })
  );

  // 9. 撤销审批
  server.tool(
    "bip_revoke_doc",
    "仅撤销指定报工单的审批，不删除。仅对审批中(4)状态有效。",
    {
      ...CRED,
      doc_no: z.string().describe("报工单单号，如 RPT20260701001"),
    },
    async ({ username, password, doc_no }) => cli(["--revoke-doc", doc_no], { username, password })
  );

  // 10. 同步选项快照
  server.tool(
    "bip_sync_options",
    "同步报工选项快照（工作类别/常用任务/历史项目）到 options.json。一般无需手动调用，bip_form_data 会自动按需同步。",
    { ...CRED },
    async ({ username, password }) => cli(["--sync-options"], { username, password })
  );

  return server;
}

// ── 页面公共样式（帮助页 / 技能页共用） ──
const PAGE_CSS = `:root { --bg:#0f1115; --card:#171a21; --border:#262b36; --text:#e6e8ee; --muted:#8b93a5; --accent:#4f8cff; --code:#1c2029; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif; background:var(--bg); color:var(--text); padding:32px 20px; }
  .wrap { max-width:860px; margin:0 auto; }
  h1 { font-size:24px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:14px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
  .card h2 { font-size:15px; margin:0 0 12px; }
  .badge { display:inline-block; padding:2px 10px; border-radius:999px; font-size:12px; border:1px solid var(--border); color:var(--muted); margin-right:6px; }
  .badge.green { color:#4ade80; border-color:#256029; background:#0f1f15; }
  code { font-family:ui-monospace,Consolas,monospace; font-size:13px; background:var(--code); border:1px solid var(--border); border-radius:6px; padding:2px 6px; }
  pre { position:relative; background:var(--code); border:1px solid var(--border); border-radius:8px; padding:12px 14px; overflow-x:auto; font-size:13px; line-height:1.6; margin:6px 0 12px; }
  pre code { background:none; border:none; padding:0; }
  .hint { color:var(--muted); font-size:13px; margin:10px 0 4px; }
  .hint b { color:var(--text); }
  .copy { position:absolute; top:8px; right:8px; font-size:12px; color:var(--accent); cursor:pointer; background:var(--card); border:1px solid var(--border); border-radius:6px; padding:3px 10px; }
  .copy:hover { border-color:var(--accent); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--border); }
  th { color:var(--muted); font-weight:500; }
  .btn { display:inline-block; padding:8px 18px; border-radius:8px; background:var(--accent); color:#fff; text-decoration:none; font-size:14px; }
  .btn:hover { opacity:.9; }
  .btn.ghost { background:var(--card); color:var(--accent); border:1px solid var(--border); }
  .md h1,.md h2,.md h3 { color:var(--text); margin:18px 0 8px; }
  .md h1 { font-size:20px; } .md h2 { font-size:17px; } .md h3 { font-size:15px; }
  .md p { margin:8px 0; line-height:1.7; font-size:14px; }
  .md ul,.md ol { margin:8px 0; padding-left:22px; font-size:14px; line-height:1.7; }
  .md blockquote { border-left:3px solid var(--border); margin:10px 0; padding:2px 12px; color:var(--muted); }
  .md blockquote code { color:var(--text); }
  .md a { color:var(--accent); }
  .md table { margin:10px 0; }
  .md strong { color:var(--text); }`;

// ── 帮助页：启动后访问 http://localhost:<port>/ 查看连接方式与可直接粘贴的配置 ──
function renderHelpPage(): string {
  const ips = getLocalIps();
  const primary = ips[0] ?? "localhost";
  const httpUrl = `http://${primary}:${PORT}${MCP_PATH}`;
  const allUrls = [
    ...ips.map((ip) => `http://${ip}:${PORT}${MCP_PATH}`),
    `http://localhost:${PORT}${MCP_PATH}`,
  ];
  const httpConfig = JSON.stringify(
    {
      mcpServers: {
        "bip-work-hour-reporting": { type: "streamablehttp", url: httpUrl },
      },
    },
    null,
    2
  );

  const tools = [
    ["bip_scan", "扫描最近30天考勤（四分类）"],
    ["bip_submitted", "查询已提交报工单及审批状态"],
    ["bip_list_phases", "查询可选任务/阶段列表"],
    ["bip_form_data", "生成报工表单数据 JSON"],
    ["bip_report", "单日报工（含审批）"],
    ["bip_auto_report", "批量自动报工所有待报日期"],
    ["bip_split_report", "拆分报工（单日多任务）"],
    ["bip_delete_doc", "删除报工单"],
    ["bip_revoke_doc", "撤销审批"],
    ["bip_sync_options", "同步选项快照"],
  ];

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>自动报工 · 连接方式</title>
<style>
${PAGE_CSS}
</style>
</head>
<body>
<div class="wrap">
  <h1>自动报工</h1>
  <p class="sub">BIP 工时填报 MCP 服务（bip-timesheet-mcp）</p>

  <div class="card">
    <h2>本机可达地址（第一条为推荐）</h2>
    ${allUrls.map((u) => `<pre><code>${u}</code></pre>`).join("")}
  </div>

  <div class="card">
    <h2>可直接粘贴的配置</h2>
    <p class="hint">HTTP 配置（「MCP 连接」→ 添加服务器 → <b>粘贴 JSON</b>）：</p>
    <pre id="cfg-http"><code>${httpConfig}</code><button class="copy" onclick="copyCfg('cfg-http', this)">复制</button></pre>
  </div>

  <div class="card">
    <h2>配套技能下载</h2>
    <p class="hint">零内部代码、零敏感配置。下载后放入 skills 目录或上传安装。</p>
    <a class="btn" href="/skill/download" download>⬇ 下载 Skill（zip）</a>
  </div>

  <div class="card">
    <h2>工具（10 个）</h2>
    <table>
      <tr><th>名称</th><th>说明</th></tr>
      ${tools.map(([n, d]) => `<tr><td><code>${n}</code></td><td>${d}</td></tr>`).join("")}
    </table>
  </div>
</div>
<script>
function copyCfg(id, btn) {
  const text = document.getElementById(id).querySelector("code").innerText;
  const done = () => {
    btn.textContent = "已复制 ✓";
    setTimeout(() => (btn.textContent = "复制"), 1500);
  };
  const fail = () => { btn.textContent = "复制失败"; };
  // 复制到剪贴板：HTTP 局域网访问（非安全上下文）时 navigator.clipboard 不可用，
  // 回退到 execCommand('copy')（旧但兼容所有环境的方案）。
  function fallback() {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    document.body.removeChild(ta);
    ok ? done() : fail();
  }
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done).catch(fallback);
  } else {
    fallback();
  }
}
</script>
</body>
</html>`;
}

// ── streamable http 传输（stateful 会话，按 Mcp-Session-Id 关联） ──
interface HttpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

function runHttp(): void {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  const sessions = new Map<string, HttpSession>();
  const findSession = (req: express.Request): HttpSession | undefined => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    return sessionId ? sessions.get(sessionId) : undefined;
  };

  app.post(MCP_PATH, async (req, res) => {
    let session = findSession(req);
    try {
      if (!session) {
        const server = createServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, { server, transport });
          },
        });
        await server.connect(transport);
        session = { server, transport };
      }
      await session.transport.handleRequest(req, res, req.body);
    } catch (e) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: (e as Error).message }, id: null });
    }
  });

  app.get(MCP_PATH, async (req, res) => {
    const session = findSession(req);
    if (!session) {
      res.status(405).json({ error: "会话不存在，请先 POST /mcp 初始化" });
      return;
    }
    await session.transport.handleRequest(req, res);
  });

  app.delete(MCP_PATH, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(405).json({ error: "会话不存在" });
      return;
    }
    await session.transport.handleRequest(req, res);
    if (sessionId) sessions.delete(sessionId);
    try {
      await session.server.close();
    } catch {
      /* 已关闭 */
    }
  });

  // 健康检查 + 帮助页 + 配套技能下载
  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "自动报工", pid: process.pid, python: resolvePython(), maxConcurrentCli: maxConcurrentCli() });
  });
  // 技能 zip 包下载：<技能名>.zip，解压后即为 skill 目录（中文名用 RFC 5987 filename* 编码）
  app.get("/skill/download", (_req, res) => {
    if (!existsSync(SKILL_MD)) {
      res.status(404).send("配套技能 skill/SKILL.md 不存在（请检查服务器部署目录）");
      return;
    }
    const zip = new AdmZip();
    zip.addLocalFolder(SKILL_DIR, SKILL_ID); // zip 内顶层目录 = 技能名
    const buf = zip.toBuffer();
    const zipFileName = `${SKILL_ID}.zip`;
    res
      .set("Content-Type", "application/zip")
      .set(
        "Content-Disposition",
        `attachment; filename="auto-report.zip"; filename*=UTF-8''${encodeURIComponent(zipFileName)}`
      )
      .send(buf);
  });
  // 单文件预览/另存
  app.get("/skill/SKILL.md", (_req, res) => {
    if (!existsSync(SKILL_MD)) {
      res.status(404).send("配套技能 skill/SKILL.md 不存在（请检查服务器部署目录）");
      return;
    }
    res.type("text/markdown; charset=utf-8").sendFile(SKILL_MD);
  });
  app.get(["/", "/help"], (_req, res) => {
    res.type("html").send(renderHelpPage());
  });

  app.listen(PORT, () => {
    const ips = getLocalIps();
    for (const ip of ips) {
      console.error(`[bip-timesheet-mcp] streamable http 就绪: http://${ip}:${PORT}${MCP_PATH}`);
    }
    console.error(`[bip-timesheet-mcp] 本机访问: http://localhost:${PORT}${MCP_PATH}`);
    console.error(`[bip-timesheet-mcp] python: ${resolvePython()}`);
  });
}

// ── stdio 传输 ──
async function runStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[bip-timesheet-mcp] stdio 传输已就绪（pid=${process.pid}）`);
}

// ── 入口：--transport stdio|http|both ──
// 决策优先级：命令行 --transport > 环境变量 TRANSPORT > pm2 自动检测 > both
// 适配 pm2：pm2 会捕获/重定向子进程的 stdout，stdio 传输的 JSON-RPC 通道会被日志污染；
// 因此在 pm2 环境下自动降级为仅 HTTP（即使不带任何参数，`pm2 start dist/index.js` 也能正确运行）。
function parseTransport(): "stdio" | "http" | "both" {
  const idx = process.argv.indexOf("--transport");
  const argV = idx !== -1 ? process.argv[idx + 1]?.toLowerCase() : "";
  if (argV === "stdio" || argV === "http") return argV;

  const envV = process.env.TRANSPORT?.toLowerCase();
  if (envV === "stdio" || envV === "http") return envV;

  // pm2 注入 NODE_APP_INSTANCE 给托管进程（fork 与 cluster 模式都会设置）
  if (process.env.NODE_APP_INSTANCE !== undefined) return "http";
  return "both";
}

const mode = parseTransport();
const underPm2 = process.env.NODE_APP_INSTANCE !== undefined;
console.error(
  `[bip-timesheet-mcp] 启动模式: ${mode}` +
    (underPm2 ? "（pm2 托管：已自动禁用 stdio，仅 HTTP）" : "") +
    `（${new Date().toISOString()}）`
);

if (mode === "stdio") {
  void runStdio();
} else if (mode === "http") {
  runHttp();
} else {
  runHttp();
  void runStdio();
}
