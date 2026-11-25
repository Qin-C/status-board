# 状态板 http 伺服的 Windows 启动器(无窗口)。macOS 那份是 com.status-board.boards-web.plist,作用相同。
#
# 为什么要这一层、不让计划任务直接起 boards-server.py:
#   · 用 pythonw(无黑窗)起时 sys.stdout / sys.stderr 是 None,伺服或 http.server 往 stderr 写一句就抛错;
#     ⇒ 这里先把两者接到 %USERPROFILE%\.claude\boards-web\.server.log(与 macOS 同一个日志位置)。
#   · 脚本按 UTF-8 读写板;Windows 缺省是本地代码页 ⇒ 不在 UTF-8 模式就带 -X utf8 重起自己。
#
# 装法(Git Bash,见 SKILL.md 第 2 步):
#   cp "$SK"/templates/boards-web-windows.pyw ~/.claude/scripts/
#   PYW="$(command -v pythonw || command -v pyw)"
#   MSYS_NO_PATHCONV=1 schtasks /create /tn StatusBoardWeb /sc onlogon /rl limited /f \
#     /tr "\"$(cygpath -w "$PYW")\" -X utf8 \"$(cygpath -w ~/.claude/scripts/boards-web-windows.pyw)\""
#   MSYS_NO_PATHCONV=1 schtasks /run /tn StatusBoardWeb
#   (MSYS_NO_PATHCONV=1:不加的话 Git Bash 会把 /create 这类参数当成路径改写掉)
# ⚠ 还没在真 Windows 上跑过(2026-10-23 写)。
import os
import runpy
import subprocess
import sys

if not sys.flags.utf8_mode:
    subprocess.Popen([sys.executable, "-X", "utf8", os.path.abspath(__file__)],
                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000), close_fds=True)
    sys.exit(0)

home = os.path.expanduser("~")
logd = os.path.join(home, ".claude", "boards-web")
os.makedirs(logd, exist_ok=True)
log = open(os.path.join(logd, ".server.log"), "a", encoding="utf-8", buffering=1)
sys.stdout = sys.stderr = log
os.environ["BOARD_UTF8_REEXEC"] = "1"      # 已经在 UTF-8 模式了,告诉 board_paths.ensure_utf8_mode 别再重起

srv = os.path.join(home, ".claude", "scripts", "boards-server.py")
sys.argv = [srv]
try:
    runpy.run_path(srv, run_name="__main__")
except SystemExit:
    raise
except BaseException:
    import traceback
    traceback.print_exc()
    raise
