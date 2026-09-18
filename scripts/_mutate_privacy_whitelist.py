"""把 privacy.mjs 的顶层 case 白名单改回历史上那个错版本（复现真实 bug），用于变异测试。

用法：
    python scripts/_mutate_privacy_whitelist.py apply     # 注入 bug
    python scripts/_mutate_privacy_whitelist.py restore   # 还原

为什么要有这个文件：`planExecDriftCloudTransport.test.js` 声称能抓住"白名单把
G_star/G_prime 裁掉"这一类 bug。声称必须被验证 —— 一个不会失败的断言等于没有断言。
（第一次注入时用 PowerShell 内联 Python，引号被 shell 吃掉，等于什么都没改，
测试当然全绿；所以这件事本身也值得写成文件而不是内联。）
"""

from __future__ import annotations

import pathlib
import sys

TARGET = pathlib.Path("cloud/src/modules/rdmd/privacy.mjs")
GOOD = "'id', 'G_star', 'G_prime'"
BAD = "'id', 'nodes', 'edges'"


def main() -> int:
    action = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    source = TARGET.read_text(encoding="utf-8")
    if action == "apply":
        if GOOD not in source:
            print("[error] 找不到正常白名单，先确认 privacy.mjs 的形状没变")
            return 1
        TARGET.write_text(source.replace(GOOD, BAD), encoding="utf-8")
        print(f"[mutate] 顶层 case 白名单已改成错误的版本：{BAD}")
        return 0
    if action == "restore":
        if BAD not in source:
            print("[ok] 已经是正常版本，无需还原")
            return 0
        TARGET.write_text(source.replace(BAD, GOOD), encoding="utf-8")
        print(f"[mutate] 已还原：{GOOD}")
        return 0
    print(__doc__)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
