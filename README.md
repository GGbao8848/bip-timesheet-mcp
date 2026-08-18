# BIP 工时填报 MCP 服务（bip-timesheet-mcp）

BIP 工时填报的 **MCP 服务端**。把 skill 的 CLI 核心（`python/report.py` 及配套模块）封装为 12 个 MCP 工具，并提供 **Keycloak 统一登录 + Token 认证接入 + Web 凭据/密钥管理**。架构与 [`aimemory`](../aimemory) 同构：纯 CJS Node 单进程，一个端口承载 MCP + REST + Web + Keycloak。

> 🎯 **为什么这么做**：原 skill 的 `scripts/` 里包含 BIP 内部地址、AES 加密密钥、公司 ID 等敏感配置。封装为 MCP 服务后，**核心代码与内部配置只存在于服务器端**；分发给用户的 skill 只描述工具、零泄密。

## 架构

```
┌──────────────┐  Keycloak SSO（浏览器）     ┌─────────────────────────────────────────┐
│ 用户浏览器    │ ──────────────────────────► │ Express 单进程 :51889                   │
└──────────────┘                             │  src/index.js                            │
┌──────────────┐  POST /mcp                  │   ├─ /mcp        MCP Streamable HTTP     │
│ 用户 Agent    │ ◄── Authorization: Token ──►│   │              （会话建立时校验 bip-xxx）│
│ （配套 skill）│    bip-xxx                  │   ├─ /api/*      /me /credentials /keys  │
└──────────────┘                             │   ├─ /auth/*     Keycloak 授权码+PKCE     │
                                             │   ├─ /connect    设备流授权页（零粘贴）    │
                                             │   ├─ /           静态 Web SPA             │
                                             │   └─ spawn ─┐                             │
                                             │  python/report.py ◄── BIP_USERNAME/PASSWORD│
                                             │  (config.py: BIP 地址/AES密钥，不出服务器)  │
                                             └─────────────────────────────────────────┘
```

- **用户侧**：登录 Web 平台（Keycloak SSO）绑定一次 BIP 凭据、生成接入密钥 `bip-xxx`，把 MCP 配置 JSON（含 `Authorization: Token bip-xxx`）填进 agent。
- **服务器侧**：本目录持有全部核心代码。`python/config.py` 内的 `BASE_URL` / `AES_KEY` / `AES_IV` / `COMPANY_ID` 不随 skill 分发。
- **MCP 完整 token 认证**：`POST /mcp` 无有效 Token 直接 401；会话建立时校验 `Authorization: Token bip-xxx` → 按密钥所属用户隔离全部工具调用。

## 快速部署

```bash
npm install
npm run setup             # 建 python/.venv 并安装 BIP 核心依赖（幂等，已存在则跳过）
cp .env.example .env      # 首次启动也会自动生成；按需改 KEYCLOAK_* / PORT
npm run setup-keycloak    # 幂等初始化 Keycloak：realm + client + audience mapper（Keycloak 26 必配）
npm start                 # http://<内网IP>:51889/  → Web 平台；/mcp → MCP 端点
```

启动后：
- **Web 平台** `http://<内网IP>:51889/`：Keycloak 登录 → 绑定 BIP 凭据 → 生成密钥 → 一键复制带 token 的 MCP 配置 JSON。
- **MCP 端点** `http://<内网IP>:51889/mcp`：需 `Authorization: Token bip-xxx`，否则 401。

| 参数 | 说明 |
|---|---|
| `PORT` | 端口，默认 `51889` |
| `PUBLIC_BASE_URL` | 对外访问地址（回调/登出/配置 JSON），留空跟随请求 Host |
| `KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` | Keycloak 对接（OIDC 发现自动拉 JWKS，运行时无需管理凭据） |
| `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` | `setup-keycloak` 脚本用（master realm 管理员） |
| `PYTHON_BIN` | Python 解释器路径，默认自动探测 venv → PATH |
| `CLI_TIMEOUT_MS` | 单次 CLI 调用超时，默认 300000（批量报工可调大） |
| `MAX_CONCURRENT_CLI` | 全局并发池大小，默认 20 |

> BIP 凭据**不随工具调用传递**：每个用户在 Web 平台（或 `bip_set_credentials` 工具）绑定一次 BIP 账号密码，AES-256-GCM 加密落库（密钥派生自 `SESSION_SECRET`），之后所有工具免密调用。

## 认证与接入（对齐 aimemory）

- **Web 登录**：Keycloak 授权码 + PKCE（服务器端，jose 裸 OIDC）；`jwtVerify` 校验 `iss` / `aud` / `exp` / RS256，公钥来自 discovery 的 JWKS（缓存 1h）。登录成功建立本地 DB 会话（`bip_session` cookie，7 天）。
- **MCP / REST 鉴权**：`Authorization: Token bip-xxx`（API Key，数据库存 sha256，吊销立即失效）或 Web 会话 cookie。
- **设备流连接**：agent 调 `POST /api/connect/start` → 浏览器打开授权页 → 确认 → agent 轮询拿到密钥，全程零粘贴（与 aimemory 的 `/connect` 一致）。
- **单点登出**：`/slo-logout` 供 Keycloak front-channel iframe 加载，其他应用登出时本服务同步退出。

## 工具（12 个）

| 工具 | 说明 | 关键参数 |
|---|---|---|
| `bip_set_credentials` | 绑定/更新当前用户的 BIP 账号密码（加密落库） | `username` `password` |
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

所有工具按 **token 所属用户** 取服务器绑定的 BIP 凭据，未绑定时返回明确引导错误；不再逐次传 `username`/`password`。

## pm2 托管（推荐上线方式）

服务为纯 CJS Node（`src/index.js`），无编译步骤，pm2 直接运行源码：

```bash
cd E:\br\MCP\bip-timesheet-mcp
pm2 start ecosystem.config.cjs   # name=bip-timesheet-mcp，日志/自动重启
pm2 save                          # 保存进程列表，供 pm2 resurrect 恢复
pm2 logs bip-timesheet-mcp        # 查看日志（logs/out.log, logs/err.log，轮转 7 天）
pm2 restart bip-timesheet-mcp     # 部署新代码后重启
```

> 开机自启：Windows 上 pm2 不支持 `pm2 startup`，需创建计划任务在登录时执行 `pm2 resurrect`（如 `schtasks /Create /TN pm2-resurrect /TR "cmd /c C:\Users\<user>\AppData\Roaming\npm\pm2.cmd resurrect" /SC ONLOGON`）。
>
> 📄 完整部署流程（pm2 安装 → 启动 → 验证 → 开机自启 → 日常运维 → 更新 → 排错）：见 [`docs/pm2-deploy.md`](docs/pm2-deploy.md)。

## 自测

```bash
node scripts/test-concurrency.mjs   # 并发控制单元验证（无需服务）
node scripts/test-http.mjs          # HTTP 冒烟：无 token 401 → 带 token 会话 → tools/list → 绑定凭据 → 吊销
```

## 并发模型（多用户）

- **per-账号串行**：同一 BIP 账号的调用排队执行（保住 BIP「并发登录互踢」约束）；**不同账号并行**，互不阻塞。
- **全局并发上限**：信号量限制同时运行的 python 进程数（默认 20，`MAX_CONCURRENT_CLI` 可调，惰性生效），保护 MCP 部署机器的 CPU/内存。
- `/health` 返回 `maxConcurrentCli` 便于查看当前上限。

## 安全说明

- **MCP 完整 token 认证**：`POST /mcp` 无有效 `Token bip-xxx` 直接 401；会话建立后按密钥所属用户隔离全部工具。
- **BIP 凭据加密落库**：AES-256-GCM，密钥 = sha256(`SESSION_SECRET`)；明文只存在于绑定瞬间；更换 `.env` 后旧密文不可解，需重新绑定。
- **API Key 只存 sha256**：明文只展示一次；吊销立即生效。
- **凭证不落 argv**：BIP 账号密码通过子进程环境变量 `BIP_USERNAME` / `BIP_PASSWORD` 传入 CLI，不会出现在进程列表或日志中。
- **内部配置不出服务器**：`python/config.py`（BIP 地址 / AES 密钥 / 公司 ID）只存在于本目录，不随 skill 分发。

## 从源 skill 同步 Python 核心

核心代码来自 `BR-Agent/apps/server/data/skills/jiangsu-beiren-bip-work-hour-reporting/scripts/`。源 skill 更新后，同步到本目录：

```bash
cp <源>/scripts/*.py python/
```

同步后重启服务即可生效（Python 直接运行，无编译）。`requirements.txt` 变更时重跑 `npm run setup`。

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

- 配套用户 skill：`自动报工`（`skill/SKILL.md`，零内部代码，可从 Web 平台 `/skill/download` 下载）
- 部署文档：`docs/pm2-deploy.md`
