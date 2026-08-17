# bip-timesheet-mcp 部署指南（pm2 托管）

本指南从 **pm2 安装** 开始，覆盖 bip-timesheet-mcp 在 Windows 服务器上用 pm2 托管的完整流程：安装 → 启动 → 验证 → 开机自启 → 日常运维 → 更新部署 → 故障排查。

## 1. 前置条件

| 项 | 要求 | 检查命令 |
|---|---|---|
| Node.js | ≥ 18（本项目在 v24 验证） | `node -v` |
| npm | 随 Node 安装 | `npm -v` |
| Python | 3.9+（服务端核心为 Python） | 见下 |

服务端依赖已就绪（一次性执行，位于项目根目录）：

```bash
cd E:\br\MCP\bip-timesheet-mcp
npm install          # 安装 MCP SDK / express 等依赖
npm run setup        # 创建 python/.venv 并安装 BIP 核心依赖（requests / pycryptodome / dotenv）
npm run build        # 编译 TypeScript → dist/
```

> `npm run build` 必须在 `pm2 start` **之前**完成——pm2 直接运行编译产物 `dist/index.js`，源码目录 `src/` 不会被执行。

## 2. 安装 pm2

pm2 是 Node.js 进程管理器，提供开机自启、崩溃自动重启、日志轮转。全局安装：

```bash
npm install -g pm2
pm2 -v          # 验证安装，输出版本号（如 5.x.x）即成功
```

> Windows 上全局包安装到 `%APPDATA%\npm`（npm 默认前缀）。若 `pm2` 命令找不到，把该目录加入 PATH，或改用完整路径：
> `C:\Users\<用户名>\AppData\Roaming\npm\pm2.cmd -v`

## 3. 理解 pm2 配置（ecosystem.config.cjs）

项目根目录的 `ecosystem.config.cjs` 已内置全部托管配置，直接 `pm2 start ecosystem.config.cjs` 即可，无需手写启动命令。关键项说明：

| 配置项 | 值 | 作用 |
|---|---|---|
| `name` | `bip-timesheet-mcp` | 进程名，后续 `pm2 logs bip-timesheet-mcp` 等命令用 |
| `script` | `./dist/index.js` | 启动入口（构建产物） |
| `args` | `--transport http` | 仅 HTTP 模式；服务检测到 pm2 环境会自动禁用 stdio，这里是显式保险 |
| `autorestart` | `true` | 崩溃自动重启 |
| `max_restarts` / `restart_delay` | `10` / `2000ms` | 异常重启上限与间隔，防崩溃循环 |
| `instances` / `exec_mode` | `1` / `fork` | 单实例进程 |
| `env.PORT` | `51889` | 服务端口（MCP 端点 `http://<IP>:51889/mcp`） |
| `out_file` / `error_file` | `./logs/out.log` / `./logs/err.log` | 日志文件（相对 `cwd`，即项目根） |
| `max_size` / `retain` | `10M` / `7` | 日志轮转：单文件上限 10MB，保留 7 天 |

> **为什么只跑 HTTP**：stdio 传输走子进程 stdout 的 JSON-RPC 通道，pm2 会捕获并重定向子进程 stdout 到日志文件，通道被污染导致 stdio 模式无法工作。因此 pm2 托管下只启用 HTTP。

## 4. 启动服务

```bash
cd E:\br\MCP\bip-timesheet-mcp
pm2 start ecosystem.config.cjs
```

输出会显示进程状态（`online`）。随后：

```bash
pm2 save        # 保存进程列表，供开机自启 pm2 resurrect 恢复（必做！见第 6 节）
```

## 5. 验证部署

| 检查项 | 命令 / 地址 | 预期 |
|---|---|---|
| 进程状态 | `pm2 list` | `bip-timesheet-mcp` 状态 `online`，重启次数合理 |
| 启动日志 | `pm2 logs bip-timesheet-mcp` | 出现 `streamable http 就绪` 与真实可达 IP |
| 健康检查 | `http://localhost:51889/health` | 返回 `{"ok":true, "python": "...", ...}` |
| 帮助页 | `http://localhost:51889/` | 页面展示连接方式、工具清单、技能下载 |
| 局域网连通 | 其他机器访问 `http://<服务器IP>:51889/mcp` | 可建立 MCP 连接 |

> 服务器 IP 从 `pm2 logs` 或帮助页获取（优先物理网卡 + 私有网段）。

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
| 停止并删除 | `pm2 delete bip-timesheet-mcp` 前先 `pm2 stop` |
| 清空日志 | `pm2 flush bip-timesheet-mcp` |

> 每次 `pm2 stop` / `pm2 delete` 后如需恢复开机自启，重新 `pm2 start ecosystem.config.cjs` 并 `pm2 save`。

## 8. 更新部署（代码升级）

```bash
cd E:\br\MCP\bip-timesheet-mcp
git pull                    # 拉取新代码（如使用 git）
npm install                 # 依赖有变更时
npm run build               # 重新编译 TypeScript
pm2 restart bip-timesheet-mcp
```

> Python 核心变更**无需重新 build**（直接运行）：重启服务即可生效。仅当 `python/requirements.txt` 变更时才重跑 `npm run setup`。

## 9. 故障排查

| 现象 | 排查步骤 |
|---|---|
| `pm2 list` 状态 `errored` / 反复重启 | `pm2 logs bip-timesheet-mcp --err` 看错误日志；确认已 `npm run build`（`dist/` 存在） |
| 端口被占用 | 修改 `ecosystem.config.cjs` 的 `env.PORT` 或环境变量 `PORT`，重启 |
| 健康检查失败 / `python` 路径不对 | 确认已 `npm run setup`；`/health` 会返回实际使用的 Python 路径，可用环境变量 `PYTHON_BIN` 指定解释器 |
| 局域网连不上 | 确认防火墙放行 `51889` 端口；用帮助页显示的真实 IP（非 localhost）连接 |
| 报工超时 | 默认单次 CLI 超时 300s，批量报工可设环境变量 `CLI_TIMEOUT_MS`（如 `600000`）后重启 |
| `pm2 resurrect` 恢复为空 | 确认执行过 `pm2 save`（见第 4 节） |
| pm2 命令找不到 | 见第 2 节 PATH 说明，用完整路径 `...\npm\pm2.cmd` |

## 10. 卸载 pm2（可选）

```bash
pm2 delete bip-timesheet-mcp   # 先从 pm2 移除服务
pm2 kill                       # 停止 pm2 守护进程
npm uninstall -g pm2           # 卸载
```

> 若已创建开机自启计划任务，一并删除：`schtasks /Delete /TN pm2-resurrect /F`。
