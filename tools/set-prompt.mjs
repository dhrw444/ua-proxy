// 从 prompt.txt 生成 wrangler/wrangler.local.toml（含提示词，不进版本库）
//
// 用法（在仓库任意位置跑都行）：
//   node tools/set-prompt.mjs              # 默认读 ./prompt.txt
//   node tools/set-prompt.mjs my.txt       # 指定提示词文件
//   npx wrangler deploy -c wrangler/wrangler.local.toml
//
// 提示词会被写进 TOML 的 [vars] PROMPT，用 '''...''' 字面量包住，
// 所以反引号和 ${ 都不用转义 —— 这正是它存在的理由。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

const PROMPT_FILE = process.argv[2] || path.join(ROOT, "prompt.txt");
const BASE_FILE = process.argv[3] || path.join(ROOT, "wrangler", "wrangler-3-env.toml");
const OUT_FILE = path.join(ROOT, "wrangler", "wrangler.local.toml");

if (!fs.existsSync(PROMPT_FILE)) {
  console.error("找不到提示词文件:", PROMPT_FILE);
  process.exit(1);
}
if (!fs.existsSync(BASE_FILE)) {
  console.error("找不到基础配置:", BASE_FILE);
  process.exit(1);
}

const raw = fs.readFileSync(PROMPT_FILE, "utf8").trim();

if (!raw) {
  console.error("提示词文件是空的");
  process.exit(1);
}

// TOML 的 ''' 字面量里唯一要防的是出现三个连续单引号
if (raw.includes("'''")) {
  console.error("提示词里有连续的三个单引号，TOML 字面量装不下。请先替换掉。");
  process.exit(1);
}

const base = fs.readFileSync(BASE_FILE, "utf8");

// 去掉已有的 [vars] 段（如果基础文件里有），再追加新的
const cleaned = base.replace(/\n\[vars\][\s\S]*$/m, "").trimEnd();

const out =
  cleaned +
  "\n\n# 由 tools/set-prompt.mjs 生成，不要手工改。改提示词请改 prompt.txt 后重跑。\n" +
  "[vars]\n" +
  "PROMPT = '''\n" +
  raw +
  "'''\n";

fs.writeFileSync(OUT_FILE, out, "utf8");

const bytes = Buffer.byteLength(raw, "utf8");
console.log("提示词  " + bytes + " 字节 / " + raw.length + " 字符");
console.log("已写入  " + OUT_FILE);
console.log("");
console.log("部署：");
console.log("  npx wrangler deploy -c " + path.relative(process.cwd(), OUT_FILE));
