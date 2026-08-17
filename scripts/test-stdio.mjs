// stdio 冒烟测试：验证服务器能启动、11 个工具已注册、子进程调用链路通。
// 用法：npm run build && node scripts/test-stdio.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js", "--transport", "stdio"],
  cwd: root,
});

const client = new Client({ name: "stdio-test", version: "1.0" });
try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
  if (tools.length !== 11) {
    console.error("❌ 工具数量不是 11，请检查 src/index.ts");
    process.exit(1);
  }

  // 不传凭据调用 bip_preview：username/password 必填，应由 SDK 参数校验拦截并返回 isError
  const scan = await client.callTool({ name: "bip_preview", arguments: {} });
  const text = JSON.stringify(scan.content);
  console.log("bip_preview(无凭据) →", text.slice(0, 120));
  if (!scan.isError) {
    console.error("❌ 预期 bip_preview 无凭据时返回错误（参数校验拦截），实际不是。");
    process.exit(1);
  }

  console.log("✅ STDIO OK");
} finally {
  await client.close();
}
