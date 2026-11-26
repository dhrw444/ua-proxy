// 功能审计：把每个声称的功能单独立项，逐条验
import worker, { injectPrompt, __resetCache } from "../src/agentrouter-5-panel.js";
import { makeDB } from "./d1mock.mjs";

let pass = 0, fail = 0;
const rows = [];
const T = (group, name, cond, detail) => {
  if (cond) { pass++; rows.push(["✓", group, name, ""]); }
  else { fail++; rows.push(["✗", group, name, detail || ""]); }
};

let hits = [];
let upstreamStatus = 200;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.url;
  hits.push({
    url,
    ua: init?.headers?.get?.("user-agent"),
    apiKey: init?.headers?.get?.("x-api-key"),
    auth: init?.headers?.get?.("authorization"),
    body: typeof init?.body === "string" ? init.body : "",
  });
  const s = upstreamStatus;
  upstreamStatus = 200;
  return new Response(JSON.stringify({ stub: s }), {
    status: s,
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
  });
};

const PROMPT = "FULL PROMPT BODY";
const PW = "pw-12345678";
const AK = "sk-client";

function mkEnv(seed) {
  __resetCache();
  return {
    ADMIN_PASSWORD: PW,
    ACCESS_KEY: AK,
    DB: makeDB(seed || {
      cfg: { main: JSON.stringify({
        prompt: PROMPT, mode: "append", ua: "ua-test/1",
        upstream: "https://up.test", suffix: "", suffixOn: false, keyStrategy: "sticky",
      }) },
      keys: [],
    }),
  };
}
// 正确的一层：先建默认 env，再覆盖
function mkEnvWith(over = {}) {
  const base = mkEnv();
  return { ...base, ...over };
}
const call = (env, path, opts = {}) =>
  worker.fetch(new Request("https://w.test" + path, opts), env);

async function auth(env) {
  const r = await call(env, "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: PW }),
  });
  return (r.headers.get("set-cookie") || "").split(";")[0];
}

// ═════════ A. 面板基础 ═════════
{
  const e = mkEnv();
  const r = await call(e, "/");
  const t = await r.text();
  T("面板", "未登录显示登录页", r.status === 200 && t.includes('type="password"'));
  T("面板", "登录页不含提示词", !t.includes(PROMPT));

  const ck = await auth(e);
  const t2 = await (await call(e, "/", { headers: { Cookie: ck } })).text();
  T("面板", "登录后显示提示词", t2.includes(PROMPT));
  T("面板", "显示上游地址", t2.includes("up.test"));
  T("面板", "四个模式卡片都在", ["append", "prepend", "replace", "last-user"].every((m) => t2.includes(`data-m="${m}"`)));
  T("面板", "提示词文本框", t2.includes('id="prompt"'));
  T("面板", "UA 输入框", t2.includes('id="ua"'));
  T("面板", "上游输入框", t2.includes('id="up"'));
  T("面板", "策略下拉", t2.includes('id="strat"'));
  T("面板", "前缀输入框", t2.includes('id="sfx"'));
  T("面板", "随机生成按钮", t2.includes('id="gsfx"'));
  T("面板", "后缀启用开关", t2.includes('id="sfxon"'));
  T("面板", "密钥添加框", t2.includes('id="newkey"'));
  T("面板", "保存按钮", t2.includes('id="save"'));
  T("面板", "退出按钮", t2.includes('id="logout"'));
  T("面板", "/panel 别名可用", (await call(e, "/panel", { headers: { Cookie: ck } })).status === 200);
}

// ═════════ B. 登录鉴权 ═════════
{
  const e = mkEnv();
  const bad = await call(e, "/api/login", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "nope" }),
  });
  T("鉴权", "错误密码 401", bad.status === 401);
  T("鉴权", "错误密码不发 cookie", !bad.headers.get("set-cookie"));

  const ck = await auth(e);
  T("鉴权", "正确密码发 cookie", !!ck);

  const r = await call(e, "/", { headers: { Cookie: "ua_session=1.dead" } });
  T("鉴权", "伪造 cookie 无效", !(await r.text()).includes(PROMPT));

  const e2 = mkEnvWith({ ADMIN_PASSWORD: "other" });
  T("鉴权", "改密码旧 cookie 失效", !(await (await call(e2, "/", { headers: { Cookie: ck } })).text()).includes(PROMPT));

  T("鉴权", "无密码时永远登录页", !(await (await call(mkEnvWith({ ADMIN_PASSWORD: undefined }), "/")).text()).includes(PROMPT));

  const noCookie = await call(e, "/api/config");
  T("鉴权", "未登录读配置 401", noCookie.status === 401);
  const noCookie2 = await call(e, "/api/keys");
  T("鉴权", "未登录读密钥 401", noCookie2.status === 401);
  const noCookie3 = await call(e, "/api/suffix", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  T("鉴权", "未登录改前缀 401", noCookie3.status === 401);

  // 限速
  const e3 = mkEnv();
  let last;
  for (let i = 0; i < 9; i++) {
    last = await call(e3, "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "5.5.5.5" },
      body: JSON.stringify({ password: "x" }),
    });
  }
  T("鉴权", "9 次失败 → 429", last.status === 429, "got " + last.status);
}

// ═════════ C. CSRF ═════════
{
  const e = mkEnv();
  const ck = await auth(e);
  const r = await call(e, "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ck, Origin: "https://evil.com" },
    body: JSON.stringify({ prompt: "X" }),
  });
  T("CSRF", "跨站 POST 403", r.status === 403);
  const r2 = await call(e, "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ck, Origin: "https://w.test" },
    body: JSON.stringify({ prompt: "OK" }),
  });
  T("CSRF", "同源 POST 通过", r2.status === 200);
  const r3 = await call(e, "/api/config", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ prompt: "OK2" }),
  });
  T("CSRF", "无 Origin（curl）放行", r3.status === 200);
}

// ═════════ D. 配置 ═════════
{
  const e = mkEnv();
  const ck = await auth(e);
  const j = await (await call(e, "/api/config", { headers: { Cookie: ck } })).json();
  T("配置", "读出 prompt", j.prompt === PROMPT);
  T("配置", "读出 mode", j.mode === "append");
  T("配置", "读出 ua", j.ua === "ua-test/1");
  T("配置", "读出 upstream", j.upstream === "https://up.test");
  T("配置", "读出 keyStrategy", j.keyStrategy === "sticky");
  T("配置", "读出 suffixOn", j.suffixOn === false);

  for (const m of ["append", "prepend", "replace", "last-user"]) {
    const r = await call(e, "/api/config", {
      method: "POST", headers: { "content-type": "application/json", Cookie: ck },
      body: JSON.stringify({ mode: m }),
    });
    T("配置", "保存 mode=" + m, r.status === 200);
  }

  await call(e, "/api/config", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ keyStrategy: "first" }),
  });
  const j2 = await (await call(e, "/api/config", { headers: { Cookie: ck } })).json();
  T("配置", "保存 keyStrategy=first", j2.keyStrategy === "first");

  const bad = await call(e, "/api/config", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ upstream: "ftp://nope" }),
  });
  T("配置", "拒绝非 http upstream", bad.status === 400);

  const badMode = await call(e, "/api/config", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ mode: "bogus" }),
  });
  const j3 = await (await call(e, "/api/config", { headers: { Cookie: ck } })).json();
  T("配置", "非法 mode 被忽略", j3.mode !== "bogus");

  const e2 = mkEnvWith({ DB: undefined });
  const ck2 = await auth(e2);
  const r = await call(e2, "/api/config", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck2 },
    body: JSON.stringify({ prompt: "x" }),
  });
  T("配置", "无 D1 保存报 500", r.status === 500);
}

// ═════════ E. 前缀 ═════════
{
  const e = mkEnv();
  const ck = await auth(e);
  const set = await call(e, "/api/suffix", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ suffix: "abc12345", suffixOn: true }),
  });
  T("前缀", "设置成功", set.status === 200);

  const ok = await call(e, "/abc12345/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("前缀", "带前缀可调", ok.status === 200, "got " + ok.status);

  const bare = await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("前缀", "裸路径 404", bare.status === 404, "got " + bare.status);
  const bt = await bare.text();
  T("前缀", "404 页不泄露", !bt.includes(PROMPT) && !bt.toLowerCase().includes("ua-proxy"));

  const wrong = await call(e, "/zzz99999/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("前缀", "错前缀 404", wrong.status === 404);

  T("前缀", "面板不受前缀影响", (await call(e, "/", { headers: { Cookie: ck } })).status === 200);
  T("前缀", "/api/* 不受前缀影响", (await call(e, "/api/config", { headers: { Cookie: ck } })).status === 200);

  for (const bad of ["ab", "ABC", "a-b", "api", "health", "v1", "logout", ""]) {
    const r = await call(e, "/api/suffix", {
      method: "POST", headers: { "content-type": "application/json", Cookie: ck },
      body: JSON.stringify({ suffix: bad, suffixOn: true }),
    });
    T("前缀", `拒绝 '${bad}'`, r.status === 400, "got " + r.status);
  }

  // 换前缀，旧的失效
  await call(e, "/api/suffix", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ suffix: "new99999", suffixOn: true }),
  });
  const oldOne = await call(e, "/abc12345/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("前缀", "换前缀后旧地址失效", oldOne.status === 404);
  const newOne = await call(e, "/new99999/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("前缀", "新地址可用", newOne.status === 200);

  // 关掉前缀
  await call(e, "/api/suffix", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ suffix: "", suffixOn: false }),
  });
  const open = await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("前缀", "关掉后裸路径可用", open.status === 200, "got " + open.status);
}

// ═════════ F. 代理鉴权 ═════════
{
  const e = mkEnv();
  const r1 = await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("代理鉴权", "无 key 401", r1.status === 401);

  const r2 = await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "wrong" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("代理鉴权", "错 key 401", r2.status === 401);

  for (const [name, hdr] of [
    ["x-api-key", { "x-api-key": AK }],
    ["Bearer", { authorization: "Bearer " + AK }],
  ]) {
    hits = [];
    const r = await call(e, "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", ...hdr },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    T("代理鉴权", name + " 可通过", r.status === 200, "got " + r.status);
  }

  hits = [];
  const r3 = await call(e, "/v1/messages?key=" + AK, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("代理鉴权", "?key= 可通过", r3.status === 200, "got " + r3.status);
  T("代理鉴权", "?key= 不进上游 URL", !hits[0].url.includes("key="), hits[0].url);

  const e2 = mkEnvWith({ ACCESS_KEY: undefined });
  hits = [];
  const r4 = await call(e2, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("代理鉴权", "未设 ACCESS_KEY 时放行", r4.status === 200);
}

// ═════════ G. 注入 ═════════
{
  const e = mkEnv();

  for (const [m, chk] of [
    ["append", (s) => s.indexOf("CLIENT") < s.indexOf("[ua-proxy]")],
    ["prepend", (s) => s.indexOf("[ua-proxy]") < s.indexOf("CLIENT")],
    ["replace", (s) => !s.includes("CLIENT")],
  ]) {
    await call(e, "/api/config", {
      method: "POST", headers: { "content-type": "application/json", Cookie: await auth(e) },
      body: JSON.stringify({ mode: m }),
    });
    hits = [];
    await call(e, "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
      body: JSON.stringify({ model: "x", system: "CLIENT", messages: [] }),
    });
    const sys = JSON.stringify(JSON.parse(hits[0].body).system);
    T("注入", "mode=" + m + " 位置正确", chk(sys), sys.slice(0, 80));
    T("注入", "mode=" + m + " 提示词在", sys.includes(PROMPT));
  }

  await call(e, "/api/config", {
    method: "POST", headers: { "content-type": "application/json", Cookie: await auth(e) },
    body: JSON.stringify({ mode: "last-user" }),
  });
  hits = [];
  await call(e, "/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [{ role: "user", content: "hi" }] }),
  });
  T("注入", "chat 协议 last-user", hits[0].body.includes("[ua-proxy]"));

  await call(e, "/api/config", {
    method: "POST", headers: { "content-type": "application/json", Cookie: await auth(e) },
    body: JSON.stringify({ mode: "append" }),
  });
  hits = [];
  await call(e, "/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", instructions: "CLIENT-INS", input: [] }),
  });
  const ins = JSON.parse(hits[0].body).instructions;
  T("注入", "responses 协议 instructions", String(ins).includes(PROMPT) && String(ins).includes("CLIENT-INS"));

  hits = [];
  await call(e, "/v1/models/x:generateContent", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ contents: [] }),
  });
  T("注入", "gemini 协议 systemInstruction", JSON.parse(hits[0].body).systemInstruction?.parts?.[0]?.text?.includes(PROMPT));

  // UA 改写
  hits = [];
  await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("注入", "UA 被改写", hits[0].ua === "ua-test/1", hits[0].ua);

  // 空提示词不注入
  const e2 = mkEnvWith({ DB: makeDB({ cfg: { main: JSON.stringify({ prompt: "", mode: "append", ua: "u", upstream: "https://up.test" }) }, keys: [] }) });
  hits = [];
  await call(e2, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", system: "CLIENT", messages: [] }),
  });
  T("注入", "空提示词不注入", !hits[0].body.includes("[ua-proxy]"));

  // 幂等
  const b = { system: "s", messages: [] };
  injectPrompt(b, "P", "/v1/messages", "append");
  const first = b.system;
  injectPrompt(b, "P", "/v1/messages", "append");
  T("注入", "重复注入幂等", b.system === first);
}

// ═════════ H. 密钥池 ═════════
{
  const e = mkEnv();
  const ck = await auth(e);
  for (const s of ["sk-A", "sk-B", "sk-C"]) {
    const r = await call(e, "/api/keys", {
      method: "POST", headers: { "content-type": "application/json", Cookie: ck },
      body: JSON.stringify({ action: "add", secret: s, label: "名" + s.slice(-1) }),
    });
    T("密钥池", "添加 " + s, r.status === 200);
  }
  const list = await (await call(e, "/api/keys", { headers: { Cookie: ck } })).json();
  T("密钥池", "列表 3 个", list.keys.length === 3, String(list.keys.length));
  T("密钥池", "secret 打码", !JSON.stringify(list).includes("sk-A\""));
  const panel = await (await call(e, "/", { headers: { Cookie: ck } })).text();
  T("密钥池", "面板不显示明文", !panel.includes("sk-A") && !panel.includes("sk-B"));

  // 禁用
  const toggle = await call(e, "/api/keys", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ action: "toggle", id: 2 }),
  });
  T("密钥池", "停用成功", toggle.status === 200);
  const list2 = await (await call(e, "/api/keys", { headers: { Cookie: ck } })).json();
  T("密钥池", "停用后有 1 个 disabled", list2.keys.filter((k) => !k.enabled).length === 1);

  // 删除
  const del = await call(e, "/api/keys", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ action: "del", id: 3 }),
  });
  T("密钥池", "删除成功", del.status === 200);
  const list3 = await (await call(e, "/api/keys", { headers: { Cookie: ck } })).json();
  T("密钥池", "删完剩 2 个", list3.keys.length === 2, String(list3.keys.length));

  // 空 key 被拒
  const empty = await call(e, "/api/keys", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ action: "add", secret: "   " }),
  });
  T("密钥池", "空密钥被拒", empty.status === 400);
}

// ═════════ I. 密钥选择 ═════════
{
  const mkPool = (strategy) => mkEnvWith({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: "P", mode: "append", ua: "u", upstream: "https://up.test", keyStrategy: strategy }) },
    keys: [{ secret: "K1" }, { secret: "K2" }, { secret: "K3" }],
  }) });

  // 粘性
  const e = mkPool("sticky");
  hits = [];
  for (let i = 0; i < 5; i++) {
    await call(e, "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
  }
  T("选 key", "粘性：5 次只用一个", new Set(hits.map((h) => h.apiKey)).size === 1, [...new Set(hits.map((h) => h.apiKey))].join(","));

  // 不同客户端（共用同一个 ACCESS_KEY，靠 IP 区分）应分散到多个 key
  const e2 = mkPool("sticky");
  const used = new Set();
  for (let i = 0; i < 24; i++) {
    hits = [];
    await call(e2, "/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": AK, "CF-Connecting-IP": "10.0.0." + i },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
    if (hits[0]) used.add(hits[0].apiKey);
  }
  T("选 key", "不同客户端分散到多个 key", used.size >= 2, [...used].join(","));
  T("选 key", "同一 IP 换请求仍钉同一个", await (async () => {
    const e9 = mkPool("sticky");
    hits = [];
    for (let i = 0; i < 3; i++) {
      await call(e9, "/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": AK, "CF-Connecting-IP": "10.9.9.9" },
        body: JSON.stringify({ model: "x", messages: [] }),
      });
    }
    return new Set(hits.map((h) => h.apiKey)).size === 1;
  })());

  // 429 → 切
  const e3 = mkPool("sticky");
  hits = [];
  upstreamStatus = 429;
  const r = await call(e3, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("选 key", "429 后切 key 成功", r.status === 200, "got " + r.status);
  T("选 key", "429 试了两个 key", new Set(hits.map((h) => h.apiKey)).size === 2, String(hits.length));

  // 400 → 不切
  const e4 = mkPool("sticky");
  hits = [];
  upstreamStatus = 400;
  const r2 = await call(e4, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("选 key", "400 不切 key", r2.status === 400 && hits.length === 1, "status=" + r2.status + " hits=" + hits.length);

  // 500 → 不切
  const e5 = mkPool("sticky");
  hits = [];
  upstreamStatus = 500;
  const r3 = await call(e5, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("选 key", "500 不切 key", r3.status === 500 && hits.length === 1, "hits=" + hits.length);

  // first 策略
  const e6 = mkPool("first");
  hits = [];
  for (let i = 0; i < 3; i++) {
    await call(e6, "/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
      body: JSON.stringify({ model: "x", messages: [] }),
    });
  }
  T("选 key", "first 策略永远第一个", hits.every((h) => h.apiKey === "K1"), [...new Set(hits.map((h) => h.apiKey))].join(","));

  // 池空 → 透传客户端 key
  const e7 = mkEnv();
  hits = [];
  await call(e7, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("选 key", "池空透传客户端 key", hits[0].apiKey === AK, hits[0].apiKey);

  // 池有 key → 客户端的 key 不能到上游
  const e8 = mkPool("sticky");
  hits = [];
  await call(e8, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("选 key", "客户端 key 不到上游", hits[0].apiKey !== AK, hits[0].apiKey);
}

// ═════════ J. 响应处理 ═════════
{
  const e = mkEnv();
  hits = [];
  const r = await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("响应", "剥 content-encoding", !r.headers.get("content-encoding"));
  T("响应", "剥 content-length", !r.headers.get("content-length"));
  T("响应", "状态码透传", r.status === 200);

  const opt = await call(e, "/v1/messages", { method: "OPTIONS" });
  T("响应", "OPTIONS 204", opt.status === 204);
  T("响应", "CORS 头", !!opt.headers.get("access-control-allow-origin"));
}

// ═════════ K. 前缀不污染代理路径 ═════════
{
  const e = mkEnv();
  const ck = await auth(e);
  await call(e, "/api/suffix", {
    method: "POST", headers: { "content-type": "application/json", Cookie: ck },
    body: JSON.stringify({ suffix: "q1w2e3r4", suffixOn: true }),
  });
  hits = [];
  await call(e, "/q1w2e3r4/v1/messages?a=1&b=2", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", messages: [] }),
  });
  T("路径", "前缀剥离后路径干净", hits[0].url === "https://up.test/v1/messages?a=1&b=2", hits[0].url);
}

// ═════════ L. health ═════════
{
  const e = mkEnv();
  const anon = await (await call(e, "/health")).text();
  T("health", "匿名只回 ok", anon.trim() === '{"ok":true}', anon);
  const ck = await auth(e);
  const full = await (await call(e, "/health", { headers: { Cookie: ck } })).json();
  T("health", "登录报 db", full.db === true);
  T("health", "登录报 keyCount", full.keyCount === 0);
  T("health", "登录报 suffixOn", typeof full.suffixOn === "boolean");
  T("health", "不吐提示词正文", !JSON.stringify(full).includes(PROMPT));
}

// ═════════ M. 长提示词 ═════════
{
  const big = "⏎".repeat(5000) + "L".repeat(15039);
  const e = mkEnvWith({ DB: makeDB({
    cfg: { main: JSON.stringify({ prompt: big, mode: "append", ua: "u", upstream: "https://up.test" }) },
    keys: [],
  }) });
  const ck = await auth(e);
  const j = await (await call(e, "/api/config", { headers: { Cookie: ck } })).json();
  T("长文本", "读回长度一致", j.prompt.length === big.length, `${j.prompt.length} vs ${big.length}`);
  T("长文本", "内容一致", j.prompt === big);
  hits = [];
  await call(e, "/v1/messages", {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": AK },
    body: JSON.stringify({ model: "x", system: "C", messages: [] }),
  });
  T("长文本", "完整注入", JSON.parse(hits[0].body).system.includes(big.slice(-100)));
}

// 输出表格
console.log("");
let group = "";
for (const [mark, g, name, detail] of rows) {
  if (g !== group) { console.log("\n■ " + g); group = g; }
  console.log("  " + mark + " " + name + (detail ? "  ← " + detail : ""));
}
console.log("\n" + "═".repeat(50));
console.log(pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
