#!/usr/bin/env python3
"""状态板配置按通用缺省、团队缺省、用户配置的顺序合并。"""
import json
import os
import shutil
import sys
import time
from pathlib import Path

DEFAULTS = {
    "board_roots": ["~/work", "~/.claude"],
    "web_root": "~/.claude/boards-web",
    "state_dir": "~/.status-board",
    "port": 8777,
    # ⭐ 0918(#4957):板顶 eyebrow 里那个前缀原来写死成 `workline`(脚本里 20 处)。
    #   AI 平台那个仓的正本是 `track:`,它为此建了两套标签。⇒ 前缀进配置。
    #   ⛔ **第一个是缺省**:作者没在 eyebrow 写前缀时按它算,也用在文案里。
    #   ⚠ 解析侧和查询侧必须同批认同一份表 —— 只改一半会让全机开卡数闸**假绿**
    #     (板写 `track:x`、查询拼 `workline:x` ⇒ 标签不存在 ⇒ gh 静默返回空 ⇒ 板写「0 张开卡」)。
    "eyebrow_prefixes": ["workline", "track"],
    # ⭐ 0918(设计系统 v2.9 报):方案板经 8777 引用 `../tokens/product.css`,而那份镜像
    #   **没有任何代码维护过** —— 是当初手工放进去的一次性副本,停在 2026-08-28、比真身少 20 行。
    #   20 个已发布方案板链着它,读者看到的是一份冻结的令牌表,而骨架的告警条给的补救是错的
    #   (「请走 http 打开」—— 读者本来就在 http 上)。⇒ 让 publish / sync 顺手落一次,变成**依赖**。
    # ⛔⛔ `ref` 必须是 `origin/main`,**不能是工作区** —— 实测:主仓工作树干净、却落后 origin/main
    #   371 个提交,那份 product.css 是 282 行、没有新令牌。照工作区落 = 每次把新令牌抹掉一遍。
    #   (`board.py` 里另一处早有同样的注释:各 worktree 的工作树互不相同,唯一对所有人一样的是 origin/main。)
    # ⚠ 只写、不删:web_root 里源里没有的文件(比如 9 张产品图)照旧保留。
    # 依据: 公开版不绑定团队仓，私有源由部署配置提供。
    "web_mirrors": [],
    "mirror_ref": "origin/main",
    "team_identity": "",
    # ⭐ #4949:打包成 skill 的那份副本放哪。⛔ 它是**副本**,正本永远是 ~/.claude/scripts/ ——
    #   所以必须有东西保证两边一致,否则它建好的当天就开始腐烂(0918 同一天我修过两次同形状的病)。
    "skill_dir": "~/.claude/skills/status-board",
    # 依据: 11-25 发布配置及既有两道不同的他人判据。
    "skill_source": {"repo": "", "path": "skills/status-board"},
    "owner_names": ["负责人"],
    "other_names": [],
    "wait_line_aliases": ["记忆助手"],
    "ask_other_names": None,
    "default_repo": "",
    "public_repo": "",
    "public_board": "",
    "public_work_dir": "",
    "public_card": "",   # 依据: 公开同步的放行卡号(他点过的那张),空 = 自动同步拒推
    "launch_service": "com.status-board.boards-web",
    "windows_task": "StatusBoardWeb",
    "skill_agent": "",
    "skill_publish": False,
}

_CACHE = None

# 依据: 旧升级器只复制旧文件表。安装了同版团队 skill 时可读它的缺省；
# 公开发行版关闭这条过渡路径。
_TEAM_DEFAULTS_FILE = "team-defaults.json"
_TEAM_SKILL_FALLBACK = ""


def _read_config(path):
    try:
        with open(path, encoding="utf-8") as handle:
            value = json.load(handle)
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _team_defaults():
    module = Path(__file__).resolve()
    adjacent = module.with_name(_TEAM_DEFAULTS_FILE)
    if adjacent.is_file():
        return _read_config(adjacent)
    if not _TEAM_SKILL_FALLBACK or module != Path("~/.claude/scripts/board_paths.py").expanduser().resolve():
        return {}
    for location in (DEFAULTS["skill_dir"], *_SKILL_DIR_FALLBACKS):
        scripts = Path(location).expanduser() / "scripts"
        candidate = scripts / _TEAM_DEFAULTS_FILE
        try:
            if candidate.is_file() and (scripts / module.name).read_bytes() == module.read_bytes():
                return _read_config(candidate)
        except OSError:
            continue
    return {}


def config_path(team=None):
    explicit = os.environ.get("BOARD_CONFIG")
    if explicit:
        return os.path.expanduser(explicit)
    declared = (_team_defaults() if team is None else team).get("config_path")
    return os.path.expanduser(declared if isinstance(declared, str) and declared else "~/.status-board/board-config.json")


def _load():
    global _CACHE
    if _CACHE is not None:
        return _CACHE
    team = _team_defaults()
    user = _read_config(config_path(team))
    _CACHE = {key: user.get(key, team.get(key, default)) for key, default in DEFAULTS.items()}
    # 用户显式给同事名单时，两道判据都用这份名单，除非另设动手判据名单。
    if "other_names" in user and "ask_other_names" not in user:
        _CACHE["ask_other_names"] = None
    return _CACHE


def roots():
    """找板的根(绝对路径,按序)。"""
    return [os.path.expanduser(x) for x in _load()["board_roots"]]


def web_root():
    return os.path.expanduser(_load()["web_root"])


def state(*parts):
    """`state_dir` 下的路径,例:state('board-server', 'acks')。"""
    return os.path.join(os.path.expanduser(_load()["state_dir"]), *parts)


def port():
    return int(_load()["port"])


# 缺省的 skill 目录不在时依次找这几处(skills CLI 1.7.4 实读:`-a codex -g` 装到 ~/.agents/skills/<名>;
#   Codex 自己也读 ~/.codex/skills)。⛔ 只在**缺省值**指的目录不存在时才找 —— 本机 ~/.claude/skills/status-board 在 ⇒ 行为不变。
_SKILL_DIR_FALLBACKS = ("~/.agents/skills/status-board", "~/.codex/skills/status-board")


def skill_dir():
    v = str(_load().get("skill_dir") or DEFAULTS["skill_dir"])
    if v == DEFAULTS["skill_dir"] and not os.path.isdir(os.path.expanduser(v)):
        for alt in _SKILL_DIR_FALLBACKS:
            if os.path.isdir(os.path.expanduser(alt)):
                return os.path.expanduser(alt)
    return os.path.expanduser(v)


def skill_agent(sd=None):
    """自动升级时给 `npx skills add -a` 的 agent 名。配置 `skill_agent` 优先;
    否则看 skill 目录的**路径本身**(⛔ 不 realpath:Windows 上 skills CLI 把 ~/.claude/skills/<名> 做成指向 ~/.agents 的 junction,
    解开就会把 Claude Code 误判成 Codex):路径里有 `.agents` / `.codex` 这一级 ⇒ codex,其余 ⇒ claude-code(从前写死的那个)。"""
    v = _load().get("skill_agent")
    if isinstance(v, str) and v.strip():
        return v.strip()
    parts = os.path.normpath(sd if sd is not None else skill_dir()).replace("\\", "/").split("/")
    return "codex" if (".agents" in parts or ".codex" in parts) else "claude-code"


def skill_source():
    """团队仓里 skill 的位置 {repo: "owner/name", path: "skills/status-board"};配坏了 ⇒ 缺省。"""
    v = _load().get("skill_source")
    if isinstance(v, dict) and v.get("repo") and v.get("path"):
        return {"repo": str(v["repo"]), "path": str(v["path"]).strip("/")}
    return dict(DEFAULTS["skill_source"])


def _names(value):
    if not isinstance(value, list):
        return ()
    return tuple(dict.fromkeys(x.strip() for x in value if isinstance(x, str) and x.strip()))


def owner_names():
    return _names(_load().get("owner_names")) or tuple(DEFAULTS["owner_names"])


def other_names(ask=False):
    config = _load()
    names = config.get("ask_other_names") if ask else None
    return _names(config.get("other_names") if names is None else names)


def wait_line_aliases():
    return _names(_load().get("wait_line_aliases"))


def default_repo():
    return str(_load().get("default_repo") or "").strip()


def public_publish():
    config = _load()
    return (str(config.get("public_repo") or "").strip(),
            os.path.expanduser(str(config.get("public_work_dir") or state("public-publish"))),
            os.path.expanduser(str(config.get("public_board") or "")))


def launch_service(windows=False):
    key = "windows_task" if windows else "launch_service"
    return str(_load().get(key) or DEFAULTS[key])


def skill_publish():
    """这台是不是正本机(改了就推团队仓)。⛔ 缺省 False:同事机绝不往团队仓推。"""
    return _load().get("skill_publish") is True


def team_identity():
    """GitHub login → 人名 的单源。读不到就降级印 login(⛔ 不是错误)。"""
    return os.path.expanduser(str(_load().get("team_identity") or DEFAULTS["team_identity"]))


def web_mirrors():
    """要镜像进 web_root 的东西:[{repo, from, to}]。`from` 可以是目录也可以是单个文件。"""
    out = []
    for m in (_load().get("web_mirrors") or []):
        if isinstance(m, dict) and m.get("repo") and m.get("from") and m.get("to"):
            out.append({"repo": os.path.expanduser(str(m["repo"])), "from": str(m["from"]), "to": str(m["to"])})
    return out


def mirror_ref():
    """从哪个 ref 取。⛔ 缺省是 `origin/main`,别改成工作区 —— 见 DEFAULTS 里那段注释。"""
    return str(_load().get("mirror_ref") or DEFAULTS["mirror_ref"])


def eyebrow_prefixes():
    """板顶 eyebrow 认的前缀,按序;第一个是缺省(写文案、作者没写时用)。"""
    xs = [str(x).strip() for x in (_load().get("eyebrow_prefixes") or []) if str(x).strip()]
    return xs or list(DEFAULTS["eyebrow_prefixes"])


def origin():
    """给人看 / 写进 launch.json 的地址前缀。"""
    return "http://127.0.0.1:%d" % port()


# 找板时不进去的依赖 / 构建目录。⚠ 只用在「不是 git 树根、也不在 .claude 里」的普通目录上 —— 树根本来就只看 .claude / .codex。
_HEAVY_DIRS = {"node_modules", "DerivedData", "Pods", ".gradle", "build", "dist", "target", ".venv", "venv", "__pycache__"}


def walk_boards(root_list=None):
    """全机的板目录:逐个给出 `(<…>/.claude/boards 的路径, 里面的文件名列表)` —— 与原先整树 `os.walk` 挑出来的**同一批、同一顺序**。
    board.py 的 all_boards / relink_stale_copies 与 boards-index.py 的 find_boards 共用这一个(三处必须一致)。

    ⛔⛔ 0928(AI Harness v2.2【急】):原来这三处各自 `os.walk` 整个 ~/work 与 ~/.claude、一层都不剪 ——
      32 棵眼镜 worktree 的源码树、各仓 node_modules、~/.claude 的对话记录全走一遍,一次 touch 走两三遍;
      磁盘一忙,一次 touch 几分钟,全机的线都被拖住。本机实测:整树 181,678 个目录 125 秒(忙时);
      只走板可能住的地方 329 个目录 0.3 秒,找到的 22 个板目录**逐个相同**。
    ⇒ 板能住的地方(这就是契约;放在别处的板扫不到):
      · 进到名叫 `.claude` 的目录,只再往 `boards` / `worktrees` 里走;`.codex` 只往 `worktrees` 里走;
      · 进到一棵 git 工作树的根(有 `.git`,目录或文件都算),只再往 `.claude` / `.codex` 里走 —— 板只住在树根,源码树不看;
      · 其余普通目录(~/work 本身、没 git 的项目、分组文件夹)照走,只跳过依赖 / 构建目录和别的隐藏目录。
    ⚠ 改这里之前先看 board.py selftest 的 [discover] 夹具:每种住法一块板 + 两个不该走进去的诱饵。"""
    seen = set()
    errs = walk_boards.errors = []                       # 1122:读不了的目录记下来(原来 os.walk 默认吞掉 ⇒ 板悄悄少一块,见 boards-index main)
    for root in (root_list if root_list is not None else roots()):
        if not os.path.isdir(root):
            continue
        for dp, dns, fns in os.walk(root, onerror=errs.append):
            base, parent = os.path.basename(dp), os.path.basename(os.path.dirname(dp))
            if base == "boards" and parent == ".claude":
                dns[:] = []
                rp = os.path.realpath(dp)
                if rp not in seen:
                    seen.add(rp)
                    yield dp, fns
                continue
            if base == ".claude":
                dns[:] = [d for d in dns if d in ("boards", "worktrees")]
            elif base == ".codex":
                dns[:] = [d for d in dns if d == "worktrees"]
            elif base == "worktrees" and parent in (".claude", ".codex"):
                pass                                     # 每个子目录是一棵树
            elif ".git" in dns or ".git" in fns:
                dns[:] = [d for d in dns if d in (".claude", ".codex")]
            else:
                dns[:] = [d for d in dns if d not in _HEAVY_DIRS and (not d.startswith(".") or d in (".claude", ".codex"))]


# ── 跨平台(1023,Windows 支持)。⛔ 每个函数在 macOS 上与从前逐字节一致;Windows 分支还没在真 Windows 上跑过。──

def _is_win():
    return sys.platform.startswith("win")


def claude_sessions_root(home=None):
    """Claude 桌面版的会话注册表根(`<根>/<账号>/<org>/local_<id>.json`)。
    macOS = ~/Library/Application Support/Claude/claude-code-sessions(原路径,一字不改);
    Windows = %APPDATA%\\Claude\\claude-code-sessions;Linux = $XDG_CONFIG_HOME(缺省 ~/.config)/Claude/claude-code-sessions。
    home = 给 selftest 用:把「家」换成临时目录时,三种系统各自落在那个家里的哪儿(Windows 下 APPDATA 也按它算)。"""
    if sys.platform == "darwin":
        if home is None:
            return os.path.expanduser("~/Library/Application Support/Claude/claude-code-sessions")
        return os.path.join(home, "Library", "Application Support", "Claude", "claude-code-sessions")
    if _is_win():
        base = (os.path.join(home, "AppData", "Roaming") if home is not None else
                (os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")))
        return os.path.join(base, "Claude", "claude-code-sessions")
    base = (os.path.join(home, ".config") if home is not None else
            (os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config")))
    return os.path.join(base, "Claude", "claude-code-sessions")


def lock_fd(fd, blocking=True):
    """对一个 os.open 出来的 fd 上排他锁;关掉 fd 即放锁。非阻塞且被别人占着 ⇒ 抛 BlockingIOError(与 fcntl.flock 同一个约定)。
    POSIX = fcntl.flock(原样);Windows = msvcrt.locking 锁第 0 个字节(非阻塞 LK_NBLCK;阻塞 = 每 0.2 秒重试 LK_NBLCK,
    ⛔ 不用 LK_LOCK:它重试 10 秒就抛错,而原来的阻塞语义是「一直等」)。"""
    if os.name == "nt":
        import msvcrt
        while True:
            try:
                os.lseek(fd, 0, os.SEEK_SET)
                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                return
            except OSError as e:
                if not blocking:
                    raise BlockingIOError(getattr(e, "errno", 0) or 11, "lock held") from e
                time.sleep(0.2)
    import fcntl
    fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def pid_alive(pid):
    """那个进程还在吗。POSIX = os.kill(pid, 0):不存在 ⇒ False,别的 OSError(没权限等)⇒ 当它还在(与原来一致)。
    ⛔ Windows 上**绝不能** os.kill(pid, 0):0 == CTRL_C_EVENT,会给那个进程组发 Ctrl-C。⇒ 用 OpenProcess + GetExitCodeProcess。"""
    pid = int(pid)
    if os.name == "nt":
        try:
            import ctypes
            k = ctypes.windll.kernel32
            h = k.OpenProcess(0x1000, False, pid)            # PROCESS_QUERY_LIMITED_INFORMATION
            if not h:
                return k.GetLastError() == 5                 # ERROR_ACCESS_DENIED ⇒ 在,只是看不了
            try:
                code = ctypes.c_ulong()
                if k.GetExitCodeProcess(h, ctypes.byref(code)):
                    return code.value == 259                 # STILL_ACTIVE
                return True
            finally:
                k.CloseHandle(h)
        except Exception:
            return True                                      # 判不了 ⇒ 当它在(宁可留个临时文件,不误删别人的)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except OSError:
        return True


def open_path(p):
    """用系统默认程序打开(--open 用)。macOS = `open`(原样);Windows = os.startfile;其余 = xdg-open。"""
    import subprocess
    if sys.platform == "darwin":
        subprocess.run(["open", p])
    elif _is_win():
        os.startfile(p)                                      # noqa —— 只在 Windows 上有
    else:
        subprocess.run(["xdg-open", p])


def resolve_exe(name):
    """subprocess 的 argv[0]。Windows 上 npx / npm 这类是 `.cmd`,CreateProcess 不会替你补后缀 ⇒ 用 shutil.which 找全路径;
    找不到 ⇒ 原样返回名字,让调用方走它原来的「起不来」那条路(FileNotFoundError)。⛔ 其余系统原样返回(行为不变)。"""
    if _is_win():
        return shutil.which(name) or name
    return name


def detach_kwargs():
    """后台起子进程、调用方退出也不连累它。POSIX = start_new_session(原样);Windows 没有 setsid ⇒ 新进程组 + 不弹窗。"""
    if os.name == "nt":
        import subprocess
        return {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0x200) | getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
    return {"start_new_session": True}


def backup_rel(p):
    """把一个绝对路径变成「备份目录底下的相对路径」。POSIX = os.path.relpath(p, "/")(原样);
    Windows 上 relpath(…, "/") 跨盘符会抛 ValueError ⇒ 用「盘符 + 其余」。"""
    if os.name == "nt":
        drive, rest = os.path.splitdrive(os.path.abspath(p))
        return os.path.join(drive.replace(":", "").strip("\\/") or "_", rest.lstrip("\\/"))
    return os.path.relpath(p, "/")


def ensure_utf8_mode():
    """Windows:脚本里大量 open() / subprocess(text=True) 没写 encoding,Windows 缺省按本地代码页(cp936 / cp1252)读写 ——
    板是 UTF-8 中文、输出里有 ⛔ ⭐ 这类字符 ⇒ 读错 / 打印就崩。⇒ 不在 UTF-8 模式就带 `-X utf8` 原样重跑自己、透传退出码。
    ⛔ 只在 `__main__` 里调(被 import 时调会把 import 它的那个脚本重跑一遍);macOS / Linux 什么都不做。"""
    if os.name != "nt" or sys.flags.utf8_mode or os.environ.get("BOARD_UTF8_REEXEC") == "1":
        return
    import subprocess
    env = dict(os.environ, PYTHONUTF8="1", BOARD_UTF8_REEXEC="1")
    try:
        rc = subprocess.call([sys.executable, "-X", "utf8"] + sys.argv, env=env)
    except KeyboardInterrupt:
        rc = 130
    sys.exit(rc)


# ⭐ 1115 大扫除 C3:board.py 和 boards-server.py 都要用的时长,只在这里写一份(两边都 import 本文件)。
#   kit.js 读不到 Python:它那边写同名常量(ANS_SUB_CHOICE_MS / ANS_SUB_NOTE_MS = 这里 ×1000),board.py selftest「1115 大扫除 C3」比对两边相等。
# 依据: 负责人 10-26 18:43 批「写完才交」(先试):没点「交给这条线」的,只点了选项 1 分钟 / 写了字 10 分钟没再改算交(board.py _ans_submitted)
ANS_SUB_CHOICE_S, ANS_SUB_NOTE_S = 60, 600
# 依据: 负责人 11-13 18:17 卡 ask-ee1ae1b3(到点该追:伺服每 10 分钟无条件起一次 wake-lines;board.py _wake_chase 的注释同一个数)
CHASE_TICK_S = 600


def answers_file_name(page):
    """⭐ 1115 大扫除 C4:页面名 → 它的答案文件名(不含目录)。boards-server.py _ans_file 与 board.py _answers_file 共用这一份。
    先解 URL 编码、只取最后一段(带子目录的取文件名)、去空白;不是 .html / .htm、以点开头、超过 200 字 ⇒ None(伺服按 400 拒)。"""
    import re
    import urllib.parse
    page = os.path.basename(urllib.parse.unquote(str(page or ""))).strip()
    if not page or len(page) > 200 or page.startswith(".") or not re.search(r"\.html?$", page):
        return None
    return urllib.parse.quote(page, safe="") + ".json"
