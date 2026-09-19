"""算出云侧 RDMD 模块的**实际依赖闭包**，回答"部署 cloud/ 够不够"。

为什么需要这个：云 API 的 rdmd 模块 re-export 了桌面端的共享契约
（`src/shared/contracts/uBuddyReverseDetective.js` 与 `uBuddyPlanExec.js`），
这是刻意的设计 —— 两侧对"什么算合法判定"必须逐字一致，云侧不许另立一份字面量。
代价是**云侧从此有了一个 cloud/ 之外的运行时依赖**，而"只同步 cloud/ 目录"的部署
会在这条 import 上崩掉，且崩在启动阶段（`ERR_MODULE_NOT_FOUND`），
错误信息指向一个 cloud/ 里根本不该存在的路径 —— 很难第一眼看懂。

所以这里不靠人工维护清单，而是从入口开始递归跟随相对 import，
把闭包里所有落在 cloud/ 之外的文件算出来。部署脚本直接用它当 INCLUDE，
依赖关系变了清单自动跟着变。

用法：python scripts/_rdmd_cloud_deps.py
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 云 API 启动时会真正 import 到的 RDMD 入口。
#
# **为什么 TPM 也在里面**：`cloud/src/modules/tpm/index.mjs` 现在没有 HTTP 路由，
# 所以云 API 启动路径并不会加载它 —— 按"启动时会不会 import"这个标准它本可以不在。
# 但它**是部署出去的那棵树的一部分**（`cloud/src` 整目录上传），并且它 import 了
# `src/shared/contracts/uBuddyTaskPublicMemory.js`（在 cloud/ 之外）。
# 不把它列进来，闭环就是：文件传上去了、依赖没传 —— 谁哪天给它加一条路由，
# 症状就是启动即崩的 `ERR_MODULE_NOT_FOUND`，而报错指向 cloud/ 之外的路径。
# 所以判据不是"启动时用不用"，而是"它是不是我们部署的东西"。
ENTRY_POINTS = [
    "cloud/src/modules/rdmd/index.mjs",
    "cloud/src/modules/rdmd/contract.mjs",
    "cloud/src/modules/rdmd/privacy.mjs",
    "cloud/src/modules/rdmd/backend.mjs",
    "cloud/src/modules/tpm/index.mjs",
]

# 匹配 `from './x'` / `from "../y"`，含 import 与 export ... from 两种形式。
FROM_RE = re.compile(r"""from\s+['"](\.[^'"]+)['"]""")


def closure(entry_points: list[str] | None = None) -> set[str]:
    """相对 import 闭包，返回值是相对仓库根的 posix 路径集合。"""
    pending = list(entry_points or ENTRY_POINTS)
    seen: set[str] = set()
    while pending:
        rel = pending.pop()
        if rel in seen:
            continue
        path = ROOT / rel
        if not path.exists():
            # 少一个文件要立刻可见，不能让闭包"静默变小"。
            raise FileNotFoundError(f"模块不在磁盘上: {rel}")
        seen.add(rel)
        for spec in FROM_RE.findall(path.read_text(encoding="utf-8")):
            target = (path.parent / spec).resolve()
            try:
                relative = target.relative_to(ROOT).as_posix()
            except ValueError:
                continue
            pending.append(relative)
    return seen


def outside_cloud(entry_points: list[str] | None = None) -> list[str]:
    return sorted(rel for rel in closure(entry_points) if not rel.startswith("cloud/"))


def main() -> int:
    modules = closure()
    outside = outside_cloud()
    print(f"闭包内模块数: {len(modules)}")
    print(f"其中落在 cloud/ 之外（必须随部署一起上传）: {len(outside)}")
    for rel in outside:
        print(f"  {rel}")
    if not outside:
        print("  (无 —— cloud/ 自包含了)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
