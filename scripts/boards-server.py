#!/usr/bin/env python3
"""状态板的 http 伺服(只绑回环)。

为什么不是裸的 `python3 -m http.server`(2026-08-27 AI平台线实测报的):
  它对 .html 回的响应头是 `Content-type: text/html`,**不带 charset** ⇒ 浏览器
  只能靠页面里的 `<meta charset>`。也就是说那一个 meta 是**唯一那道闸**,漏了就
  整页中文乱码。这里把 charset 补进响应头,**两道闸总比一道稳**
  —— 万一哪块板的 meta 被人改没了,还有这一层兜着。
"""
import http.server, os, socketserver, sys, threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import board_paths as BP        # 落点表(缺省 = 本机现状),见 board_paths.py

# 0910(CI/AI Review #4658 查到,本线复现):串行 TCPServer + handler 无 timeout ⇒ 一个连上却不发完整请求行的客户端
#   (浏览器预连接就会造出来)把整个 8777 卡死,进程活着、端口照常握手 ⇒ KeepAlive 救不了、板整页白「连续 N 次取不到」。
#   修法两处缺一不可:线程化(别的连接不排队)+ handler 超时(半开连接自己被踢)。
_ACK_LOCK = threading.Lock()   # 线程化之后 /_ack 的读改写不再天然串行,这把锁接替「伺服是单线程」那条前提

ROOT = BP.web_root()
# 依据: plan.py BATCH_ITEM_MAX 把条目名卡在 60 字(三字节一字 ≈ 180),留余量取 200;条数按请求体 262144 字节的上限,2000 条短名放得下。
ANS_EXCEPT_ITEM = 200
ANS_EXCEPT_MAX = 2000   # 依据: 同上一行 —— 请求体 262144 字节上限下 2000 条短名放得下
PORT = BP.port()


# ⭐ 1029 负责人(经选品 v2.9,retro-1029.html):「方案板上我回答了一轮,然后你进行了第二轮以后,方案板没有任何动静……我记得原来已经出过这个问题了」
#   题号按题目文字算 ⇒ 页面重出、题目没改,题号不变;他上一轮的回答一直挂在那个题号下 ⇒ 新版一打开就按「已答」摆出旧回答、新内容被压住。
#   ⇒ 回答时间早于这一页最后改动(/proposals/ 下的文件 mtime)的,算「上一版的回答」:/_answers 把它挪进 prev,不再当已答;
#     页面上由 /_page-prev.js 顶上写「这一页 X 改过」、旧回答灰着放在原题下。板(不在 /proposals/ 下)不受影响。
def _ans_ts_sec(v):
    import datetime as _dt
    try:
        return _dt.datetime.fromisoformat(str(v or "").strip().replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


# ⭐ 1105(AI Harness v3.0 转,负责人 11-05 21:16「我相当于变成我成了这个最大的卡点」,要判断哪些事能下放):量他 862 张已答卡,831 张查不到当时建议的是哪项,
#   「他多常照建议选」量不出来 ⇒ 收到回答时从页面现读建议项,存进记录的 sug。放伺服不放 kit / plan.js:老方案页的脚本是内联的,改不到,这样老页也生效。
#   板上的卡:第一个 .opt.pick(ask 的 --opt 第一项)→ 没选项的卡:「我的建议」那句;方案页:checked data-sug="1" 那一项。都没有 ⇒ ""(不知道就不写)。纯读,不抛。
def _ans_suggestion(page, ans_id, root=None):
    import html as _h, re as _re, urllib.parse
    pg = os.path.basename(urllib.parse.unquote(str(page or ""))).strip()
    k = str(ans_id or "")
    if not pg or pg.startswith(".") or not k:
        return ""
    src = None
    for f in (os.path.join(root or ROOT, pg), os.path.join(root or ROOT, "proposals", pg)):
        try:
            src = open(f, encoding="utf-8").read()
            break
        except OSError:
            continue
    if not src:
        return ""
    plain = lambda t: _re.sub(r"\s+", " ", _h.unescape(_re.sub(r"<[^>]+>", "", t))).strip()[:600]
    qk = _re.escape(_h.escape(k, quote=True))
    m = _re.search(r'<div class="decision" id="%s"(.*?)(?=<div class="decision" id=|\Z)' % qk, src, _re.S)
    if m:
        o = _re.search(r'<input type="radio"[^>]*\bvalue="([^"]*)"[^>]*\bdata-sug="1"', m.group(1))
        return plain(o.group(1)) if o else ""
    m = _re.search(r'<article\b[^>]*\bdata-ack="%s"[^>]*>(.*?)</article>' % qk, src, _re.S)
    if not m:
        return ""
    _v = _re.search(r'<div class="opt pick"[^>]*\bdata-val="([^"]*)"', m.group(1))   # 1117 回答卡:按钮写「看过了」、记的值是「通过」⇒ 建议项按值记
    if _v:
        return plain(_v.group(1))
    o = _re.search(r'<div class="opt pick"[^>]*>\s*<b>(.*?)</b>', m.group(1), _re.S) or \
        _re.search(r'<b>我的建议</b>\s*<span class="res">(.*?)</span>', m.group(1), _re.S) or \
        _re.search(r'我的建议[::]\s*<b>(.*?)</b>', m.group(1), _re.S)
    return plain(o.group(1)) if o else ""


def _page_mtime(page):
    import urllib.parse
    pg = os.path.basename(urllib.parse.unquote(str(page or ""))).strip()
    if not pg or pg.startswith("."):
        return None
    try:
        return os.path.getmtime(os.path.join(ROOT, "proposals", pg))
    except OSError:
        return None


def _ans_is_prev(rec, pm):
    """这条回答是不是答的上一版:页面在它之后改过(留 2 秒余量,同一次出页不算)。没有页面时间 / 读不出回答时间 ⇒ 不算。"""
    t = _ans_ts_sec(rec.get("ts")) if isinstance(rec, dict) else None
    return pm is not None and t is not None and t < pm - 2   # 依据: 出页与写回答同一秒内常见,2 秒余量只防这一种;实测 retro-1029 回答 14:48、改页 14:55


def _ans_split(ans, pm):
    fresh, prev = {}, {}
    for k, v in (ans or {}).items():
        (prev if _ans_is_prev(v, pm) else fresh)[k] = v
    return fresh, prev


class Handler(http.server.SimpleHTTPRequestHandler):
    # 实测: e7a632106 本线复现修复后5个半开连接不妨碍200响应，约11秒被主动断开；超时设10秒。
    timeout = 10   # 秒;半开连接 10 s 内不发完请求行就断,不占线程也不占别人

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def guess_type(self, path):
        t = super().guess_type(path)
        # 文本类一律显式声明 utf-8;二进制原样
        if isinstance(t, str) and t.startswith(("text/", "application/javascript")) \
           and "charset" not in t:
            return t + "; charset=utf-8"
        return t

    def end_headers(self):
        # 板会被反复刷新,不许缓存 —— 缓存住就又变成「看起来是最新其实是旧的」
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, *a):
        pass          # 别把访问日志刷满

    # ⭐ 0907(负责人:「一休眠回来板就没了,你得彻底解决」):记下**每块板最近一次被面板拉取的时间**。
    #   面板里的板每 15–60 秒会自己回来拉一次(kit.js 的 reloadIfChanged / _peers.json)⇒
    #   「某块板超过 3 分钟没被拉过」= 没有任何面板在显示它。这是机器能判「面板死了」的唯一抓手,
    #   下游 `~/.claude/hooks/board-pane-check.js` 靠它在每轮开头逼 session 先送板,不再靠「记得重开」那条提醒。
    #   ⚠ 零行为改变:只写一个小 json,写失败静默;不影响响应。
    # ⭐ 0907 负责人:「我明确点了已读的事项,为什么你更新完以后又蹦出来了?…每次都重新刷新出来,会越攒越多,
    #   长到彻底腐烂。」实测:面板里 7 块板的 localStorage rack **全是 {}**(含他点过已读的那块)。
    #   来源没抓死(桌面端回收面板 / 换 webview),但结论是一样的:**已读的真相不能只活在浏览器里**。
    #   ⇒ 伺服端存一份:GET /_ack?board=<slug> 读,POST 同 URL 整份替换。只绑回环,文件在 ~/.status-board/board-server/acks/。
    ACK_DIR = BP.state("board-server", "acks")   # ⛔ 0918 起不写死绝对路径(#4949)

    def _ack_path(self):
        import re, urllib.parse
        q = urllib.parse.urlparse(self.path)
        if q.path != "/_ack":
            return None
        slug = (urllib.parse.parse_qs(q.query).get("board") or [""])[0]
        if not re.fullmatch(r"[A-Za-z0-9%._~-]{1,240}", slug):
            return ""            # 有 /_ack 但 slug 不合法 ⇒ 400,不当成普通文件去找
        return os.path.join(self.ACK_DIR, slug + ".json")

    # ⭐ 1006 负责人:「点了当场记到板上,这个我觉得是 OK 的」。周检 398 条里头号毛病是「他答了,板还挂着」(13 条),
    #   而 0930 把 AI 改板降成一行命令之后比例没变 ⇒ 板得不靠 AI 也能跟上他的回答:他在卡 / 方案页上一点,这里当场记下。
    #   GET  /_answers?page=<页面文件名>   → {"answers": {<题 id>: {q, choice, note, ts[, copied]}}}
    #   POST /_answer  {page, id, q, choice, note, ts}  记一条(同 id 覆盖);{page, id, clear:true} 撤回;
    #                  {page, copied:[id…], ts}          标「这几条他已复制去粘给那条线」。
    #   ⛔ 只记,不发任何消息:把答复交给那条线必须是他手动粘、能攒着一批一起回(负责人同日原话:「自动去发肯定是有问题的」)。
    ANS_DIR = BP.state("board-server", "answers")

    def _ans_file(self, page):
        n = BP.answers_file_name(page)        # 1115 大扫除 C4:算法只在 board_paths 一份(board.py _answers_file 用同一个)
        return os.path.join(self.ANS_DIR, n) if n else None

    def _ans_load(self, f, json):
        try:
            d = json.load(open(f, encoding="utf-8")) if os.path.exists(f) else {}
            return d if isinstance(d, dict) else {}
        except (OSError, ValueError):
            return {}

    def _ans_get(self):
        import json, urllib.parse
        q = urllib.parse.urlparse(self.path)
        f = self._ans_file((urllib.parse.parse_qs(q.query).get("page") or [""])[0])
        if f is None:
            return self._send_bytes(400, b'{"error":"bad page"}')
        pm = _page_mtime((urllib.parse.parse_qs(q.query).get("page") or [""])[0])
        fresh, prev = _ans_split(self._ans_load(f, json), pm)
        out = {"answers": fresh}
        if prev:
            out["prev"], out["mtime"] = prev, int(pm * 1000)
        return self._send_bytes(200, json.dumps(out, ensure_ascii=False).encode("utf-8"))

    def _ans_post(self, data, json):
        f = self._ans_file(data.get("page"))
        if f is None:
            return self._send_bytes(400, b'{"error":"bad page"}')
        cut = lambda v, n: str(v if v is not None else "")[:n]
        with _ACK_LOCK:
            cur = self._ans_load(f, json)
            if isinstance(data.get("submit"), list):      # 1026 晚:方案页右下「交给这条线」⇒ 这几题记成交了(时间由伺服定)
                import datetime
                now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
                # 1028(AI Harness 全机数字普查):原来是 data["submit"][:200] —— 第 201 个起静默不交。逐个都处理;
                #   依据:请求体上面已封顶 262144 字节,一次最多几千个短编号,循环有界;实测 10-28 答案目录 83 页,单页最多 17 题。
                n_sub = 0
                for k in data["submit"]:
                    if isinstance(cur.get(str(k)), dict):
                        cur[str(k)]["sub"] = now
                        n_sub += 1
            elif isinstance(data.get("copied"), list):
                for k in data["copied"]:
                    if isinstance(cur.get(str(k)), dict):
                        cur[str(k)]["copied"] = cut(data.get("ts"), 40)
            else:
                k = cut(data.get("id"), 120).strip()
                if not k:
                    return self._send_bytes(400, b'{"error":"no id"}')
                if data.get("clear"):
                    cur.pop(k, None)
                else:
                    old = cur.get(k)
                    cur[k] = {"q": cut(data.get("q"), 400), "choice": cut(data.get("choice"), 600),
                              "note": cut(data.get("note"), 8000), "ts": cut(data.get("ts"), 40)}
                    # 1113 按组批量定(plan.py ```batch,负责人「我不可能点105次」):方案页带 except = 整组里勾成例外的条目名;
                    #   没带(板上的卡点同一题、老页面)⇒ 留上次的例外,别被一次没带字段的点击清掉。
                    if isinstance(data.get("except"), list):
                        cur[k]["except"] = [cut(x, ANS_EXCEPT_ITEM).strip() for x in data["except"][:ANS_EXCEPT_MAX] if str(x if x is not None else "").strip()]
                    elif isinstance(old, dict) and isinstance(old.get("except"), list):
                        cur[k]["except"] = old["except"]
                    _sug = _ans_suggestion(data.get("page"), k) or (old.get("sug") if isinstance(old, dict) else "")   # 1105:当时建议的是哪项;页上读不到了就留上次读到的
                    if _sug:
                        cur[k]["sug"] = _sug
                    if data.get("sub"):                    # 1026:他点了「交给这条线」(没有 = 草稿,见 board.py _ans_submitted)
                        cur[k]["sub"] = cut(data.get("sub"), 40)
                    if data.get("keep"):                   # 1027:他点了卡上「记下」= 这张写完了(board.py _ans_kept)
                        cur[k]["keep"] = cut(data.get("keep"), 40)
                    elif (isinstance(old, dict) and old.get("sub") and old.get("choice") == cur[k]["choice"]
                          and old.get("note") == cur[k]["note"] and old.get("except") == cur[k].get("except") and not _ans_is_prev(old, _page_mtime(data.get("page")))):
                        cur[k]["ts"], cur[k]["sub"] = old.get("ts") or cur[k]["ts"], old["sub"]   # 交了以后同一份内容重存(失焦 / 再点一下已选的项)不算又改了
                    if (isinstance(old, dict) and old.get("keep") and not data.get("keep") and old.get("choice") == cur[k]["choice"]
                            and old.get("note") == cur[k]["note"] and old.get("except") == cur[k].get("except") and not _ans_is_prev(old, _page_mtime(data.get("page")))):
                        cur[k]["ts"], cur[k]["keep"] = old.get("ts") or cur[k]["ts"], old["keep"]   # 记下以后同一份内容重存,记下还算数
            os.makedirs(self.ANS_DIR, exist_ok=True)
            tmp = f + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(cur, fh, ensure_ascii=False)
            os.replace(tmp, f)
        out = {"answers": _ans_split(cur, _page_mtime(data.get("page")))[0]}   # 同 GET:上一版的回答不回给页面(否则「交给这条线」把旧的也算成交了)
        if isinstance(data.get("submit"), list):
            out["submitted"] = n_sub                       # 1028:交了几题,调用方可以核「交的 = 发的」
        return self._send_bytes(200, json.dumps(out, ensure_ascii=False).encode("utf-8"))

    # ⭐ 1022(示例-选品 v2.2 转,负责人 15:55:「你这两个证据图我根本没有办法保存啊……我右键只有复制啊」):
    #   publish 出来的页面图是 base64 内嵌的,桌面版内置浏览器右键没有「另存为」,下载也不一定走得通;他要把图传到 示例平台 后台申诉。
    #   ⇒ 伺服发出的每个 HTML 末尾挂一小段脚本:鼠标停在图上,右上角浮出「⬇ 存到下载」(全页只有一个浮动按钮,
    #     几千张缩略图的页也不加一堆 DOM);点了由伺服把图写进 ~/Downloads(不靠浏览器的下载)。磁盘上的页面一个字不动。
    #   接口只收 data:image/... 或本伺服自己目录下的图片路径;只写 ~/Downloads,文件名清洗过、不覆盖已有文件。
    IMG_SAVE_JS = (
        "(function(){if(window.__qsave)return;window.__qsave=1;"
        "var b=document.createElement('button'),cur=null,t=null;b.type='button';b.textContent='⬇ 存到下载';"
        "b.setAttribute('style','position:fixed;z-index:2147483647;display:none;font:600 12px/1.3 -apple-system,sans-serif;padding:5px 10px;"
        "border-radius:999px;border:1px solid rgba(0,0,0,.25);background:rgba(255,255,255,.95);color:#161C24;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,.2)');"
        "function ok(i){var s=i.currentSrc||i.src||'';if(!(s.indexOf('data:image/')===0||s.indexOf(location.origin+'/')===0))return false;"
        "var r=i.getBoundingClientRect();return r.width>=96&&r.height>=64;}"
        "function show(i){cur=i;var r=i.getBoundingClientRect();b.style.top=Math.max(4,r.top+6)+'px';"
        "b.style.left=Math.max(4,Math.min(innerWidth-150,r.right-140))+'px';if(b.dataset.done!==(i.currentSrc||i.src).slice(-64)){b.textContent='⬇ 存到下载';}b.style.display='block';}"
        "function hide(){clearTimeout(t);t=setTimeout(function(){b.style.display='none';cur=null;},400);}"
        "document.addEventListener('mouseover',function(e){var i=e.target;if(i===b){clearTimeout(t);return;}"
        "if(i&&i.tagName==='IMG'&&ok(i)){clearTimeout(t);show(i);}else if(cur)hide();},true);"
        "addEventListener('scroll',function(){if(cur)hide();},true);"
        "b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();if(!cur)return;var i=cur,src=i.currentSrc||i.src;"
        "b.textContent='存…';fetch('/_save-image',{method:'POST',headers:{'Content-Type':'application/json'},"
        "body:JSON.stringify({src:src,name:(i.alt||i.title||'').trim(),page:decodeURIComponent(location.pathname)})})"
        ".then(function(r){return r.json();}).then(function(j){b.dataset.done=src.slice(-64);"
        "b.textContent=j.ok?'✓ 已存到 下载/'+j.file:'没存成:'+(j.error||'');})"
        ".catch(function(){b.textContent='没存成(伺服没回)';});});"
        "(document.body||document.documentElement).appendChild(b);})();"
    )
    IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif"}

    def _img_save(self, data, json):
        import base64, re, urllib.parse
        src = str(data.get("src") or "")
        blob, ext = None, None
        m = re.match(r"data:(image/(?:png|jpeg|webp|gif));base64,", src)
        if m:
            try:
                blob = base64.b64decode(src[m.end():], validate=False)
            except (ValueError, TypeError):
                return self._send_bytes(400, json.dumps({"ok": False, "error": "图片数据坏了"}, ensure_ascii=False).encode("utf-8"))
            ext = self.IMG_EXT[m.group(1)]
        else:
            u = urllib.parse.urlparse(src)
            if u.scheme not in ("http", "") or (u.hostname or "127.0.0.1") not in ("127.0.0.1", "localhost") and not str(u.hostname).endswith(".localhost"):
                return self._send_bytes(400, json.dumps({"ok": False, "error": "只存本机页面里的图"}, ensure_ascii=False).encode("utf-8"))
            f = os.path.realpath(self.translate_path(urllib.parse.unquote(u.path)))
            ext = os.path.splitext(f)[1].lower()
            if not f.startswith(os.path.realpath(ROOT) + os.sep) or ext not in (".png", ".jpg", ".jpeg", ".webp", ".gif") or not os.path.isfile(f):
                return self._send_bytes(400, json.dumps({"ok": False, "error": "找不到这张图"}, ensure_ascii=False).encode("utf-8"))
            blob = open(f, "rb").read()
        if not blob:
            return self._send_bytes(400, json.dumps({"ok": False, "error": "空图"}, ensure_ascii=False).encode("utf-8"))
        page = os.path.splitext(os.path.basename(str(data.get("page") or "")))[0]
        stem = re.sub(r"[^\w一-鿿-]+", "-", str(data.get("name") or "").strip())[:40].strip("-") \
            or (re.sub(r"[^\w一-鿿-]+", "-", page)[:40].strip("-") or "图") + "-图"
        dl = os.path.expanduser(os.environ.get("BOARD_SAVE_DIR") or "~/Downloads")
        os.makedirs(dl, exist_ok=True)
        name, k = stem + ext, 2
        while os.path.exists(os.path.join(dl, name)):
            name, k = "%s-%d%s" % (stem, k, ext), k + 1
        with open(os.path.join(dl, name), "xb") as fh:
            fh.write(blob)
        return self._send_bytes(200, json.dumps({"ok": True, "file": name, "path": os.path.join(dl, name)}, ensure_ascii=False).encode("utf-8"))

    # ⭐ 1026(负责人:「有时候我想要图片回复,我一般我就只能回复到这个对话框里……让那个状态板也支持……Ctrl C、Ctrl V把图片复制进去做回复」;
    #   板上卡 ask-ef9b0c79 他选「按这个做」):板和方案页的每个回复框都能粘贴 / 拖进图片。
    #   做法挂在伺服这一层(和存图按钮同一处注入)⇒ 板、方案页一处覆盖,不改各块板的 kit、不用 sync --all:
    #   图 POST /_answer-image 存进本机 ~/.status-board/board-server/answer-media/,框里在光标处插一个标记「〔图:文件名〕」并触发 input
    #   ⇒ kit / 方案页原有的自动保存把标记连同文字一起记下;框下面按标记出缩略图(× 去掉 = 删标记);
    #   `board.py answers` 读到标记就列出图片在本机的完整路径,AI 用 Read 打开看。图只在本机,不传任何外部服务。
    ANS_IMG_JS = (
        "(function(){if(window.__qai)return;window.__qai=1;var RE=/〔图:([\\w.-]+)〕/g;"
        # 1113 晚负责人(经示例-选品 #a4e9):图点开回不去 ⇒ 每一页同一个当前页大图层(状态板 kit 的链接兜底、卡上的图、贴图缩略图都用它)
        "window.__qLightbox=function(src,alt){var o=document.createElement('div');o.className='q-lightbox';o.setAttribute('role','dialog');o.setAttribute('style','position:fixed;top:0;left:0;right:0;bottom:0;z-index:2147483000;background:rgba(15,18,24,.9);display:flex;align-items:center;justify-content:center;overflow:auto;cursor:zoom-out;padding:44px 16px 40px;box-sizing:border-box');var im=document.createElement('img');im.src=src;im.alt=alt||'';var fit='max-width:100%;max-height:100%;object-fit:contain;cursor:zoom-in;border-radius:6px;background:#fff;box-shadow:0 8px 40px rgba(0,0,0,.5);margin:auto';im.setAttribute('style',fit);var full=false;var x=document.createElement('button');x.type='button';x.textContent='× 关闭';x.className='q-lightbox-x';x.setAttribute('style','position:fixed;top:10px;right:12px;padding:6px 14px;border-radius:999px;border:1px solid rgba(255,255,255,.5);background:rgba(255,255,255,.12);color:#fff;font:600 14px/18px -apple-system,sans-serif;cursor:pointer');var h=document.createElement('div');h.textContent='点图看原尺寸 · 点空白处或按 Esc 关闭';h.setAttribute('style','position:fixed;bottom:10px;left:0;right:0;text-align:center;color:#fff;opacity:.85;font:13px -apple-system,sans-serif;pointer-events:none');function kd(e){if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}}function close(){document.removeEventListener('keydown',kd,true);if(o.parentNode)o.parentNode.removeChild(o);}im.addEventListener('click',function(e){e.stopPropagation();full=!full;im.setAttribute('style',full?'max-width:none;max-height:none;cursor:zoom-out;border-radius:6px;background:#fff;margin:auto':fit);o.style.alignItems=full?'flex-start':'center';o.style.justifyContent=full?'flex-start':'center';});o.addEventListener('click',close);x.addEventListener('click',function(e){e.stopPropagation();close();});document.addEventListener('keydown',kd,true);o.appendChild(im);o.appendChild(x);o.appendChild(h);document.body.appendChild(o);return o;};"
        "function strip(ta){var s=ta.__qs;if(!s){s=document.createElement('div');s.className='q-ans-imgs';"
        "s.setAttribute('style','display:flex;flex-wrap:wrap;gap:6px;margin:6px 0');ta.parentNode.insertBefore(s,ta.nextSibling);ta.__qs=s;}return s;}"
        "function paint(ta){var v=ta.value||'',ns=[],m;RE.lastIndex=0;while((m=RE.exec(v)))ns.push(m[1]);var key=ns.join('|')+(ta.readOnly?'r':'');"
        "if(ta.__qk===key)return;ta.__qk=key;if(!ns.length&&!ta.__qs)return;var s=strip(ta);s.innerHTML='';"
        "ns.forEach(function(n){var w=document.createElement('span');w.setAttribute('style','position:relative;display:inline-block');"
        "var i=document.createElement('img');i.src='/_answer-media/'+encodeURIComponent(n);i.alt=n;i.title='点开看大图';"
        "i.setAttribute('style','height:72px;max-width:160px;object-fit:cover;border-radius:6px;border:1px solid rgba(0,0,0,.15);cursor:zoom-in;display:block');"
        "i.onclick=function(){window.__qLightbox(i.src,n);};w.appendChild(i);"
        "if(!ta.readOnly){var x=document.createElement('button');x.type='button';x.textContent='×';x.title='去掉这张';"
        "x.setAttribute('style','position:absolute;top:-6px;right:-6px;width:20px;height:20px;border-radius:50%;border:1px solid rgba(0,0,0,.25);background:#fff;color:#161C24;font:600 13px/16px -apple-system,sans-serif;cursor:pointer;padding:0');"
        "x.onclick=function(e){e.preventDefault();ta.value=ta.value.split('〔图:'+n+'〕').join('');ta.dispatchEvent(new Event('input',{bubbles:true}));paint(ta);};w.appendChild(x);}"
        "s.appendChild(w);});}"
        "function insert(ta,t){var a=(ta.selectionStart==null)?ta.value.length:ta.selectionStart,b=(ta.selectionEnd==null)?a:ta.selectionEnd;"
        "ta.value=ta.value.slice(0,a)+t+ta.value.slice(b);try{ta.selectionStart=ta.selectionEnd=a+t.length;}catch(e){}"
        "ta.dispatchEvent(new Event('input',{bubbles:true}));paint(ta);}"
        "function tip(ta,msg){var s=strip(ta),d=document.createElement('span');d.textContent=msg;d.setAttribute('style','font:12px -apple-system,sans-serif;color:#B42318;align-self:center');s.appendChild(d);setTimeout(function(){d.remove();},6000);}"
        "function up(ta,f){if(!/^image\\/(png|jpeg|webp|gif)$/.test(f.type))return tip(ta,'只收 png / jpg / webp / gif');"
        "if(f.size>15*1024*1024)return tip(ta,'图太大(超过 15MB)');var r=new FileReader();"
        "r.onload=function(){fetch('/_answer-image',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:r.result})})"
        ".then(function(x){return x.json();}).then(function(j){if(j&&j.ok)insert(ta,'〔图:'+j.file+'〕');else tip(ta,'图没存上:'+((j&&j.error)||''));})"
        ".catch(function(){tip(ta,'图没存上(伺服没回)');});};r.readAsDataURL(f);}"
        "function files(dt){var o=[];if(!dt)return o;var it=dt.items||[];for(var k=0;k<it.length;k++){if(it[k].kind==='file'){var f=it[k].getAsFile();if(f&&/^image\\//.test(f.type))o.push(f);}}"
        "if(!o.length&&dt.files){for(var j=0;j<dt.files.length;j++)if(/^image\\//.test(dt.files[j].type))o.push(dt.files[j]);}return o;}"
        "function isTa(t){return t&&t.tagName==='TEXTAREA'&&!t.readOnly;}"
        "document.addEventListener('paste',function(e){if(!isTa(e.target))return;var fs=files(e.clipboardData);if(!fs.length)return;e.preventDefault();fs.forEach(function(f){up(e.target,f);});},true);"
        "document.addEventListener('dragover',function(e){if(isTa(e.target))e.preventDefault();},true);"
        "document.addEventListener('drop',function(e){if(!isTa(e.target))return;var fs=files(e.dataTransfer);if(!fs.length)return;e.preventDefault();fs.forEach(function(f){up(e.target,f);});},true);"
        "document.addEventListener('input',function(e){if(e.target&&e.target.tagName==='TEXTAREA')paint(e.target);},true);"
        "function scan(){document.querySelectorAll('textarea').forEach(paint);}scan();setInterval(scan,1500);})();"
    )
    # ⭐ 1026 晚(示例-选品 v2.6 转,负责人 21:5x):「我在方案板里面我已经写完了，但没有那个按钮，就说就是彻底要交给你，
    #   所以它会一直显示还在写没交，但实际上我这边根本就没有提交按钮。」—— 0db1ef7「写完才交」只给板上的回复框加了按钮,
    #   方案页只按停手时间算交(写了字 10 分钟),而 answers 让他点的「交给这条线」在方案页上不存在。
    #   ⇒ 方案页右下(「都定了」「生成回复」旁边)加「交给这条线」:先失焦让 plan.js 把手上的字存下,再把这页答过的题记成交了。
    #   伺服注入一处 ⇒ 历史方案页(plan.js 内联,改不到)也一起有;不是方案页(没有 .decision / .float / #resp)什么都不做。
    PLAN_SUB_JS = (
        "(function(){if(window.__qps)return;window.__qps=1;"
        "var ds=[].slice.call(document.querySelectorAll('.decision')),fl=document.querySelector('.float'),R=document.getElementById('resp');"
        "if(!ds.length||!fl||!R||!window.fetch)return;var page;try{page=decodeURIComponent(location.pathname.split('/').pop()||'')||'index.html';}catch(e){page='index.html';}"
        "var b=document.createElement('button');b.type='button';b.className='q-plan-sub';b.hidden=true;fl.insertBefore(b,R);"
        "function T(v){var t=Date.parse(v||'');return isNaN(t)?null:t;}"
        "function show(a){var ks=Object.keys(a||{}).filter(function(k){return a[k]&&typeof a[k]==='object'&&(a[k].choice||a[k].note);});"
        "if(!ks.length){b.hidden=true;return;}b.hidden=false;var all=ks.every(function(k){var s=T(a[k].sub),t=T(a[k].ts);return (s!==null&&(t===null||s>=t))||t===null||Date.now()-t>=(String(a[k].note||'').trim()?" + str(BP.ANS_SUB_NOTE_S * 1000) + ":" + str(BP.ANS_SUB_CHOICE_S * 1000) + ");});"   # 1115 大扫除 C3:交题时限取 board_paths 那一份
        "b.textContent=all?'已发给 AI ✓ 约 1 分钟接手,不用再说':'全部发给 AI';b.setAttribute('style',all?'background:#e8eefc;color:#1d4ed8;box-shadow:none':'background:#1d4ed8;color:#fff');b.__ks=ks;}"
        "function load(){fetch('/_answers?page='+encodeURIComponent(page),{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){show(j&&j.answers);}).catch(function(){});}"
        # ⭐ 1027 晚(投流达人 v1.9 转,负责人 18:1x 答了 4 题、1 题交了 3 题没交,看不懂):离开这一页 / 收起「写回答」框 ⇒ 这页答过的全部发给 AI
        #   (伺服只给已有的记录盖 sub;写到一半又回来改 ⇒ ts 比 sub 新,又算没发,下次离开再发)
        "function subAll(keep){var ks=ds.map(function(d){return d.id;}).concat(['_overall']);try{fetch('/_answer',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:!!keep,body:JSON.stringify({page:page,submit:ks})}).catch(function(){});}catch(x){}}"
        "window.__qpsSubAll=subAll;addEventListener('pagehide',function(){if(!b.hidden&&b.textContent!=='已发给 AI ✓ 约 1 分钟接手,不用再说')subAll(true);});"
        "var tm=null;function later(){clearTimeout(tm);tm=setTimeout(load,1500);}window.__qpsLater=later;"
        "ds.forEach(function(d){d.addEventListener('input',function(){if(!b.hidden){b.textContent='交给这条线';b.setAttribute('style','background:#1d4ed8;color:#fff');}later();});d.addEventListener('change',later);});"
        "b.addEventListener('mousedown',function(e){e.preventDefault();});"
        # 他打字时输入框停靠在屏幕底部(plan.js dock),会盖住右下这排按钮 ⇒ 停靠期间把这排抬到输入框上方;失焦晚 0.4 秒放回(别让按钮在点下去那一刻挪走)
        "var rt=null;function lift(){var g=document.querySelector('.decision.docked .dock-tag');if(!g)return;fl.style.bottom=Math.max(22,innerHeight-g.getBoundingClientRect().top+10)+'px';}"
        "document.addEventListener('focusin',function(e){if(e.target&&e.target.classList&&e.target.classList.contains('note')){clearTimeout(rt);setTimeout(lift,60);}},true);"
        "document.addEventListener('input',function(e){if(e.target&&e.target.classList&&e.target.classList.contains('note'))lift();},true);"
        "document.addEventListener('focusout',function(e){if(e.target&&e.target.classList&&e.target.classList.contains('note')){clearTimeout(rt);rt=setTimeout(function(){if(!document.querySelector('.decision.docked'))fl.style.bottom='';},400);}},true);"
        "b.addEventListener('click',function(){var a=document.activeElement;if(a&&a.blur&&a!==document.body)try{a.blur();}catch(x){}b.textContent='正在发…';"
        "setTimeout(function(){fetch('/_answers?page='+encodeURIComponent(page),{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){"
        "var ks=Object.keys((j&&j.answers)||{});return fetch('/_answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({page:page,submit:ks})});})"
        ".then(function(r){return r.json();}).then(function(j){show(j&&j.answers);}).catch(function(){b.textContent='没发出去,再点一次';});},700);});"
        # 停手到点(只点选项 1 分钟 / 写了字 10 分钟)也算交,与 board.py _ans_submitted 同一条规则 ⇒ 每 30 秒重看一次;
        # 再点一下已经选中的「其他(我自己写)」⇒ 光标进输入框(plan.js 只在选项变了时才聚焦,旧页改不到)
        "setInterval(load,30000);"
        "document.addEventListener('click',function(e){var o=e.target&&e.target.closest?e.target.closest('.decision .opt'):null;if(!o)return;"
        "var r=o.querySelector('input[type=radio]');if(!r||!r.checked||!r.getAttribute('data-other'))return;var n=o.closest('.decision').querySelector('.note');"
        "if(n&&document.activeElement!==n)setTimeout(function(){try{n.focus();}catch(x){}},0);});"
        # ⭐ 1029 负责人(经选品 v2.9):「在方案板里面我没有选任何事项,然后直接写回复……在方案板里它还是会默认选择第一个,这是一个bug」
        #   plan.py 出页时把「建议」那项预先勾上(data-sug),他没点任何选项直接写补充 ⇒ 带着建议项交了。板上的卡同样操作记「其他(我自己写)」。
        #   ⇒ 这一题还没答过(没 .done)、他也没亲手点过选项、勾着的只是预勾的建议(或什么都没勾)时,一开写就改勾「其他」,与板上一致。
        #   在 document 捕获阶段先跑,plan.js 记答案时读到的就是「其他」;伺服注入 ⇒ 历史方案页(plan.js 内联)一起修。
        "var pk={};document.addEventListener('change',function(e){var t=e.target,d=t&&t.type==='radio'&&t.closest?t.closest('.decision'):null;if(d)pk[d.id]=1;},true);"
        "document.addEventListener('input',function(e){var n=e.target;if(!n||!n.classList||!n.classList.contains('note'))return;var d=n.closest('.decision');"
        "if(!d||pk[d.id]||d.classList.contains('done'))return;var c=d.querySelector('input[type=radio]:checked');if(c&&!c.getAttribute('data-sug'))return;"
        "var o=d.querySelector('input[type=radio][data-other]');if(o){o.checked=true;pk[d.id]=1;}},true);"
        "load();})();"
    )
    # ⭐ 1027(示例-投流达人 v1.9 转,负责人原话:「我必须得翻到下面的问题页才能开写回复……我回复可能是基于整个方案去回复的」):
    #   方案页的回复框只长在页底每道题里 ⇒ 他边看正文边写,得先翻到底、再翻回来看。
    #   ⇒ 右下「交给这条线」旁边加「✍ 写回答」:点开一个浮在右下角的框(页面照常滚),上面选「答哪一题」,默认「整份方案(总的补充)」。
    #     选某一题 ⇒ 字直接写进那一题的补充框(触发 plan.js 原有的自动存,两边是同一份);选整份方案 ⇒ 记成这一页一条 id=_overall 的回答。
    #   伺服注入一处 ⇒ 历史方案页(plan.js 内联)也一起有;交仍是右下角「交给这条线」(_overall 一起交)。不是方案页什么都不做。
    # ⭐ 1028(内容助理转,负责人看图文审稿页:「六张图根本没有办法点开放大,有些小图根本看不清」):
    #   方案页(/proposals/ 下,plan.py 出的、各线手写的、老页都算)上点任一张图 ⇒ 全屏看原图;←/→ 翻同页别的图,Esc / 点一下关。
    #   ⛔ 只在 /proposals/ 下起作用:状态板自己的卡里有图、有点击(kit 管),别抢。链接里的图、按钮、右下浮框里的不接。
    # ⭐ 1029 负责人(经选品 v2.9):「我没有办法在审图的方案板里面找到一个地方,我可以直接看着那些图,直接给你反馈。我必须得要退回原来的状态板上」
    #   plan.py 出的页有题(.decision)和自己的答题框;别的方案页(选品 review.py 的审图页、各线手写页)什么都没有 ⇒
    #   /proposals/ 下没有 .decision 的页,右下角固定一个「回复这一页」:选项(页面 <meta name="reply-options" content="可以上|要改"> 可改,缺省 可以|要改)+ 补充 + 交。
    #   答案记成这一页的题 id「page」,点「交」才算答了(同 1026 晚「没交不算已答」);板上用 --deep 连着这一页的卡照原样认它。
    PAGE_REPLY_JS = r"""(function(){if(window.__qpr)return;window.__qpr=1;
if(location.pathname.indexOf('/proposals/')<0||!window.fetch)return;
if(document.querySelector('.decision'))return;
var page;try{page=decodeURIComponent(location.pathname.split('/').pop()||'')||'index.html';}catch(e){page='index.html';}
var mt=document.querySelector('meta[name="reply-options"]');
var opts=((mt&&mt.getAttribute('content'))||'可以|要改').split('|').map(function(x){return x.trim();}).filter(Boolean);
var cur={choice:'',note:''},tm=null;
var box=document.createElement('div');box.className='q-page-reply';
box.setAttribute('style','position:fixed;right:16px;bottom:16px;width:300px;max-width:calc(100vw - 32px);z-index:2147482000;background:#fff;border:1px solid #d0d5dd;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.15);font:14px/1.5 system-ui,-apple-system,sans-serif;color:#1d2939');
box.innerHTML='<div class="h" style="padding:10px 12px;font-weight:600;cursor:pointer;display:flex;justify-content:space-between"><span>回复这一页</span><span class="tg">▾</span></div>'+
'<div class="b" style="padding:0 12px 12px"><div class="o" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px"></div>'+
'<textarea placeholder="补充:哪张、哪里要改(可以边看图边写)" style="width:100%;box-sizing:border-box;min-height:84px;border:1px solid #d0d5dd;border-radius:6px;padding:6px;font:inherit"></textarea>'+
'<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px"><span class="st" style="font-size:12px;color:#667085"></span>'+
'<button class="sb" style="border:0;background:#1d4ed8;color:#fff;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer">交</button></div></div>';
document.body.appendChild(box);
var ob=box.querySelector('.o'),ta=box.querySelector('textarea'),st=box.querySelector('.st'),bd=box.querySelector('.b');
box.querySelector('.h').onclick=function(){var h=bd.style.display==='none';bd.style.display=h?'':'none';box.querySelector('.tg').textContent=h?'▾':'▸';};
function paint(){[].forEach.call(ob.children,function(b){var on=b.textContent===cur.choice;b.style.background=on?'#1d4ed8':'#fff';b.style.color=on?'#fff':'#1d2939';});}
opts.forEach(function(o){var b=document.createElement('button');b.textContent=o;b.setAttribute('style','border:1px solid #1d4ed8;border-radius:16px;padding:3px 12px;font:inherit;cursor:pointer;background:#fff');
b.onclick=function(){cur.choice=(cur.choice===o?'':o);paint();save();};ob.appendChild(b);});
function hm(){var d=new Date();return ('0'+d.getHours()).slice(-2)+':'+('0'+d.getMinutes()).slice(-2);}
function post(o){return fetch('/_answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(o)});}
function save(){clearTimeout(tm);cur.note=ta.value;if(!cur.choice&&!cur.note.trim())return;
post({page:page,id:'page',q:'这一页',choice:cur.choice,note:cur.note,ts:new Date().toISOString()}).then(function(r){st.textContent=r.ok?'已记下 '+hm()+',点「交」才算答了':'没记下(服务没回应)';}).catch(function(){st.textContent='没记下(服务没回应)';});}
ta.addEventListener('input',function(){clearTimeout(tm);tm=setTimeout(save,1500);});ta.addEventListener('blur',save);
box.querySelector('.sb').onclick=function(){cur.note=ta.value;if(!cur.choice&&!cur.note.trim()){st.textContent='先选一项或写一句';return;}
post({page:page,id:'page',q:'这一页',choice:cur.choice,note:cur.note,ts:new Date().toISOString()}).then(function(){return post({page:page,submit:['page'],ts:new Date().toISOString()});})
.then(function(r){st.textContent=r.ok?'交了 '+hm()+',回板上那张卡会显示你答了':'没交上(服务没回应)';}).catch(function(){st.textContent='没交上(服务没回应)';});};
fetch('/_answers?page='+encodeURIComponent(page),{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){
var a=j&&j.answers&&j.answers.page;if(!a)return;cur.choice=a.choice||'';ta.value=cur.note=a.note||'';paint();st.textContent=a.sub?'已交过,改了再点「交」':'上次记下了,还没交';}).catch(function(){});
})();"""

    PAGE_PREV_JS = r"""(function(){if(window.__qpv)return;window.__qpv=1;
if(location.pathname.indexOf('/proposals/')<0||!window.fetch)return;
var page;try{page=decodeURIComponent(location.pathname.split('/').pop()||'')||'index.html';}catch(e){page='index.html';}
function z(n){return (n<10?'0':'')+n;}
function fm(ms){var d=new Date(ms);return isNaN(d.getTime())?'':z(d.getMonth()+1)+'-'+z(d.getDate())+' '+z(d.getHours())+':'+z(d.getMinutes());}
function cut(t,n){t=String(t||'').replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n)+'…':t;}
fetch('/_answers?page='+encodeURIComponent(page),{cache:'no-store'}).then(function(r){return r.ok?r.json():null;}).then(function(j){
var p=j&&j.prev,ks=p?Object.keys(p):[];if(!ks.length||document.querySelector('.q-prev-banner'))return;
var bn=document.createElement('div');bn.className='q-prev-banner';
bn.setAttribute('style','margin:0 0 16px;padding:10px 14px;border-radius:10px;background:#fff7e0;border:1px solid #f0c36d;color:#5c3d00;font:14px/1.6 system-ui,-apple-system,sans-serif');
var h=document.createElement('b');h.textContent='这一页 '+fm(j.mtime)+' 改过,是新版。';bn.appendChild(h);
bn.appendChild(document.createTextNode('你上一轮的回答灰着放在原题下面,这一版的题要重新答。'));
var host=document.getElementById('plan')||document.body;host.insertBefore(bn,host.firstChild);
ks.forEach(function(k){var a=p[k]||{},el=document.createElement('div');el.className='q-prev';
el.setAttribute('style','margin:6px 0 10px;padding:6px 10px;border-left:3px solid #c0c4cc;background:#f4f5f7;color:#667085;font-size:13px;line-height:1.5');
el.textContent='上一版你答的('+fm(Date.parse(a.ts))+'):'+(a.choice||'(没选)')+(a.note?'　补充:'+cut(a.note,300):'');
var d=null;[].forEach.call(document.querySelectorAll('.decision'),function(x){if(x.id===k)d=x;});
if(d){var t=d.querySelector('h3');if(t&&t.nextSibling)d.insertBefore(el,t.nextSibling);else d.appendChild(el);}else bn.appendChild(el);});
}).catch(function(){});
})();"""

    IMG_ZOOM_JS = (
        "(function(){if(window.__qiz)return;window.__qiz=1;if(location.pathname.indexOf('/proposals/')<0)return;"
        "var ov=null,im=null,cap=null,list=[],at=0;"
        "function ok(t){return t&&t.tagName==='IMG'&&!t.closest('a,button,.float,.q-img-zoom')&&!(t.naturalWidth&&t.naturalWidth<48);}"
        "function show(i){at=(i+list.length)%list.length;var t=list[at];im.src=t.currentSrc||t.src;im.alt=t.alt||'';"
        "cap.textContent=(t.alt?t.alt+'  ':'')+(list.length>1?(at+1)+' / '+list.length+'  ←/→ 翻页 · Esc 关':'Esc 关');}"
        "function close(){if(ov){ov.remove();ov=null;}}"
        # 页面自己会放大(手写页自带一套)⇒ 让它的先跑,等一拍看有没有别的全屏层冒出来,有就不开 —— 10-28 内容助理那页实测两层叠在一起
        "function other(){return [].some.call(document.body.children,function(x){if(x===ov)return false;var c=getComputedStyle(x);"
        "return c.position==='fixed'&&c.display!=='none'&&c.visibility!=='hidden'&&x.offsetWidth>innerWidth*.8&&x.offsetHeight>innerHeight*.8;});}"
        "document.addEventListener('click',function(e){var t=e.target;if(ov){close();e.preventDefault();return;}if(!ok(t)||e.defaultPrevented)return;"
        "setTimeout(function(){if(ov||other())return;open(t);},0);},false);"
        "function open(t){list=[].filter.call(document.images,ok);"
        "ov=document.createElement('div');ov.className='q-img-zoom';ov.setAttribute('style','position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.9);display:flex;align-items:center;justify-content:center;cursor:zoom-out');"
        "im=document.createElement('img');im.setAttribute('style','max-width:96vw;max-height:92vh;object-fit:contain;border-radius:6px');"
        "cap=document.createElement('div');cap.setAttribute('style','position:fixed;left:0;right:0;bottom:12px;text-align:center;color:#ddd;font:13px system-ui');"
        "ov.appendChild(im);ov.appendChild(cap);document.body.appendChild(ov);show(Math.max(0,list.indexOf(t)));}"
        "document.addEventListener('keydown',function(e){if(!ov)return;if(e.key==='Escape')close();else if(e.key==='ArrowRight')show(at+1);else if(e.key==='ArrowLeft')show(at-1);else return;e.preventDefault();});"
        "var st=document.createElement('style');st.textContent='img{cursor:zoom-in}a img,.float img{cursor:pointer}';document.head.appendChild(st);})();"
    )

    PLAN_NOTE_JS = (
        "(function(){if(window.__qpn)return;window.__qpn=1;"
        "var ds=[].slice.call(document.querySelectorAll('.decision')),fl=document.querySelector('.float');"
        "if(!ds.length||!fl||!window.fetch)return;var page;try{page=decodeURIComponent(location.pathname.split('/').pop()||'')||'index.html';}catch(e){page='index.html';}"
        "var K='_overall',Q='整份方案的补充(不针对哪一题)',ov='',tm=null;"
        "function el(t,css,txt){var e=document.createElement(t);if(css)e.setAttribute('style',css);if(txt!=null)e.textContent=txt;return e;}"
        "var btn=el('button','background:#fff;color:#1d4ed8;box-shadow:0 0 0 1px #1d4ed8 inset,0 4px 14px rgba(0,0,0,.18)','✍ 写回答');btn.type='button';btn.className='q-plan-note-btn';"
        "btn.title='边看正文边写:选答哪一题,或写整份方案的补充';fl.insertBefore(btn,fl.firstChild);"
        "var P=el('div','position:fixed;right:22px;z-index:10;width:min(460px,calc(100vw - 44px));background:#fff;border:1px solid rgba(0,0,0,.18);"
        "border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);padding:10px 12px;font:14px/1.5 -apple-system,system-ui,sans-serif;color:#161C24');"
        "P.className='q-plan-note';P.hidden=true;"
        "var top=el('div','display:flex;gap:8px;align-items:center;margin-bottom:6px');top.appendChild(el('span','font-weight:600;white-space:nowrap','答哪一题'));"
        "var sel=el('select','flex:1;min-width:0;font:inherit;padding:3px 4px');var o0=el('option',null,'整份方案(总的补充)');o0.value=K;sel.appendChild(o0);"
        "ds.forEach(function(d,i){var o=el('option',null,(i+1)+'. '+(d.getAttribute('data-q')||d.id));o.value=d.id;sel.appendChild(o);});"
        "var x=el('button','border:0;background:none;color:#555;cursor:pointer;font:inherit;white-space:nowrap','收起');x.type='button';top.appendChild(sel);top.appendChild(x);"
        "var ta=el('textarea','width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;border:1px solid rgba(0,0,0,.2);border-radius:8px;resize:vertical;max-height:40vh');"
        "ta.rows=6;ta.maxLength=8000;ta.placeholder='边看边写,页面照常滚;字自动存。收起这个框或离开这页,就自动发给 AI';"
        "var st=el('div','font-size:12px;color:#667;margin-top:4px;min-height:1em','');P.appendChild(top);P.appendChild(ta);P.appendChild(st);document.body.appendChild(P);"
        "function place(){P.style.bottom=Math.max(70,innerHeight-fl.getBoundingClientRect().top+10)+'px';}"
        "function dn(id){for(var i=0;i<ds.length;i++)if(ds[i].id===id)return ds[i];return null;}"
        "function nt(d){return d&&d.querySelector('.note');}"
        "function again(){try{if(window.__qpsLater)window.__qpsLater();}catch(e){}}"
        "function load(cb){fetch('/_answers?page='+encodeURIComponent(page),{cache:'no-store'}).then(function(r){return r.json();})"
        ".then(function(j){var a=j&&j.answers&&j.answers[K];ov=(a&&a.note)||'';cb();}).catch(function(){cb();});}"
        "function fill(){var n=nt(dn(sel.value));ta.value=n?n.value:ov;st.textContent=n?'写进这一题的补充(和页上那一题是同一份)':'';}"
        "function saveOv(){clearTimeout(tm);tm=null;ov=ta.value;var v=ta.value.trim();"
        "fetch('/_answer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(v?{page:page,id:K,q:Q,choice:'',note:v,ts:new Date().toISOString()}:{page:page,id:K,clear:true})})"
        ".then(function(r){if(!r.ok)throw 0;st.textContent=v?'已存(还没发给 AI;收起这个框或离开这页就自动发)':'';again();}).catch(function(){st.textContent='没存上(伺服没回),字还在框里';});}"
        "ta.addEventListener('input',function(){var n=nt(dn(sel.value));"
        "if(n){n.value=ta.value;n.dispatchEvent(new Event('input',{bubbles:true}));again();}else{st.textContent='…';clearTimeout(tm);tm=setTimeout(saveOv,900);}});"
        "ta.addEventListener('blur',function(){var n=nt(dn(sel.value));if(n)n.dispatchEvent(new Event('blur'));else if(tm)saveOv();});"
        "sel.addEventListener('change',function(){if(tm)saveOv();fill();try{ta.focus();}catch(e){}});"
        "btn.addEventListener('mousedown',function(e){e.preventDefault();});"
        "btn.addEventListener('click',function(){if(!P.hidden){closeSend();return;}load(function(){fill();P.hidden=false;place();try{ta.focus();}catch(e){}});});"
        "function closeSend(){var n=nt(dn(sel.value));if(n)n.dispatchEvent(new Event('blur'));if(tm)saveOv();P.hidden=true;setTimeout(function(){try{if(window.__qpsSubAll)window.__qpsSubAll(false);}catch(e){}again();},1200);}"
        "x.addEventListener('click',closeSend);"
        "addEventListener('resize',function(){if(!P.hidden)place();});"
        "addEventListener('pagehide',function(){if(tm)saveOv();});})();"
    )
    # 1027(同一件 ①):板上的卡只出方案页的一题(ask --deep-q 只连一题),他看不出这页还有几题没答 ⇒ kit 按页取题目清单画在卡上。
    #   GET /_plan-qs?page=<方案页文件名> → {"qs":[{id, q}]}(按页面上的 .decision 元素读;按修改时间缓存;读不到 ⇒ 空表)
    PLAN_QS_CACHE = {}

    def _plan_qs(self):
        import html as _h, json, re, urllib.parse
        q = urllib.parse.urlparse(self.path)
        page = os.path.basename(urllib.parse.unquote((urllib.parse.parse_qs(q.query).get("page") or [""])[0])).strip()
        if not page or len(page) > 200 or page.startswith(".") or not re.search(r"\.html?$", page):
            return self._send_bytes(400, b'{"error":"bad page"}')
        f = os.path.join(ROOT, "proposals", page)
        try:
            mt = os.path.getmtime(f)
        except OSError:
            return self._send_bytes(200, b'{"qs":[]}')
        hit = self.PLAN_QS_CACHE.get(f)
        if not hit or hit[0] != mt:
            body = open(f, encoding="utf-8", errors="replace").read()
            qs = []
            for m in re.finditer(r'<[a-z]+\b[^>]*\bclass="decision\b[^"]*"[^>]*>', body):
                i = re.search(r'\bid="([^"]+)"', m.group(0))
                dq = re.search(r'\bdata-q="([^"]*)"', m.group(0))
                if i:
                    qs.append({"id": _h.unescape(i.group(1)), "q": _h.unescape(dq.group(1)) if dq else _h.unescape(i.group(1))})
            hit = self.PLAN_QS_CACHE[f] = (mt, qs)
        return self._send_bytes(200, json.dumps({"qs": hit[1]}, ensure_ascii=False).encode("utf-8"))

    ANS_IMG_DIR = os.path.join(os.path.expanduser(os.environ.get("BOARD_ANSWER_MEDIA") or BP.state("board-server", "answer-media")))

    def _ans_img_save(self, data, json):
        """POST /_answer-image {data: data:image/...;base64,…} ⇒ 存进 ANS_IMG_DIR,回 {ok, file}。只收四种图,单张 ≤ 15MB。"""
        import base64, re, secrets, time
        src = str(data.get("data") or "")
        m = re.match(r"data:(image/(?:png|jpeg|webp|gif));base64,", src)
        if not m:
            return self._send_bytes(400, json.dumps({"ok": False, "error": "只收 png / jpg / webp / gif"}, ensure_ascii=False).encode("utf-8"))
        try:
            blob = base64.b64decode(src[m.end():], validate=False)
        except (ValueError, TypeError):
            return self._send_bytes(400, json.dumps({"ok": False, "error": "图片数据坏了"}, ensure_ascii=False).encode("utf-8"))
        if not blob or len(blob) > 15 * 1024 * 1024:
            return self._send_bytes(400, json.dumps({"ok": False, "error": "空图或超过 15MB"}, ensure_ascii=False).encode("utf-8"))
        os.makedirs(self.ANS_IMG_DIR, exist_ok=True)
        name = time.strftime("%Y%m%d-%H%M%S") + "-" + secrets.token_hex(3) + self.IMG_EXT[m.group(1)]
        with open(os.path.join(self.ANS_IMG_DIR, name), "xb") as fh:
            fh.write(blob)
        return self._send_bytes(200, json.dumps({"ok": True, "file": name}, ensure_ascii=False).encode("utf-8"))

    def _ans_img_get(self):
        """GET /_answer-media/<文件名> ⇒ 发那张图;文件名只认 [\\w.-],不出目录。"""
        import re, urllib.parse
        n = urllib.parse.unquote(urllib.parse.urlparse(self.path).path[len("/_answer-media/"):])
        ext = os.path.splitext(n)[1].lower()
        f = os.path.join(self.ANS_IMG_DIR, n)
        if not re.match(r"^[\w.-]+$", n) or ext not in (".png", ".jpg", ".webp", ".gif") or not os.path.isfile(f):
            return self._send_bytes(404, b'{"error":"not found"}')
        ct = {".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}[ext]
        return self._send_bytes(200, open(f, "rb").read(), ct)

    def _html_with_saver(self):
        """GET 一个 .html ⇒ 原样加上存图脚本的 <script> 再发;不是 html / 读不了 ⇒ None(交给父类照常发)。"""
        import urllib.parse
        f = self.translate_path(urllib.parse.urlparse(self.path).path)
        if os.path.isdir(f):
            f = os.path.join(f, "index.html")
        if not f.endswith(".html") or not os.path.isfile(f):
            return None
        try:
            body = open(f, "rb").read()
        except OSError:
            return None
        tag = (b'<script src="/_img-save.js" defer></script><script src="/_ans-img.js" defer></script>'
               b'<script src="/_plan-sub.js" defer></script><script src="/_plan-note.js" defer></script>'
               b'<script src="/_img-zoom.js" defer></script>'
               b'<script src="/_page-reply.js" defer></script>'
               b'<script src="/_page-prev.js" defer></script>')
        i = body.lower().rfind(b"</body>")
        body = body[:i] + tag + body[i:] if i >= 0 else body + tag
        self._send_bytes(200, body, "text/html; charset=utf-8")
        return True

    def _send_bytes(self, code, body, ctype="application/json; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    # ⭐ 0908 负责人:面板被拆后右侧会留一个 launch.json 的「▶ 状态板」按钮,点了却进总览 —— 桌面端只接受 origin 不接受路径。
    #   ⇒ 用 Host 区分:`http://<alias>.localhost:8777`(Chromium 把 *.localhost 全解析到回环)。alias = 板顶 eyebrow 的
    #   workline slug,表由 boards-index.py 写在 webroot/_hosts.json;命中就 302 到那块板。各线在自己 worktree 的
    #   .claude/launch.json 里写 {"name":"状态板","url":"http://<alias>.localhost:8777","port":8777} 即可一键回到自己的板。
    def _host_redirect(self):
        import json, re, urllib.parse
        if self.path.split("?", 1)[0] not in ("/", "/index.html"):
            return False
        host = (self.headers.get("Host") or "").lower()
        m = re.fullmatch(r"([a-z0-9][a-z0-9-]*)\.localhost(?::\d+)?", host)
        if not m:
            return False
        try:
            table = json.load(open(os.path.join(ROOT, "_hosts.json"), encoding="utf-8"))
        except (OSError, ValueError):
            return False
        target = table.get(m.group(1))
        if not target:
            return False
        self.send_response(302)
        self.send_header("Location", "/" + urllib.parse.quote(target))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        return True

    def do_GET(self):
        if self._host_redirect():
            return
        if self.path.split("?", 1)[0] == "/_answers":
            return self._ans_get()
        ap = self._ack_path()
        if ap is not None:
            if ap == "":
                return self._send_bytes(400, b'{"error":"bad board"}')
            try:
                body = open(ap, "rb").read() if os.path.exists(ap) else b"{}"
            except OSError:
                body = b"{}"
            return self._send_bytes(200, body)
        if self.path.split("?", 1)[0] == "/_img-save.js":
            return self._send_bytes(200, self.IMG_SAVE_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_ans-img.js":
            return self._send_bytes(200, self.ANS_IMG_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_plan-sub.js":
            return self._send_bytes(200, self.PLAN_SUB_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_plan-note.js":
            return self._send_bytes(200, self.PLAN_NOTE_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_page-prev.js":
            return self._send_bytes(200, self.PAGE_PREV_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_page-reply.js":
            return self._send_bytes(200, self.PAGE_REPLY_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_img-zoom.js":
            return self._send_bytes(200, self.IMG_ZOOM_JS.encode("utf-8"), "application/javascript; charset=utf-8")
        if self.path.split("?", 1)[0] == "/_plan-qs":
            return self._plan_qs()
        if self.path.startswith("/_answer-media/"):
            return self._ans_img_get()
        try:
            self._note_fetch()
        except Exception:
            pass
        try:
            if self._html_with_saver():
                return
        except Exception:
            pass                   # 注入自己出错 ⇒ 照常发原文件,板不能因为它打不开
        return super().do_GET()

    def _open_external(self, json):
        """⭐ 1113 负责人(经示例-基建 #a7f3):外部网站(主站 example.invalid 等)在 App 内置面板里打开卡很久、加载不出来 ⇒
        板上点外部链接时,kit 发 POST /_open,这里用系统默认浏览器(他的是 ego)打开。
        只认本机页面发来的(Origin / Referer 是 127.0.0.1 / localhost / *.localhost),只认 http / https,别的一律拒。"""
        import subprocess
        from urllib.parse import urlsplit
        src = self.headers.get("Origin") or self.headers.get("Referer") or ""
        host = (urlsplit(src).hostname or "").lower()
        if not (host in ("127.0.0.1", "localhost") or host.endswith(".localhost")):
            return self._send_bytes(403, b'{"ok":false,"error":"origin"}')
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 4096:      # 依据: 网址上限按 4 KB,足够任何正常入口
                raise ValueError("size")
            data = json.loads(self.rfile.read(n).decode("utf-8"))
            url = str((data or {}).get("url") or "")
            u = urlsplit(url)
            if u.scheme not in ("http", "https") or not u.hostname or any(ord(c) < 32 for c in url):
                raise ValueError("url")
            subprocess.Popen(["/usr/bin/open", url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (ValueError, OSError) as e:
            return self._send_bytes(400, json.dumps({"ok": False, "error": str(e)[:60]}).encode("utf-8"))
        return self._send_bytes(200, b'{"ok":true}')

    def do_POST(self):
        import json
        if self.path.split("?", 1)[0] == "/_save-image":
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > 64 * 1024 * 1024:
                return self._send_bytes(413, b'{"ok":false,"error":"size"}')
            try:
                data = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("not an object")
                return self._img_save(data, json)
            except (ValueError, OSError) as e:
                return self._send_bytes(400, json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False).encode("utf-8"))
        if self.path.split("?", 1)[0] == "/_answer-image":
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > 24 * 1024 * 1024:
                return self._send_bytes(413, b'{"ok":false,"error":"size"}')
            try:
                data = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("not an object")
                return self._ans_img_save(data, json)
            except (ValueError, OSError) as e:
                return self._send_bytes(400, json.dumps({"ok": False, "error": str(e)[:80]}, ensure_ascii=False).encode("utf-8"))
        if self.path.split("?", 1)[0] == "/_open":
            return self._open_external(json)
        if self.path.split("?", 1)[0] == "/_answer":
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                n = 0
            if n <= 0 or n > 65536:
                return self._send_bytes(413, b'{"error":"size"}')
            try:
                data = json.loads(self.rfile.read(n).decode("utf-8"))
                if not isinstance(data, dict):
                    raise ValueError("not an object")
            except ValueError:
                return self._send_bytes(400, b'{"error":"bad json"}')
            return self._ans_post(data, json)
        ap = self._ack_path()
        if ap is None:
            return self._send_bytes(404, b'{"error":"not found"}')
        if ap == "":
            return self._send_bytes(400, b'{"error":"bad board"}')
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 262144:
            return self._send_bytes(413, b'{"error":"size"}')
        raw = self.rfile.read(n)
        try:
            data = json.loads(raw.decode("utf-8"))
            if not isinstance(data, dict):
                raise ValueError("not an object")
        except ValueError:
            return self._send_bytes(400, b'{"error":"bad json"}')
        # ⭐ 0907 22:3x 记忆助手实测:整份替换 + 连点 = 后到的盖掉先到的(33 条只剩 16)。⇒ 伺服端**逐 key 合并**,永远不整份替换:
        #   v2 增量 {set:{k:rec} 硬写, soft:{k:rec} 只在现有那条没被他点过(无 t / 无 popped)时写, del:[k]};
        #   旧格式(整份)也按「并集覆盖」合并,不删缺席的 key。⚠ 0910 起伺服是多线程,串行靠 _ACK_LOCK(见顶部),⛔ 别拿掉。回整份给客户端采纳。
        with _ACK_LOCK:
            return self._ack_merge(ap, data, json)

    def _ack_merge(self, ap, data, json):
        try:
            cur = json.load(open(ap, encoding="utf-8")) if os.path.exists(ap) else {}
            if not isinstance(cur, dict):
                cur = {}
        except (OSError, ValueError):
            cur = {}
        if data.get("v") == 2:
            for k, rec in (data.get("set") or {}).items():
                if isinstance(rec, dict):
                    cur[k] = rec
            for k, rec in (data.get("soft") or {}).items():
                old = cur.get(k)
                if isinstance(rec, dict) and not (isinstance(old, dict) and (old.get("t") or old.get("popped"))):
                    cur[k] = rec
            for k in (data.get("del") or []):
                cur.pop(str(k), None)
        else:
            for k, rec in data.items():
                if isinstance(rec, dict):
                    cur[k] = rec
        os.makedirs(self.ACK_DIR, exist_ok=True)
        tmp = ap + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, ensure_ascii=False)
        os.replace(tmp, ap)
        return self._send_bytes(200, json.dumps(cur, ensure_ascii=False).encode("utf-8"))

    def _note_fetch(self):
        import json, os, time
        # 只算浏览器(面板)的拉取:curl / python 之类脚本拉一下不代表有人在看;同侪条的拉取带 Referer=板本身 ⇒ 归到那块板名下。
        #   1110:判法抽成模块级纯函数 _fetch_target(逐字同原判法),顺带取出面板标记
        name, mark = _fetch_target(self.path, self.headers.get("User-Agent"), self.headers.get("Referer"))
        if not name:
            return
        d = BP.state("board-server")
        os.makedirs(d, exist_ok=True)
        f = os.path.join(d, "last-fetch.json")
        try:
            data = json.load(open(f, encoding="utf-8"))
        except Exception:
            data = {}
        data[name] = int(time.time())
        tmp = f + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False)
        os.replace(tmp, f)
        try:                                   # 1117 打开历史:写不进去静默,不影响响应
            _note_open(os.path.join(d, "open-history.jsonl"), name, mark, time.time())
        except Exception:
            pass
        # ⭐ 1110 面板归属:带了合格标记的再记一份「哪个面板此刻在拉哪块板」;写不进去静默,不影响响应
        if mark:
            try:
                _note_pane(os.path.join(d, "pane-fetch.json"), mark, name, time.time())
            except Exception:
                pass


# ⭐ 1110 面板归属(状态板线):last-fetch.json 只记「这块板最近一次被拉」,不分是哪个会话的面板拉的 ⇒
#   别的会话的面板开着它,本会话也被判成开着(负责人 11-09:「挂到板上了」他在这个会话右边找不到)。
#   ⇒ kit.js 的定时拉取带 ?s=<面板标记>(AI navigate 时带进地址、页面记进 sessionStorage),这里另记一份
#   pane-fetch.json = {标记: {"board": 板文件名, "t": 秒}};board.py _pane_tail 与面板检查钩子据此核「本会话的面板此刻指向哪块板」。
#   last-fetch.json 照旧写(别处在读),一个字不改它的判法。
PANE_MARK_LEN = 10          # 依据: 与 board.py PANE_MARK_LEN 同长(sha1 前 10 位十六进制,1110 面板归属)
PANE_KEEP_S = 7 * 86400     # 依据: 会话很少活过一周;清掉的标记只会让那个面板下次拉取时重新记上,不丢判断,只防文件无限长


def _pane_s(q):
    """query 串 → 合格的面板标记(10 位小写十六进制);没有 / 不合格 ⇒ None。"""
    import urllib.parse
    m = (urllib.parse.parse_qs((q or "").split("#", 1)[0], keep_blank_values=True).get("s") or [""])[0]
    return m if len(m) == PANE_MARK_LEN and all(c in "0123456789abcdef" for c in m) else None


def _fetch_target(path, ua, referer):
    """纯函数(1110 抽出,不依赖 handler):一次 GET → (板文件名, 面板标记)。不算面板拉取 ⇒ (None, None);没带合格标记 ⇒ (板, None)。
    板名判法与原 _note_fetch 逐字相同:只算浏览器;_peers.json 归到 Referer 那块板;不是 .html / 以 _ 开头 / index.html 不算。
    标记:板页面本身看自己的 query;_peers.json 先看自己的 query,没有再看 Referer 的 query。"""
    import urllib.parse
    ua = (ua or "").lower()
    if not ua or ua.startswith(("curl", "python", "wget", "httpie")):
        return None, None
    path = path or ""
    name = os.path.basename(urllib.parse.unquote(path.split("?", 1)[0]))
    q = path.split("?", 1)[1] if "?" in path else ""
    if (urllib.parse.parse_qs(q.split("#", 1)[0]).get("proj") or [""])[0] == "1":
        return None, None             # 1110 子线投影:父板页面取子板内容(?proj=1)不是有人开着子板 ⇒ 不记账
    if name == "_peers.json":
        ref = referer or ""
        name = os.path.basename(urllib.parse.unquote(ref).split("?", 1)[0])
        rq = ref.split("?", 1)[1] if "?" in ref else ""
        q = q if _pane_s(q) else rq
    if not name.endswith(".html") or name.startswith("_") or name == "index.html":
        return None, None
    return name, _pane_s(q)


# ⭐ 1117 打开历史(负责人 11-17 12:13 方案页第 4 条):面板真拉一块板(上面写 last-fetch / pane-fetch 那一刻;?proj=1 投影取数、curl 之类不算)
#   ⇒ 往状态目录下的打开历史(open-history,一行一条 JSON)追加一行 {ts, board, sid(带了面板标记才有)}。只追加,本机没有谁读它(留给以后量「他多久打开哪块板」)。
OPEN_HIST_DEDUP_S = 60   # 依据: kit 面板开着时每 15 秒看一次、真去拉页面最快 60 秒一次(reloadIfChanged 60000),同侪条 60 秒一次(paintPeers)⇒ 同一块板 60 秒内只记一次,开着不动约一分钟一行
OPEN_HIST_MAX = 5 * 1024 * 1024   # 依据: 一行约 80 字节,一个面板一直开着一天约 1440 行 ≈ 115 KB ⇒ 5 MB ≈ 常开 40 多天;超了砍掉前一半(只追加没人读,旧的丢了不影响任何判断)
_OPEN_LAST = {}
_OPEN_LOCK = threading.Lock()


def _note_open(f, board, sid, now):
    """追加一行打开记录 ⇒ 记了 True / 60 秒内同板记过 False。文件超过 OPEN_HIST_MAX 先砍掉前一半(从中点后第一个换行起留,每行都完整)。"""
    import json, time
    with _OPEN_LOCK:
        t0 = _OPEN_LAST.get(board)
        if t0 is not None and 0 <= now - t0 < OPEN_HIST_DEDUP_S:
            return False
        _OPEN_LAST[board] = now
        os.makedirs(os.path.dirname(f), exist_ok=True)
        try:
            if os.path.getsize(f) > OPEN_HIST_MAX:
                with open(f, "rb") as fh:
                    data = fh.read()
                cut = data.find(b"\n", len(data) // 2)
                tmp = "%s.%d.%d.tmp" % (f, os.getpid(), threading.get_ident())
                with open(tmp, "wb") as fh:
                    fh.write(data[cut + 1:] if cut >= 0 else b"")
                os.replace(tmp, f)
        except OSError:
            pass
        rec = {"ts": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now)), "board": board}
        if sid:
            rec["sid"] = sid
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return True


def _note_pane(f, mark, board, now):
    """把「标记 mark 的面板此刻在拉 board」写进 pane-fetch.json(原子写);顺手清掉 PANE_KEEP_S 没更新的标记。"""
    import json
    try:
        data = json.load(open(f, encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except Exception:
        data = {}
    data = {k: v for k, v in data.items()
            if isinstance(v, dict) and isinstance(v.get("t"), (int, float)) and now - v["t"] < PANE_KEEP_S}
    data[mark] = {"board": board, "t": int(now)}
    os.makedirs(os.path.dirname(f), exist_ok=True)
    tmp = "%s.%d.%d.tmp" % (f, os.getpid(), threading.get_ident())     # 伺服是多线程的:临时文件按线程分开,免得两次拉取写进同一个 tmp
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)
    os.replace(tmp, f)


def _launch_heal_loop():
    """⭐ 0928(cc控制 v2.6【要你做】):▶ 按钮原来只在各线自己 touch 时补 —— 线停手时 `.claude/launch.json` 没了没人发现,
    他在那条线的右侧面板上找不到 ▶,也就开不了板、没法反馈。伺服是常驻的 ⇒ 由它每分钟跑一次 `board.py launch-heal`
    (0928 由 5 分钟改:桌面端恢复会话那一刻会清掉 launch.json,他正是那时要点 ▶;一轮实测约 0.5 秒 CPU)。
    子进程跑:崩了不连累伺服;补不补、补成什么只在 board.py 一处定(每补一次记在 ~/.status-board/launch-heal.log)。"""
    import time
    exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board.py")
    time.sleep(20)
    while True:
        _launch_heal_once(exe, BP.state("launch-heal.log"))
        time.sleep(60)


def _child_python():
    """起子进程用的解释器。⚠ 1113 AI Harness 实测:伺服 10:09 由 Python 3.14 起,brew 当天升到 3.15 删掉旧解释器 ⇒
    sys.executable 指向的文件没了,每 30 秒起 wake-lines 都失败、被 except 吞掉,升级后到 16:44 他交的回答一条都没叫醒线。
    ⇒ 旧解释器还在就用它;没了 ⇒ 伺服自己退出(launchd KeepAlive 会用 plist 里的 /opt/homebrew/bin/python3 重新拉起)。"""
    if os.path.exists(sys.executable):
        return sys.executable
    try:
        with open(os.path.join(os.path.expanduser("~"), ".status-board", "board-wake.log"), "a", encoding="utf-8") as fh:
            import time
            fh.write("%s ✗ 伺服的解释器 %s 已不在(多半 brew 升级删了),伺服自退让 launchd 重新拉起\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), sys.executable))
    except Exception:
        pass
    os._exit(75)


def _launch_heal_once(exe, log):
    """跑一轮 `board.py launch-heal`。没跑成(非零退出 / 超时 / 起不来)就往自愈日志记一行,返回那句原因;跑成了返回空串。
    ⚠ 0928 v1.4:原先结果整个吞掉 —— 自愈自己坏了不留任何痕迹,「右侧没 ▶ 先看日志」那条路也看不出来。"""
    import subprocess, time
    err = ""
    try:
        r = subprocess.run([_child_python(), exe, "launch-heal", "--quiet"], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            tail = (r.stderr or r.stdout or "").strip().splitlines()
            err = "退出码 %d:%s" % (r.returncode, tail[-1] if tail else "没有输出")
    except Exception as e:
        err = "%s: %s" % (type(e).__name__, e)
    if err:
        try:
            os.makedirs(os.path.dirname(log), exist_ok=True)
            with open(log, "a", encoding="utf-8") as fh:
                fh.write("%s ✗ launch-heal 没跑成(%s)—— 这一轮一个 ▶ 都没补\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), err[:300]))
        except Exception:
            pass
    return err


def _wake_loop():
    """⭐ 1026(负责人 18:43 批「先试」):他在板上交了回答 ⇒ 1 分钟内叫醒那条线开着的会话。判谁该叫、怎么叫全在
    `board.py wake-lines`(一条回答只叫一次,记 ~/.status-board/board-wake.log);这里只每 30 秒看一眼答案目录,
    15 分钟内没动静就不起子进程(每轮只是 70 来个 stat)。"""
    import time
    exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "board.py")
    adir = Handler.ANS_DIR
    # ⭐ 1113 等外部计时(负责人 11-13 18:17 卡 ask-ee1ae1b3):到点该追的叫醒不能等他刚在板上答过题 ⇒ 另外每 CHASE_TICK_S 无条件起一次 wake-lines
    #   (它一进来先跑 _wake_chase:一条线一天最多叫一次;没有到点的、没有回答的,子进程几百毫秒就退)。
    # 依据: 负责人 11-13 18:17 卡 ask-ee1ae1b3(每 10 分钟无条件一次;与 board.py CHASE_TICK_S 同一个数)
    CHASE_TICK_S = BP.CHASE_TICK_S   # 1115 大扫除 C3:与 board.py 共用 board_paths 那一份
    last_chase = 0.0
    time.sleep(25)
    while True:
        try:
            now = time.time()
            if now - last_chase >= CHASE_TICK_S or any(n.endswith(".json") and now - os.path.getmtime(os.path.join(adir, n)) < 15 * 60 for n in os.listdir(adir)):
                last_chase = now if now - last_chase >= CHASE_TICK_S else last_chase
                import subprocess
                r = subprocess.run([_child_python(), exe, "wake-lines"], capture_output=True, text=True, timeout=60)
                if r.returncode != 0:     # 1113:原先失败整个吞掉,叫醒坏了 6 小时没人知道 ⇒ 记进叫醒日志
                    tail = (r.stderr or r.stdout or "").strip().splitlines()
                    raise RuntimeError("wake-lines 退出码 %d:%s" % (r.returncode, tail[-1][:200] if tail else "没有输出"))
        except Exception as e:
            try:
                with open(os.path.join(os.path.expanduser("~"), ".status-board", "board-wake.log"), "a", encoding="utf-8") as fh:
                    fh.write("%s ✗ 伺服起 wake-lines 没成(%s: %s)\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), type(e).__name__, str(e)[:300]))
            except Exception:
                pass
        time.sleep(30)


if __name__ == "__main__":
    # 1113 AI Harness 实测:launchd 给的 PATH 只有 /usr/bin:/bin:/usr/sbin:/sbin ⇒ 伺服起的子进程里裸写的 node / gh 全找不到
    #   (验收通过的知会一条没投,失败又只 print)。⇒ 起服务时把 brew 和 /usr/local 的 bin 补到 PATH 前面,子进程都继承。
    os.environ["PATH"] = os.pathsep.join([p for p in ("/opt/homebrew/bin", "/usr/local/bin") if os.path.isdir(p)] + [os.environ.get("PATH", "/usr/bin:/bin")])
    BP.ensure_utf8_mode()        # 1023:Windows 下不在 UTF-8 模式 ⇒ 带 -X utf8 重跑自己(macOS / Linux 什么都不做,见 board_paths)
    class _Server(socketserver.ThreadingTCPServer):
        # 1023:Windows 上 SO_REUSEADDR 的意思是「别人占着也照样绑」⇒ 装两次就有两个伺服抢同一个端口、谁回请求看运气。
        #   ⇒ Windows 不开它(macOS / Linux 原样 True:它在那边只是允许 TIME_WAIT 里的端口立刻重绑)。
        allow_reuse_address = os.name != "nt"
        daemon_threads = True   # 卡住的线程不拦进程退出
        # 1021 晚(个人助理线报:选片墙 3,473 张缩略图滚动时大片坏图,ERR_CONNECTION_RESET;curl 60 并发全 200 所以只在浏览器里出现):
        #   监听队列默认只有 5 ⇒ 同一刻到的连接一多,系统直接回 RST。实测 50 个同时到的连接 36 个被重置。
        #   ⇒ 放到 128(= 本机 kern.ipc.somaxconn 上限)。⚠ 改它要重启伺服才生效(launchctl kickstart -k gui/$UID/com.status-board.boards-web)。
        request_queue_size = 128
    # 1021 晚:launchd 起的进程同时能开的文件默认只有 256 ⇒ 300 个连接同时到时开文件失败,SimpleHTTPRequestHandler 把它回成 404、
    #   accept 也失败(实测 300 并发:约一半 404 / 重置)。抬到 4096(不超过硬上限);抬不上就照旧跑。
    try:
        import resource
        _soft, _hard = resource.getrlimit(resource.RLIMIT_NOFILE)
        _want = 4096 if _hard == resource.RLIM_INFINITY else min(4096, _hard)
        if _soft < _want:
            resource.setrlimit(resource.RLIMIT_NOFILE, (_want, _hard))
    except Exception:
        pass
    threading.Thread(target=_launch_heal_loop, daemon=True).start()
    threading.Thread(target=_wake_loop, daemon=True).start()
    with _Server(("127.0.0.1", PORT), Handler) as httpd:
        httpd.serve_forever()
