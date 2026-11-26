// agentrouter-5-panel.js
// Cloudflare Worker | ES Module
// 一个 Worker 干四件事：代理 / 内嵌管理面板 / 配置存 D1 / 聚合上游密钥
//
// ── 部署 ──────────────────────────────────────────────────
//   wrangler d1 create ua-proxy
//     把返回的 database_id 填进 wrangler-5-panel.toml
//   wrangler d1 execute ua-proxy --remote --file=./schema.sql
//   wrangler secret put ADMIN_PASSWORD     # 面板登录密码（必填）
//   wrangler secret put ACCESS_KEY         # 客户端调代理用的 key（必填）
//   wrangler secret put SESSION_SECRET     # 可选，会话签名用，不设则用密码
//   wrangler deploy
//
// ── 路由 ──────────────────────────────────────────────────
//   GET  /                 面板（未登录显示登录页）
//   POST /api/login        校验密码，发签名 Cookie
//   GET  /logout           清 Cookie
//   GET  /api/config       读配置
//   POST /api/config       存配置
//   GET  /api/keys         列出上游密钥（secret 打码）
//   POST /api/keys         增删改密钥
//   POST /api/suffix       生成/修改访问前缀
//   GET  /health           健康检查
//   /<suffix>/v1/messages  代理（suffix 开启时必须有前缀）
//   *                      其余按 suffix 规则判定
//
// ── 为什么全用 D1 不用 KV ─────────────────────────────────
//   KV 免费版：10 万读/天、1000 写/天、同一键 1 次/秒、最终一致
//   D1 免费版：500 万行读/天、10 万行写/天、无秒级限制、强一致
//   面板连点两次保存，KV 会失败，D1 不会。

const DEFAULT_UA = "claude-cli/2.0.0 (external, cli)";
const DEFAULT_UP = "https://api.xingchiapi.com";
const MARK = "[ua-proxy]";
const VALID_MODES = ["append", "prepend", "replace", "last-user"];
const SESSION_TTL = 7 * 24 * 3600; // 秒

// 配置缓存 TTL。D1 查询有 ~100ms 冷启动，缓存住就不用每请求都打。
// 副作用：改配置后其他 isolate 最长这么久才知道。
const CFG_TTL = 30000;

// ═════════════════════════════════════════════════════════════
// 工具函数
// ═════════════════════════════════════════════════════════════

function joinText(a, b) {
  if (!a) return b;
  return a + "\n\n" + b;
}

function hasMark(s) {
  if (typeof s === "string") return s.includes(MARK);
  if (Array.isArray(s)) {
    return s.some((b) => b && typeof b.text === "string" && b.text.includes(MARK));
  }
  return false;
}

function sysText(sys) {
  if (typeof sys === "string") return sys;
  if (Array.isArray(sys)) {
    return sys.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("\n");
  }
  if (sys && Array.isArray(sys.parts)) {
    return sys.parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
  }
  return "";
}

function family(pathname, body) {
  const p = (pathname || "").toLowerCase();
  if (p.includes("/chat/completions")) return "chat";
  if (p.includes("generatecontent")) return "gemini";
  if (p.includes("/messages")) return "anthropic";
  if (p.includes("/responses")) return "responses";

  if (Array.isArray(body?.contents)) return "gemini";
  if (body?.systemInstruction) return "gemini";
  if (typeof body?.instructions === "string") return "responses";
  if (Object.prototype.hasOwnProperty.call(body || {}, "system")) return "anthropic";
  if (Array.isArray(body?.messages)) {
    const hasSys = body.messages.some((m) => m && m.role === "system");
    if (!hasSys && body.max_tokens !== undefined) return "anthropic";
    return "chat";
  }
  return "unknown";
}

// ═════════════════════════════════════════════════════════════
// 提示词注入（与 2-full 完全一致，已在 120 项测试中验证）
// ═════════════════════════════════════════════════════════════

function anthropicWrite(body, text, mode) {
  const sys = body.system;
  if (mode === "replace") {
    body.system = text;
    return true;
  }
  if (Array.isArray(sys)) {
    if (mode === "prepend") sys.unshift({ type: "text", text });
    else sys.push({ type: "text", text });
    return true;
  }
  if (typeof sys === "string") {
    body.system = mode === "prepend" ? text + "\n\n" + sys : joinText(sys, text);
    return true;
  }
  body.system = text;
  return true;
}

function chatWrite(body, text, mode) {
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return false;

  const first = msgs[0];
  const hasSys = first && first.role === "system";

  if (mode === "replace") {
    if (hasSys) msgs.shift();
    msgs.unshift({ role: "system", content: text });
    return true;
  }

  if (!hasSys) {
    msgs.unshift({ role: "system", content: text });
    return true;
  }

  if (Array.isArray(first.content)) {
    if (mode === "prepend") first.content.unshift({ type: "text", text });
    else first.content.push({ type: "text", text });
  } else if (typeof first.content === "string") {
    first.content = mode === "prepend" ? text + "\n\n" + first.content : joinText(first.content, text);
  } else {
    first.content = text;
  }
  return true;
}

function responsesWrite(body, text, mode) {
  if (mode === "replace") {
    body.instructions = text;
    return true;
  }
  const cur = body.instructions;
  body.instructions = mode === "prepend" ? text + "\n\n" + (cur || "") : joinText(cur, text);
  return true;
}

function geminiWrite(body, text, mode) {
  const si = body.systemInstruction;
  if (mode === "replace") {
    body.systemInstruction = { parts: [{ text }] };
    return true;
  }
  if (si && Array.isArray(si.parts)) {
    if (mode === "prepend") si.parts.unshift({ text });
    else si.parts.push({ text });
    return true;
  }
  if (si && typeof si.parts === "string") {
    si.parts = [{ text: mode === "prepend" ? text + "\n\n" + si.parts : joinText(si.parts, text) }];
    return true;
  }
  body.systemInstruction = { parts: [{ text }] };
  return true;
}

function lastUserWrite(body, text, fam) {
  if (fam === "gemini") {
    const cs = body.contents;
    if (!Array.isArray(cs) || cs.length === 0) {
      body.contents = [{ role: "user", parts: [{ text }] }];
      return true;
    }
    for (let i = cs.length - 1; i >= 0; i--) {
      const c = cs[i];
      if (!c || c.role !== "user") continue;
      if (Array.isArray(c.parts)) c.parts.push({ text });
      else c.parts = [{ text }];
      return true;
    }
    cs.push({ role: "user", parts: [{ text }] });
    return true;
  }

  const msgs = body.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) {
    body.messages = [{ role: "user", content: text }];
    return true;
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role !== "user") continue;
    if (Array.isArray(m.content)) m.content.push({ type: "text", text });
    else if (typeof m.content === "string") m.content = joinText(m.content, text);
    else m.content = text;
    return true;
  }
  msgs.push({ role: "user", content: text });
  return true;
}

function lastUserText(body, fam) {
  if (fam === "gemini") {
    const cs = body.contents;
    if (!Array.isArray(cs)) return "";
    for (let i = cs.length - 1; i >= 0; i--) {
      if (cs[i] && cs[i].role === "user") return sysText({ parts: cs[i].parts });
    }
    return "";
  }
  const msgs = body.messages;
  if (!Array.isArray(msgs)) return "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i] && msgs[i].role === "user") {
      const c = msgs[i].content;
      return typeof c === "string" ? c : sysText(c);
    }
  }
  return "";
}

export function injectPrompt(body, rawPrompt, pathname = "", mode = "append") {
  if (!rawPrompt || typeof rawPrompt !== "string" || !rawPrompt.trim()) return false;
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;

  const m = VALID_MODES.includes(mode) ? mode : "append";
  const text = MARK + "\n" + rawPrompt.trim();
  const fam = family(pathname, body);

  if (m !== "replace") {
    if (m === "last-user") {
      if (lastUserText(body, fam).includes(MARK)) return false;
    } else {
      if (hasMark(body.system)) return false;
      if (hasMark(body.systemInstruction)) return false;
      if (typeof body.instructions === "string" && hasMark(body.instructions)) return false;
      const f = Array.isArray(body.messages) ? body.messages[0] : null;
      if (f && f.role === "system" && hasMark(f.content)) return false;
    }
  }

  if (m === "last-user") return lastUserWrite(body, text, fam);

  switch (fam) {
    case "chat":
      return chatWrite(body, text, m);
    case "gemini":
      return geminiWrite(body, text, m);
    case "responses":
      return responsesWrite(body, text, m);
    case "anthropic":
      return anthropicWrite(body, text, m);
    default:
      return false;
  }
}

// ═════════════════════════════════════════════════════════════
// D1：配置读写
// ═════════════════════════════════════════════════════════════

// isolate 级缓存。丢了就重新查，代价只是一次 D1 读。
let CFG_CACHE = null;
let CFG_EXP = 0;

const CFG_DEFAULT_MAIN = {
  prompt: "",
  mode: "append",
  ua: DEFAULT_UA,
  upstream: DEFAULT_UP,
  suffix: "",
  suffixOn: false,
  keyStrategy: "sticky",
};

function normMain(o) {
  const c = { ...CFG_DEFAULT_MAIN };
  if (!o || typeof o !== "object") return c;
  if (typeof o.prompt === "string") c.prompt = o.prompt;
  if (VALID_MODES.includes(o.mode)) c.mode = o.mode;
  if (typeof o.ua === "string" && o.ua.trim()) c.ua = o.ua.trim();
  if (typeof o.upstream === "string" && o.upstream.trim()) {
    c.upstream = o.upstream.trim().replace(/\/+$/, "");
  }
  if (typeof o.suffix === "string") c.suffix = o.suffix;
  c.suffixOn = o.suffixOn === true;
  if (o.keyStrategy === "first" || o.keyStrategy === "sticky") c.keyStrategy = o.keyStrategy;
  return c;
}

async function loadConfig(env) {
  const now = Date.now();
  if (CFG_CACHE && now < CFG_EXP) return CFG_CACHE;

  let main = null;
  if (env.DB) {
    try {
      const row = await env.DB.prepare("SELECT v FROM cfg WHERE k = ?").bind("main").first();
      if (row && row.v) main = JSON.parse(row.v);
    } catch {
      main = null;
    }
  }

  const c = normMain(main);

  // env 覆盖 D1：临时改一行不用开面板
  if (env.MODE && VALID_MODES.includes(String(env.MODE).toLowerCase().trim())) {
    c.mode = String(env.MODE).toLowerCase().trim();
  }
  if (env.UA && String(env.UA).trim()) c.ua = String(env.UA).trim();
  if (env.UPSTREAM && String(env.UPSTREAM).trim()) {
    c.upstream = String(env.UPSTREAM).trim().replace(/\/+$/, "");
  }

  CFG_CACHE = c;
  CFG_EXP = now + CFG_TTL;
  return c;
}

async function saveConfig(env, patch) {
  if (!env.DB) throw new Error("D1 未绑定");

  const cur = await loadConfig(env);
  const next = { ...cur };

  if (typeof patch.prompt === "string") next.prompt = patch.prompt;
  if (VALID_MODES.includes(patch.mode)) next.mode = patch.mode;
  if (typeof patch.ua === "string" && patch.ua.trim()) next.ua = patch.ua.trim();
  if (patch.keyStrategy === "first" || patch.keyStrategy === "sticky") {
    next.keyStrategy = patch.keyStrategy;
  }
  if (typeof patch.upstream === "string" && patch.upstream.trim()) {
    let u = patch.upstream.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(u)) throw new Error("upstream 必须 http(s)");
    next.upstream = u;
  }

  await env.DB
    .prepare("INSERT INTO cfg (k,v,ts) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts")
    .bind("main", JSON.stringify(next), Date.now())
    .run();

  CFG_CACHE = next;
  CFG_EXP = Date.now() + CFG_TTL;
  return next;
}

// ═════════════════════════════════════════════════════════════
// D1：上游密钥池
// ═════════════════════════════════════════════════════════════

let KEYS_CACHE = null;
let KEYS_EXP = 0;

async function loadKeys(env) {
  const now = Date.now();
  if (KEYS_CACHE && now < KEYS_EXP) return KEYS_CACHE;
  if (!env.DB) return [];

  let rows = [];
  try {
    const r = await env.DB
      .prepare("SELECT id,label,secret,enabled FROM upstream_keys WHERE enabled = 1 ORDER BY id")
      .all();
    rows = (r && r.results) || [];
  } catch {
    rows = [];
  }

  const list = rows
    .filter((x) => x && typeof x.secret === "string" && x.secret.trim())
    .map((x) => ({ id: x.id, label: x.label || "", secret: x.secret.trim() }));

  KEYS_CACHE = list;
  KEYS_EXP = now + CFG_TTL;
  return list;
}

async function invalidateKeys() {
  KEYS_CACHE = null;
  KEYS_EXP = 0;
}

// 测试用：清空所有 isolate 级缓存。
// 生产环境一个 isolate 只服务一个 DB，用不上；但测试里每个用例换 env，
// 不清就会串味（上一个用例的配置被下一个读到）。
export function __resetCache() {
  CFG_CACHE = null;
  CFG_EXP = 0;
  KEYS_CACHE = null;
  KEYS_EXP = 0;
  KEY_CURSOR.clear();
  failMem.clear();
}


// 给面板用的完整列表（含禁用项，secret 打码）
async function listKeysForPanel(env) {
  if (!env.DB) return [];
  try {
    const r = await env.DB
      .prepare("SELECT id,label,secret,enabled,ts FROM upstream_keys ORDER BY id")
      .all();
    return ((r && r.results) || []).map((x) => ({
      id: x.id,
      label: x.label || "",
      enabled: !!x.enabled,
      masked: maskSecret(x.secret),
    }));
  } catch {
    return [];
  }
}

function maskSecret(s) {
  s = String(s || "");
  if (s.length <= 8) return "****";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// ═════════════════════════════════════════════════════════════
// 密钥选择：确定性 + 只前进
// ═════════════════════════════════════════════════════════════
//
// 规则：每个客户端钉住一个下标，只有「该切」的错误才 +1。
// 冷却到期不换回 —— 档位只前进，环形兜一圈。
// 状态全在内存，isolate 重建就回落到哈希初值。

const KEY_CURSOR = new Map(); // clientId → index
const CURSOR_MAX = 2000;
let CURSOR_DAY = "";

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// 每天清一次游标，让被换下去但额度已重置的 key 重新有份
function maybeResetDaily() {
  const d = todayUTC();
  if (CURSOR_DAY !== d) {
    CURSOR_DAY = d;
    KEY_CURSOR.clear();
  }
}

async function clientTag(request, env) {
  // 客户端 key 只有「每个客户端各拿一把」时才有区分度。
  // 共用同一个 ACCESS_KEY 时所有人哈希到同一处，密钥池就等于只有一把
  // —— 所以只在 key 与 ACCESS_KEY 不同才用它做标识，否则退回 IP。
  const k = extractClientKey(request);
  const shared = env && env.ACCESS_KEY;
  if (k && (!shared || k !== shared)) {
    const h = await sha256Hex("c|" + k);
    return h.slice(0, 16);
  }
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    "unknown";
  return "ip:" + ip;
}

async function pickKey(request, env, keys) {
  if (!keys.length) return null;
  if (keys.length === 1) return keys[0];

  maybeResetDaily();

  const tag = await clientTag(request, env);
  const cfg = await loadConfig(env);

  if (cfg.keyStrategy === "first") {
    return keys[0];
  }

  let idx = KEY_CURSOR.get(tag);
  if (typeof idx !== "number" || idx >= keys.length) {
    // 首次见，或 key 数量变了：用哈希定初始位置，然后钉住
    const h = await sha256Hex("k|" + tag);
    idx = parseInt(h.slice(0, 8), 16) % keys.length;
    KEY_CURSOR.set(tag, idx);
    if (KEY_CURSOR.size > CURSOR_MAX) {
      // 被灌爆了就直接清，重置的代价只是重新哈希
      KEY_CURSOR.clear();
    }
  }

  return keys[idx];
}

// 该切吗？只有「这个 key 特有」的错误才切。
// 400/500 换了也没用，会白白把健康 key 打进冷宫。
function shouldRotate(status) {
  return status === 429 || status === 401 || status === 402 || status === 403;
}

async function rotateKey(request, env, keys) {
  if (!keys.length) return;
  const tag = await clientTag(request, env);
  const cur = KEY_CURSOR.get(tag);
  const idx = typeof cur === "number" ? cur : 0;
  KEY_CURSOR.set(tag, (idx + 1) % keys.length);
}

// ═════════════════════════════════════════════════════════════
// 访问前缀
// ═════════════════════════════════════════════════════════════

const RESERVED_SUFFIX = new Set([
  "api", "s", "health", "logout", "login", "panel", "v1", "admin",
  "v1beta", "favicon.ico", "robots.txt",
]);

const SUFFIX_RE = /^[a-z0-9]{4,32}$/;

// 返回 { hit, rest } —— hit=false 表示这个请求不该被代理
function splitSuffix(pathname, cfg) {
  if (!cfg.suffixOn || !cfg.suffix) return { hit: true, rest: pathname };
  const prefix = "/" + cfg.suffix;
  if (pathname === prefix) return { hit: true, rest: "/" };
  if (pathname.startsWith(prefix + "/")) {
    return { hit: true, rest: pathname.slice(prefix.length) };
  }
  return { hit: false, rest: pathname };
}

// ═════════════════════════════════════════════════════════════
// 鉴权
// ═════════════════════════════════════════════════════════════

const enc = new TextEncoder();

function b64url(bytes) {
  let s = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacB64(secret, msg) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(String(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(String(msg)));
  return b64url(sig);
}

async function sha256Hex(v) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(String(v)));
  return Array.from(new Uint8Array(d))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// 常数时间比较。长度也走同一循环，不按长度提前返回。
function timingSafeEq(a, b) {
  a = String(a == null ? "" : a);
  b = String(b == null ? "" : b);
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function sessionSecret(env) {
  return env.SESSION_SECRET || env.ADMIN_PASSWORD || "";
}

// 令牌 = 过期时间 . HMAC(密码指纹 | 过期时间)
// 改密码 → 指纹变 → 所有旧 Cookie 立刻失效
async function issueToken(env, ttlSec = SESSION_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const fp = await sha256Hex("fp|" + (env.ADMIN_PASSWORD || ""));
  const sig = await hmacB64(sessionSecret(env), fp + "|" + exp);
  return exp + "." + sig;
}

async function verifyToken(env, token) {
  if (!token || typeof token !== "string") return false;
  const i = token.indexOf(".");
  if (i <= 0) return false;
  const exp = Number(token.slice(0, i));
  const sig = token.slice(i + 1);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const fp = await sha256Hex("fp|" + (env.ADMIN_PASSWORD || ""));
  const want = await hmacB64(sessionSecret(env), fp + "|" + exp);
  return timingSafeEq(sig, want);
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const t = part.trim();
    if (t.startsWith(name + "=")) return t.slice(name.length + 1);
  }
  return "";
}

function cookieHeader(token, maxAge, secure) {
  let s = "ua_session=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAge;
  if (secure) s += "; Secure";
  return s;
}

async function isAuthed(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  return verifyToken(env, readCookie(request, "ua_session"));
}

// 登录限速。内存计数，各 isolate 独立。
const failMem = new Map();
const FAIL_MAX = 8;
const FAIL_WINDOW = 10 * 60 * 1000;

function clientIp(request) {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    "unknown"
  );
}

function failCount(ip) {
  const rec = failMem.get(ip);
  if (!rec) return 0;
  if (Date.now() - rec.t > FAIL_WINDOW) {
    failMem.delete(ip);
    return 0;
  }
  return rec.n;
}

function recordFail(ip) {
  const now = Date.now();
  const rec = failMem.get(ip);
  if (!rec || now - rec.t > FAIL_WINDOW) failMem.set(ip, { n: 1, t: now });
  else rec.n++;
  if (failMem.size > 500) {
    for (const [k, v] of failMem) if (now - v.t > FAIL_WINDOW) failMem.delete(k);
  }
}

// 非 GET 必须同源，或没有 Origin（curl 这类直连）
function sameOrigin(request) {
  const m = request.method.toUpperCase();
  if (m === "GET" || m === "HEAD") return true;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
}

// ═════════════════════════════════════════════════════════════
// 代理鉴权：客户端调 /v1/* 用的 ACCESS_KEY
// ═════════════════════════════════════════════════════════════

function extractClientKey(request) {
  const h = request.headers;
  const apiKey = h.get("x-api-key");
  if (apiKey) return apiKey.trim();
  const auth = h.get("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = new URL(request.url).searchParams.get("key");
  if (q) return q.trim();
  return "";
}

function checkAccess(request, env) {
  const expected = env.ACCESS_KEY || "";
  if (!expected) return { ok: true, open: true };
  const got = extractClientKey(request);
  if (!got) return { ok: false, reason: "missing" };
  return { ok: timingSafeEq(got, expected), reason: "mismatch" };
}

// ═════════════════════════════════════════════════════════════
// 面板 HTML
// ═════════════════════════════════════════════════════════════

const CSS = [
  "*{box-sizing:border-box;margin:0;padding:0}",
  "body{font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;",
  "background:#0d1117;color:#e6edf3;min-height:100vh;padding:20px 14px 60px}",
  ".wrap{max-width:880px;margin:0 auto}",
  ".card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:18px;margin-bottom:14px}",
  "h1{font-size:19px;font-weight:600;margin-bottom:2px}",
  "h2{font-size:13px;font-weight:600;margin-bottom:12px;color:#8b949e;",
  "text-transform:uppercase;letter-spacing:.06em}",
  ".sub{color:#8b949e;font-size:12.5px;margin:0}",
  "label{display:block;font-size:12.5px;color:#8b949e;margin-bottom:6px}",
  "input[type=text],input[type=password],textarea,select{width:100%;background:#0d1117;",
  "border:1px solid #30363d;border-radius:6px;color:#e6edf3;padding:9px 11px;",
  "font-size:14px;font-family:inherit;outline:none;transition:border-color .15s}",
  "input:focus,textarea:focus,select:focus{border-color:#1f6feb}",
  "textarea{min-height:300px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55}",
  "button{background:#238636;border:1px solid #2ea043;color:#fff;border-radius:6px;",
  "padding:8px 16px;font-size:13.5px;font-weight:500;cursor:pointer;transition:background .15s}",
  "button:hover{background:#2ea043}",
  "button:disabled{opacity:.45;cursor:default}",
  "button.ghost{background:transparent;border:1px solid #30363d;color:#8b949e}",
  "button.ghost:hover{background:#21262d;color:#e6edf3}",
  "button.danger{background:#8b2c2c;border-color:#b33}",
  "button.danger:hover{background:#b33}",
  "button.mini{padding:4px 10px;font-size:12px}",
  ".row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}",
  ".grow{flex:1 1 auto;min-width:160px}",
  ".modes{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}",
  ".mode{background:#0d1117;border:1px solid #30363d;border-radius:7px;padding:10px;cursor:pointer;transition:all .15s}",
  ".mode:hover{border-color:#484f58}",
  ".mode.on{border-color:#1f6feb;background:#0d1f3c}",
  ".mode b{display:block;font-size:12.5px;margin-bottom:3px}",
  ".mode span{font-size:11.5px;color:#8b949e;line-height:1.4;display:block}",
  ".bar{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;gap:10px;flex-wrap:wrap}",
  ".tag{display:inline-block;padding:1px 7px;border-radius:20px;font-size:11px;",
  "font-family:ui-monospace,monospace;border:1px solid #30363d;color:#8b949e;white-space:nowrap}",
  ".tag.ok{border-color:#238636;color:#3fb950}",
  ".tag.warn{border-color:#9e6a03;color:#d29922}",
  ".tag.bad{border-color:#da3633;color:#f85149}",
  ".msg{padding:9px 13px;border-radius:6px;font-size:13px;margin-bottom:14px;display:none}",
  ".msg.show{display:block}",
  ".msg.ok{background:#0d2818;border:1px solid #238636;color:#3fb950}",
  ".msg.err{background:#2d1214;border:1px solid #da3633;color:#f85149}",
  ".hint{font-size:11.5px;color:#6e7681;margin-top:5px}",
  ".login{max-width:340px;margin:12vh auto 0}",
  ".login input{margin-bottom:12px;text-align:center;letter-spacing:2px}",
  ".login button{width:100%}",
  "code{font-family:ui-monospace,monospace;background:#21262d;padding:1px 5px;border-radius:3px;font-size:11.5px}",
  ".kitem{display:flex;gap:8px;align-items:center;padding:9px 0;border-bottom:1px solid #21262d;flex-wrap:wrap}",
  ".kitem:last-child{border-bottom:none}",
  ".kname{font-size:13px;font-weight:500;min-width:70px}",
  ".ksec{font-family:ui-monospace,monospace;font-size:11.5px;color:#8b949e;flex:1 1 120px;word-break:break-all}",
  ".off{opacity:.45}",
  ".sfx{font-family:ui-monospace,monospace;font-size:15px;letter-spacing:1px;",
  "background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:8px 12px;color:#3fb950;flex:1 1 200px}",
].join("");

const MODE_INFO = {
  append: ["append（默认）", "追加到 system 末尾。稳，但落在缓存断点后，每轮全额计费。"],
  prepend: ["prepend", "插到 system 最前。进缓存前缀，省钱。权重略低。"],
  replace: ["replace", "删掉客户端原有 system，只留你的。工具调用容易坏。"],
  "last-user": ["last-user", "塞进最后一条 user 消息。遵从度最高，不省缓存。"],
};

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const PANEL_JS = [
  "var $=function(s){return document.querySelector(s)};",
  "var modes=[].slice.call(document.querySelectorAll('.mode'));",
  "modes.forEach(function(el){el.addEventListener('click',function(){",
  "  modes.forEach(function(x){x.classList.remove('on')});",
  "  el.classList.add('on');$('#modeInput').value=el.dataset.m;",
  "})});",
  "var ta=$('#prompt'),cnt=$('#count');",
  "function upd(){cnt.textContent=ta.value.length+' 字符'}",
  "ta.addEventListener('input',upd);",
  "function say(t,ok){var e=$('#msg');e.textContent=t;e.className='msg show '+(ok?'ok':'err');",
  "  setTimeout(function(){e.className='msg'},5000)}",
  "function post(url,body){return fetch(url,{method:'POST',headers:{'content-type':'application/json'},",
  "  body:JSON.stringify(body)}).then(function(r){return r.json()})}",
  "$('#save').addEventListener('click',function(){",
  "  var b=$('#save');b.disabled=true;",
  "  post('/api/config',{prompt:ta.value,mode:$('#modeInput').value,",
  "    ua:$('#ua').value,upstream:$('#up').value,keyStrategy:$('#strat').value})",
  "  .then(function(j){b.disabled=false;",
  "    if(j.error){say('保存失败：'+j.error,false);return}",
  "    say('已保存。本 isolate 立刻生效，其他最多 30 秒。',true);upd();",
  "  }).catch(function(e){b.disabled=false;say('保存失败：'+e,false)});",
  "});",
  "$('#gsfx').addEventListener('click',function(){",
  "  var a='abcdefghijklmnopqrstuvwxyz0123456789',s='',b=new Uint8Array(8);",
  "  crypto.getRandomValues(b);for(var i=0;i<8;i++)s+=a[b[i]%a.length];",
  "  $('#sfx').value=s;",
  "});",
  "$('#savesfx').addEventListener('click',function(){",
  "  var v=$('#sfx').value.trim().toLowerCase();",
  "  if(!/^[a-z0-9]{4,32}$/.test(v)){say('后缀只能 4-32 位小写字母数字',false);return}",
  "  var on=$('#sfxon').checked;var b=$('#savesfx');b.disabled=true;",
  "  post('/api/suffix',{suffix:v,suffixOn:on}).then(function(j){b.disabled=false;",
  "    if(j.error){say('保存失败：'+j.error,false);return}",
  "    say('已保存。新地址：/'+v+'/',true);",
  "  }).catch(function(e){b.disabled=false;say('保存失败：'+e,false)});",
  "});",
  "$('#addkey').addEventListener('click',function(){",
  "  var s=$('#newkey').value.trim(),l=$('#newlabel').value.trim();",
  "  if(!s){say('密钥不能为空',false);return}",
  "  post('/api/keys',{action:'add',secret:s,label:l}).then(function(j){",
  "    if(j.error){say('添加失败：'+j.error,false);return}",
  "    location.reload();",
  "  }).catch(function(e){say('添加失败：'+e,false)});",
  "});",
  "document.querySelectorAll('[data-del]').forEach(function(b){",
  "  b.addEventListener('click',function(){",
  "    if(!confirm('删除密钥 #'+b.dataset.del+'？'))return;",
  "    post('/api/keys',{action:'del',id:Number(b.dataset.del)}).then(function(){location.reload()});",
  "  });",
  "});",
  "document.querySelectorAll('[data-toggle]').forEach(function(b){",
  "  b.addEventListener('click',function(){",
  "    post('/api/keys',{action:'toggle',id:Number(b.dataset.toggle)}).then(function(){location.reload()});",
  "  });",
  "});",
  "$('#logout').addEventListener('click',function(){",
  "  document.cookie='ua_session=; Path=/; Max-Age=0';location.reload();",
  "});",
  "upd();",
].join("");

function loginPage() {
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>ua-proxy</title><style>" + CSS + "</style></head><body>" +
    '<div class="login"><div class="card">' +
    "<h1>ua-proxy</h1><p class=\"sub\">管理面板</p>" +
    '<div id="msg" class="msg" style="margin-top:14px"></div>' +
    '<input id="pw" type="password" placeholder="密码" autocomplete="current-password" style="margin-top:14px">' +
    '<button id="go">登录</button>' +
    '<p class="hint" style="margin-top:12px">连续 8 次失败锁 10 分钟</p>' +
    "</div></div><script>" +
    "var pw=document.getElementById('pw'),go=document.getElementById('go'),msg=document.getElementById('msg');" +
    "function say(t){msg.textContent=t;msg.className='msg show err'}" +
    "function sub(){go.disabled=true;" +
    "  fetch('/api/login',{method:'POST',headers:{'content-type':'application/json'}," +
    "    body:JSON.stringify({password:pw.value})" +
    "  }).then(function(r){return r.json().then(function(j){return {s:r.status,j:j}})}).then(function(o){" +
    "    go.disabled=false;if(o.s===200){location.reload();return}" +
    "    say(o.j.error||'登录失败');pw.value='';pw.focus();" +
    "  }).catch(function(e){go.disabled=false;say('网络错误：'+e)});" +
    "}" +
    "go.addEventListener('click',sub);" +
    "pw.addEventListener('keydown',function(e){if(e.key==='Enter')sub()});" +
    "pw.focus();" +
    "</script></body></html>"
  );
}

function panelPage(cfg, env, keys) {
  const modes = VALID_MODES.map((m) => {
    const [title, desc] = MODE_INFO[m];
    const on = cfg.mode === m ? " on" : "";
    return (
      '<div class="mode' + on + '" data-m="' + m + '"><b>' + esc(title) +
      "</b><span>" + esc(desc) + "</span></div>"
    );
  }).join("");

  const keyRows = keys.length
    ? keys
        .map(
          (k) =>
            '<div class="kitem' + (k.enabled ? "" : " off") + '">' +
            '<span class="kname">#' + k.id + (k.label ? " " + esc(k.label) : "") + "</span>" +
            '<span class="ksec">' + esc(k.masked) + "</span>" +
            '<span class="tag' + (k.enabled ? " ok" : "") + '">' +
            (k.enabled ? "启用" : "停用") + "</span>" +
            '<button class="ghost mini" data-toggle="' + k.id + '">' +
            (k.enabled ? "停用" : "启用") + "</button>" +
            '<button class="danger mini" data-del="' + k.id + '">删除</button>' +
            "</div>"
        )
        .join("")
    : '<p class="hint">还没有密钥。当前用客户端自带的 key 直连上游。</p>';

  const keyTag = env.ACCESS_KEY
    ? '<span class="tag ok">ACCESS_KEY 已设</span>'
    : '<span class="tag warn">ACCESS_KEY 未设 · 代理公开</span>';
  const dbTag = env.DB
    ? '<span class="tag ok">D1 已绑定</span>'
    : '<span class="tag bad">D1 未绑定</span>';
  const poolTag = keys.length
    ? '<span class="tag ok">密钥池 ' + keys.length + " 个</span>"
    : '<span class="tag">密钥池空</span>';
  const sfxTag = cfg.suffixOn && cfg.suffix
    ? '<span class="tag ok">前缀已开</span>'
    : '<span class="tag warn">前缀未开 · 任意路径可调</span>';

  const base = cfg.suffixOn && cfg.suffix ? "/" + cfg.suffix : "";
  const proxyURL = base + "/v1/messages";

  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>ua-proxy 管理</title><style>" + CSS + "</style></head><body><div class=\"wrap\">" +

    '<div class="bar"><div><h1>ua-proxy</h1>' +
    '<p class="sub">' + esc(cfg.upstream) + "</p></div>" +
    '<div class="row">' + keyTag + dbTag + poolTag + sfxTag +
    '<button class="ghost mini" id="logout">退出</button></div></div>' +

    '<div id="msg" class="msg"></div>' +

    '<div class="card"><h2>注入模式</h2><div class="modes">' + modes + "</div>" +
    '<input type="hidden" id="modeInput" value="' + esc(cfg.mode) + '"></div>' +

    '<div class="card"><h2>提示词</h2>' +
    '<p class="hint" style="margin-bottom:8px">存 D1，不经过 JS 字符串。反引号和 ${ 都不用转义。</p>' +
    '<textarea id="prompt" spellcheck="false">' + esc(cfg.prompt) + "</textarea>" +
    '<div class="row" style="margin-top:6px"><span class="hint" id="count">' +
    cfg.prompt.length + " 字符</span></div></div>" +

    '<div class="card"><h2>上游</h2>' +
    '<label>User-Agent</label><input type="text" id="ua" value="' + esc(cfg.ua) + '">' +
    '<label style="margin-top:12px">上游地址</label>' +
    '<input type="text" id="up" value="' + esc(cfg.upstream) + '">' +
    '<label style="margin-top:12px">密钥选择策略</label>' +
    '<select id="strat">' +
    '<option value="sticky"' + (cfg.keyStrategy === "sticky" ? " selected" : "") +
    ">sticky — 每个客户端钉一个 key，出错才切（推荐）</option>" +
    '<option value="first"' + (cfg.keyStrategy === "first" ? " selected" : "") +
    ">first — 永远用第一个启用的 key</option>" +
    "</select></div>" +

    '<div class="card"><h2>访问前缀</h2>' +
    '<p class="hint" style="margin-bottom:10px">开启后，代理路径必须带这个前缀。' +
    "不知道前缀的人访问 <code>/v1/messages</code> 只会拿到 404。" +
    "面板本身的路径不受影响。</p>" +
    '<div class="row"><input type="text" class="sfx" id="sfx" value="' + esc(cfg.suffix) + '" placeholder="点右侧生成">' +
    '<button class="ghost" id="gsfx">随机生成</button></div>' +
    '<div class="row" style="margin-top:10px">' +
    '<label style="display:flex;align-items:center;gap:6px;margin:0;cursor:pointer">' +
    '<input type="checkbox" id="sfxon"' + (cfg.suffixOn ? " checked" : "") +
    "> 启用前缀</label>" +
    '<button id="savesfx">保存前缀</button></div>' +
    '<p class="hint" style="margin-top:10px">当前调用地址：<code>' + esc(proxyURL) + "</code></p></div>" +

    '<div class="card"><h2>上游密钥池</h2>' +
    '<p class="hint" style="margin-bottom:10px">' +
    (keys.length
      ? "按策略从下面选一个发给上游。客户端只拿 ACCESS_KEY，永远看不到这些。"
      : "填入星驰的 key 后，客户端就不需要自带 key 了。") +
    "</p>" + keyRows +
    '<div class="row" style="margin-top:12px">' +
    '<input type="text" class="grow" id="newlabel" placeholder="备注（可选）">' +
    '<input type="text" class="grow" id="newkey" placeholder="密钥 sk-..." style="flex:2 1 220px">' +
    '<button id="addkey">添加</button></div></div>' +

    '<div class="row"><button id="save">保存配置</button>' +
    '<span class="hint">提示词和上游改动写这里；前缀和密钥各自有独立按钮</span></div>' +
    "</div><script>" + PANEL_JS + "</script></body></html>"
  );
}

function notFoundPage() {
  return (
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>404</title><style>" +
    "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
    "background:#0d1117;color:#484f58;font:14px/1.6 -apple-system,sans-serif}" +
    ".b{text-align:center}.n{font-size:56px;font-weight:200;color:#21262d}" +
    "</style></head><body><div class=\"b\"><div class=\"n\">404</div>" +
    "<p>Not Found</p></div></body></html>"
  );
}

// ═════════════════════════════════════════════════════════════
// 响应工具
// ═════════════════════════════════════════════════════════════

function cleanHeaders(src) {
  const out = new Headers(src);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  out.delete("connection");
  out.delete("keep-alive");
  return out;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

// ═════════════════════════════════════════════════════════════
// 管理 API
// ═════════════════════════════════════════════════════════════

async function handleLogin(request, env) {
  const ip = clientIp(request);
  if (failCount(ip) >= FAIL_MAX) {
    return json({ error: "失败次数过多，请 10 分钟后再试" }, 429);
  }
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "未设置 ADMIN_PASSWORD" }, 500);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是 JSON" }, 400);
  }

  const input = typeof body.password === "string" ? body.password : "";
  if (!input || !timingSafeEq(input, env.ADMIN_PASSWORD)) {
    recordFail(ip);
    return json({ error: "密码错误" }, 401);
  }

  const token = await issueToken(env);
  const res = json({ ok: true });
  res.headers.set(
    "set-cookie",
    cookieHeader(token, SESSION_TTL, new URL(request.url).protocol === "https:")
  );
  return res;
}

async function handleConfig(request, env) {
  if (request.method === "GET") {
    const cfg = await loadConfig(env);
    const keys = await listKeysForPanel(env);
    return json({
      prompt: cfg.prompt,
      mode: cfg.mode,
      ua: cfg.ua,
      upstream: cfg.upstream,
      keyStrategy: cfg.keyStrategy,
      promptLength: cfg.prompt.length,
      suffix: cfg.suffix,
      suffixOn: cfg.suffixOn,
      keys,
    });
  }

  if (request.method === "POST") {
    if (!env.DB) return json({ error: "D1 未绑定" }, 500);
    let body = {};
    try {
      body = await request.json();
    } catch {
      return json({ error: "请求体不是 JSON" }, 400);
    }
    try {
      const next = await saveConfig(env, body);
      return json({ ok: true, promptLength: next.prompt.length, mode: next.mode });
    } catch (e) {
      return json({ error: String(e && e.message ? e.message : e) }, 400);
    }
  }

  return json({ error: "method not allowed" }, 405);
}

async function handleSuffix(request, env) {
  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
  if (!env.DB) return json({ error: "D1 未绑定" }, 500);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是 JSON" }, 400);
  }

  const sfx = String(body.suffix || "").trim().toLowerCase();
  const on = body.suffixOn === true;

  if (on) {
    if (!SUFFIX_RE.test(sfx)) {
      return json({ error: "后缀只能 4-32 位小写字母和数字" }, 400);
    }
    if (RESERVED_SUFFIX.has(sfx)) {
      return json({ error: "这个后缀被系统占用了，换一个" }, 400);
    }
  }

  const cur = await loadConfig(env);
  const next = { ...cur, suffix: sfx, suffixOn: on };

  await env.DB
    .prepare("INSERT INTO cfg (k,v,ts) VALUES (?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, ts=excluded.ts")
    .bind("main", JSON.stringify(next), Date.now())
    .run();

  CFG_CACHE = next;
  CFG_EXP = Date.now() + CFG_TTL;
  return json({ ok: true, suffix: sfx, suffixOn: on });
}

async function handleKeys(request, env) {
  if (!env.DB) return json({ error: "D1 未绑定" }, 500);

  if (request.method === "GET") {
    return json({ keys: await listKeysForPanel(env) });
  }

  if (request.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是 JSON" }, 400);
  }

  const action = String(body.action || "");

  try {
    if (action === "add") {
      const secret = String(body.secret || "").trim();
      const label = String(body.label || "").trim().slice(0, 40);
      if (!secret) return json({ error: "密钥不能为空" }, 400);
      if (secret.length > 512) return json({ error: "密钥过长" }, 400);
      await env.DB
        .prepare("INSERT INTO upstream_keys (label,secret,enabled,ts) VALUES (?,?,1,?)")
        .bind(label, secret, Date.now())
        .run();
      await invalidateKeys();
      return json({ ok: true });
    }

    if (action === "del") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "id 无效" }, 400);
      await env.DB.prepare("DELETE FROM upstream_keys WHERE id = ?").bind(id).run();
      await invalidateKeys();
      return json({ ok: true });
    }

    if (action === "toggle") {
      const id = Number(body.id);
      if (!Number.isFinite(id)) return json({ error: "id 无效" }, 400);
      await env.DB
        .prepare("UPDATE upstream_keys SET enabled = 1 - enabled, ts = ? WHERE id = ?")
        .bind(Date.now(), id)
        .run();
      await invalidateKeys();
      return json({ ok: true });
    }

    return json({ error: "未知 action" }, 400);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}

// ═════════════════════════════════════════════════════════════
// 代理
// ═════════════════════════════════════════════════════════════

function buildTarget(upstream, pathname, search) {
  const u = String(upstream).replace(/\/+$/, "");
  return u + pathname + (search || "");
}

// 从 URL 里剥掉 ?key=（那是给本 Worker 鉴权的，不该进上游日志）
function stripKeyParam(pathname, search) {
  if (!search) return search || "";
  const sp = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  if (!sp.has("key")) return search;
  sp.delete("key");
  const s = sp.toString();
  return s ? "?" + s : "";
}

// 请求体只能读一次。所以先读成字符串存着，重试时复用。
// 返回 { body, replayable }：非 JSON 是流，无法重放，只能试一次。
async function prepareBody(request, cfg, pathname) {
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && request.body;
  if (!hasBody) return { body: undefined, replayable: true };

  const ct = (request.headers.get("content-type") || "").toLowerCase();
  if (!ct.includes("application/json")) {
    return { body: request.body, replayable: false };
  }

  const raw = await request.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const next =
    parsed && injectPrompt(parsed, cfg.prompt, pathname, cfg.mode)
      ? JSON.stringify(parsed)
      : raw;
  return { body: next, replayable: true };
}

async function sendUpstream(target, method, headers, body) {
  const init = { method, headers };
  if (body !== undefined) {
    init.body = body;
    if (typeof body !== "string") init.duplex = "half";
  }
  return fetch(target, init);
}

async function doProxy(request, env, cfg, pathname, search) {
  const upstream = cfg.upstream.replace(/\/+$/, "");
  const cleanSearch = stripKeyParam(pathname, search);
  const target = buildTarget(upstream, pathname, cleanSearch);

  // 先读一次 body。重试时复用同一个字符串。
  const prepared = await prepareBody(request, cfg, pathname);
  const method = request.method.toUpperCase();

  const keys = await loadKeys(env);

  const baseHeaders = new Headers(request.headers);
  baseHeaders.delete("host");
  baseHeaders.delete("content-length");
  baseHeaders.delete("transfer-encoding");
  baseHeaders.set("user-agent", cfg.ua || DEFAULT_UA);

  // 没有密钥池：原样透传客户端带来的 key（老行为）
  if (!keys.length) {
    const res = await sendUpstream(target, method, baseHeaders, prepared.body);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: cleanHeaders(res.headers),
    });
  }

  // 有密钥池：换发上游 key。
  // 流式 body 不可重放 → 只试一次，不重试。
  const maxAttempts = prepared.replayable ? keys.length : 1;
  let res = null;
  let lastErr = null;
  const tried = new Set();

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const k = await pickKey(request, env, keys);
    if (!k || tried.has(k.id)) break;
    tried.add(k.id);

    const headers = new Headers(baseHeaders);
    headers.set("x-api-key", k.secret);
    const auth = headers.get("authorization");
    if (auth && /^Bearer\s+/i.test(auth)) headers.set("authorization", "Bearer " + k.secret);

    try {
      const r = await sendUpstream(target, method, headers, prepared.body);

      if (shouldRotate(r.status)) {
        lastErr = r;
        // 把这个 key 推进冷宫：游标 +1，下次不再选它
        await rotateKey(request, env, keys);
        if (attempt < maxAttempts - 1) continue;
        // 最后一个也失败，把它的响应透传出去
        break;
      }

      res = r;
      break;
    } catch (e) {
      lastErr = e;
      await rotateKey(request, env, keys);
      continue;
    }
  }

  if (!res) {
    if (lastErr instanceof Response) {
      return new Response(lastErr.body, {
        status: lastErr.status,
        statusText: lastErr.statusText,
        headers: cleanHeaders(lastErr.headers),
      });
    }
    return json(
      {
        error: "所有上游密钥均不可用",
        detail: lastErr ? String(lastErr.message || lastErr) : "无可用 key",
      },
      503
    );
  }

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: cleanHeaders(res.headers),
  });
}

// ═════════════════════════════════════════════════════════════
// 入口
// ═════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const secure = url.protocol === "https:";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "*",
          "access-control-max-age": "86400",
        },
      });
    }

    // ---- 管理路由：固定路径，不受前缀影响 ----
    if (path === "/api/login") {
      if (request.method !== "POST") return json({ error: "method not allowed" }, 405);
      if (!sameOrigin(request)) return json({ error: "跨站请求被拒" }, 403);
      return handleLogin(request, env);
    }

    if (path === "/api/config") {
      if (!(await isAuthed(request, env))) return json({ error: "未登录" }, 401);
      if (!sameOrigin(request)) return json({ error: "跨站请求被拒" }, 403);
      return handleConfig(request, env);
    }

    if (path === "/api/keys") {
      if (!(await isAuthed(request, env))) return json({ error: "未登录" }, 401);
      if (!sameOrigin(request)) return json({ error: "跨站请求被拒" }, 403);
      return handleKeys(request, env);
    }

    if (path === "/api/suffix") {
      if (!(await isAuthed(request, env))) return json({ error: "未登录" }, 401);
      if (!sameOrigin(request)) return json({ error: "跨站请求被拒" }, 403);
      return handleSuffix(request, env);
    }

    if (path === "/" || path === "/panel") {
      const authed = await isAuthed(request, env);
      if (!authed) return html(loginPage());
      const cfg = await loadConfig(env);
      const keys = await listKeysForPanel(env);
      return html(panelPage(cfg, env, keys));
    }

    if (path === "/logout") {
      const res = new Response(null, { status: 302, headers: { location: "/" } });
      res.headers.set("set-cookie", cookieHeader("", 0, secure));
      return res;
    }

    // /health：匿名只回存活，细节要登录。
    // 原来匿名就吐 upstream、keyCount、promptLength —— 开了前缀也白开，
    // 扫一下 /health 就把上游地址和家底全看走了。
    if (path === "/health") {
      const authed = await isAuthed(request, env);
      if (!authed) return json({ ok: true });
      const cfg = await loadConfig(env);
      const keys = await loadKeys(env);
      return json({
        ok: true,
        mode: cfg.mode,
        upstream: cfg.upstream,
        promptLength: cfg.prompt.length,
        suffixOn: cfg.suffixOn,
        keyCount: keys.length,
        db: !!env.DB,
        accessKeySet: !!env.ACCESS_KEY,
      });
    }

    // ---- 其余走代理 ----
    const cfg = await loadConfig(env);
    const split = splitSuffix(path, cfg);

    // 前缀开了但没带，或路径不对 → 404，不给任何线索
    if (!split.hit) {
      return html(notFoundPage(), 404);
    }

    const gate = checkAccess(request, env);
    if (!gate.ok) {
      return json(
        {
          error: "unauthorized client detected",
          hint:
            gate.reason === "missing"
              ? "缺少 key。x-api-key / Authorization: Bearer / ?key= 三选一。"
              : "key 不正确。",
        },
        401
      );
    }

    return doProxy(request, env, cfg, split.rest, url.search);
  },
};
