# BIP 工时填报 MCP 服务（bip-timesheet-mcp）

BIP 工时填报的 **MCP 服务端**（bip-timesheet-mcp）。把原 skill 的 CLI 核心（`python/report.py` 及配套模块）封装为 11 个 MCP 工具，同时支持 **streamable http** 与 **stdio** 两种传输。

> 🎯 **为什么这么做**：原 skill 的 `scripts/` 里包含 BIP 内部地址、AES 加密密钥、公司 ID 等敏感配置。把它封装成 MCP 服务后，**核心代码与内部配置只存在于服务器端**，分发给用户的 skill 只描述工具、零泄密。

## 架构

```
┌──────────────┐   HTTP (streamable)    ┌───────────────────────────────┐
│ 用户 Agent    │ ◄────────────────────► │ 本 MCP 服务（部署在服务器）     │
│ （配套 skill）│                        │  src/index.ts                 │
└──────────────┘                        │    ├─ bip_scan / bip_report … │
                                        │    └─ spawn ─┐                │
                                        │  python/report.py ◄── 内部配置  │
                                        │  (config.py: BIP 地址/AES密钥) │
                                        └───────────────────────────────┘
```

- **用户侧**：只拿到配套 skill（描述工具与流程），无任何 Python 代码、无内部配置。
- **服务器侧**：本目录持有全部核心代码。`python/config.py` 内的 `BASE_URL` / `AES_KEY` / `AES_IV` / `COMPANY_ID` 不随 skill 分发。

## 快速部署

```bash
npm install
npm run setup       # 建 python/.venv 并安装 BIP 核心依赖（requests / pycryptodome / dotenv）
npm run build
npm start           # 默认 both：HTTP(:51889/mcp) + stdio 同时启动
```

启动后终端会打印**真实可达 IP**（如 `http://10.1.20.132:51889/mcp`，优先物理网卡 + 私有网段），局域网其他机器用该地址连接；本机访问 `http://localhost:51889/` 有帮助页，可复制粘贴到 BR-Agent 的连接配置（帮助页同样按真实 IP 生成）。

| 参数 | 说明 |
|---|---|
| `--transport http` | 仅 HTTP |
| `--transport stdio` | 仅 stdio（桌面客户端本机 MCP） |
| `PORT` | 端口，默认 `51889` |
| `PYTHON_BIN` | Python 解释器路径，默认自动探测 venv → PATH |
| `CLI_TIMEOUT_MS` | 单次 CLI 调用超时，默认 300000（批量报工可调大） |

> 不在服务器配置 BIP 默认凭据：账号密码由每个用户调用工具时**必传**（`username` / `password`），服务器端不存明文密码。

## 工具（11 个）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `bip_preview` | 报工主入口：一次返回 考勤四分类 + 报工单概况 + 表单数据 JSON | — |
| `bip_scan` | 扫描最近 30 天考勤（待报工/已报工/异常/无考勤） | — |
| `bip_submitted` | 查询已提交报工单及审批状态 | `date` `audit_status` `doc_no` |
| `bip_list_phases` | 查询可选任务/阶段列表 | `work_type` `project_id` |
| `bip_form_data` | 生成报工表单数据 JSON（`【表单数据】`包裹） | `date` `work_type` |
| `bip_report` | 单日报工（考勤→匹配→提交→审批→状态） | `work_type` `phase_id` `content` `project_id` `hours` |
| `bip_auto_report` | 批量自动报工所有待报日期 | `work_type` `content` |
| `bip_split_report` | 拆分报工（单日多任务，单 DocNo 多明细） | `items[]` |
| `bip_delete_doc` | 删除报工单（审批中自动先撤销） | `doc_no` |
| `bip_revoke_doc` | 撤销审批 | `doc_no` |
| `bip_sync_options` | 同步选项快照到 options.json | — |

报工流程：`bip_preview`（一次拿齐分析+表单）→ 用户确认 → `bip_report` / `bip_split_report` / `bip_auto_report`，全程仅 2 次 CLI 调用；`bip_scan`/`bip_submitted`/`bip_form_data` 仅在单独查询意图时按需调用。

每个工具**必传** `username` / `password`（各用户自己的 BIP 账号），服务器端不提供默认凭据。

## pm2 托管（推荐上线方式）

服务已内置 **pm2 适配**：检测到 pm2 环境（`NODE_APP_INSTANCE`）时自动禁用 stdio、仅启用 HTTP——因为 pm2 会捕获子进程 stdout，stdio 传输的 JSON-RPC 通道会被污染。因此即使不带任何参数，`pm2 start dist/index.js` 也能正确运行。

```bash
cd E:\br\MCP\bip-timesheet-mcp
pm2 start ecosystem.config.cjs   # 用配置启动（name=bip-timesheet-mcp，HTTP-only，日志/自动重启）
pm2 save                          # 保存进程列表，供 pm2 resurrect 恢复
pm2 logs bip-timesheet-mcp        # 查看日志（logs/out.log, logs/err.log，轮转 7 天）
pm2 restart bip-timesheet-mcp     # 部署新代码后重启
pm2 stop bip-timesheet-mcp        # 停止
```

传输模式决策优先级：命令行 `--transport` > 环境变量 `TRANSPORT` > pm2 自动检测 > `both`。

> 开机自启：Windows 上 pm2 不支持 `pm2 startup`，需创建计划任务在登录时执行 `pm2 resurrect`（如 `schtasks /Create /TN pm2-resurrect /TR "cmd /c C:\Users\<user>\AppData\Roaming\npm\pm2.cmd resurrect" /SC ONLOGON`）。
>
> 📄 完整部署流程（pm2 安装 → 启动 → 验证 → 开机自启 → 日常运维 → 更新 → 排错）：见 [`docs/pm2-deploy.md`](docs/pm2-deploy.md)。

## 自测

```bash
npm run build && node scripts/test-stdio.mjs   # stdio 冒烟：工具清单 + 子进程链路
npm run build && node scripts/test-http.mjs    # HTTP 冒烟：会话 + tools/list + 调用 + 关闭
```

## 并发模型（多用户）

- **per-账号串行**：同一 BIP 账号的调用排队执行（保住 BIP「并发登录互踢」约束）；**不同账号并行**，互不阻塞。
- **全局并发上限**：信号量限制同时运行的 python 进程数（默认 20，`MAX_CONCURRENT_CLI` 可调，惰性生效），保护 MCP 部署机器的 CPU/内存——关注点仅在本机并发能力。
- 100 人不同账号同时报工：受并发池上限约束，超出的请求排队，不会互相踢下线。
- `/health` 返回 `maxConcurrentCli` 便于查看当前上限。

## 安全说明

- **凭证不落 argv**：BIP 账号密码通过子进程环境变量 `BIP_USERNAME` / `BIP_PASSWORD` 传入 CLI，不会出现在进程列表或日志中。
- **内部配置不出服务器**：`python/config.py`（BIP 地址 / AES 密钥 / 公司 ID）只存在于本目录，不随 skill 分发。
- 需要更强的访问控制时，可在网关层给 `:51889/mcp` 加白名单/反向代理，本服务本身不做认证。

## 从源 skill 同步 Python 核心

核心代码来自 `BR-Agent/apps/server/data/skills/jiangsu-beiren-bip-work-hour-reporting/scripts/`。源 skill 更新后，同步到本目录：

```bash
cp <源>/scripts/*.py python/
```

同步后重新 `npm run build` 无需（Python 直接运行），重启服务即可生效。`requirements.txt` 变更时重跑 `npm run setup`。

## 审批状态码

| 状态码 | 含义 | 可删除 | 可撤销 |
|---|---|---|---|
| 1 | 待提交 | ✅ | — |
| 2 | 已撤销 | ✅ | — |
| 4 | 审批中 | ✅ 自动撤销后删 | ✅ |
| 8 | 审批通过 | ❌ | ❌ |
| 16 | 反审核 | ✅ | — |
| 32 | 已驳回 | ✅ | — |

## 相关文档

- 配套用户 skill：`自动报工`（BR-Agent skills 目录，描述工具编排与报工流程；其目录名保留旧名 `jiangsu-beiren-bip-work-hour-reporting-mcp`，如需可另行同步改名）
- 封装方法论 skill：`mcp-server-encapsulation`（把任意 skill 的 CLI 核心快速封装成 MCP）
