// 并发控制单元验证（不依赖网络）：
//   1) 同账号串行 —— 同一 BIP 账号的两个调用排队执行（BIP 互踢约束）
//   2) 不同账号并行 —— 互不阻塞
//   3) 全局并发上限 —— 同时运行的 python 进程数 ≤ MAX_CONCURRENT_CLI
// 用法：npm run build && node scripts/test-concurrency.mjs
import { serializedByUser, withConcurrencyLimit, maxConcurrentCli } from "../dist/queue.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let running = 0;
let maxRunning = 0;
async function work(ms) {
  running++;
  maxRunning = Math.max(maxRunning, running);
  await sleep(ms);
  running--;
}
function reset() {
  running = 0;
  maxRunning = 0;
}

let failed = 0;
const report = (name, ok, detail) => {
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " | " + detail : ""}`);
  if (!ok) failed++;
};

// 1. 同账号串行
reset();
const t0 = Date.now();
await Promise.all([
  serializedByUser("u1", () => work(100)),
  serializedByUser("u1", () => work(100)),
]);
const dSame = Date.now() - t0;
report(
  "同账号串行",
  dSame >= 190,
  `两个 100ms 任务总耗时 ${dSame}ms，maxRunning=${maxRunning}（期望 ≥190ms 且 maxRunning=1）`
);

// 2. 不同账号并行
reset();
const t1 = Date.now();
await Promise.all([
  serializedByUser("u1", () => work(120)),
  serializedByUser("u2", () => work(120)),
  serializedByUser("u3", () => work(120)),
]);
const dPara = Date.now() - t1;
report(
  "不同账号并行",
  dPara <= 200 && maxRunning === 3,
  `三个账号各 120ms 任务总耗时 ${dPara}ms，maxRunning=${maxRunning}（期望 ~120ms 且 maxRunning=3）`
);

// 3. 全局并发上限（惰性读取，运行时设 env 生效）
reset();
process.env.MAX_CONCURRENT_CLI = "2";
const t2 = Date.now();
await Promise.all(Array.from({ length: 6 }, (_, i) => withConcurrencyLimit(() => work(50))));
const dLimit = Date.now() - t2;
delete process.env.MAX_CONCURRENT_CLI;
report(
  "全局并发上限=2",
  maxRunning <= 2 && dLimit >= 140,
  `6×50ms 任务并发=2 总耗时 ${dLimit}ms，maxRunning=${maxRunning}（期望 ~150ms 且 ≤2）`
);

console.log("当前 maxConcurrentCli =", maxConcurrentCli());
console.log(failed === 0 ? "=== 并发单元验证全部通过 ===" : `=== ${failed} 项失败 ==="`);
process.exit(failed === 0 ? 0 : 1);
