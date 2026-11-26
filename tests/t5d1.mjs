import worker, { injectPrompt, __resetCache } from "../src/agentrouter-5-panel.js";
import { makeDB } from "./d1mock.mjs";

let pass = 0, fail = 0;
const fails = [];
const ok = (n, c, d) => (c ? pass++ : (fail++, fails.push(n + (d ? " :: " + d : ""))));

// ---- 上游 mock ----
let hits = [];
let nextStatus = 200;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  const body = init && init.body && typeof init.body === "string" ? init.body : "";
  hits.push({
    url,
    method: init?.method,
    ua: init?.headers?.get?.("user-agent"),
    apiKey: init?.headers?.get?.("x-api-key"),
    auth: init?.headers?.get?.("authorization"),
    te: init?.headers?.get?.("transfer-encoding"),
    body,
  });
  if (nextStatus !== 200) {
    const s = nextStatus;
    nextStatus = 200;
    return new Response(JSON.stringify({ error: "stub " + s }), {
      status: s,
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
    });
  }
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  });
};

const PROMPT = "YOU ARE MINE.\nLine two.";
const PW = "correct horse battery staple";

function mkEnv(over = {}) {
  __resetCache();
  const db = over.DB || makeDB({
    cfg: { main: JSON.stringify({
      prompt: PROMPT, mode: "append", ua: "test-ua/1.0",
      upstream: "https://up.example.com", suffix: "", suffixOn: false,
      keyStrategy: "sticky",
    }) },
    keys: [],
  });
  return {
    ADMIN_PASSWORD: PW,
    ACCESS_KEY: "sk-client-123",
    DB: db,
    ...over,
  };
}

async function call(path, opts = {}, env) {
  const e = env || mkEnv();
  const r = await worker.fetch(new Request("https://px.example.workers.dev" + path, opts), e);
  return r;
}

async function login(env) {
  const r = await call("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PW }),
  }, env);
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

// ═══════ 1. 未登录 ═══════
{
  const r = await call("/");
  const t = await r.text();
  ok("未登录 → 登录页", r.status === 200 && t.includes("password") && !t.includes(PROMPT));
}

// ═══════ 2. 登录 ═══════
{
  const r = await call("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "bad" }),
  });
  ok("错误密码 401", r.status === 401);
  ok("错误密码不下发 cookie", !r.headers.get("set-cookie"));
}
const env0 = mkEnv();
const cookie0 = await login(env0);
{
  const r = await call("/", { headers: { Cookie: cookie0 } }, env0);
  const t = await r.text();
  ok("登录后看得到提示词", t.includes("YOU ARE MINE"));
  ok("登录后看得到上游", t.includes("up.example.com"));
  ok("面板有四模式", t.includes('data-m="append"') && t.includes('data-m="last-user"'));
  ok("面板有前缀区", t.includes("访问前缀") && t.includes("随机生成"));
  ok("面板有密钥池区", t.includes("上游密钥池"));
}

// ═══════ 3. 会话安全 ═══════
{
  const r = await call("/", { headers: { Cookie: "ua_session=9999999999.xxx" } });
  ok("伪造 cookie 无效", !(await r.text()).includes(PROMPT));
}
{
  const env2 = mkEnv({ ADMIN_PASSWORD: "changed" });
  const r = await call("/", { headers: { Cookie: cookie0 } }, env2);
  ok("改密码后旧 cookie 失效", !(await r.text()).includes(PROMPT));
}

// ═══════ 4. 配置读写 ═══════
{
  const env = mkEnv();
  const ck = await login(env);
  const r = await call("/api/config", { headers: { Cookie: ck } }, env);
  const j = await r.json();
  ok("GET config 返回提示词", j.prompt === PROMPT);
  ok("GET config 返回后缀状态", j.suffixOn === false);

  const r2 = await call("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ prompt: "NEW", mode: "prepend" }),
  }, env);
  const j2 = await r2.json();
  ok("POST config 成功", r2.status === 200 && j2.ok);
  const stored = JSON.parse(env.DB._cfg.get("main"));
  ok("写进 D1", stored.prompt === "NEW" && stored.mode === "prepend");
  ok("未传字段保留", stored.upstream === "https://up.example.com");
}
{
  const r = await call("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: "HACK" }),
  });
  ok("未登录改配置 401", r.status === 401);
}

// ═══════ 5. 跨站 ═══════
{
  const env = mkEnv();
  const ck = await login(env);
  const r = await call("/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ck, Origin: "https://evil.example" },
    body: JSON.stringify({ prompt: "X" }),
  }, env);
  ok("跨站 POST 403", r.status === 403);
}

// ═══════ 6. 限速 ═══════
{
  const env = mkEnv();
  let last;
  for (let i = 0; i < 9; i++) {
    last = await call("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "7.7.7.7" },
      body: JSON.stringify({ password: "no" }),
    }, env);
  }
  ok("9 次失败 → 429", last.status === 429, "got " + last.status);
}

// ═══════ 7. 代理鉴权 ═══════
{
  const r = await call("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  ok("无 key 401", r.status === 401);
}
{
  hits = [];
  const r = await call("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", max_tokens: 5, system: "client-sys", messages: [{ role: "user", content: "hi" }] }),
  });
  ok("正确 key 200", r.status === 200);
  ok("转发到上游", hits.length === 1 && hits[0].url === "https://up.example.com/v1/messages");
  ok("UA 改写", hits[0].ua === "test-ua/1.0");
  const b = JSON.parse(hits[0].body);
  ok("提示词注入", JSON.stringify(b.system).includes("YOU ARE MINE"));
  ok("客户端 system 保留", JSON.stringify(b.system).includes("client-sys"));
  ok("响应头剥 content-encoding", !r.headers.get("content-encoding"));
}

// ═══════ 8. 访问前缀 ═══════
{
  const env = mkEnv();
  const ck = await login(env);

  // 先开前缀
  const r = await call("/api/suffix", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ suffix: "abc12345", suffixOn: true }),
  }, env);
  ok("设置前缀成功", r.status === 200);

  // 不带前缀 → 404，且不泄露任何东西
  const r2 = await call("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  const t2 = await r2.text();
  ok("无前缀 → 404", r2.status === 404, "got " + r2.status);
  ok("404 页不含提示词", !t2.includes("YOU ARE MINE"));
  ok("404 页不说是代理", !t2.includes("ua-proxy"));

  // 带前缀 → 正常
  hits = [];
  const r3 = await call("/abc12345/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  ok("带前缀 → 200", r3.status === 200, "got " + r3.status);
  ok("前缀被剥掉，上游收到干净路径", hits[0].url === "https://up.example.com/v1/messages", hits[0].url);

  // 错前缀 → 404
  const r4 = await call("/wrong999/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  ok("错前缀 404", r4.status === 404);

  // 面板不受前缀影响
  const r5 = await call("/", { headers: { Cookie: ck } }, env);
  ok("面板路径不受前缀影响", (await r5.text()).includes("YOU ARE MINE"));
}
{
  // 非法后缀被拒
  const env = mkEnv();
  const ck = await login(env);
  for (const bad of ["ab", "ABC", "a-b-c", "api", "health"]) {
    const r = await call("/api/suffix", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: ck },
      body: JSON.stringify({ suffix: bad, suffixOn: true }),
    }, env);
    ok("拒绝非法后缀 '" + bad + "'", r.status === 400, "got " + r.status);
  }
}

// ═══════ 9. 密钥池 ═══════
{
  const env = mkEnv();
  const ck = await login(env);

  for (const s of ["sk-aaa", "sk-bbb", "sk-ccc"]) {
    const r = await call("/api/keys", {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: ck },
      body: JSON.stringify({ action: "add", secret: s, label: "L-" + s.slice(-3) }),
    }, env);
    ok("添加密钥 " + s, r.status === 200);
  }

  const list = await (await call("/api/keys", { headers: { Cookie: ck } }, env)).json();
  ok("列表 3 个", list.keys.length === 3, String(list.keys.length));
  ok("secret 被掩码", list.keys.every((k) => !JSON.stringify(k).includes("sk-aaa")));
  ok("短密钥也完全打码", list.keys.every((k) => k.masked === "****"), JSON.stringify(list.keys.map((k) => k.masked)));
  ok("不返回 tail 字段", list.keys.every((k) => !("tail" in k)));
}
{
  // 同一客户端多次请求 → 钉同一个 key
  const env = mkEnv({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: "P", mode: "append", ua: "ua", upstream: "https://up.example.com", keyStrategy: "sticky" }) },
    keys: [{ secret: "sk-A" }, { secret: "sk-B" }, { secret: "sk-C" }],
  }) });
  hits = [];
  for (let i = 0; i < 5; i++) {
    await call("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
      body: JSON.stringify({ model: "x", messages: [] }),
    }, env);
  }
  const used = new Set(hits.map((h) => h.apiKey));
  ok("粘性：5 次请求只用 1 个 key", used.size === 1, [...used].join(","));
  ok("上游收到的是池里的 key", ["sk-A", "sk-B", "sk-C"].includes([...used][0]));
}
{
  // 429 → 换 key
  const env = mkEnv({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: "P", mode: "append", ua: "ua", upstream: "https://up.example.com", keyStrategy: "sticky" }) },
    keys: [{ secret: "sk-A" }, { secret: "sk-B" }, { secret: "sk-C" }],
  }) });
  hits = [];
  nextStatus = 429;
  const r = await call("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  ok("429 后自动换 key 并成功", r.status === 200, "got " + r.status + " hits=" + hits.length);
  ok("确实试了两个不同 key", new Set(hits.map((h) => h.apiKey)).size === 2);
}
{
  // 400 不换 key
  const env = mkEnv({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: "P", mode: "append", ua: "ua", upstream: "https://up.example.com", keyStrategy: "sticky" }) },
    keys: [{ secret: "sk-A" }, { secret: "sk-B" }],
  }) });
  hits = [];
  nextStatus = 400;
  const r = await call("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  ok("400 不换 key，直接透传", r.status === 400 && hits.length === 1, "status=" + r.status + " hits=" + hits.length);
}
{
  // 全挂 → 503
  const env = mkEnv({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: "P", mode: "append", ua: "ua", upstream: "https://up.example.com", keyStrategy: "sticky" }) },
    keys: [{ secret: "sk-A" }, { secret: "sk-B" }],
  }) });
  hits = [];
  globalThis.fetch = async (input, init) => {
    hits.push({ apiKey: init?.headers?.get?.("x-api-key") });
    return new Response(JSON.stringify({ error: "bad key" }), { status: 401, headers: { "content-type": "application/json" } });
  };
  const r = await call("/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  ok("全部 401 → 返回 401 透传", r.status === 401, "got " + r.status);
  ok("试了每个 key 一次", hits.length <= 2, "hits=" + hits.length);
  // 恢复 fetch
  globalThis.fetch = async (i, init) => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
}
{
  // first 策略
  const env = mkEnv({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: "P", mode: "append", ua: "ua", upstream: "https://up.example.com", keyStrategy: "first" }) },
    keys: [{ secret: "sk-1" }, { secret: "sk-2" }],
  }) });
  hits = [];
  globalThis.fetch = async (i, init) => {
    hits.push({ apiKey: init?.headers?.get?.("x-api-key") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  for (let n = 0; n < 3; n++) {
    await call("/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
      body: JSON.stringify({ model: "x", messages: [] }),
    }, env);
  }
  ok("first 策略永远用第一个", hits.every((h) => h.apiKey === "sk-1"));
}

// ═══════ 10. 密钥池空时透传 ═══════
{
  const env = mkEnv();
  hits = [];
  globalThis.fetch = async (i, init) => {
    hits.push({ apiKey: init?.headers?.get?.("x-api-key") });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  await call("/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "sk-client-123" },
    body: JSON.stringify({ model: "x", messages: [] }),
  }, env);
  ok("池空 → 透传客户端 key", hits[0].apiKey === "sk-client-123", hits[0].apiKey);
}

// ═══════ 11. health ═══════
{
  const env = mkEnv();
  // 匿名：只回存活，不吐家底
  const r = await call("/health", {}, env);
  const t = await r.text();
  ok("health 200", r.status === 200);
  ok("匿名 health 只回 ok", t === '{"ok":true}', t);
  ok("匿名 health 不泄露上游", !t.includes("up.example.com"));
  ok("匿名 health 不泄露提示词", !t.includes("YOU ARE MINE"));

  // 登录后：给完整信息
  const ck = await login(env);
  const r2 = await call("/health", { headers: { Cookie: ck } }, env);
  const j2 = await r2.json();
  ok("登录 health 报 keyCount", j2.keyCount === 0);
  ok("登录 health 报 db", j2.db === true);
  ok("登录 health 也不吐提示词正文", !JSON.stringify(j2).includes("YOU ARE MINE"));
}

// ═══════ 12. 注入四模式 ═══════
{
  for (const [m, chk] of [
    ["append", (b) => b.system.indexOf("client") < b.system.indexOf("[ua-proxy]")],
    ["prepend", (b) => b.system.indexOf("[ua-proxy]") < b.system.indexOf("client")],
    ["replace", (b) => !b.system.includes("client")],
  ]) {
    const b = { system: "client-sys", messages: [] };
    injectPrompt(b, "P", "/v1/messages", m);
    ok("mode " + m, chk(b));
  }
  const b4 = { messages: [{ role: "user", content: "hi" }] };
  injectPrompt(b4, "P", "/v1/chat/completions", "last-user");
  ok("mode last-user", b4.messages[0].content.includes("[ua-proxy]"));
}

// ═══════ 13. 长提示词完整往返 ═══════
{
  const big = "L".repeat(15039);
  const env = mkEnv({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: big, mode: "append", ua: "ua", upstream: "https://up.example.com" }) },
    keys: [],
  }) });
  const ck = await login(env);
  const r = await call("/api/config", { headers: { Cookie: ck } }, env);
  const j = await r.json();
  ok("15039 字符提示词完整读出", j.prompt.length === 15039, String(j.prompt.length));
  const panel = await (await call("/", { headers: { Cookie: ck } }, env)).text();
  ok("面板里提示词完整", (panel.match(/L/g) || []).length >= 15039);
}

// ═══════ 14. 幂等 ═══════
{
  const b = { system: "s", messages: [] };
  injectPrompt(b, "P", "/v1/messages", "append");
  const first = b.system;
  injectPrompt(b, "P", "/v1/messages", "append");
  ok("重复注入幂等", b.system === first);
}

console.log("\n═══ 失败项 ═══");
if (!fails.length) console.log("(无)");
else fails.forEach((f) => console.log("  FAIL " + f));
console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
