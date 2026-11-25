#!/usr/bin/env python3
"""把本机所有工作线的状态板汇成一页,并显示各自的新鲜度。

为什么要它(负责人 2026-08-26 的担心,原话):
> 「其他 session 在推进的过程中,不一定会遵守这个或者触发这个状态板的规则。
>  这样的话,不管我们的规则设计的有多好,没有人用,那问题是最大的。」

⇒ 这个脚本**不强迫任何人遵守**,它只做一件事:**让不遵守变得看得见**。
   一条线的板三天没动,这页上就是红的;一条活跃的线压根没有板,这页上会明说。
   负责人不必去逐条检查谁照做了 —— 打开这一页就知道。

⚠ 它是**只读投影**,不是第二真相源:每条线的板仍是那条线的正本,这页只汇总不改写。
   (出处:负责人 0826「可以有一个很薄的全局首页,但它不直接维护任务」)

用法:  python3 ~/.claude/scripts/boards-index.py [--open]
      (board.py 的 touch / sync / lint 会带 `--background` 在后台顺带叫一轮;同一时刻只跑一轮,见 `_run_locked`)
"""
import glob, json, os, re, sys, time, html, subprocess

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board_paths as BP        # 落点表(缺省 = 本机现状),见 board_paths.py
HOME = os.path.expanduser("~")
# ⛔ 0918(#4949 干净 HOME 验收当场抓到):这里原来写死 `~/work` + `~/.claude`,
#   **没走配置** —— 别人机器上板放在别处就扫出「0 块板」,而它长得像「你还没建板」。
SCAN = BP.roots()
OUT  = os.path.join(HOME, ".claude", "boards-index.html")
# ⛔ 1009(状态板 v1.5 的子代理当场撞上):上面这个落点写死、不走配置 —— 从临时环境(`BOARD_CONFIG=<临时 config>`)跑,
#   别的全落在临时目录,唯独这一页照样盖掉真的 `~/.claude/boards-index.html`(里面变成临时目录那几块板)。
#   ⇒ 带着 BOARD_CONFIG 跑的时候,这一页落到那份配置的 state_dir 里;没带(日常)时一个字不变。
if os.environ.get("BOARD_CONFIG"):
    OUT = BP.state("boards-index.html")



EXTRA_FILES = []


def _is_board_file(p):
    """板 = 有 data-gen(kit 外壳)或标题含「状态板」。先蒙 script/style/注释 —— kit 自带 data-gen 字样,不蒙会把方案板也认成板。"""
    try:
        s = open(p, encoding="utf-8", errors="ignore").read()
    except OSError:
        # ⛔ 1122(客户项目甲-总控 #b4e2):读不到原来回 False ⇒ 板被当成方案页、web 根里的板页被清掉(8777 404,不出声)。
        #   和 board.py 的 _is_board_file 同一判法:读不到当板(宁可多挂)。
        return True
    body = re.sub(r"<script\b.*?</script>|<style\b.*?</style>|<!--.*?-->", " ", s, flags=re.S)
    t = re.search(r"<title>(.*?)</title>", body, re.S)
    return bool(re.search(r'data-gen="', body)) or ("状态板" in (t.group(1) if t else ""))

def find_boards():
    """扫出全机的板。

    ⚠⚠ 0826 两处订正,两处都是**静默丢板**:

    ① 原来用 `glob.glob(root + "/**/.claude/boards/*.html", recursive=True)`。
       **Python 的 `**` 不会穿过隐藏目录** —— 而 worktree 的路径里有 `.claude/worktrees/`,
       所以任何住在 worktree 里的板对这个 glob **永远不可见**。改用 os.walk。
    ② 原来还有一句 `if "/worktrees/" in p: continue`,理由是「worktree 里的板会和主仓重复」。
       对**副本**成立,对**只存在于 worktree 的板**就是静默丢弃。

    两条叠加的后果:`cc控制` 那块板在负责人的标签栏里开着,却**从来没出现在总览页上**,
    那条线也因此在「各线自己刷板」那一轮里没被通知到 —— 是负责人自己发现少了一条线。
    ⭐ 同一族:①把一个实现细节当成「扫得到全部」;②把「我观察到的那几个」当成普遍规律。

    ⇒ 现在:仓根的板一律收;worktree 里的板**只有当仓根没有同名板时**才收,
      并记进 `find_boards.homeless` —— 那种板会随 worktree 被删而消失,该搬回仓根。
    """
    roots, wt, seen = {}, [], set()
    # ⭐ 0928(AI Harness v2.2【急】)③:原来整树 os.walk SCAN —— 每次 touch 都在后台叫一轮,忙时一轮几分钟、跟各线的刷板抢磁盘。
    #   ⇒ 只走板可能住的地方,与 board.py 共用一个(board_paths.walk_boards);两边「必须一致」从此是同一段代码。
    for dirpath, filenames in BP.walk_boards(SCAN):
        for fn in filenames:
            if not fn.endswith(".html") or fn.endswith(".bak") or fn == "_index.html":
                continue
            p = os.path.join(dirpath, fn)
            rp = os.path.realpath(p)
            if rp in seen:
                continue
            seen.add(rp)
            # ⭐ 0908 负责人:「3591 方案板 / C001 面试题 / 4178 方案板…怎么会是线?这几个都只是单纯的事项,还带问号」
            #   ⇒ 与 board.py `--all` 同一条判据:没有 data-gen 且标题不含「状态板」的,不是板,不进总览(方案板 / 测试单该放 boards-web/proposals/)。
            if fn.startswith("_") or not _is_board_file(p):
                if not fn.startswith("_"):
                    EXTRA_FILES.append(p)        # 方案板 / 测试单:不当线,但仍挂到 webroot/proposals/ 下可达
                continue
            if "/worktrees/" in p or "/.codex/worktrees/" in p:
                wt.append(p)
            else:
                roots[fn] = p
    out = sorted(roots.values())
    homeless = sorted(p for p in wt if os.path.basename(p) not in roots)
    find_boards.homeless = set(homeless)

    # ⚠ 同名板出现在多个路径 = 「板随 worktree 漂移」这个 bug 的特征(总控 v5.1 2026-08-27 报,
    #   负责人亲自撞到:他看的那份是两小时前的,而写板那一棒每次都照规则做了)。
    #   ⭐ 这里必须**主动报**,因为上面的挑选逻辑会安静地只取一份 —— 看起来一切正常。
    #   硬链接(同 inode)不算重复:那本来就是同一个文件。
    dup = {}
    for p in list(roots.values()) + wt:
        dup.setdefault(os.path.basename(p), []).append(p)
    find_boards.duplicates = {
        k: v for k, v in dup.items()
        if len({os.stat(x).st_ino for x in v if os.path.exists(x)}) > 1
    }
    return out + homeless


def read_board(p):
    try:
        s = open(p, encoding="utf-8", errors="replace").read()
    except Exception as e:
        return {"path": p, "title": os.path.basename(p), "epoch": None, "err": str(e), "pending": None}
    m = re.search(r"<title>(.*?)</title>", s, re.S)
    title = html.unescape(m.group(1).strip()) if m else os.path.basename(p)
    g = re.search(r'data-gen="(\d+)"', s)
    epoch = int(g.group(1)) if g else None
    # 「要你的」那区有几件 —— 板自己声明的数字,不去猜
    #
    # ⚠ 语义解析,不钉死某一种标记写法:找到文字含「要你的」的那个 h2(⚠ 别命中「要你的手」),
    #   剥掉标签后取第一个数字;数字可能在 h2 内部,也可能在紧随其后的兄弟 <span>。
    #   ⭐ 钉死写法的那一版 4 块板里 3 块读不出来 —— **在「标记字符串」那一层取证,
    #     却拿它当「这个区存不存在」的结论**。消费者该宽容,契约不该是某一种写法。
    #   ⛔ 0908(#4495):五区形态(等你拍 / 要你的手)的解析分支已删,只认三块形态。
    pend = None
    # ⛔⛔ 2026-08-31:必须先剥 <style>/<script>,否则会命中**注释里的示例**。
    #   实犯:kit 的 CSS 注释里为了解释「emoji 并进 h2 会让闸读不到区标题」这个事故,
    #   逐字写了一个带 emoji 的示例区标题 ⇒ 本函数扫全文时**先命中那段注释**,
    #   而它里面没有数字 ⇒ 落到下面的「往后 120 字符找数字」⇒ 抓到 CSS 里的任意一个数。
    #   后果:iOS 板真值「0 件」,同侪条显示「2」——**10 块板里 9 块显示同一个假数 2**。
    #   🔑 **讲这个 bug 的那段注释,自己制造了同一个 bug**(「使用 vs 提及」,本机第 N 次)。
    #   ⚠ 而 `board.py lint` 那条「boards-index 读得出要你的几件」**照样绿** ——
    #     它只验「读得出」,不验「读得对」。**能读出一个数,和那个数是对的,是两件事。**
    s_vis = re.sub(r"<(style|script)\b.*?</\1>", " ", s, flags=re.S | re.I)
    for hm in re.finditer(r"<h2\b[^>]*>(.*?)</h2>", s_vis, re.S):
        inner = hm.group(1)
        text = html.unescape(re.sub(r"<[^>]+>", " ", inner))
        if "要你的" not in text or "要你的手" in text:   # ⚠ 只认三块形态的「要你的」
            continue
        # 数字可能在 h2 内部,也可能在紧随其后的兄弟 <span class="n">
        after = s_vis[hm.end():hm.end() + 120]
        num = re.search(r"(\d+)", text)
        if not num:
            num = re.search(r"(\d+)", html.unescape(re.sub(r"<[^>]+>", " ", after)))
        if num:
            pend = int(num.group(1))
        break
    # 兜底:区里没写数字,但板上明说「没有需要你拍的」⇒ 当 0(读不出时的最后一档)
    if pend is None and ("没有需要你拍的" in s or "没有需要他拍的" in s):
        pend = 0
    archived = bool(re.search(r'name="board-status"\s+content="archived"', s))
    # ⭐ 0914 负责人(状态板线 ㊴):「这么多规则和机制,当前这些 session 到底能不能很好地遵守?」
    #   ⇒ 落没落地不靠问:每块板「没做完的写清了吗」直接数出来(与 board.py lint 同一个函数,不另写一遍)。
    comp = None
    try:
        _b = _board_mod()
        _y = _b._yours_zone_rows(s) if _b else None
        if _y:
            comp = {"open": sum(1 for f in _y["facts"] if f["open"]), "vague": len(_y["open_missing"]),
                    "late": len(_y["late"]), "fake_done": len(_y["done_open_sub"])}
    except Exception:
        comp = None
    return {"path": p, "title": title, "epoch": epoch, "err": None,
            "pending": pend, "archived": archived, "comp": comp}


_BOARD_MOD = []
def _board_mod():
    if not _BOARD_MOD:
        try:
            import importlib.util
            spec = importlib.util.spec_from_file_location("board_for_index", os.path.join(os.path.dirname(os.path.abspath(__file__)), "board.py"))
            m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
            _BOARD_MOD.append(m)
        except Exception:
            _BOARD_MOD.append(None)
    return _BOARD_MOD[0]


def repo_of(p):
    # <repo>/.claude/boards/x.html → <repo>
    return os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(p))))


def LINK_ABS(p):
    return "file://" + p


def build_rows(boards, now, link_for):
    rows = []
    for b in sorted(boards, key=lambda x: (x["epoch"] or 0), reverse=True):
        # ⚠ 存档的板不该标红。红色的意思必须始终是「真的有问题」——
        #   一条线正常收尾后永远挂着红字,会让人学会忽略红色,那这一页就废了
        #   (2026-08-27 AI平台线迁往 Codex 时暴露)。
        if b.get("archived"):
            age_txt, tone = "已存档 · 该线迁走了", "archived"
        elif b["epoch"] is None:
            age_txt, tone = "板上没写生成时间", "crit"
        else:
            mins = (now - b["epoch"]) // 60
            if   mins < 60:   age_txt, tone = f"{mins} 分钟前", "good"
            elif mins < 480:  age_txt, tone = f"{mins // 60} 小时前", "warn"
            else:             age_txt, tone = f"{mins // 60} 小时前 · 大概率没人在维护", "crit"
        pend = "—" if b["pending"] is None else (f"{b['pending']} 件" if b["pending"] else "无")
        c = b.get("comp")
        if c is None:
            comp_txt, comp_cls = "—", "comp"
        else:
            bad = [x for x in ((f"{c['vague']} 件没写清" if c["vague"] else ""), (f"{c['fake_done']} 件标了做完却没做完" if c["fake_done"] else ""),
                               (f"{c['late']} 件过期" if c["late"] else "")) if x]
            comp_txt = f"没做完 {c['open']}" + (" · " + " · ".join(bad) if bad else " · 都写清了")
            comp_cls = "comp bad" if bad else "comp"
        rows.append(
            f'<tr class="{tone}"><td><a href="{html.escape(link_for(b["path"]))}">{html.escape(b["title"])}</a>'
            f'<div class="repo">{html.escape(repo_of(b["path"]))}</div></td>'
            f'<td class="age">{html.escape(age_txt)}</td><td class="pend">{pend}</td>'
            f'<td class="{comp_cls}">{html.escape(comp_txt)}</td></tr>'
        )
    return rows


def build_doc(rows, boards, same_dir=False, webroot=False):
    body = "\n".join(rows) or '<tr><td colspan="4">本机一块状态板都没有。</td></tr>'
    note = (
        "<b>这页存在的唯一理由：让「没人照规则用」变得看得见。</b><br>"
        "一条线的板超过 8 小时没动就会标红——那通常不是\"这条线没事发生\"，而是<b>那条线没在维护它的板</b>。<br>"
        "规则本身在 <code>~/.claude/rules/common/status-board.md</code>，自动注入本机每个 session。"
        "重新生成：<code>python3 ~/.claude/scripts/boards-index.py --open</code>"
    )
    if webroot:
        note = (
            "<b>这是 http 版 —— 侧栏里唯一点得动的那份。</b>"
            "Claude Desktop 的面板把 <code>file://</code> 渲成 <b>data: 静态快照</b>："
            "看得见，但<b>点不动、JS 也不跑</b>（自动刷新 / 已看过勾选 / 自算年龄全失效）。"
            "换成 <code>http://127.0.0.1</code> 之后全部恢复正常，已实测。<br>"
            "这里的每个文件都是原板的<b>硬链接</b>（同一个 inode），不是拷贝，不会漂。"
        )
    elif same_dir:
        note = (
            "<b>这是「同目录版」总览。</b>本仓的板用<b>相对路径</b>链接（<code>./x.html</code>），"
            "为的是能在 <b>Claude Desktop 的 in-app browser</b> 里点得动——"
            "全局版放在 <code>~/.claude/</code>、板在 <code>~/work/</code>，跨目录树，面板会拦掉。<br>"
            "它和全局版是<b>同一个脚本同一次运行生成的投影</b>，不是第二份真相。"
            "重新生成：<code>python3 ~/.claude/scripts/boards-index.py</code>"
        )
    return f"""<meta charset="utf-8">
<title>本机状态板总览</title>
<style>
:root{{--bg:#F5F7F9;--card:#fff;--line:#D8DFE5;--ink:#161C24;--ink2:#4A5663;--ink3:#77848F;
--good:#3A805A;--warn:#B4741A;--crit:#AE4034}}
@media(prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#10141A;--card:#171D25;--line:#2E3742;
--ink:#E6EBF1;--ink2:#A9B5C1;--ink3:#7A8894;--good:#63BC8D;--warn:#D9A052;--crit:#E0766A}}}}
body{{background:var(--bg);color:var(--ink);font:15px/1.6 "IBM Plex Sans","PingFang SC",system-ui;margin:0;padding:36px 20px}}
.wrap{{max-width:760px;margin:0 auto}}
h1{{font-size:27px;letter-spacing:-.02em;margin:0 0 6px}}
p.sub{{color:var(--ink2);margin:0 0 22px;font-size:14.5px}}
table{{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}}
th{{text-align:left;font:600 11.5px/1 ui-monospace,monospace;letter-spacing:.1em;text-transform:uppercase;
color:var(--ink3);padding:13px 16px;border-bottom:1px solid var(--line)}}
td{{padding:13px 16px;border-bottom:1px solid var(--line);vertical-align:top}}
tr:last-child td{{border-bottom:none}}
a{{color:inherit;text-decoration:none;font-weight:600}}
a:hover{{text-decoration:underline}}
.repo{{font:11.5px ui-monospace,monospace;color:var(--ink3);margin-top:2px}}
.age,.pend{{font:13px ui-monospace,monospace;white-space:nowrap}}
.comp{{font-size:13px}} .comp.bad{{color:#b42318;font-weight:600}}
tr.good .age{{color:var(--good)}} tr.warn .age{{color:var(--warn)}}
tr.crit .age{{color:var(--crit);font-weight:600}}
tr.archived{{opacity:.55}} tr.archived .age{{color:var(--ink3)}}
.note{{margin-top:20px;font-size:13.5px;color:var(--ink2);background:var(--card);border:1px solid var(--line);
border-radius:12px;padding:15px 17px}}
.note b{{color:var(--ink)}}
</style>
<div class="wrap">
<h1>本机状态板总览</h1>
<p class="sub">生成于 {time.strftime('%Y-%m-%d %H:%M')} · 共 {len(boards)} 块 · 这一页<b>只读</b>，不改任何板</p>
<table>
<tr><th>工作线</th><th>板多久没动了</th><th>要你的</th><th>没做完的写清了吗</th></tr>
{body}
</table>
<div class="note">
{note}
</div>
</div>
"""


def main():
    boards = [read_board(p) for p in find_boards()]
    now = int(time.time())

    # ⛔ 0918(Handoff 线的一句提醒逼我实测出来的):新用户机器上 `~/.claude/` **还不存在**
    #   ⇒ 这里直接 FileNotFoundError traceback。我早先的沙箱验收没撞到,**因为我手工先建了那个目录**
    #   —— 验收环境比真实环境宽,等于没验。
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    _atomic_write(OUT, build_doc(build_rows(boards, now, LINK_ABS), boards))
    print(f"{len(boards)} 块板 → {OUT}")
    for _e in getattr(BP.walk_boards, "errors", [])[:5]:      # 1122:扫目录出错原来被 os.walk 吞掉 ⇒ 板悄悄少一块
        print(f"  ⚠ 扫板时读不了目录:{_e} —— 这一轮可能漏了那里的板(web 根里它的页不会被删)")
    if not boards:
        # ⛔ 0918:「0 块板」和「你还没建板」在输出上一模一样 —— 而新用户第一次跑时,
        #   真正的原因多半是**板不在这几个根底下**。⇒ 把扫了哪儿、怎么改说出来。
        print("  ⚠ **一块板都没扫到** —— 这不一定是「你还没建板」。刚才扫的是:")
        for _r in SCAN:
            print(f"      · {_r}{'' if os.path.isdir(_r) else '   (这个目录不存在)'}")
        print("    板的形状必须是 `<某个根>/<项目>/.claude/boards/*.html` 或 `<某个根>/.claude/boards/*.html`。")
        print(f"    你的项目不在上面这些根底下 ⇒ 在 {os.path.expanduser('~/.status-board/board-config.json')} 里写:")
        print('      {"board_roots": ["~/你放项目的地方"]}')
    for b in boards:
        age = "无时间戳" if b["epoch"] is None else f"{(now-b['epoch'])//60} 分钟前"
        print(f"  · {b['title']}  ({age})")

    # ⭐ 同目录版:`<repo>/.claude/boards/_index.html`
    #
    # 为什么要第二份(2026-08-27 负责人实测触发):全局版放在 ~/.claude/,板放在 ~/work/<repo>/,
    # **跨目录树**。在 Chrome 里点得开,但在 Claude Desktop 的 in-app browser 里
    # **点了没有任何反应** —— 负责人原话。假说:面板允许 file:// 跳同目录、拦跨目录。
    # ⇒ 同目录版对本仓的板用**相对路径** `./x.html`,把这个假说变成一次可验证的点击。
    # ⚠ 它不是第二真相源:和全局版同一个脚本、同一次运行、同一批数据生成的**投影**。
    for d in sorted({os.path.dirname(b["path"]) for b in boards}):
        def link_for(p, _d=d):
            return "./" + os.path.basename(p) if os.path.dirname(p) == _d else "file://" + p
        out = os.path.join(d, "_index.html")
        _atomic_write(out, build_doc(build_rows(boards, now, link_for), boards, same_dir=True))
        print(f"  ↳ 同目录版 → {out}")

    dups = getattr(find_boards, "duplicates", {})
    if dups:
        # ⚠⚠ 报告必须**按 inode 分组**,不能把硬链接和真拷贝混在一张清单里(#3651,CI 线 2026-08-28 报)。
        #   触发条件本来就是 inode-aware 的(见 find_boards),但**报告不是** —— 于是一块板
        #   「3 个硬链接 + 2 个真拷贝」会被原样列成「7 份」。
        #   ⭐ 后果比看起来严重:`status-board.md` 推荐的修法就是**把拷贝换成硬链接**,
        #     而照着做完之后这条告警**一个字都不会变** ⇒ 它教会所有人忽略它。
        #     一个「做对了也照样报警」的告警,比没有告警更糟。
        print("\n⚠⚠ 同名板出现在多个路径 —— 他打开的可能不是你在写的那份:")
        for name, paths in sorted(dups.items()):
            by_ino = {}
            for p in paths:
                if os.path.exists(p):
                    by_ino.setdefault(os.stat(p).st_ino, []).append(p)
            canonical = next(
                (ino for ino, ps in by_ino.items() if any("/worktrees/" not in x for x in ps)), None
            )
            strays = [ino for ino in by_ino if ino != canonical]
            print(f"  · {name}  —— {len(by_ino)} 个真副本(共 {len(paths)} 条路径,其余是硬链接、不算)")
            # ⚠⚠ 这条分级改过两版,两版都错过一次,理由值得留着(2026-08-28,#3651):
            #
            #   v1 按 **mtime**:把「字节完全相同、只是被拷贝时顶了时间戳」误报成漂移(实测撞到)。
            #   v2 按 **内容**:正确但**全红** —— 每个 worktree 建出来都自带一份旧快照,
            #      于是又回到本卡抱怨的那种「做对了也照样报警」。
            #
            #   ⭐ 想清楚之后的判据 = **有没有人能读到它**,不是「它跟规范落点一不一样」:
            #     负责人当初真撞到的那次之所以危险,是因为他**在 Chrome 里收藏了那个路径**。
            #     而那条读取路径**今天已经不存在** —— 面板走 http → boards-web → 规范落点,
            #     Chrome 方案他明确否掉过不止一次。⇒ 死快照今天**没有读者**。
            #   ⚠ 这个结论**挂在「没人直接开 worktree 里那份」这个前提上**。哪天有人又去
            #     直接打开某个 worktree 里的板,这套分级立刻不成立,回来改。
            def _same(a, b):
                try:
                    with open(a, "rb") as fa, open(b, "rb") as fb:
                        return fa.read() == fb.read()
                except OSError:
                    return False

            canon_path = by_ino[canonical][0] if canonical in by_ino else None
            live, dead, same = 0, 0, 0
            for ino, ps in by_ino.items():
                if ino == canonical:
                    extra = f"(另有 {len(ps) - 1} 条硬链接指向它)" if len(ps) > 1 else ""
                    print(f"      [规范落点] {ps[0]} {extra}")
                    for x in ps[1:]:
                        print(f"          ↳ 硬链接 {x}")
                elif canon_path and _same(ps[0], canon_path):
                    same += 1
                elif canon_path and os.stat(ps[0]).st_mtime > os.stat(canon_path).st_mtime:
                    live += 1
                    print(f"      [🔴 内容不同、而且比规范落点新 —— 有人正在往这一份里写] {ps[0]}")
                else:
                    dead += 1
            if dead or same:
                bits = []
                if dead:
                    bits.append(f"{dead} 份建 worktree 时拷的旧快照")
                if same:
                    bits.append(f"{same} 份内容与规范落点一致")
                print(f"      ⚪ 另有 {'、'.join(bits)} —— 今天没有读者(面板走 http 指向规范落点),不用管")
            if strays and not live:
                print("      ✅ **这块板没有在漂** —— 没有任何一份是「有人在往里写的另一个版本」")
        print("  ⇒ 规范落点用 `python3 ~/.claude/scripts/board.py path <线名>` 拿,别照 cwd 拼。")
        print("     🔴 = 有人正在往一个**非规范落点**写板 —— 他写的东西他看不到。这才是要处理的。")
        print("     ⚪ = 死快照,今天没有读者(面板走 http 指向规范落点);顺手删,别为它专门跑一趟。")
        print("     ⚠ `.claude/boards/` 没被 git 跟踪,这些副本是**建 worktree 时整个拷过去**的 ——")
        print("        所以「删掉即可」是个跑步机:每开一个 worktree 就再长一批。")
        print("     硬链接不用管 —— 同一个 inode,只有一份文件,不会漂。\n")

    build_webroot(boards, now)

    if "--open" in sys.argv:
        BP.open_path(OUT)                       # macOS = `open`(原样);Windows = os.startfile;Linux = xdg-open


def _run_locked(background=False):
    """同一时刻只跑一轮(文件锁)。⭐ 0928:board.py 每次 touch / sync / lint 都在后台叫一轮,各线一刷就好几轮叠在一起 ——
    两轮同时重建 web 根会互相撞(见 build_webroot 那段)。
    · `--background`(board.py 叫的):锁被占着 ⇒ 不排队,只留一个「刷完再补一轮」的记号就走;
    · 手跑:等前一轮跑完再跑。
    放锁之后看记号:这一轮开跑以后有人要过 ⇒ 再补一轮(最多三轮)—— 不然跑的途中刷过的板,要等下一次有人刷才进总览。
    ⚠ 记号在放锁**之后**才看:放锁前看会漏掉「看完记号、还没放锁」那一瞬间来的那一轮(它拿不到锁,只留了记号)。"""
    lock, dirty = BP.state("boards-index.lock"), BP.state("boards-index.dirty")
    os.makedirs(os.path.dirname(lock), exist_ok=True)
    for _pass in range(3):
        fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o644)
        try:
            try:
                BP.lock_fd(fd, blocking=not (background or _pass))   # POSIX = fcntl.flock(原样);Windows = msvcrt.locking
            except BlockingIOError:
                if _pass == 0:
                    with open(dirty, "a"):
                        pass
                    os.utime(dirty, None)
                return 0
            start = time.time()
            if _pass:
                print("↻ 上一轮跑的途中又有板被刷过 —— 再补一轮")
            main()
        finally:
            os.close(fd)                         # 关掉即放锁
        try:
            if os.path.getmtime(dirty) <= start:
                return 0
        except OSError:
            return 0
    return 0


WEBROOT = BP.web_root()


def _atomic_write(path, text):
    """整份写到临时名、再 `os.replace` 一步换上 —— 读的人(伺服 / 各块板的 kit)任何时刻看到的都是一份完整的旧文件或新文件。
    ⛔ 0928:原来 `open(path, "w").write(...)`,写到一半被掐断就留下半截 JSON / 半页 HTML(伺服读 `_hosts.json` 出错 ⇒ ▶ 全打不开)。"""
    tmp = "%s.tmp-%d" % (path, os.getpid())
    try:
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.lexists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _link_into(src, dst):
    """把一块板挂进 web 根:已是同一个 inode 就不动;否则先挂到临时名、再 `os.replace` 一步换上。
    ⇒ 任何时刻 dst 要么是旧的、要么是新的,⛔ 永远不会「不存在」—— 被掐断、两轮撞车都一样。"""
    try:
        if os.path.exists(dst) and os.path.samefile(src, dst):
            return
    except OSError:
        pass
    tmp = "%s.tmp-%d" % (dst, os.getpid())
    try:
        if os.path.lexists(tmp):
            os.remove(tmp)
        try:
            os.link(src, tmp)                    # 硬链接:同 inode,零漂移
        except OSError:                          # 跨卷之类 → 退回拷贝(拷的会过期,下一轮再换)
            import shutil as _sh
            _sh.copy2(src, tmp)
        os.replace(tmp, dst)
    finally:
        if os.path.lexists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass


def _sweep_tmp(d):
    """清掉前几轮被掐断时留下的临时名(`<名>.tmp-<pid>`,且那个进程已经不在了)。"""
    for fn in os.listdir(d):
        m = re.search(r"\.tmp-(\d+)$", fn)
        if not m or int(m.group(1)) == os.getpid():
            continue
        if BP.pid_alive(m.group(1)):             # 那一轮还活着,别动它的临时文件(⛔ Windows 上 os.kill(pid, 0) 会发 Ctrl-C,见 board_paths)
            continue
        try:
            os.remove(os.path.join(d, fn))
        except OSError:
            pass


def build_webroot(boards, now):
    """把所有板**硬链接**进一个可以用 http 伺服的目录,并在里面放一份 index。

    为什么必须走 http(2026-08-27 iOS 线在 in-app browser 里实测,不是推测):
      · `file://` 交给 Claude Desktop 的面板 → 它渲成 **`data:` 静态快照**。
        表现是「看得见,但点了没有任何反应」,工具侧的报错原文是
        `No site is open in this tab` —— **连读都读不到,更不用说点**。
        ⇒ 板里靠 JS 的那些东西(自动刷新 / 「已看过」勾选 / 页面自算年龄变黄变红)
           在那个面板里**都不成立**。而「页面自己变旧变红」正是本规则的防腐核心。
      · 同一批页面换成 `http://127.0.0.1` → 真实点击**跳转成功**(实测:相对链接
        `./to.html` 点下去标题真的换了)。JS 也正常。

    为什么用硬链接而不是拷贝:拷贝 = 第二真相源,当天就会漂。硬链接是**同一个 inode**,
    而各板的写入方(`board.py` / 本脚本)都用 `open(path,"w")` 原地截断,不是
    write-then-rename ⇒ 链接不会断。

    ⚠ 只伺服这一个目录,不要去伺服 `~/work` —— 那会把两个仓的源码、密钥文件
      一并暴露给本机任何进程,即使只绑 127.0.0.1 也不划算。
    """
    os.makedirs(WEBROOT, exist_ok=True)
    _sweep_tmp(WEBROOT)
    # ⛔⛔ 0928(状态板 v1.4 压缩后核对当场撞上):这里原来**先把 web 根里的 .html 全删光、再逐块挂回去**。
    #   而 board.py 的 refresh_index 等它 20 秒就杀(全机扫一遍 19–39 秒,正好骑在线上),两轮同时跑还会互相撞
    #   (后一轮挂的时候前一轮已挂上 ⇒ 链接报「已存在」⇒ 退回拷贝又撞「同一个文件」⇒ 整轮崩)。
    #   结果:按路径排序挂到示例项目仓就断了 —— 8777 上那个仓 9 块板 + VPN 1 块全 404,▶ 点开是「File not found」,
    #   而 refresh_index 把异常整个吞掉,没人知道。⇒ 改成**先挂新的(一步换上)、最后才清掉不再对应任何板的**:
    #   任何时刻被掐断,web 根里每块板要么是旧的、要么是新的,⛔ 不会少一块。
    names, mapping = {}, {}
    for b in boards:
        base = os.path.basename(b["path"])
        if base in names:                       # 撞名就加仓名前缀
            base = f'{repo_of(b["path"])}__{base}'
        names[base] = True
        _link_into(b["path"], os.path.join(WEBROOT, base))
        mapping[b["path"]] = base
    # 挂完才清:web 根里不再对应任何板的 .html(板撤了 / 改名了)。自己生成的那几页下面会整份换掉,不删。
    _keep = set(names) | {"index.html", "_index.html", "_markup.html"}
    # 1021:`board.py retire` 退场的板在 web 根原地留一页「已退场 → 去向」⇒ 别当成「不再对应任何板」清掉(他开着的面板会变 404)
    try:
        for _l in open(BP.state("retired-boards.jsonl"), encoding="utf-8"):
            try:
                _keep.add(os.path.basename(json.loads(_l).get("board") or ""))
            except ValueError:
                pass
    except OSError:
        pass
    # 1026:`board.py rename` 改名的板,旧名那页是「改名了 → 跳到新名」⇒ 同样留着(他开着旧网址的面板靠它跳过去)
    try:
        for _l in open(BP.state("renamed-boards.jsonl"), encoding="utf-8"):
            try:
                _keep.add(os.path.basename(json.loads(_l).get("from") or ""))
            except ValueError:
                pass
    except OSError:
        pass
    for fn in os.listdir(WEBROOT):
        if fn.endswith(".html") and fn not in _keep:
            _wp = os.path.join(WEBROOT, fn)
            try:
                # ⛔⛔ 1122(客户项目甲-总控 #b4e2,负责人截图「右侧面板看不到 客户项目甲-总控 板」):这一轮扫板漏了它(那时 ~/Desktop/客户项目甲 读目录报
                #   Errno 4),这里就把 web 根里它的硬链当「不再对应任何板」删了 ⇒ 8777 404、源文件链接数变 1,全程不出声。
                #   ⇒ 还连着别的硬链(= 某处真有一份源文件)的页一律不删,说出来;板真撤了 / 改名了,源那份已不在,链接数是 1,照删。
                if os.stat(_wp).st_nlink > 1:
                    print(f"  ⚠ {fn} 这一轮没扫到它的源板,但它还连着一份源文件 ⇒ 没删(多半是扫目录出错,见上)")
                    continue
                os.remove(_wp)
            except OSError:
                pass
    # 0908:住在 .claude/boards/ 里的非板文件(方案板 / 测试单)挂到 proposals/ 下,老 URL /<name>.html 不再有,
    #   新 URL /proposals/<name>.html;proposals/ 里手放的文件不动。
    # 0908:alias 表给 boards-server 的 Host 路由用(见那边注释)。alias = eyebrow 里的 workline slug(ASCII);读不到就不进表。
    hosts = {}
    for b in boards:
        try:
            src = open(b["path"], encoding="utf-8", errors="ignore").read()
        except OSError:
            continue
        body = re.sub(r"<script\b.*?</script>|<style\b.*?</style>|<!--.*?-->", " ", src, flags=re.S)
        eb = re.search(r'<div class="eyebrow">(.*?)</div>', body, re.S)
        wm = re.search(r"workline\s*[:：]\s*([A-Za-z0-9][A-Za-z0-9._-]*)", eb.group(1) if eb else "")
        fn = mapping.get(b["path"], os.path.basename(b["path"]))
        if wm and wm.group(1).lower() != "none":
            alias = wm.group(1).lower().replace(".", "-").replace("_", "-")
        else:
            # 0908 负责人:「确保每个地方都有这个按钮」⇒ 没写 workline 的板也要有 alias:取文件名里的 ASCII 段,不够就用短哈希
            import hashlib
            asc = re.sub(r"[^a-z0-9]+", "-", os.path.splitext(fn)[0].lower()).strip("-")
            alias = asc if len(asc) >= 3 else "board-" + hashlib.md5(fn.encode("utf-8")).hexdigest()[:6]
        hosts.setdefault(alias, fn)
    _atomic_write(os.path.join(WEBROOT, "_hosts.json"), json.dumps(hosts, ensure_ascii=False, indent=1))
    pdir = os.path.join(WEBROOT, "proposals")
    os.makedirs(pdir, exist_ok=True)
    _sweep_tmp(pdir)
    for src in EXTRA_FILES:
        try:
            _link_into(src, os.path.join(pdir, os.path.basename(src)))
        except OSError as e:                     # 一份方案板挂不上,别拖垮整轮(后面的总览页 / 同侪条还要写)
            print(f"  ⚠ 方案板没挂上 {os.path.basename(src)}:{e}")

    doc = build_doc(build_rows(boards, now, lambda p: "./" + mapping[p]), boards, webroot=True)
    # ⚠ 同一份内容落两个名字,不是手滑:
    #   · `index.html` —— http 伺服时的默认入口
    #   · `_index.html` —— **kit 页脚写死的就是这个名字**(它原本是给 file:// 同目录用的)
    #   2026-08-27 Harness 线实测报的回归:迁到 http 之后 `/_index.html` 直接 404,
    #   ⇒ 每一块板页脚那个「↗ 全部状态板」都是死链。而那个链接存在的唯一理由,正是负责人
    #   「不小心关掉了板、找不回来,只能发消息让那条 session 重新打开 —— 我觉得这很不合理」。
    #   ⭐ 它和我们自己写的「验收必须在他真正消费它的那个载体里」是同一个形状:
    #      改载体的时候,原来在旧载体下成立的东西会静默失效。
    #   两个名字都落 = 对 file:// 和 http 都成立,不用改 kit、也不用动任何已有的板。
    for name in ("index.html", "_index.html"):
        _atomic_write(os.path.join(WEBROOT, name), doc)

    # ⭐⭐ 给每块板用的**同侪快照**(负责人 2026-08-28 拍:「我现在基本只看状态板」)。
    #
    #   他看板的方式是「切到哪条对话就看哪块板」——于是**别的线在等他拍什么,他看不到**。
    #   总览页有这份数据,但它在一次点击之外,而「他会去点」正是本体系反复证伪过的假设。
    #   ⇒ 把它推到**每一块板上**:任何一块板都能回答「现在谁在等我」。
    #
    #   ⚠ 只放**极少量**字段(名字/时间/要你的几件),不放内容 —— 它是导航,不是第二真相源。
    peers = [
        {
            "file": mapping[b["path"]],
            "title": b["title"],
            "epoch": b["epoch"],
            "pending": b["pending"],
            "archived": bool(b.get("archived")),
        }
        for b in boards
        if not b.get("err")
    ]
    _atomic_write(os.path.join(WEBROOT, "_peers.json"), json.dumps(peers, ensure_ascii=False))
    # ⭐ 1110 子线投影:父板 web 名 → 带父板声明的子板 [{file, title, row}](kit 据此去取子板的卡和一句进度)。
    #   没人声明 ⇒ {}(kit 不发任何取子板的请求);子板退场 / 声明清掉 ⇒ 下一轮条目就没了。算不出来就写 {},别拖垮这一轮。
    try:
        _bm = _board_mod()
        kids = _bm._children_web([b["path"] for b in boards if not b.get("err")], mapping) if _bm else {}
    except Exception:
        kids = {}
    _atomic_write(os.path.join(WEBROOT, "_children.json"), json.dumps(kids, ensure_ascii=False))

    # ⭐ 标记速查页:kit 的每个可视化原语 = 渲染效果 + 逐字可抄的写法。
    #   为什么值得单独落一页(2026-08-27 Harness 线实际付了这个成本):
    #   他们建第一块板时**七处标记全写错**(`.bar-fill` 颜色要内联、`.steps` 是 dl/dt/dd、
    #   `.opt` 用 pick+<small>、`.legend` 要 <i class="sw">、`.split` 子元素得是 div …),
    #   而 **lint 全过、孤儿类为零** —— 只有渲图才看得见。他们最后是**靠 grep 别人的板**
    #   拼出正确写法的。⇒ 那是每条新线都要重复付一次的成本,落一页就免掉。
    kit_markup = os.path.join(HOME, ".claude", "scripts", "board-kit", "markup.html")
    if os.path.exists(kit_markup):
        try:
            head = open(os.path.join(HOME, ".claude", "scripts", "board-kit", "head.html"),
                        encoding="utf-8").read()
            css = open(os.path.join(HOME, ".claude", "scripts", "board-kit", "kit.css"),
                       encoding="utf-8").read()
            head = re.sub(r"<title>.*?</title>", "<title>状态板标记速查</title>", head, flags=re.S)
            body = open(kit_markup, encoding="utf-8").read()
            _atomic_write(os.path.join(WEBROOT, "_markup.html"), head + "<style>\n" + css + "\n</style>\n" + body)
            print(f"  ↳ 标记速查 → {BP.origin()}/_markup.html")
        except OSError as e:
            print(f"  ⚠ 标记速查没生成:{e}")
    print(f"  ↳ http 版(硬链接,可点) → {WEBROOT}/index.html")

if __name__ == "__main__":
    BP.ensure_utf8_mode()        # 1023:Windows 下不在 UTF-8 模式 ⇒ 带 -X utf8 重跑自己(macOS / Linux 什么都不做,见 board_paths)
    # ⛔ 0928:原来任何参数都不看、一跑就重写总览页和 boards-web —— 子代理拿 `--help` 探用法,当场写了 4 个文件。
    #   ⇒ 只认 `--open`;`-h/--help` 打印用法就走,别的参数一律拒绝(什么都不写)。
    _args = sys.argv[1:]
    if any(a in ("-h", "--help") for a in _args):
        print(__doc__.strip())
        sys.exit(0)
    _bad = [a for a in _args if a not in ("--open", "--background")]
    if _bad:
        print("不认识的参数:%s —— 什么都没写。用法:python3 %s [--open]" % (" ".join(_bad), sys.argv[0]), file=sys.stderr)
        sys.exit(2)
    # ⛔ 0928:`BOARD_CONFIG` 指着的文件不见了,board_paths 会**悄悄退回缺省**(真的 ~/work 与 boards-web)——
    #   后台那一轮若是从临时环境(自检 / 临时目录验收)叫起来的,临时目录一删,它就去重建真的 web 根。⇒ 这种情况什么都不写。
    _cfg = os.environ.get("BOARD_CONFIG")
    if _cfg and not os.path.isfile(_cfg):
        print("BOARD_CONFIG 指向的 %s 不存在 —— 什么都没写(不退回缺省路径)。" % _cfg, file=sys.stderr)
        sys.exit(2)
    sys.exit(_run_locked(background="--background" in _args))
