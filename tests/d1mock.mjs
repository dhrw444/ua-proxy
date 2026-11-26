// 本地 D1 mock —— 只实现 worker 用到的几条 SQL，按模式匹配
export function makeDB(seed = {}) {
  const cfg = new Map(Object.entries(seed.cfg || {}));
  let keys = (seed.keys || []).map((k, i) => ({
    id: k.id != null ? k.id : i + 1,
    label: k.label || "",
    secret: k.secret,
    enabled: k.enabled === false ? 0 : 1,
    ts: Date.now(),
  }));
  let nextId = keys.reduce((m, k) => Math.max(m, k.id), 0) + 1;
  const stats = { reads: 0, writes: 0, queries: 0 };

  function run(sql, args) {
    stats.queries++;
    const s = sql.replace(/\s+/g, " ").trim();

    if (/^SELECT v FROM cfg WHERE k = \?$/i.test(s)) {
      const v = cfg.get(args[0]);
      return { first: v !== undefined ? { v } : null, results: v !== undefined ? [{ v }] : [] };
    }
    if (/^INSERT INTO cfg/i.test(s)) {
      cfg.set(args[0], args[1]);
      stats.writes++;
      return { success: true, meta: { changes: 1 } };
    }
    if (/^SELECT id,label,secret,enabled FROM upstream_keys WHERE enabled = 1/i.test(s)) {
      const r = keys.filter((k) => k.enabled === 1);
      stats.reads += r.length;
      return { results: r };
    }
    if (/^SELECT id,label,secret,enabled,ts FROM upstream_keys/i.test(s)) {
      stats.reads += keys.length;
      return { results: keys.slice() };
    }
    if (/^INSERT INTO upstream_keys/i.test(s)) {
      keys.push({ id: nextId++, label: args[0], secret: args[1], enabled: 1, ts: args[2] });
      stats.writes++;
      return { success: true };
    }
    if (/^DELETE FROM upstream_keys WHERE id = \?/i.test(s)) {
      const before = keys.length;
      keys = keys.filter((k) => k.id !== args[0]);
      stats.writes++;
      return { success: true, meta: { changes: before - keys.length } };
    }
    if (/^UPDATE upstream_keys SET enabled = 1 - enabled/i.test(s)) {
      const k = keys.find((x) => x.id === args[1]);
      if (k) k.enabled = k.enabled ? 0 : 1;
      stats.writes++;
      return { success: true };
    }
    throw new Error("mock DB: 未支持的 SQL → " + s.slice(0, 80));
  }

  return {
    _cfg: cfg,
    _keys: () => keys,
    _stats: stats,
    prepare(sql) {
      let bound = [];
      const api = {
        bind(...a) {
          bound = a;
          return api;
        },
        async first() {
          const r = run(sql, bound);
          return r.first !== undefined ? r.first : (r.results && r.results[0]) || null;
        },
        async all() {
          const r = run(sql, bound);
          return { results: r.results || [], success: true };
        },
        async run() {
          const r = run(sql, bound);
          return { success: true, meta: r.meta || { changes: 0 } };
        },
      };
      return api;
    },
  };
}
