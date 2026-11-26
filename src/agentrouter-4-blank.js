/**
 * AgentRouter UA 伪装代理 + 提示词注入
 * Cloudflare Worker，单文件，无绑定、无存储、无 KV、无 D1
 *
 * ═════════════════════════════════════════════════════════════
 * 干什么
 * ═════════════════════════════════════════════════════════════
 *   1. 出站统一改写 User-Agent 为白名单值
 *   2. 在请求体里注入系统提示词，真正进模型上下文
 *
 * ═════════════════════════════════════════════════════════════
 * ★ 提示词填哪里 ★
 * ═════════════════════════════════════════════════════════════
 *   下面 PROMPT 常量（第 57 行左右）。当前为空，自己填：
 *
 *     const PROMPT = `
 *     你的提示词，多行随便写
 *     `.trim();
 *
 *   ⚠ 提示词里如果有反引号 ` 或 ${ ，必须转义成 \` 和 \${ ，
 *     否则模板字符串提前闭合，整个文件语法错。
 *
 *   ⚠ 更省事的办法：用 agentrouter-3-env.js，
 *     提示词写进 prompt.txt，跑 set-prompt.mjs 自动转义，不用手改代码。
 *
 *   留空 = 不注入，只做 UA 伪装。
 *
 * ═════════════════════════════════════════════════════════════
 * ★ 注入模式（MODE 常量）★
 * ═════════════════════════════════════════════════════════════
 *   "append"     追加到 system 末尾          ← 默认，稳妥
 *   "prepend"    插到 system 最前            ← 省 token，进缓存
 *   "replace"    删掉客户端 system 只留你的   ← 最强势，可能坏工具调用
 *   "last-user"  塞进最后一条 user 消息       ← 遵从度最高
 *
 * ═════════════════════════════════════════════════════════════
 * ★ 先看清软件发了什么 ★
 * ═════════════════════════════════════════════════════════════
 *   客户端 Base URL 改成 https://<你的域>/__inspect
 *   发一条消息 → 返回该软件实际发出的完整请求体
 *   看 systemPromptLength 就知道它塞了多少字规则
 *
 * ═════════════════════════════════════════════════════════════
 * 部署
 * ═════════════════════════════════════════════════════════════
 *   Dashboard：Workers & Pages → Create → Worker → 粘贴 → Deploy
 *   wrangler ：npx wrangler deploy
 *
 * 可选变量（Dashboard → Settings → Variables and Secrets）：
 *   UA        自定义 User-Agent
 *   UPSTREAM  上游地址
 *   MODE      注入模式，覆盖代码里的 MODE 常量
 */

// ═════════════════════════════════════════════════════════════
// ★★★ 提示词写这里 ★★★
// ═════════════════════════════════════════════════════════════
// 在这里写你的提示词。反引号内多行随便写。
//
// 注意：文本里的反引号要写成 \` ，美元花括号要写成 \${ ，
// 否则会破坏模板字符串。或者用同目录的 set-prompt.mjs 生成配置，
// 把提示词放 prompt.txt 里，不用手工转义：
//   node set-prompt.mjs prompt.txt
//   npx wrangler deploy -c wrangler.local.toml
//
// 留空 = 不注入，只做 UA 伪装。
const PROMPT = ``.trim();

// ═════════════════════════════════════════════════════════════
// 其他配置
// ═════════════════════════════════════════════════════════════

const MODE = "append";

const DEFAULT_UA = "claude-cli/2.0.0 (external, cli)";
const DEFAULT_UP = "https://api.xingchiapi.com";

// 注入标记。幂等检查靠它。
const MARK = "[ua-proxy]";

const VALID_MODES = ["append", "prepend", "replace", "last-user"];

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

// 把客户端 system 拍平成纯文本，供 /__inspect 展示
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

// 判定请求体家族：chat / gemini / anthropic
function family(pathname, body) {
  const p = (pathname || "").toLowerCase();
  if (p.includes("/chat/completions")) return "chat";
  if (p.includes("generatecontent")) return "gemini";
  if (p.includes("/messages")) return "anthropic";
  if (p.includes("/responses")) return "responses";

  // 路径认不出来，退回结构嗅探
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
// 各家族的写入实现
// ═════════════════════════════════════════════════════════════

// ---- Anthropic：system 是 string 或 block 数组 ----

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

// ---- OpenAI Chat：system 在 messages[0] ----

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

// ---- OpenAI Responses：instructions ----

function responsesWrite(body, text, mode) {
  if (mode === "replace") {
    body.instructions = text;
    return true;
  }
  const cur = body.instructions;
  body.instructions = mode === "prepend" ? text + "\n\n" + (cur || "") : joinText(cur, text);
  return true;
}

// ---- Gemini：systemInstruction.parts ----

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

// ---- last-user：塞进最后一条 user 消息 ----

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

// 取最后一条 user 消息的文本，用于 last-user 模式的幂等判断
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

// ═════════════════════════════════════════════════════════════
// 注入入口
// ═════════════════════════════════════════════════════════════

export function injectPrompt(body, rawPrompt, pathname = "", mode = "append") {
  if (!rawPrompt || typeof rawPrompt !== "string" || !rawPrompt.trim()) return false;
  if (typeof body !== "object" || body === null) return false;

  const m = VALID_MODES.includes(mode) ? mode : "append";
  const text = MARK + "\n" + rawPrompt.trim();
  const fam = family(pathname, body);

  // 幂等：已注入过就不重复叠加
  // replace 模式会整段替换，不需要查
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
// 响应头清理
// ═════════════════════════════════════════════════════════════
// fetch 拿到的 body 已被运行时解压，content-encoding / content-length
// 必须剥掉，否则客户端按 gzip 去解明文会炸。

function cleanHeaders(src) {
  const out = new Headers(src);
  out.delete("content-encoding");
  out.delete("content-length");
  out.delete("transfer-encoding");
  out.delete("connection");
  out.delete("keep-alive");
  return out;
}

// ═════════════════════════════════════════════════════════════
// Worker 入口
// ═════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const rawMode = String(env.MODE || MODE).toLowerCase().trim();
    const mode = VALID_MODES.includes(rawMode) ? rawMode : "append";

    // ---- 观测端点：原样回显客户端发的请求体 ----
    if (url.pathname.startsWith("/__inspect")) {
      let raw = "";
      try {
        raw = await request.text();
      } catch {
        raw = "";
      }

      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }

      const report = {
        note: "客户端实际发出的请求体（未经本 Worker 修改）",
        method: request.method,
        path: url.pathname.replace(/^\/__inspect/, "") || "/",
        bodyBytes: new TextEncoder().encode(raw).length,
        family: parsed ? family(url.pathname, parsed) : "unknown",
        systemPromptLength: 0,
        systemPromptPreview: "",
        messageCount: 0,
        parsed,
      };

      if (parsed) {
        let st = sysText(parsed.system);
        if (!st && parsed.systemInstruction) st = sysText(parsed.systemInstruction);
        if (!st && typeof parsed.instructions === "string") st = parsed.instructions;
        if (!st && Array.isArray(parsed.messages) && parsed.messages[0]?.role === "system") {
          const c = parsed.messages[0].content;
          st = typeof c === "string" ? c : sysText(c);
        }
        report.systemPromptLength = st.length;
        report.systemPromptPreview = st.slice(0, 4000);
        report.messageCount = Array.isArray(parsed.messages)
          ? parsed.messages.length
          : Array.isArray(parsed.contents)
          ? parsed.contents.length
          : 0;
      }

      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      const prompt = PROMPT.trim();
      return new Response(
        "ua-proxy ok\n" +
          "mode     = " + mode + "\n" +
          "upstream = " + (env.UPSTREAM || DEFAULT_UP) + "\n" +
          "ua       = " + (env.UA || DEFAULT_UA) + "\n" +
          "prompt   = " + (prompt ? prompt.length + " chars" : "(off)") + "\n" +
          "\n观测：Base URL 改成 /__inspect 可看到客户端实际发的 system prompt\n"
      );
    }

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

    const upstream = (env.UPSTREAM || DEFAULT_UP).replace(/\/+$/, "");
    const target = upstream + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.delete("host");
    // content-length 必须删：body 被我们重新序列化过，长度变了。
    headers.delete("content-length");
    // transfer-encoding 也必须删：请求体已经被读成完整字符串，
    // 再声明 chunked 会让上游直接拒绝（undici 报 invalid transfer-encoding header）。
    headers.delete("transfer-encoding");
    headers.set("user-agent", env.UA || DEFAULT_UA);

    let body;
    const method = request.method.toUpperCase();
    const hasBody = method !== "GET" && method !== "HEAD" && request.body;

    if (hasBody) {
      const ct = (headers.get("content-type") || "").toLowerCase();

      if (ct.includes("application/json")) {
        const raw = await request.text();
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = null;
        }
        body = parsed && injectPrompt(parsed, PROMPT, url.pathname, mode)
          ? JSON.stringify(parsed)
          : raw;
      } else {
        // multipart / 二进制 / 表单：不碰，流式透传
        body = request.body;
      }
    }

    const init = { method, headers };
    if (body !== undefined) {
      init.body = body;
      if (typeof body !== "string") init.duplex = "half";
    }

    const res = await fetch(target, init);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: cleanHeaders(res.headers),
    });
  },
};
