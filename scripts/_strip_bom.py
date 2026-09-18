"""把一个目录/文件里的 UTF-8 BOM 剥掉（幂等，可反复跑）。

为什么值得一个正式的小工具而不是每次临时写一段：BOM 在这台开发机的写文件路径上是
**系统性**的（Write 工具、某些编辑器都会加），而且后果因文件类型而异、且都很难从报错
反推出来：

    .mjs/.js    ``JSON.parse`` 抛 "Unexpected token ''"；云 API 直接起不来
    .sql        Postgres 报 ``syntax error at or near ""``；迁移装不上
    .sh         ``#!/usr/bin/env: No such file or directory`` —— 报错指向一个**不存在的
                可执行文件**，而真正的错是第 1 行那 3 个字节
    .py         ``SyntaxError: invalid non-printable character U+FEFF``
    package.json  静默降级（``readDesktopPackageVersion`` 的 catch 返回 '0.0.0'）

真实事故记录：``_rdmd_worker_daemon.sh`` 部署到盒子上后，每次调用都先吐一行
``#!/usr/bin/env: No such file or directory`` —— 脚本本身还能跑（因为是 ``bash <file>``
调用的），所以很容易被当成"无关噪声"放过。这类"看起来还能用"的问题是 BOM 最危险的地方。

用法：
    python scripts/_strip_bom.py                # 扫默认范围并剥掉
    python scripts/_strip_bom.py --check        # 只报告，不改（CI/本地自检用）
    python scripts/_strip_bom.py <path> ...     # 指定文件或目录
"""

from __future__ import annotations

import argparse
import pathlib
import sys

BOM = b"\xef\xbb\xbf"

# 默认扫描范围：**会被部署到盒子上、或被解释器当文本读**的那些。
# 不扫整棵 experiments/：里面有大体积语料，且它们不经过"文本解析"这条路。
DEFAULT_ROOTS = ["cloud", "scripts", "src", "network", "experiments/rdmd_detective_dataset"]
EXTS = {".mjs", ".js", ".cjs", ".py", ".sh", ".sql", ".json", ".md", ".yml", ".yaml", ".txt"}
SKIP_DIRS = {
    "node_modules", "archive", ".git", "dist", "build", "coverage",
    # 数据目录：语料/权重/运行产物，不是源码，扫它们既慢又没意义。
    "sft", "runs", "adapters", "samples", "generated",
}


def iter_files(paths: list[str]):
    for raw in paths:
        path = pathlib.Path(raw)
        if path.is_file():
            yield path
            continue
        if not path.is_dir():
            continue
        for candidate in path.rglob("*"):
            if not candidate.is_file() or candidate.suffix.lower() not in EXTS:
                continue
            if SKIP_DIRS & set(candidate.parts):
                continue
            yield candidate


def main() -> int:
    parser = argparse.ArgumentParser(description="Strip UTF-8 BOMs (idempotent).")
    parser.add_argument("paths", nargs="*", default=None, help="文件或目录；默认扫仓库常见范围")
    parser.add_argument("--check", action="store_true", help="只报告，不修改")
    args = parser.parse_args()

    targets = args.paths or DEFAULT_ROOTS
    offenders: list[pathlib.Path] = []
    for path in iter_files(targets):
        try:
            if not path.read_bytes().startswith(BOM):
                continue
        except OSError as exc:
            print(f"[warn] 读不了 {path}: {exc}", file=sys.stderr)
            continue
        offenders.append(path)
        if not args.check:
            path.write_bytes(path.read_bytes()[3:])

    if offenders:
        verb = "发现带 BOM" if args.check else "已剥掉 BOM"
        print(f"[bom] {verb} {len(offenders)} 个文件：")
        for path in offenders:
            print(f"  {path}")
    else:
        print(f"[bom] 干净：扫描范围内没有带 BOM 的文件（{len(list(iter_files(targets)))} 个文件）")
    # --check 时用退出码表达"有问题"，方便接进流水线。
    return 1 if (offenders and args.check) else 0


if __name__ == "__main__":
    raise SystemExit(main())
