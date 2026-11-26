// 验 tools/set-prompt.mjs：提示词经过 TOML 往返后必须字节级不变
// 这个测试存在的原因：''' 多行字面量的尾部换行会被算进内容，
// 曾经因此把 15039 字符写成 15040，往上推 D1 时冷不起眼。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const WRANGLER = path.join(ROOT, "wrangler");
const OUT = path.join(WRANGLER, "wrangler.local.toml");

let pass = 0, fail = 0;
const fails = [];
const ok = (n, c, d) => (c ? pass++ : (fail++, fails.push(n + (d ? " :: " + d : ""))));

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

// 1. 跑生成器
execFileSync("node", [path.join(ROOT, "tools", "set-prompt.mjs")], { cwd: ROOT, stdio: "pipe" });
ok("生成文件存在", fs.existsSync(OUT));

const toml = fs.readFileSync(OUT, "utf8");

// 2. 从 TOML 里抠出 PROMPT（不引入 toml 依赖，手工解析 ''' 段）
const m = toml.match(/PROMPT = '''\n([\s\S]*?)'''/);
ok("能解析出 PROMPT", !!m);
const got = m ? m[1] : "";

// 3. 跟原文比
const raw = fs.readFileSync(path.join(ROOT, "prompt.txt"), "utf8").trim();
ok("字节数一致", Buffer.byteLength(got, "utf8") === Buffer.byteLength(raw, "utf8"),
   `${Buffer.byteLength(got, "utf8")} vs ${Buffer.byteLength(raw, "utf8")}`);
ok("字符数一致", got.length === raw.length, `${got.length} vs ${raw.length}`);
ok("sha256 一致", sha(got) === sha(raw), sha(got).slice(0, 16) + " vs " + sha(raw).slice(0, 16));
ok("没有多余尾部换行", !got.endsWith("\n\n"), JSON.stringify(got.slice(-10)));

// 4. 反引号不被破坏（这是整个工具存在的理由）
const backticks = (raw.match(/`/g) || []).length;
const gotBackticks = (got.match(/`/g) || []).length;
ok("反引号数量不变", backticks === gotBackticks, `${gotBackticks} vs ${backticks}`);

// 5. 生成的 toml 能标准解析（python tomllib）
let parsed = null;
try {
  const out = execFileSync("python3", ["-c", `
import tomllib, json, sys
d = tomllib.load(open("${OUT.replace(/\\/g, "/")}", "rb"))
print(json.dumps({"len": len(d["vars"]["PROMPT"]), "keys": list(d.keys())}))
`], { encoding: "utf8" });
  parsed = JSON.parse(out);
} catch (e) {
  parsed = null;
}
ok("标准 TOML 解析通过", !!parsed, "python3 tomllib 解析失败");
if (parsed) {
  ok("解析后长度正确", parsed.len === raw.length, `${parsed.len} vs ${raw.length}`);
  ok("有 vars 段", parsed.keys.includes("vars"));
}

// 6. 生成 file 里不该泄漏注释之外的东西
ok("生成的 toml 里 main 指向 src/", /^main = "src\//m.test(toml), "main 路径不对");

// 清理
try { fs.unlinkSync(OUT); } catch { /* ignore */ }
ok("清理临时文件", !fs.existsSync(OUT));

console.log("\n═══ 失败项 ═══");
if (!fails.length) console.log("(无)");
else fails.forEach((f) => console.log("  FAIL " + f));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
