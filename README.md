# ua-proxy

> Cloudflare Worker 反向代理：**User-Agent 伪装** + **提示词注入** + **管理面板** + **多密钥池**

很多中转站按 `User-Agent` 判断客户端来源，非白名单直接 `401 unauthorized client detected`。这个 Worker 站在你和上游之间，把 UA 改掉，同时把你的系统提示词塞进请求体——绘图软件看不到你的指令，模型看得到。

---

## 它解决什么

| 问题 | 做法 |
|---|---|
| 上游不认你的客户端 | 改写 `User-Agent`，其余全部透传 |
| 客户端的系统提示词盖过你的 | 把提示词**注入请求体**，不是塞响应 |
| 改一个字要重新部署 | 5 号版把配置放 D1，面板上改 |
| 域名泄露就被白嫖额度 | `ACCESS_KEY` 鉴权 + 可改的访问前缀 |
| 只有一把 key，打满就停 | 密钥池，出错自动切换 |

**关键认知**：提示词必须注入**请求体**。往响应流里塞文字只会出现在界面上，模型根本收不到。

---

## 五个版本，按需选

| 文件 | 提示词在哪 | 面板 | 鉴权 | 密钥池 | 适合 |
|---|---|---|---|---|---|
| [`src/agentrouter-1-ua-only.js`](src/agentrouter-1-ua-only.js) | 无 | — | — | — | 只要绕过 UA 限制 |
| [`src/agentrouter-2-full.js`](src/agentrouter-2-full.js) | 代码常量 | — | — | — | 单文件、不想配 D1 |
| [`src/agentrouter-3-env.js`](src/agentrouter-3-env.js) | `env.PROMPT` | — | — | — | 提示词走环境变量 |
| [`src/agentrouter-4-blank.js`](src/agentrouter-4-blank.js) | 留空自填 | — | — | — | 拿来当模板 |
| **[`src/agentrouter-5-panel.js`](src/agentrouter-5-panel.js)** | **D1，面板改** | **有** | **有** | **有** | **推荐** |

1 号和 4 号代码完全相同，只差注释。

---

## 5 号：五分钟部署

```bash
# 1. 建库
wrangler d1 create ua-proxy
#    把返回的 database_id 填进 wrangler/wrangler-5-panel.toml

# 2. 建表（只跑一次）
wrangler d1 execute ua-proxy --remote --file=./schema.sql

# 3. 设密码
wrangler secret put ADMIN_PASSWORD   # 面板登录密码，必填
wrangler secret put ACCESS_KEY       # 客户端调代理用的 key，必填

# 4. 部署
wrangler deploy -c wrangler/wrangler-5-panel.toml
```

打开 `https://你的域名/`，输密码，粘提示词，保存。

详细步骤见 [`docs/部署与使用.md`](docs/部署与使用.md)。

### 客户端怎么接

```
Base URL   https://你的域名/<前缀>
API Key    ACCESS_KEY
```

三种带 key 的方式都认，不用改客户端协议：

```
x-api-key: <ACCESS_KEY>              ← Anthropic 系天然带
Authorization: Bearer <ACCESS_KEY>   ← OpenAI 系天然带
?key=<ACCESS_KEY>                    ← 都不支持的走这个
```

`?key=` 转发前会从 URL 剥掉，不进上游日志。

---

## 四种注入模式

| 模式 | 位置 | 取舍 |
|---|---|---|
| `append` | system 末尾 | 稳。但落在缓存断点后，**每轮全额计费** |
| `prepend` | system 最前 | **进缓存前缀，省 10 倍**。权重略低 |
| `replace` | 删掉客户端 system | 最强势，工具调用容易坏 |
| `last-user` | 塞进末条 user 消息 | **遵从度最高**，不省缓存 |

15KB 提示词约 4200 token。`append` 每轮全额付，`prepend` 命中缓存后只要 10%——**差价 10 倍，且每一轮都在付**。

要「软件听我的」用 `last-user`，要省钱用 `prepend`。详情见 [`docs/四种模式.md`](docs/四种模式.md)。

---

## 密钥池怎么工作

```
客户端 ──ACCESS_KEY──▶ Worker ──池里选一个──▶ 上游
```

上游真 key 永不出 Worker。

**粘性，不是轮询。** 每个客户端钉住一个 key，只有该切的时候才换：

| 上游返回 | 切？ |
|---|---|
| `429` 额度打满 | ✅ |
| `401 / 402 / 403` key 失效 | ✅ |
| `500 / 502 / 503 / 529` 上游挂了 | ❌ 换了也没用 |
| `400 / 422` 请求本身有问题 | ❌ **不是 key 的锅** |

最后一行最容易搞错——收到 400 就换 key，等于把健康 key 一个个打进冷宫。

**为什么不轮询**：上游的 prompt cache 按 key 算。每轮换 key 等于永久放弃缓存，15KB 提示词每轮全额计费。粘性既保缓存又保稳定。

切走之后**不因「冷却到期」自动换回**，只前进，环形走一圈，每天 UTC 0 点重置。

---

## 访问前缀

```
https://你的域名/a7f3k2m9/v1/messages   ← 能用
https://你的域名/v1/messages             ← 404
https://你的域名/wrong999/v1/messages    ← 404
```

面板上点「随机生成」得到 8 位，或自己填。改完旧地址立刻失效。

**错误前缀返回 404 而不是 401**——401 等于告诉扫描器「这里有个受保护的服务」。404 让它以为什么都没有。

⚠️ 前缀**不是加密**，URL 会进浏览器历史和 CDN 日志。它挡的是「不知道地址的人」，真正挡人的是 `ACCESS_KEY`。

---

## 安全设计

| 机制 | 说明 |
|---|---|
| 会话令牌 | `<过期时间>.<HMAC(密码指纹\|过期时间)>`，无状态验签 |
| 改密码 | 指纹变 → **所有设备立刻掉线** |
| `timingSafeEq` | 常数时间比较，挡时序攻击 |
| Cookie | `HttpOnly; SameSite=Lax`，HTTPS 下加 `Secure` |
| CSRF | 非 GET 校验 `Origin` 同源 |
| 爆破 | 同 IP 失败 8 次锁 10 分钟 |
| `/health` | 匿名只回 `{"ok":true}`，细节要登录 |
| 密钥列表 | 只显示掩码，短密钥直接 `****` |

**不设 `ACCESS_KEY` = 代理完全公开。** 面板会亮黄色警告。

---

## 用什么存储，为什么

**只用 D1，不用 KV。**

| | KV 免费 | D1 免费 |
|---|---|---|
| 读 | 10 万次/天 | **500 万行/天** |
| 写 | 1000 次/天 | **10 万行/天** |
| 同一键 | **1 次/秒** | 无限制 |
| 一致性 | 最终（最长 60 秒） | **强一致** |

面板连点两次保存，KV 会失败，D1 不会。

**用量设计**：

| 操作 | 行数 |
|---|---|
| 代理请求 | **0** |
| 读配置 | 2 行（30 秒内存缓存兜住） |
| 面板保存 | 1 行 |

一天 2000 请求 ≈ 几百行读，占免费额度 **0.01%**。

**密钥游标和失败计数只存内存，不进 D1**——否则每请求一次写，10 万行/天几天就烧光。

---

## 测试

```bash
node tests/audit.mjs    # 功能审计：115 项
node tests/t5d1.mjs     # 单元：68 项
node tests/e2e5d1.mjs   # 真实 TCP 端到端：36 项
```

三个都不需要网络，用本地 mock 的 D1 和上游。

`tests/audit.mjs` 会把每个功能单独立项打印出来，失败带原因。

---

## 已知边界

- **面板是单页、无客户端路由**。故意如此——Worker 的静态资源 fallback 会把 `/v1/messages` 吃掉。
- **配置文件缓存 30 秒**。改完只有当前 isolate 立即生效，其他最长 30 秒。
- **密钥游标是内存状态**。isolate 重启回落到哈希初值，代价是最多白试一次坏 key。
- **流式请求不重试**。body 无法重放，multipart/二进制只试一次。
- **提示词注入只影响请求体**，改不了模型权重。这是能做的全部。

---

## 目录

```
src/          五个版本的 Worker
wrangler/     对应的 wrangler 配置
docs/         部署文档、四种模式详解
tests/        自测脚本（无网络依赖）
tools/        set-prompt.mjs：从 prompt.txt 生成 wrangler 配置
schema.sql    D1 建表
prompt.txt    提示词示例（换成你自己的）
```

---

## License

MIT
