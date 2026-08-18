# bip-timesheet-mcp 部署指南（pm2 托管）

本指南从 **pm2 安装** 开始，覆盖 bip-timesheet-mcp 在 Windows 服务器上用 pm2 托管的完整流程：安装 → 初始化 Keycloak → 启动 → 验证 → 开机自启 → 日常运维 → 更新部署 → 故障排查。

> 架构对齐 [`aimemory`](../../aimemory)：纯 CJS Node 单进程（`src/index.js`），**无编译步骤**。MCP 端点需 `Authorization: Token bip-xxx` 才能建立会话（无 token 直接 401）。

## 1. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 20（本项目在 v24 验证） | `node -v` |
| npm | 随 Node 安装 | `npm -v` |
| Python | 3.9+（服务端核心为 Python） | 见下 |
| Keycloak | 可达的 Keycloak 实例（本地或内网，如 aimemory 部署） | 见第 2 节 |

服务端依赖已就绪（一次性执行，位于项目根目录）：

```bash
cd E:\br\MCP\bip-timesheet-mcp
npm install          # 安装 MCP SDK / express / better-sqlite3 / jose 等依赖
npm run setup        # 创建 python/.venv 并安装 BIP 核心依赖（幂等，已存在则跳过）
```

## 2. 初始化 Keycloak（一次性）

配置 `.env` 中的 Keycloak 参数（`KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` / `KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD`），然后执行：

```bash
npm run setup-keycloak
```

脚本幂等、可重跑，自动完成：网络预检 → master 管理员登录 → 创建 realm → 创建 client（`bip-timesheet-web`，publicClient + PKCE S256 + 回调地址）→ **audience mapper**（Keycloak 26 默认不给 access token 签 `aud`，本服务验签强制要求 `aud=clientId`，缺了登录回调必报错）→ 测试用户（`TEST_USERS` 留空则跳过）。

> 与 aimemory 共用 Keycloak / SSO 时：`KEYCLOAK_URL` 必须与 aimemory 指向**同一个 host**（SSO cookie 按域名隔离），`KEYCLOAK_REALM` 填现有业务 realm（如 `br-platform`），`KEYCLOAK_CLIENT_ID` 可沿用默认新 client，脚本只补建缺失项，不动已有配置。

## 3. 理解 pm2 配置（ecosystem.config.cjs）

项目根目录的 `ecosystem.config.cjs` 已内置全部托管配置，直接 `pm2 start ecosystem.config.cjs` 即可。关键项说明：

| 配置项 | 值 | 作用 |
|---|---|---|
| `name` | `bip-timesheet-mcp` | 进程名，后续 `pm2 logs bip-timesheet-mcp` 等命令用 |
| `script` | `./src/index.js` | 启动入口（纯 JS，无编译） |
| `autorestart` | `true` | 崩溃自动重启 |
| `max_restarts` / `restart_delay` | `10` / `2000ms` | 异常重启上限与间隔，防崩溃循环 |
| `instances` / `exec_mode` | `1` / `fork` | 单实例进程 |
| `env` | 仅 `NODE_ENV=production` | 端口不在这里配——pm2 注入的 env 会盖过 `.env`；端口统一在 `.env` 的 `PORT`（默认 51889，MCP 端点 `http://<IP>:<PORT>/mcp`，Web 平台同端口） |
| `out_file` / `error_file` | `./logs/out.log` / `./logs/err.log` | 日志文件（相对 `cwd`，即项目根） |
| `max_size` / `retain` | `10M` / `7` | 日志轮转：单文件上限 10MB，保留 7 天 |

> 首次启动时 `src/config.js` 会自动从 `.env.example` 复制 `.env` 并生成 `SESSION_SECRET`（BIP 凭据加密密钥 + 会话一致性），无需手工创建。

## 4. 启动服务

```bash
cd E:\br\MCP\bip-timesheet-mcp
pm2 start ecosystem.config.cjs
pm2 save        # 保存进程列表，供开机自启 pm2 resurrect 恢复（必做！见第 6 节）
```

## 5. 验证部署

| 检查项 | 命令 / 地址 | 预期 |
|---|---|---|
| 进程状态 | `pm2 list` | `bip-timesheet-mcp` 状态 `online` |
| 启动日志 | `pm2 logs bip-timesheet-mcp` | 出现 `MCP + API + Web 已启动` 与 Keycloak 地址 |
| 健康检查 | `http://localhost:51889/health` | 返回 `{"ok":true, "python": "...", "keycloak": "..."}` |
| Web 平台 | `http://localhost:51889/` | 跳转 Keycloak 登录，登录后可绑定凭据/生成密钥 |
| **MCP 无 token 拒绝** | `curl -X POST http://localhost:51889/mcp -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'` | 返回 **401**（未带 `Authorization: Token bip-xxx`） |
| 局域网连通 | 其他机器访问 `http://<服务器IP>:51889/` | Web 平台可打开（Keycloak 回调地址需已包含该 IP） |

> 服务器 IP 从 `pm2 logs` 获取。若换了机器/IP，需重跑 `npm run setup-keycloak` 补齐新 IP 的回调地址。

## 6. Windows 开机自启

Windows 上 pm2 **不支持** `pm2 startup` 命令，需用计划任务在用户登录时执行 `pm2 resurrect`（恢复第 4 节 `pm2 save` 保存的进程列表）。

用管理员身份打开 CMD，执行：

```bat
schtasks /Create /TN pm2-resurrect /TR "cmd /c C:\Users\<用户名>\AppData\Roaming\npm\pm2.cmd resurrect" /SC ONLOGON /RL HIGHEST
```

验证计划任务已创建：

```bat
schtasks /Query /TN pm2-resurrect
```

> 说明：`/SC ONLOGON` 表示用户登录时触发；`/RL HIGHEST` 以最高权限运行（确保能写日志、访问服务）。路径按第 2 节实际 pm2 位置替换。

## 7. 日常运维命令

| 操作 | 命令 |
|---|---|
| 查看所有进程 | `pm2 list` |
| 查看实时日志 | `pm2 logs bip-timesheet-mcp` |
| 查看进程资源占用 | `pm2 monit` |
| 查看进程详细信息（路径/环境/重启历史） | `pm2 info bip-timesheet-mcp` |
| 重启 | `pm2 restart bip-timesheet-mcp` |
| 停止 | `pm2 stop bip-timesheet-mcp` |
| 删除进程（从 pm2 移除） | `pm2 delete bip-timesheet-mcp` |
| 清空日志 | `pm2 flush bip-timesheet-mcp` |

> 每次 `pm2 stop` / `pm2 delete` 后如需恢复开机自启，重新 `pm2 start ecosystem.config.cjs` 并 `pm2 save`。

## 8. 更新部署（代码升级）

```bash
cd E:\br\MCP\bip-timesheet-mcp
git pull                    # 拉取新代码（如使用 git）
npm install                 # 依赖有变更时
pm2 restart bip-timesheet-mcp
```

> 本服务**无编译步骤**（纯 CJS Node）。Python 核心变更同样直接重启即生效；仅当 `python/requirements.txt` 变更时才重跑 `npm run setup`。换 Keycloak / 换 IP 时重跑 `npm run setup-keycloak`。

## 9. 故障排查

| 现象 | 排查步骤 |
|---|---|
| `pm2 list` 状态 `errored` / 反复重启 | `pm2 logs bip-timesheet-mcp --err` 看错误日志；确认 Node ≥ 20（better-sqlite3 需要预编译二进制） |
| 端口被占用 / `EACCES` | Windows 上部分端口段被 Hyper-V 保留（`netsh interface ipv4 show excludedportrange protocol=tcp` 查看）；改 `.env` 的 `PORT` 避开后 `pm2 restart` |
| 登录回调报 `missing required aud claim` | 未配置 audience mapper：重跑 `npm run setup-keycloak`（脚本幂等补齐） |
| Keycloak 登录发起失败 / 网络不通 | 确认 `KEYCLOAK_URL` 可达且为对外端口（非管理端口 9000）；`setup-keycloak` 第 1 步预检会给出明确提示 |
| `state 校验失败` | `PUBLIC_BASE_URL` 与浏览器访问地址不一致（回调 URL 漂移）；设置 `PUBLIC_BASE_URL` 为统一对外地址后重启 |
| BIP 凭据「解密失败」 | 更换过 `.env` 的 `SESSION_SECRET`；让用户在平台重新绑定 BIP 凭据 |
| MCP 连不上 / 401 | 确认 Web 平台生成的密钥尚未吊销，MCP 配置 JSON 里 `Authorization` 为 `Token bip-xxx` 完整值 |
| 局域网连不上 Web | 确认防火墙放行 `51889`；Keycloak client 回调地址需包含该 IP（重跑 `setup-keycloak`） |
| 报工超时 | 默认单次 CLI 超时 300s，批量报工可设环境变量 `CLI_TIMEOUT_MS`（如 `600000`）后重启 |
| `pm2 resurrect` 恢复为空 | 确认执行过 `pm2 save`（见第 4 节） |
| pm2 命令找不到 | 见第 3 节 PATH 说明，用完整路径 `...\npm\pm2.cmd` |

## 10. 卸载 pm2（可选）

```bash
pm2 delete bip-timesheet-mcp   # 先从 pm2 移除服务
pm2 kill                       # 停止 pm2 守护进程
npm uninstall -g pm2           # 卸载
```

> 若已创建开机自启计划任务，一并删除：`schtasks /Delete /TN pm2-resurrect /F`。
