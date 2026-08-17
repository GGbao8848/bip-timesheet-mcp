// 并发控制：
//   1) serializedByUser —— per-账号串行。同一 BIP 账号的调用排队执行，
//      保住 BIP「并发登录互踢」约束；不同账号之间并行，互不阻塞。
//   2) withConcurrencyLimit —— 全局并发上限。用信号量限制同时运行的 python
//      子进程数量，保护 MCP 部署机器的 CPU/内存（关注点仅在本机并发能力）。
//      上限由环境变量 MAX_CONCURRENT_CLI 控制，默认 20。
import { env } from "node:process";

// 惰性读取，运行时改 MAX_CONCURRENT_CLI 即时生效
function getMaxConcurrent(): number {
  const n = Number(env.MAX_CONCURRENT_CLI);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

// ── per-账号串行队列 ──
const userChains = new Map<string, Promise<unknown>>();

export function serializedByUser<T>(username: string | undefined, fn: () => Promise<T>): Promise<T> {
  const key = username?.trim() || "__anonymous__";
  const prev = userChains.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  // 链尾吞掉错误，避免一条失败影响后续排队
  userChains.set(key, run.then(() => undefined, () => undefined));
  return run;
}

// ── 全局并发上限（信号量） ──
let active = 0;
const waiters: (() => void)[] = [];

export function maxConcurrentCli(): number {
  return getMaxConcurrent();
}

export async function withConcurrencyLimit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= getMaxConcurrent()) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiters.shift()?.();
  }
}
