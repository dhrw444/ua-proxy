#!/usr/bin/env python3
"""验 wrangler/*.toml 能被标准 TOML 解析器读进去，且关键字段对。

存在的原因：打包时手滑把 [vars] 写空、或 main 指向不存在的文件，
在 Cloudflare 那边只会得到一句含糊的部署错误。
"""
import glob
import os
import sys
import tomllib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(ROOT)

fail = 0
files = sorted(glob.glob("wrangler/*.toml"))

for f in files:
    if "local" in os.path.basename(f):
        continue  # 生成物，不进检查
    try:
        with open(f, "rb") as fh:
            d = tomllib.load(fh)
    except Exception as e:
        print(f"FAIL {f} — 解析失败: {e}")
        fail += 1
        continue

    errs = []
    if not d.get("name"):
        errs.append("缺 name")
    main = d.get("main", "")
    if not main:
        errs.append("缺 main")
    elif not main.startswith("src/"):
        errs.append(f"main 应指向 src/，实际是 {main}")
    elif not os.path.exists(main):
        errs.append(f"main 指向的文件不存在: {main}")

    # 5 号必须有 D1 绑定；1-4 号不应该有 KV 也不再需要额外绑定
    if "5-panel" in f:
        dbs = d.get("d1_databases") or []
        if not dbs:
            errs.append("5 号缺 [[d1_databases]]")
        elif dbs[0].get("binding") != "DB":
            errs.append(f"D1 binding 应为 DB，实际是 {dbs[0].get('binding')}")

    if d.get("kv_namespaces"):
        errs.append("还在用 KV，5 号已经改成 D1 了")

    # 空 [vars] 表是无害的，但多半是手滑，提醒一下
    if "vars" in d and not d["vars"]:
        errs.append("[vars] 是空表，可能是手滑")

    if errs:
        print(f"FAIL {f} — " + "; ".join(errs))
        fail += 1
    else:
        print(f"ok   {f}")

print()
print(f"{len(files)} 个文件，{fail} 个失败")
sys.exit(1 if fail else 0)
