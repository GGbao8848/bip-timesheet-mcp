// 一键部署脚本：创建 python/.venv 并安装核心依赖。
// 用法：npm run setup   （可选 PYTHON_BIN 指定解释器，如 PYTHON_BIN=C:\...\python.exe npm run setup）
import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const venvDir = join(root, "python", ".venv");
const reqFile = join(root, "python", "requirements.txt");
const venvPy = join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");

function q(p) {
  return `"${p}"`;
}

function findPython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const candidates = [
    join(home, ".local", "bin", "python3.12.exe"),
    join(home, ".local", "bin", "python3.11.exe"),
    "python3.11",
    "python3",
    "python",
  ];
  for (const c of candidates) {
    const r = spawnSync(c, ["--version"], { stdio: "ignore" });
    if (r.status === 0) return c;
  }
  throw new Error(
    "未找到可用的 Python。请安装 Python 3.10+，或在环境变量 PYTHON_BIN 中指定 python.exe 的完整路径。"
  );
}

// 探测 uv：先按常见安装路径（含 Windows 上 ~/.local/bin 不在 PATH 的情况），再回退 PATH。
function findUv() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const exe = process.platform === "win32" ? ".exe" : "";
  const candidates = [
    join(home, ".local", "bin", `uv${exe}`),
    join(home, ".cargo", "bin", `uv${exe}`),
    "uv",
  ];
  for (const c of candidates) {
    try {
      execSync(`${c} --version`, { stdio: "ignore" });
      return c;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return null;
}

// 判断 venv 里的 python 是否自带 pip（uv 建的 venv 默认不装 pip）。
function hasPip() {
  const r = spawnSync(venvPy, ["-m", "pip", "--version"], { stdio: "ignore" });
  return r.status === 0;
}

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}

console.log("=== BIP 工时填报 MCP（bip-timesheet-mcp）· 环境准备 ===");

const py = findPython();
const uv = findUv();
console.log(`Python 解释器: ${py}`);
console.log(`uv: ${uv || "未找到（回退 pip 安装）"}`);

if (existsSync(venvPy)) {
  console.log("python/.venv 已存在，跳过创建。");
} else {
  mkdirSync(venvDir, { recursive: true });
  if (uv) {
    console.log("使用 uv 创建虚拟环境...");
    run(`${uv} venv ${q(venvDir)}`);
  } else {
    console.log("使用 python -m venv 创建虚拟环境...");
    run(`${q(py)} -m venv ${q(venvDir)}`);
  }
}

console.log("安装依赖...");
if (uv) {
  run(`${uv} pip install --python ${q(venvPy)} -r ${q(reqFile)}`);
} else {
  // 无 uv 且 venv 缺 pip（例如之前用 uv 建过 venv）→ 用 ensurepip 补装
  if (!hasPip()) {
    console.log("venv 内无 pip，尝试 ensurepip...");
    run(`${q(venvPy)} -m ensurepip`);
  }
  run(`${q(venvPy)} -m pip install --upgrade pip`);
  run(`${q(venvPy)} -m pip install -r ${q(reqFile)}`);
}

console.log("\n✅ 环境就绪。");
console.log(`   venv Python: ${venvPy}`);
console.log("   如需自定义解释器，设置环境变量 PYTHON_BIN 后重新运行。");
