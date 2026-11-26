// 真 TCP 端到端：真起上游、真挂 worker，跑完整链路
import http from "node:http";
import zlib from "node:zlib";
import worker from "../src/agentrouter-5-panel.js";
import { makeDB } from "./d1mock.mjs";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

let pass = 0, fail = 0;
const fails = [];
const ok = (n, c, d) => (c ? pass++ : (fail++, fails.push(n + (d ? " :: " + d : ""))));

let upstreamHits = [];
const upstream = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamHits.push({
      url: req.url,
      ua: req.headers["user-agent"],
      te: req.headers["transfer-encoding"],
      cl: req.headers["content-length"],
      apiKey: req.headers["x-api-key"],
      body,
    });
    if (req.url.includes("sse")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: one\n\n");
      setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 30);
      return;
    }
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify({ ok: true })));
    res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(gz.length) });
    res.end(gz);
  });
});

const HERE = path.dirname(fileURLToPath(import.meta.url));
const prompt = fs.readFileSync(path.join(HERE, "..", "prompt.txt"), "utf8");

const db = makeDB({
  cfg: { main: JSON.stringify({
    prompt, mode: "prepend", ua: "claude-cli/2.0.0 (external, cli)",
    upstream: "", suffix: "abc12345", suffixOn: true, keyStrategy: "sticky",
  }) },
  keys: [{ secret: "sk-UPSTREAM-1", label: "主" }, { secret: "sk-UPSTREAM-2", label: "备" }],
});

let envRef = null;
const proxy = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const buf = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const init = { method: req.method, headers };
  if (buf.length) init.body = buf;
  let out;
  try {
    out = await worker.fetch(
      new Request("http://127.0.0.1:" + proxy.address().port + req.url, init),
      envRef
    );
  } catch (e) {
    res.writeHead(500); res.end("threw: " + e.message + "\n" + e.stack); return;
  }
  const h = {};
  out.headers.forEach((v, k) => (h[k] = v));
  res.writeHead(out.status, h);
  res.end(out.body ? Buffer.from(await out.arrayBuffer()) : "");
});

const listen = (s, p = 0) => new Promise((r) => s.listen(p, "127.0.0.1", () => r(s.address().port)));
const upPort = await listen(upstream);
const pxPort = await listen(proxy);
const BASE = "http://127.0.0.1:" + pxPort;

// 上游地址依赖端口，回填
db._cfg.set("main", JSON.stringify({
  prompt, mode: "prepend", ua: "claude-cli/2.0.0 (external, cli)",
  upstream: "http://127.0.0.1:" + upPort, suffix: "abc12345", suffixOn: true, keyStrategy: "sticky",
}));

envRef = { ADMIN_PASSWORD: "pw123456", ACCESS_KEY: "sk-client", DB: db };

async function hit(path, opts = {}) {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, headers: r.headers, text: await r.text() };
}

console.log("上游 " + upPort + " / 代理 " + pxPort + "\n");

// 1. 登录
let cookie = "";
{
  const r = await hit("/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "pw123456" }),
  });
  ok("真 TCP 登录", r.status === 200, "got " + r.status);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
}

// 2. 面板显示 15039 字符提示词
{
  const r = await hit("/", { headers: { cookie } });
  ok("面板 200", r.status === 200);
  ok("面板含提示词开头", r.text.includes("Little Code Sauce") || r.text.length > 20000, "len=" + r.text.length);
  ok("面板显示前缀 abc12345", r.text.includes("abc12345"));
  ok("面板列出 2 个密钥", r.text.includes("#1") && r.text.includes("#2"));
  ok("面板不泄露明文密钥", !r.text.includes("sk-UPSTREAM-1"));
}

// 3. 无前缀 → 404
{
  const r = await hit("/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  ok("无前缀 404", r.status === 404, "got " + r.status);
  ok("404 不泄露", !r.text.includes("ua-proxy") && !r.text.includes("Little Code"));
}

// 4. 带前缀 + key → 代理成功
upstreamHits = [];
const BIG = "y".repeat(40000);
{
  const payload = JSON.stringify({
    model: "x", max_tokens: 10, system: "client-sys",
    messages: [{ role: "user", content: BIG }],
  });
  const r = await hit("/abc12345/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client" },
    body: payload,
  });
  ok("带前缀代理 200", r.status === 200, "got " + r.status + " " + r.text.slice(0, 120));
  ok("上游被命中", upstreamHits.length === 1);
  const u = upstreamHits[0] || {};
  ok("路径干净", u.url === "/v1/messages", u.url);
  ok("UA 改写", u.ua === "claude-cli/2.0.0 (external, cli)", u.ua);
  ok("不转发 transfer-encoding", !u.te, "te=" + u.te);
  ok("上游收到池里的 key", u.apiKey === "sk-UPSTREAM-1" || u.apiKey === "sk-UPSTREAM-2", u.apiKey);
  ok("客户端 key 没到上游", u.apiKey !== "sk-client");
  ok("40KB body 完整", (u.body || "").length > 40000, "len=" + (u.body || "").length);
  const b = JSON.parse(u.body || "{}");
  const sys = JSON.stringify(b.system || "");
  ok("15039 字符提示词真的注入了", sys.length > 15000, "sys len=" + sys.length);
  ok("prepend：提示词在客户端 system 之前", sys.indexOf("[ua-proxy]") < sys.indexOf("client-sys"));
  ok("响应头剥 content-encoding", !r.headers.get("content-encoding"));
}

// 5. 同一客户端粘同一个 key
upstreamHits = [];
for (let i = 0; i < 4; i++) {
  await hit("/abc12345/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
}
{
  const used = new Set(upstreamHits.map((h) => h.apiKey));
  ok("粘性：4 次只用 1 个 key", used.size === 1, [...used].join(","));
}

// 6. ?key= 被剥离，不进上游 URL
upstreamHits = [];
await hit("/abc12345/v1/messages?key=sk-client", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "x", messages: [] }),
});
ok("?key= 从上游 URL 剥掉", upstreamHits[0].url === "/v1/messages", upstreamHits[0].url);

// 7. 无 ACCESS_KEY → 401
{
  const r = await hit("/abc12345/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  ok("无 ACCESS_KEY → 401", r.status === 401, "got " + r.status);
}

// 8. health：匿名只回存活
{
  const r = await hit("/health");
  ok("匿名 health 200", r.status === 200);
  ok("匿名 health 只回 ok", r.text.trim() === '{"ok":true}', r.text.trim());
  ok("匿名 health 不泄露上游端口", !r.text.includes(String(upPort)));

  const r2 = await hit("/health", { headers: { cookie } });
  const j2 = JSON.parse(r2.text);
  ok("登录 health 报 keyCount=2", j2.keyCount === 2, String(j2.keyCount));
  ok("登录 health 报 suffixOn", j2.suffixOn === true);
  ok("登录 health 不吐提示词正文", !r2.text.includes("Little Code"));
}

// 9. 改配置 → 立刻生效
{
  const r = await hit("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ prompt: "SHORT-NEW-PROMPT", mode: "append" }),
  });
  ok("改配置 200", r.status === 200, r.text.slice(0, 100));
  upstreamHits = [];
  await hit("/abc12345/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  const b = JSON.parse(upstreamHits[0].body);
  ok("新提示词立刻生效", JSON.stringify(b.system).includes("SHORT-NEW-PROMPT"));
  ok("append 位置正确", JSON.stringify(b.system).indexOf("[ua-proxy]") > 0);
}

// 10. 关掉前缀 → 裸路径可用
{
  await hit("/api/suffix", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ suffix: "", suffixOn: false }),
  });
  upstreamHits = [];
  const r = await hit("/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  ok("关前缀后裸路径可用", r.status === 200, "got " + r.status);
}

// 11. SSE 透传
{
  const r = await hit("/v1/stream/sse", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client" },
    body: JSON.stringify({ model: "x", stream: true, messages: [] }),
  });
  ok("SSE 200", r.status === 200);
  ok("SSE 两帧都在", r.text.includes("data: one") && r.text.includes("data: two"), JSON.stringify(r.text).slice(0, 100));
}

// 12. 登出
{
  const r = await fetch(BASE + "/logout", { redirect: "manual" });
  ok("登出 302", r.status === 302);
  ok("登出清 cookie", (r.headers.get("set-cookie") || "").includes("Max-Age=0"));
}

console.log("\n═══ 失败项 ═══");
if (!fails.length) console.log("(无)");
else fails.forEach((f) => console.log("  FAIL " + f));
console.log("\n" + pass + " passed, " + fail + " failed");

upstream.close();
proxy.close();
process.exit(fail ? 1 : 0);
