// pm2 托管配置：`pm2 start ecosystem.config.cjs`
// 说明：服务已内置 pm2 适配 —— 检测到 pm2 环境（NODE_APP_INSTANCE）时自动禁用 stdio、
// 仅启用 HTTP（stdio 的 JSON-RPC 通道会被 pm2 的 stdout 捕获污染）。这里的 args
// 是显式保险；即使去掉 args，直接 `pm2 start dist/index.js` 也能正确只跑 HTTP。
module.exports = {
  apps: [
    {
      name: "bip-timesheet-mcp",
      script: "./dist/index.js",
      cwd: __dirname,
      args: "--transport http",
      interpreter: "node",
      // 崩溃/异常自动重启
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
      kill_timeout: 5000,
      // 单实例
      instances: 1,
      exec_mode: "fork",
      env: {
        PORT: "51889",
      },
      // 日志按时间轮转（保留 7 天，单文件上限 10MB）
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      merge_logs: true,
      time: true,
      max_size: "10M",
      retain: 7,
    },
  ],
};
