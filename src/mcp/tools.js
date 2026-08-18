'use strict';

/**
 * MCP 工具定义与处理器（bip_ 前缀，12 个）：
 * - 11 个 BIP 报工工具：不再接收 username/password，凭据按登录用户（token 绑定的
 *   user_id）从服务器读取（bip_credentials 表，AES-256-GCM 密文）。
 * - bip_set_credentials：绑定/更新当前用户的 BIP 账号密码（仅此工具需要密码入参）。
 * Python 核心调用沿用原并发模型：per-账号串行 + 全局并发上限。
 */
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { z } = require('zod');
const config = require('../config');
const bipcred = require('../auth/bipcred');
const { serializedByUser, withConcurrencyLimit } = require('../queue');

const PYTHON_DIR = path.join(config.root, 'python');
const REPORT_SCRIPT = path.join(PYTHON_DIR, 'report.py');

// ── Python 解释器探测：PYTHON_BIN > python/.venv 内 > PATH ──
function resolvePython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const venvPython =
    process.platform === 'win32'
      ? path.join(PYTHON_DIR, '.venv', 'Scripts', 'python.exe')
      : path.join(PYTHON_DIR, '.venv', 'bin', 'python');
  if (existsSync(venvPython)) return venvPython;
  return 'python';
}

// ── 子进程执行核心 CLI ──
function runCli(args, opts = {}) {
  const py = resolvePython();
  const childEnv = { ...process.env, PYTHONIOENCODING: 'utf-8' };
  if (opts.username) childEnv.BIP_USERNAME = opts.username;
  if (opts.password) childEnv.BIP_PASSWORD = opts.password;

  return new Promise((resolve, reject) => {
    // -W ignore::SyntaxWarning：report.py 顶部文档字符串有转义序列，3.12 会刷警告到 stderr 污染输出
    const child = spawn(py, ['-W', 'ignore::SyntaxWarning', REPORT_SCRIPT, ...args], {
      env: childEnv,
      cwd: PYTHON_DIR,
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ stdout, stderr, code: null, timedOut: true });
    }, config.cliTimeoutMs);

    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut: false });
    });
  });
}

// ── 统一工具出口：串行执行 + 格式化输出 ──
// summaryOnly：写操作只留结果（过滤 [N/M] 步骤日志 + 截取尾部），只读操作/失败保留全量
async function cli(args, cred, opts = {}) {
  let r;
  try {
    r = await serializedByUser(cred.username, () => withConcurrencyLimit(() => runCli(args, cred)));
  } catch (e) {
    return {
      content: [{ type: 'text', text: `❌ 无法启动 Python 核心: ${e.message}\n（请确认已运行 npm run setup 且 PYTHON_BIN 指向可用的 python）` }],
      isError: true,
    };
  }
  const parts = [];
  if (r.stdout.trim()) parts.push(r.stdout.trim());
  if (r.stderr.trim()) parts.push(`(stderr) ${r.stderr.trim()}`);
  let text = parts.join('\n') || '(无输出)';

  if (r.timedOut) {
    return {
      content: [{ type: 'text', text: `⏱️ 执行超过 ${Math.round(config.cliTimeoutMs / 1000)}s 已终止（可设置 CLI_TIMEOUT_MS 调大）。已输出:\n${text}` }],
      isError: true,
    };
  }
  if (r.code !== 0) {
    return { content: [{ type: 'text', text }], isError: true };
  }
  if (opts.summaryOnly) {
    const lines = text.split('\n').filter((l) => !/^\s*\[\d+\/\d+\]/.test(l));
    text = lines.slice(-15).join('\n');
  }
  return { content: [{ type: 'text', text }] };
}

// ── 凭据守卫：未绑定 BIP 账号密码时给出明确指引 ──
function withCreds(userId, fn) {
  const cred = bipcred.getBipCredentials(userId);
  if (!cred) {
    return Promise.resolve({
      content: [{ type: 'text', text: '❌ 未绑定 BIP 账号密码：请先在 Web 平台「BIP 凭据」页保存，或调用 bip_set_credentials 绑定（按登录用户，一次绑定长期有效，绑定后本工具无需再传账号密码）' }],
      isError: true,
    });
  }
  if (cred.decryptError) {
    return Promise.resolve({
      content: [{ type: 'text', text: `❌ BIP 凭据解密失败：${cred.decryptError}（可能更换了 .env 的 SESSION_SECRET，请重新绑定）` }],
      isError: true,
    });
  }
  return fn(cred);
}

// ── 为指定用户创建 MCP Server（userId 闭包注入，天然租户隔离）──
function createServer(userId) {
  const server = new McpServer({
    name: '自动报工',
    version: '1.1.0',
  });
  server.userId = userId;

  // 1. 绑定/更新 BIP 凭据（唯一需要密码入参的工具）
  server.tool(
    'bip_set_credentials',
    '绑定（或更新）当前登录用户的 BIP 账号密码。密码经 AES-256-GCM 加密后落库，服务器不存明文。绑定一次后，本用户的所有 bip_* 工具无需再传账号密码；再次调用可更新凭据。',
    {
      username: z.string().describe('BIP 账号'),
      password: z.string().describe('BIP 密码'),
    },
    async ({ username, password }) => {
      try {
        bipcred.setBipCredentials(userId, username, password);
      } catch (e) {
        return { content: [{ type: 'text', text: `❌ 绑定失败: ${e.message}` }], isError: true };
      }
      return { content: [{ type: 'text', text: `✅ 已绑定 BIP 凭据：${String(username).trim()}（登录用户维度，之后调用 bip_* 工具无需再传账号密码；再次调用可更新）` }] };
    }
  );

  // 2. 扫描考勤（只读）
  server.tool(
    'bip_scan',
    '扫描最近30天考勤，返回四类明细：待报工（可报）、已报工、考勤异常（需手动指定工时）、无考勤。不提交任何数据。',
    {},
    async () => withCreds(userId, (cred) => cli(['--scan'], cred))
  );

  // 3. 查询已提交报工单（只读）
  server.tool(
    'bip_submitted',
    '查询已提交报工单及审批状态。可选按日期 / 审批状态码 / 单号筛选。审批状态码：1待提交 2已撤销 4审批中 8审批通过 16反审核 32已驳回。无筛选时按近6个月的 RPTyyMM 单号前缀分次查询并去重合并，返回全部记录（不遗漏最近单）；筛选时单次查询。',
    {
      date: z.string().describe('报工日期 YYYY-MM-DD（可选）').optional(),
      audit_status: z.string().describe('审批状态码筛选，如 4（审批中）').optional(),
      doc_no: z.string().describe('按单号筛选，如 RPT20260701001').optional(),
    },
    async ({ date, audit_status, doc_no }) => {
      const args = ['--submitted'];
      if (date) args.push('-d', date);
      if (audit_status) args.push('--audit-status', audit_status);
      if (doc_no) args.push('--doc-no', doc_no);
      return withCreds(userId, (cred) => cli(args, cred));
    }
  );

  // 4. 查询可选任务/阶段列表（只读）
  server.tool(
    'bip_list_phases',
    '查询指定工作类别的可选任务/阶段列表。部门工作无需项目；项目工时/销售支持必须提供 project_id。任务/阶段支持 ID 或名称模糊匹配。',
    {
      work_type: z.enum(['部门工作', '项目工时', '销售支持']).describe('工作类别'),
      project_id: z.string().describe('项目号或名称关键词（项目工时/销售支持必填）').optional(),
      date: z.string().describe('查询日期 YYYY-MM-DD（可选，默认前一天）').optional(),
    },
    async ({ work_type, project_id, date }) => {
      const args = ['--list-phases', '-w', work_type];
      if (project_id) args.push('--project-id', project_id);
      if (date) args.push('-d', date);
      return withCreds(userId, (cred) => cli(args, cred));
    }
  );

  // 5. 报工预览（报工主入口）：一次返回 考勤四分类 + 报工单概况 + 表单数据
  server.tool(
    'bip_preview',
    '报工前的综合预览，一次返回：① 考勤四分类（待报工/已报工/异常/无考勤）② 已提交报工单概况（按审批状态计数，近6个月按月分次查询合并）③ 【表单数据】JSON（日期行/工作类别/常用任务/历史项目/最近报工模式）。agent 据此渲染表格+表单供用户确认，无需再调 bip_scan/bip_submitted/bip_form_data。',
    {
      date: z.string().describe('指定待报工日期 YYYY-MM-DD（可选，默认取最近待报日/异常日）').optional(),
    },
    async ({ date }) => {
      const args = ['--preview'];
      if (date) args.push('-d', date);
      return withCreds(userId, (cred) => cli(args, cred));
    }
  );

  // 6. 单日报工
  server.tool(
    'bip_report',
    '执行单日（或单任务）报工：获取考勤 → 匹配项目/阶段 → 提交 → 发起审批 → 更新状态。任务/项目支持 ID 或名称关键词模糊匹配。content 必须使用用户原话。',
    {
      date: z.string().describe('报工日期 YYYY-MM-DD（可选，默认前一天）').optional(),
      work_type: z.enum(['部门工作', '项目工时', '销售支持']).describe('工作类别'),
      phase_id: z.string().describe('任务/阶段 ID 或名称关键词（必填）'),
      content: z.string().describe('报工内容（必须使用用户原话）'),
      project_id: z.string().describe('项目号或名称关键词（项目工时/销售支持必填）').optional(),
      hours: z.number().describe('手动覆盖工时（考勤异常时必填）').optional(),
      cost_org: z.string().describe('成本部门 ID（可选）').optional(),
    },
    async ({ date, work_type, phase_id, content, project_id, hours, cost_org }) => {
      const args = ['-w', work_type, '--phase-id', phase_id, '-c', content];
      if (date) args.push('-d', date);
      if (project_id) args.push('--project-id', project_id);
      if (hours !== undefined) args.push('--hours', String(hours));
      if (cost_org) args.push('--cost-org', cost_org);
      return withCreds(userId, (cred) => cli(args, cred, { summaryOnly: true }));
    }
  );

  // 7. 生成报工表单数据
  server.tool(
    'bip_form_data',
    '生成报工表单数据：日期行（待报工/考勤异常日，带考勤工时）、工作类别、常用任务、历史项目、最近报工模式。输出以【表单数据】...【表单数据结束】包裹的 JSON，agent 据此渲染表单卡片供用户确认。',
    {
      date: z.string().describe('指定待报工日期 YYYY-MM-DD（可选，默认取最近待报日/异常日）').optional(),
      work_type: z.string().describe('工作类别（可选，默认部门工作）').optional(),
    },
    async ({ date, work_type }) => {
      const args = ['--form-data'];
      if (date) args.push('-d', date);
      if (work_type) args.push('-w', work_type);
      return withCreds(userId, (cred) => cli(args, cred));
    }
  );

  // 8. 批量自动报工
  server.tool(
    'bip_auto_report',
    '批量自动报工所有待报工日期（最近30天）。所有日期使用相同阶段和内容，不同任务需分开报。考勤异常日会跳过，需手动指定 hours 单独报工。',
    {
      work_type: z.enum(['部门工作', '项目工时', '销售支持']).describe('工作类别'),
      content: z.string().describe('报工内容（必须使用用户原话）'),
      phase_id: z.string().describe('任务/阶段 ID 或名称关键词').optional(),
      project_id: z.string().describe('项目号或名称关键词（项目工时/销售支持必填）').optional(),
      hours: z.number().describe('手动覆盖工时（可选）').optional(),
    },
    async ({ work_type, content, phase_id, project_id, hours }) => {
      const args = ['--auto', '-w', work_type, '-c', content];
      if (phase_id) args.push('--phase-id', phase_id);
      if (project_id) args.push('--project-id', project_id);
      if (hours !== undefined) args.push('--hours', String(hours));
      return withCreds(userId, (cred) => cli(args, cred, { summaryOnly: true }));
    }
  );

  // 9. 拆分报工
  server.tool(
    'bip_split_report',
    '拆分报工（单日多任务，单 DocNo 多明细）。items 为管道分隔字符串数组，格式：部门工作=『类别|任务|内容|标准工时|加班工时』(5段)；项目类=『类别|项目ID|任务|内容|标准工时|加班工时』(6段)。可重复多条。',
    {
      date: z.string().describe('报工日期 YYYY-MM-DD（可选，默认前一天）').optional(),
      items: z.array(z.string()).describe('拆分明细，如 ["部门工作|skill开发|月结处理|6|0", "部门工作|T02|课题讨论|0|2"]'),
    },
    async ({ date, items }) => {
      const args = [];
      if (date) args.push('-d', date);
      for (const item of items) args.push('--item', item);
      return withCreds(userId, (cred) => cli(args, cred, { summaryOnly: true }));
    }
  );

  // 10. 删除报工单
  server.tool(
    'bip_delete_doc',
    '删除指定报工单。审批中(4)会自动先撤销再删除；审批通过(8)拒绝删除。',
    {
      doc_no: z.string().describe('报工单单号，如 RPT20260701001'),
    },
    async ({ doc_no }) => withCreds(userId, (cred) => cli(['--delete-doc', doc_no], cred, { summaryOnly: true }))
  );

  // 11. 撤销审批
  server.tool(
    'bip_revoke_doc',
    '仅撤销指定报工单的审批，不删除。仅对审批中(4)状态有效。',
    {
      doc_no: z.string().describe('报工单单号，如 RPT20260701001'),
    },
    async ({ doc_no }) => withCreds(userId, (cred) => cli(['--revoke-doc', doc_no], cred, { summaryOnly: true }))
  );

  // 12. 同步选项快照
  server.tool(
    'bip_sync_options',
    '同步报工选项快照（工作类别/常用任务/历史项目）到 options.json。一般无需手动调用，bip_form_data 会自动按需同步。',
    {},
    async () => withCreds(userId, (cred) => cli(['--sync-options'], cred))
  );

  return server;
}

module.exports = { createServer, resolvePython };
