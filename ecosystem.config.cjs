// pm2 托管配置：`pm2 start ecosystem.config.cjs`
// 说明：本服务为纯 CJS Node（src/index.js），无编译步骤；pm2 直接运行源码。
// 依赖 .env（首次启动自动生成并写回 SESSION_SECRET）。
module.exports = {
  apps: [
    {
      name: "bip-timesheet-mcp",
      script: "./src/index.js",
      cwd: __dirname,
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
        NODE_ENV: "production",
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
