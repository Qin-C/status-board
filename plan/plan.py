#!/usr/bin/env python3
"""plan.py — 方案板生成器。

AI 只写一份很短的 Markdown 草稿,本工具把它拼成一页网页,并在生成时检查;
不合格就不出页面。草稿格式见 plan-kit/README.md。

  python3 plan.py render <草稿.md> -o <输出.html>     ('-' 表示从标准输入读)
  python3 plan.py lint   <草稿.md> [--strict]
  python3 plan.py patch  <已生成.html> --section "<节标题或序号>" < 新的一节.md
  python3 plan.py selftest

只用 Python 3 标准库;页面里的 CSS / JS 全部内联,不引任何外部网址。
"""
import argparse
import contextlib
import hashlib
import html as _html
import io
import math
import os
import re
import sys
import tempfile

KIT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "plan-kit")

# 依据: 80a39ab54 的plan-kit/README.md规定结论段最多120字，超出报错。
LEAD_MAX = 120        # 结论段上限
# 依据: 80a39ab54 的plan-kit/README.md规定节标题至少6字，并明确允许“不改什么”例外。
HEAD_MIN = 6          # 节标题下限
# 依据: 80a39ab54 的plan-kit/README.md规定无图的一节外露文字超过300字报错。
SEC_MAX = 300         # 一节没图时露在外面的文字上限
# 依据: 80a39ab54 的plan-kit/README.md规定全页外露文字超过2500字报错。
PAGE_MAX = 2500       # 全页露在外面的文字上限
# 依据: 80a39ab54 的plan-kit/README.md规定超过800字的页面至少有一张外露图。
NOFIG_MAX = 800       # 超过这么多字的页面至少要有一张图
# 依据: 80a39ab54 的plan-kit/README.md规定单句超过45字警告，严格模式按错误处理。
SENT_MAX = 45         # 一句话上限(warn)
PARA_SENTS = 6        # 一段句数上限(warn)
# 依据: 04850cfc5 规定表格单格超过60字报错，防止将长文放进表格绕过字数检查。
CELL_MAX = 60         # 表格一格上限(error:长文塞进表格能躲过每节 / 全页字数,所以按格卡)
REL_WORDS = ("今天", "今晚", "明天", "昨天", "明早", "今早")
STATUSES = ("提议中", "已定")
KEEP_TITLE = "不改什么"   # 这一节标题短也放行(鼓励写)
OTHER = "其他(我自己写)"
FIG_KINDS = ("flow", "compare", "bars", "steps", "table")

EXAMPLES = {
    "meta": "---\ntitle: 状态板与方案板 · 优化方案\nline: 状态板线\ndate: 2026-10-06\nstatus: 提议中\n---",
    "lead-missing": "frontmatter 后面第一段直接写结论:\n**结论:两处要动。** ① 状态板改成直接点选。② 方案板由工具生成。",
    "lead-long": "**结论:两处要动。** ① 状态板改成直接点选。② 方案板由工具生成。(展开的话放进下面各节)",
    "head-short": "## 方案板改成由工具生成页面",
    "head-colon": "## 我们卡在状态板和方案板两处   (标题本身就是结论,不要用冒号引出下文)",
    "sec-wall": "把过程画成图,或把细节收起:\n```flow\n写草稿 -> 工具拼页面 -> 你点选项\n```\n```fold 细节:五类检查各查什么\n(原来那一大段放这里)\n```",
    "page-long": "每节只留结论和图,展开的细节放进 ```fold 标题 ... ``` 里",
    "page-nofig": "```bars\n一张图都没有 | 45 | 94 | 45 / 94\n正文超过 6000 字 | 19 | 94 | 19 / 94\n```",
    "dec-opts": "```decision\n方案板归谁管？\ncost: 不定的话这套工具没人能动。\n- *状态板线接管 | 结构和检查归我。\n- 仍归设计系统线 | 我把方案交给它。\n```",
    "dec-sug": "恰好一个选项以 * 开头:\n- *状态板线接管 | 结构和检查归我。\n- 仍归设计系统线 | 我把方案交给它。",
    "dec-cost": "cost: 不定的话这套工具没人能动。",
    "dec-dup": "两道题问法相同时各写一行 id:\nid: owner-board\nid: owner-plan",
    "dec-fold": "把 ```decision 块挪到 ```fold 外面(要他定的题不能收起)",
    "rel-date": "写成日期:「10-06 新落的行」;要引用界面上的字就放进反引号:`今天新增`",
    "syntax": "```flow\n写草稿 -> 工具拼页面: 检查\n```   (围栏块要有开头和结尾两行 ```)",
    "sent-long": "拆成两句:「上线前 254 条里 18 条。上线后 144 条里 11 条,比例没变。」",
    "para-long": "一段只讲一件事;超过 6 句就拆成两段,或改成列表 / 表格",
    "cell-long": "一格只放一个短语或一个数:| 方案板 | 94 页里 45 页没有图 |   长的说明挪到表格下面写成一段,或放进 ```fold",
}

SYNTAX_EX = {   # 语法类报错按零件给例子
    "decision": EXAMPLES["dec-opts"],
    "flow": "```flow\n写草稿 -> !工具拼页面: 检查\n工具拼页面 -> 你点选项 | 答案写回这一页\n```",
    "compare": "```compare\n✕ 现在\n32 步纯文字\n✓ 改成\n标题是结论,图在前\n```",
    "bars": "```bars\n一张图都没有 | 45 | 94 | 45 / 94\n```",
    "steps": "```steps\n第 1 步 · 2 天 | 方案板工具第一版 | 拿一页真方案重做给你看。\n```",
    "fold": "```fold 细节:五类检查各查什么\n(收起的内容,普通 Markdown)\n```",
}


# ───────────────────────── 文字小工具 ─────────────────────────

def esc(s):
    return _html.escape(s, quote=True)


_CODE = re.compile(r"(`+)(.+?)\1")
_IMG = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
_LINK = re.compile(r"\[([^\]]+)\]\(([^)\s]+)\)")
_BOLD = re.compile(r"\*\*(.+?)\*\*")
_ITAL = re.compile(r"(?<![\*\w])\*(?![\s\*])(.+?)(?<![\s\*])\*(?![\*\w])")
_BAREURL = re.compile(r"https?://[^\s)）」』]+")
_SAFE_URL = re.compile(r"^(https?:|mailto:|#|/|\.|[^:]*$)", re.I)


def _img_sub(m):
    if not _SAFE_URL.match(m.group(2)):
        return m.group(0)
    return '<img src="%s" alt="%s" loading="lazy">' % (m.group(2), m.group(1))


def _link_sub(m):
    if not _SAFE_URL.match(m.group(2)):
        return m.group(0)
    return '<a href="%s" target="_blank" rel="noopener noreferrer">%s</a>' % (m.group(2), m.group(1))


def _inline_nocode(s):
    s = esc(s)
    s = _IMG.sub(_img_sub, s)
    s = _LINK.sub(_link_sub, s)
    s = _BOLD.sub(r"<b>\1</b>", s)
    s = _ITAL.sub(r"<i>\1</i>", s)
    return s


def inline(s):
    """行内 Markdown → HTML(粗体、斜体、代码、链接、图片)。一切原始 HTML 都被转义。"""
    codes = []

    def stash(m):
        codes.append("<code>%s</code>" % esc(m.group(2).strip()))
        return "\x00%d\x00" % (len(codes) - 1)

    s = _inline_nocode(_CODE.sub(stash, s.replace("\x00", "")))
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], s)


def plain(s, code=True, urls=True):
    """去掉 Markdown 记号后的纯文字。code=False 连代码内容一起去掉;urls=False 去掉裸网址。"""
    s = _CODE.sub((lambda m: m.group(2)) if code else "", s)
    s = _IMG.sub(r"\1", s)
    s = _LINK.sub(r"\1", s)
    if not urls:
        s = _BAREURL.sub("", s)
    s = _BOLD.sub(r"\1", s)
    s = _ITAL.sub(r"\1", s)
    return s


def nchars(s):
    """字数 = 去掉空白后的字符数(汉字、标点、字母、数字各算 1)。"""
    return len(re.sub(r"\s+", "", s))


def join_lines(lines):
    out = ""
    for t in lines:
        t = t.strip()
        if not t:
            continue
        if out and (ord(out[-1]) < 0x2E80 or ord(t[0]) < 0x2E80):
            out += " "
        out += t
    return out


def split_row(s):
    s = s.strip().replace("\\|", "\x00")
    if s.startswith("|"):
        s = s[1:]
    if s.endswith("|"):
        s = s[:-1]
    return [c.strip().replace("\x00", "|") for c in s.split("|")]


# ───────────────────────── 解析 ─────────────────────────

_FENCE = re.compile(r"^(`{3,})\s*([A-Za-z0-9_+-]*)\s*(.*)$")
_HEAD = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_LIST = re.compile(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$")
_TSEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
_HR = re.compile(r"^\s*(-{3,}|\*{3,}|_{3,})\s*$")


def _starts_block(s):
    return bool(_FENCE.match(s) or _HEAD.match(s) or _LIST.match(s) or s.lstrip().startswith(">"))


def parse_blocks(items, issues):
    """items = [(行号, 文字)];返回块列表。issues 收语法问题 (行号, 级别, 代码, 说明)。"""
    blocks, i, n = [], 0, len(items)
    while i < n:
        ln, s = items[i]
        if not s.strip():
            i += 1
            continue
        m = _FENCE.match(s)
        if m:
            ticks, lang, arg = len(m.group(1)), m.group(2).lower(), m.group(3).strip()
            j, body, closed = i + 1, [], False
            while j < n:
                t = items[j][1].strip()
                if re.fullmatch(r"`{%d,}" % ticks, t):
                    closed = True
                    break
                body.append(items[j])
                j += 1
            if not closed:
                issues.append((ln, "error", "syntax", "这个 ``` 围栏块没有关上(缺结尾那行 ```)"))
            blocks.append(make_fence(lang, arg, body, ln, issues))
            i = j + 1
            continue
        m = _HEAD.match(s)
        if m:
            blocks.append({"kind": "h", "level": len(m.group(1)), "text": m.group(2), "line": ln})
            i += 1
            continue
        if _HR.match(s):
            blocks.append({"kind": "hr", "line": ln})
            i += 1
            continue
        if "|" in s and i + 1 < n and _TSEP.match(items[i + 1][1]) and "-" in items[i + 1][1]:
            rows, j = [(ln, split_row(s))], i + 2
            while j < n and items[j][1].strip() and "|" in items[j][1]:
                rows.append((items[j][0], split_row(items[j][1])))
                j += 1
            blocks.append({"kind": "table", "rows": rows, "line": ln})
            i = j
            continue
        if s.lstrip().startswith(">"):
            lines, j = [], i
            while j < n and items[j][1].lstrip().startswith(">"):
                lines.append((items[j][0], re.sub(r"^\s*>\s?", "", items[j][1])))
                j += 1
            blocks.append({"kind": "quote", "lines": lines, "line": ln})
            i = j
            continue
        if _LIST.match(s):
            its, j = [], i
            while j < n:
                t = items[j][1]
                lm = _LIST.match(t)
                if lm:
                    its.append({"indent": len(lm.group(1).expandtabs(4)),
                                "ordered": lm.group(2)[0].isdigit(),
                                "lines": [(items[j][0], lm.group(3))]})
                elif t.strip() and t[:1] in " \t" and its:
                    its[-1]["lines"].append((items[j][0], t.strip()))
                elif not t.strip() and j + 1 < n and _LIST.match(items[j + 1][1]):
                    pass
                else:
                    break
                j += 1
            blocks.append({"kind": "list", "items": its, "line": ln})
            i = j
            continue
        lines, j = [], i
        while j < n and items[j][1].strip():
            if j > i and _starts_block(items[j][1]):
                break
            lines.append(items[j])
            j += 1
        blocks.append({"kind": "para", "lines": lines, "line": ln})
        i = j
    return blocks


def make_fence(lang, arg, body, line, issues):
    if lang == "decision":
        return parse_decision(body, line, issues)
    if lang == "flow":
        return parse_flow(body, line, issues)
    if lang == "compare":
        return parse_compare(body, line, issues)
    if lang == "bars":
        return parse_bars(body, line, issues)
    if lang == "steps":
        return parse_steps(body, line, issues)
    if lang == "draft":
        # 1028(用户反馈:配图要能点开放大;审稿页不该套用上架专用的模板):
        #   要他审的稿本身(社媒正文、串推、配图)放这里 —— 单列、图排成网格(8777 上点图放大),字数不算进页面上限:稿多长是稿的事,不是页面写长了。
        if not arg:
            issues.append((line, "error", "syntax", "draft 要在同一行写标题(这是哪一份稿,如「小红书正文」)"))
        return {"kind": "draft", "title": arg or "原稿", "blocks": parse_blocks(body, issues), "line": line}
    if lang == "fold":
        if not arg:
            issues.append((line, "error", "syntax", "fold 要在同一行写标题"))
        return {"kind": "fold", "title": arg or "细节", "blocks": parse_blocks(body, issues), "line": line}
    return {"kind": "code", "lang": lang, "lines": body, "line": line}


def _cap(s):
    m = re.match(r"^cap\s*[:：]\s*(.*)$", s)
    return m.group(1) if m else None


def parse_decision(body, line, issues):
    d = {"kind": "decision", "line": line, "q": "", "q_line": line, "cost": "", "cost_line": line,
         "id": "", "opts": []}
    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        m = re.match(r"^(cost|id|q)\s*[:：]\s*(.*)$", s)
        if m:
            key, val = m.group(1), m.group(2).strip()
            if key == "cost":
                d["cost"], d["cost_line"] = val, ln
            elif key == "q":
                d["q"], d["q_line"] = val, ln
            elif re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", val):
                d["id"] = val
            else:
                issues.append((ln, "error", "syntax", "decision 的 id 只能用字母、数字、- 和 _,且以字母开头"))
            continue
        sug = None
        if s[0] in "-+" and len(s) > 1:
            rest = s[1:].strip()
            sug = rest.startswith("*") and not rest.startswith("**")
            if sug:
                rest = rest[1:].strip()
        elif s[0] == "*" and not s.startswith("**"):
            sug, rest = True, s[1:].strip()
        if sug is not None:
            parts = rest.split("|", 1)
            title = parts[0].strip()
            if not title:
                issues.append((ln, "error", "syntax", "decision 的选项缺标题,写法:- 标题 | 说明"))
                continue
            d["opts"].append({"title": title, "desc": parts[1].strip() if len(parts) > 1 else "",
                              "sug": sug, "line": ln})
            continue
        if not d["q"]:
            d["q"], d["q_line"] = s, ln
        else:
            issues.append((ln, "error", "syntax",
                           "decision 里这一行看不懂(只认:问题一行、cost: …、id: …、- 标题 | 说明)"))
    if not d["q"]:
        issues.append((line, "error", "syntax", "decision 缺问题:围栏里第一行写要他定的那个问题"))
    if not d["id"]:
        d["id"] = "d" + hashlib.sha1(plain(d["q"]).encode("utf-8")).hexdigest()[:6]
    return d


def _split_label(s):
    """'B: 标注' → ('B', '标注');时间 10:30 里的冒号不算。只认英文冒号。"""
    for k, c in enumerate(s):
        if c == ":" and not (0 < k < len(s) - 1 and s[k - 1].isdigit() and s[k + 1].isdigit()):
            return s[:k].strip(), s[k + 1:].strip()
    return s.strip(), ""


def parse_flow(body, line, issues):
    b = {"kind": "flow", "line": line, "lanes": [], "cap": "", "cap_line": line}
    cur = None

    def lane(title="", tone="", ln=line):
        nonlocal cur
        cur = {"title": title, "tone": tone, "nodes": {}, "edges": [], "line": ln}
        b["lanes"].append(cur)

    def node(spec, ln):
        spec = spec.strip()
        emph = spec.startswith("!")
        if emph:
            spec = spec[1:].strip()
        parts = spec.split("|", 1)
        name = parts[0].strip()
        if not name:
            issues.append((ln, "error", "syntax", "flow 这一行有空的节点,写法:A -> B: 标注"))
            return None
        info = cur["nodes"].setdefault(name, {"sub": "", "emph": False, "line": ln})
        info["emph"] = info["emph"] or emph
        if len(parts) > 1 and parts[1].strip():
            info["sub"] = parts[1].strip()
        return name

    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        c = _cap(s)
        if c is not None:
            b["cap"], b["cap_line"] = c, ln
            continue
        if s[0] in "✕✗×":
            lane(s[1:].strip(), "bad", ln)
            continue
        if s[0] in "✓✔√":
            lane(s[1:].strip(), "good", ln)
            continue
        if s[0] == "@":
            lane(s[1:].strip(), "", ln)
            continue
        if cur is None:
            lane()
        parts = re.split(r"\s*(?:->|→)\s*", s)
        label = ""
        if len(parts) > 1:
            parts[-1], label = _split_label(parts[-1])
        names = [node(p, ln) for p in parts]
        if None in names:
            continue
        for k in range(len(names) - 1):
            if names[k] == names[k + 1]:
                issues.append((ln, "error", "syntax", "flow 里节点不能指向自己"))
                continue
            cur["edges"].append((names[k], names[k + 1], label if k == len(names) - 2 else "", ln))
    b["lanes"] = [l for l in b["lanes"] if l["nodes"]]
    if not b["lanes"]:
        issues.append((line, "error", "syntax", "flow 是空的,至少写一行:A -> B: 标注"))
    return b


def parse_compare(body, line, issues):
    b = {"kind": "compare", "line": line, "cols": {}}
    cur = None
    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        if s[0] in "✕✗×" or s[0] in "✓✔√":
            key = "bad" if s[0] in "✕✗×" else "good"
            cur = b["cols"].setdefault(key, {"title": s[1:].strip(), "lines": [], "cap": "", "line": ln})
            continue
        if cur is None:
            issues.append((ln, "error", "syntax", "compare 要先写一行「✕ 现在」或「✓ 改成」,再写内容"))
            continue
        c = _cap(s)
        if c is not None:
            cur["cap"], cur["cap_line"] = c, ln
        elif s.startswith(">"):
            cur["lines"].append((ln, s[1:].strip(), True))
        else:
            cur["lines"].append((ln, re.sub(r"^[-+]\s+", "", s), False))
    for key, name in (("bad", "✕ 现在"), ("good", "✓ 改成")):
        if key not in b["cols"] or not b["cols"][key]["lines"]:
            issues.append((line, "error", "syntax", "compare 缺「%s」这一栏(两栏都要有,各写几行短文字)" % name))
    return b


def _num(s):
    try:
        return float(s.replace(",", "").rstrip("%").strip())
    except ValueError:
        return None


def parse_bars(body, line, issues):
    b = {"kind": "bars", "line": line, "rows": [], "cap": "", "cap_line": line}
    n0 = len(issues)
    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        c = _cap(s)
        if c is not None:
            b["cap"], b["cap_line"] = c, ln
            continue
        f = [x.strip() for x in s.split("|")]
        val = _num(f[1]) if len(f) > 1 else None
        mx = _num(f[2]) if len(f) > 2 and f[2] else None
        if not (2 <= len(f) <= 5) or not f[0] or val is None or (len(f) > 2 and f[2] and mx is None):
            issues.append((ln, "error", "syntax",
                           "bars 这一行不对,写法:标签 | 数值 | 满格值 | 右侧文字(数值和满格值必须是数字)"))
            continue
        b["rows"].append({"label": f[0], "val": val, "max": mx,
                          "right": f[3] if len(f) > 3 and f[3] else f[1],
                          "ok": len(f) > 4 and f[4].lower() == "ok", "line": ln})
    if not b["rows"] and len(issues) == n0:
        issues.append((line, "error", "syntax", "bars 是空的,至少写一行:标签 | 数值 | 满格值 | 右侧文字"))
    return b


def parse_steps(body, line, issues):
    b = {"kind": "steps", "line": line, "rows": []}
    n0 = len(issues)
    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        f = [x.strip() for x in s.split("|")]
        if not (2 <= len(f) <= 3) or not f[0] or not f[1]:
            issues.append((ln, "error", "syntax", "steps 这一行不对,写法:第 1 步 · 2 天 | 标题 | 一句说明"))
            continue
        b["rows"].append({"head": f[0], "title": f[1], "desc": f[2] if len(f) > 2 else "", "line": ln})
    if not b["rows"] and len(issues) == n0:
        issues.append((line, "error", "syntax", "steps 是空的,至少写一行:第 1 步 · 2 天 | 标题 | 一句说明"))
    return b


def parse_doc(text):
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if text.startswith("﻿"):
        text = text[1:]
    lines = text.split("\n")
    issues, meta, meta_lines, start = [], {}, {}, 0
    if lines and lines[0].strip() == "---":
        end = None
        for k in range(1, len(lines)):
            if lines[k].strip() == "---":
                end = k
                break
        if end is None:
            issues.append((1, "error", "meta", "frontmatter 没有关上(缺第二行 ---)"))
        else:
            for k in range(1, end):
                m = re.match(r"^\s*([A-Za-z_]+)\s*[:：]\s*(.*?)\s*$", lines[k])
                if m:
                    meta[m.group(1).lower()] = m.group(2).strip("\"'")
                    meta_lines[m.group(1).lower()] = k + 1
            start = end + 1
    else:
        issues.append((1, "error", "meta", "草稿第一行必须是 ---,开头写 frontmatter"))
    items = [(k + 1, lines[k]) for k in range(start, len(lines))]
    blocks = parse_blocks(items, issues)
    doc = {"text": text, "lines": lines, "meta": meta, "meta_lines": meta_lines, "issues": issues,
           "lead": None, "pre": [], "sections": [], "body_line": start + 1}
    cur = None
    for b in blocks:
        if b["kind"] == "h" and b["level"] == 2:
            cur = {"title": b["text"], "line": b["line"], "blocks": [], "num": len(doc["sections"]) + 1,
                   "end": len(lines)}
            if doc["sections"]:
                doc["sections"][-1]["end"] = b["line"] - 1
            doc["sections"].append(cur)
        elif cur is not None:
            cur["blocks"].append(b)
        elif doc["lead"] is None and not doc["pre"] and b["kind"] == "para":
            doc["lead"] = b
        else:
            doc["pre"].append(b)
    return doc


def decisions_in(blocks):
    out = []
    for b in blocks:
        if b["kind"] == "decision":
            out.append(b)
        elif b["kind"] == "fold":
            out.extend(decisions_in(b["blocks"]))
    return out


def all_decisions(doc):
    out = decisions_in(doc["pre"])
    for s in doc["sections"]:
        out.extend(decisions_in(s["blocks"]))
    return out


# ───────────────────────── 检查 ─────────────────────────

def _is_image_para(b):
    return b["kind"] == "para" and any(_IMG.search(t) for _, t in b["lines"])


def has_figure(blocks):
    """露在外面的图:flow / compare / bars / steps / 表格 / 图片(fold 里的不算)。"""
    for b in blocks:
        if b["kind"] in FIG_KINDS or _is_image_para(b):
            return True
        if b["kind"] == "list" and any(_IMG.search(t) for it in b["items"] for _, t in it["lines"]):
            return True
        if b["kind"] == "draft" and has_figure(b["blocks"]):
            return True
    return False


def text_items(blocks):
    """露在外面的文字 → [(行号, 原文, 类别)]。fold 里面的不出;fold 的标题算。
    类别:prose 正文 / cap 图注 / table 表格 / decision 题 / figure 图里的字。"""
    out = []
    for b in blocks:
        k = b["kind"]
        if k == "para":
            out += [(ln, t, "prose") for ln, t in b["lines"]]
        elif k == "quote":
            out += [(ln, t, "prose") for ln, t in b["lines"]]
        elif k == "list":
            out += [(ln, t, "prose") for it in b["items"] for ln, t in it["lines"]]
        elif k == "h":
            out.append((b["line"], b["text"], "prose"))
        elif k in ("fold", "draft"):
            out.append((b["line"], b["title"], "prose"))
        elif k == "table":
            out += [(ln, " ".join(cells), "table") for ln, cells in b["rows"]]
        elif k == "decision":
            out.append((b["q_line"], b["q"], "decision"))
            if b["cost"]:
                out.append((b["cost_line"], b["cost"], "decision"))
            for o in b["opts"]:
                out.append((o["line"], o["title"], "decision"))
                if o["desc"]:
                    out.append((o["line"], o["desc"], "decision"))
        elif k == "flow":
            for l in b["lanes"]:
                if l["title"]:
                    out.append((l["line"], l["title"], "figure"))
                for name, info in l["nodes"].items():
                    out.append((info["line"], name + " " + info["sub"], "figure"))
                out += [(ln, lab, "figure") for _, _, lab, ln in l["edges"] if lab]
            if b["cap"]:
                out.append((b["cap_line"], b["cap"], "cap"))
        elif k == "compare":
            for c in b["cols"].values():
                out.append((c["line"], c["title"], "figure"))
                out += [(ln, t, "figure") for ln, t, _ in c["lines"]]
                if c["cap"]:
                    out.append((c["cap_line"], c["cap"], "cap"))
        elif k == "bars":
            out += [(r["line"], r["label"] + " " + r["right"], "figure") for r in b["rows"]]
            if b["cap"]:
                out.append((b["cap_line"], b["cap"], "cap"))
        elif k == "steps":
            out += [(r["line"], " ".join((r["head"], r["title"], r["desc"])), "figure") for r in b["rows"]]
    return out


def prose_count(items):
    return sum(nchars(plain(t)) for _, t, cat in items if cat in ("prose", "cap"))


def sentences(t):
    t = plain(t, code=False, urls=False)
    return [x for x in re.split(r"[。！？；!?\n]", t) if nchars(x)]


def lint_doc(doc):
    """返回 (issues, stats)。issues = [(行号, 'error'|'warn', 代码, 说明)],按行号排好。"""
    iss = list(doc["issues"])
    meta, ml = doc["meta"], doc["meta_lines"]
    have_fm = not any(c == "meta" for _, _, c, _ in iss)
    if have_fm:
        for key in ("title", "line", "date", "status"):
            if not meta.get(key):
                iss.append((1, "error", "meta", "frontmatter 缺 %s" % key))
        if meta.get("date") and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", meta["date"]):
            iss.append((ml.get("date", 1), "error", "meta", "date 要写成 YYYY-MM-DD,现在是「%s」" % meta["date"]))
        if meta.get("status") and meta["status"] not in STATUSES:
            iss.append((ml.get("status", 1), "error", "meta",
                        "status 只能是「提议中」或「已定」,现在是「%s」" % meta["status"]))

    groups = []   # (露在外面的文字, 是不是结论段)
    lead = doc["lead"]
    lead_n = 0
    if lead is None:
        iss.append((doc["body_line"], "error", "lead-missing",
                    "没有结论段:frontmatter 后面第一段必须是一段话的结论(不能直接上标题、列表或图)"))
    else:
        lead_n = nchars(plain(" ".join(t for _, t in lead["lines"])))
        if lead_n > LEAD_MAX:
            iss.append((lead["line"], "error", "lead-long",
                        "结论段 %d 字,超过 %d 字" % (lead_n, LEAD_MAX)))
        groups.append(([(ln, t, "prose") for ln, t in lead["lines"]], True))

    total = lead_n
    any_fig = has_figure(doc["pre"])
    pre_items = text_items(doc["pre"])
    total += prose_count(pre_items)
    groups.append((pre_items, False))
    para_blocks = [lead] if lead else []
    para_blocks += [b for b in doc["pre"] if b["kind"] == "para"]

    for s in doc["sections"]:
        title = plain(s["title"]).strip()
        tn = nchars(title)
        total += tn
        if title.endswith((":", "：")):
            iss.append((s["line"], "error", "head-colon",
                        "节标题「%s」以冒号结尾,不是一句完整的话" % title))
        elif tn < HEAD_MIN and title != KEEP_TITLE:
            iss.append((s["line"], "error", "head-short",
                        "节标题「%s」只有 %d 个字,不足 %d 个字(标题要是一句结论)" % (title, tn, HEAD_MIN)))
        items = text_items(s["blocks"])
        n = prose_count(items)
        total += n
        fig = has_figure(s["blocks"])
        any_fig = any_fig or fig
        if n > SEC_MAX and not fig:
            iss.append((s["line"], "error", "sec-wall",
                        "第 %d 节「%s」露在外面的文字 %d 字,超过 %d 字,而这一节没有任何图"
                        % (s["num"], title, n, SEC_MAX)))
        groups.append((items + [(s["line"], s["title"], "head")], False))
        para_blocks += [b for b in s["blocks"] if b["kind"] == "para"]

    if total > PAGE_MAX:
        iss.append((doc["body_line"], "error", "page-long",
                    "全页露在外面的文字 %d 字,超过 %d 字" % (total, PAGE_MAX)))
    if total > NOFIG_MAX and not any_fig:
        iss.append((doc["body_line"], "error", "page-nofig",
                    "这一页 %d 字,超过 %d 字,却一张图都没有(flow / compare / bars / steps / 表格 / 图片)"
                    % (total, NOFIG_MAX)))

    # 要他定的题
    seen = {}
    for d in all_decisions(doc):
        q = plain(d["q"]) or "(没写问题)"
        if len(d["opts"]) < 2:
            iss.append((d["line"], "error", "dec-opts",
                        "「%s」只有 %d 个选项,至少要 2 个" % (q, len(d["opts"]))))
        nsug = sum(1 for o in d["opts"] if o["sug"])
        if d["opts"] and nsug != 1:
            iss.append((d["line"], "error", "dec-sug",
                        "「%s」%s,必须恰好标出一个建议" % (q, "没有标出建议" if nsug == 0 else "标了 %d 个建议" % nsug))
                       )
        if not d["cost"]:
            iss.append((d["line"], "error", "dec-cost", "「%s」没写 cost:(不定会卡住什么)" % q))
        if d["id"] in seen:
            iss.append((d["line"], "error", "dec-dup",
                        "「%s」和第 %d 行那道题的 id 相同(%s),答案会记串" % (q, seen[d["id"]], d["id"])))
        else:
            seen[d["id"]] = d["line"]

    def folded(blocks, inside):
        for b in blocks:
            if b["kind"] == "decision" and inside:
                iss.append((b["line"], "error", "dec-fold",
                            "「%s」这道题写在 %s 里,他看不到 / 会当成稿的一部分" % (plain(b["q"]) or "(没写问题)", inside)))
            elif b["kind"] in ("fold", "draft"):
                folded(b["blocks"], b["kind"])

    folded(doc["pre"], False)
    for s in doc["sections"]:
        folded(s["blocks"], False)

    # 表格一格太长(fold 里的不查:收起的不占他的眼)
    for blocks in [doc["pre"]] + [s["blocks"] for s in doc["sections"]]:
        for b in blocks:
            if b["kind"] != "table":
                continue
            for ln, cells in b["rows"]:
                for c in cells:
                    k = nchars(plain(c, code=False))
                    if k > CELL_MAX:
                        iss.append((ln, "error", "cell-long",
                                    "表格这一格 %d 个字,超过 %d 个字:「%s…」" % (k, CELL_MAX, plain(c).strip()[:14])))

    # 相对日期 + 长句
    for items, _ in groups:
        hit = {}
        for ln, t, cat in items:
            p = plain(t, code=False)
            for w in REL_WORDS:
                if w in p:
                    hit.setdefault(ln, [])
                    if w not in hit[ln]:
                        hit[ln].append(w)
            if cat in ("prose", "cap", "decision"):
                for sen in sentences(t):
                    k = nchars(sen)
                    if k > SENT_MAX:
                        iss.append((ln, "warn", "sent-long",
                                    "这一句 %d 个字,超过 %d 个字:「%s…」" % (k, SENT_MAX, sen.strip()[:14])))
        for ln, ws in hit.items():
            iss.append((ln, "error", "rel-date",
                        "出现「%s」,过一夜就错,要写成日期" % " / ".join(ws)))
    for b in para_blocks:
        k = sum(len(sentences(t)) for _, t in b["lines"])
        if k > PARA_SENTS:
            iss.append((b["line"], "warn", "para-long", "这一段有 %d 句,超过 %d 句" % (k, PARA_SENTS)))

    iss.sort(key=lambda x: (x[0], x[1] != "error", x[2]))
    stats = {"chars": total, "sections": len(doc["sections"]), "decisions": len(all_decisions(doc)),
             "lead": lead_n}
    return iss, stats


def report(issues, stats, name, strict=False, out=None):
    """打印检查结果;返回 True = 可以出页面。"""
    out = out or sys.stderr
    ne = nw = 0
    for ln, level, code, msg in issues:
        if level == "error":
            ne += 1
        else:
            nw += 1
        shown = "error" if (level == "error" or strict) else "warn"
        print("%s:%d: %s [%s] %s" % (name, ln, shown, code, msg), file=out)
        ex = EXAMPLES.get(code, "")
        if code == "syntax" and msg.split(" ")[0] in SYNTAX_EX:
            ex = SYNTAX_EX[msg.split(" ")[0]]
        if ex:
            print("      写对的例子: " + ex.replace("\n", "\n        "), file=out)
    ok = ne == 0 and not (strict and nw)
    print("lint: %d error, %d warn%s · 露在外面的文字 %d 字 · %d 节 · %d 道题 — %s"
          % (ne, nw, "(--strict:warn 当 error)" if strict else "", stats["chars"], stats["sections"],
             stats["decisions"], "通过" if ok else "不出页面"), file=out)
    return ok


# ───────────────────────── 渲染 ─────────────────────────

def fmt(x):
    s = "%.1f" % x
    return s[:-2] if s.endswith(".0") else s


def _cw(c, size):
    return size if ord(c) >= 0x2E80 else size * 0.58


def tw(s, size):
    return sum(_cw(c, size) for c in s)


def wrap_text(s, size, maxw):
    lines, cur, w = [], "", 0.0
    for c in s:
        cw = _cw(c, size)
        if cur and w + cw > maxw:
            lines.append(cur.rstrip())
            cur, w = "", 0.0
            if c == " ":
                continue
        cur += c
        w += cw
    if cur.strip():
        lines.append(cur.rstrip())
    return lines or [""]


TONES = {  # 底色, 边框, 箭头和栏名
    "bad": ("#fbecea", "#c2392b", "#c2392b"),
    "good": ("#e6f3ec", "#1f7a4d", "#1f7a4d"),
    "": ("#faf9f5", "#b9b5aa", "#1c1c1e"),
}


def render_flow(b, ctx):
    ctx["fig"] += 1
    fid = "ar-%s-%d" % (ctx["sec"], ctx["fig"])
    W, pad, y = 760, 10, 6.0
    edges_svg, nodes_svg, labels_svg, tones, desc = [], [], [], [], []
    for lane in b["lanes"]:
        fill, stroke, ink = TONES[lane["tone"]]
        if lane["tone"] not in tones:
            tones.append(lane["tone"])
        names = list(lane["nodes"])
        n = len(names)
        labs = [l for _, _, l, _ in lane["edges"] if l]
        gap = 34
        if labs:
            gap = int(min(130, max(44, max(tw(l, 11) for l in labs) + 18)))
        cols = n
        while cols > 1 and (W - 2 * pad - gap * (cols - 1)) / cols < 118:
            cols -= 1
        nw = min(240.0, (W - 2 * pad - gap * (cols - 1)) / cols)
        wrapped, nh = {}, 44.0
        for name in names:
            tl = wrap_text(name, 13, nw - 18)
            sub = lane["nodes"][name]["sub"]
            sl = wrap_text(sub, 11, nw - 18) if sub else []
            th = 17 * len(tl) + (14 * len(sl) + 2 if sl else 0)
            wrapped[name] = (tl, sl, th)
            nh = max(nh, th + 18)
        idx = {name: k for k, name in enumerate(names)}
        rowgap = 38
        arcs = any(idx[a] // cols == idx[c] // cols and idx[c] % cols != idx[a] % cols + 1
                   for a, c, _, _ in lane["edges"])
        if lane["title"]:
            labels_svg.append('<text x="%d" y="%s" fill="%s" font-weight="600">%s</text>'
                              % (pad, fmt(y + 14), ink, esc(lane["title"])))
            y += 24
        if arcs:
            y += 22
        pos = {name: (pad + (k % cols) * (nw + gap), y + (k // cols) * (nh + rowgap))
               for name, k in idx.items()}
        mk = ' marker-end="url(#%s%s)"' % (fid, lane["tone"])
        for a, c, lab, _ in lane["edges"]:
            desc.append("%s → %s" % (a, c))
            (xa, ya), (xb, yb) = pos[a], pos[c]
            ra, rb, ca, cb = idx[a] // cols, idx[c] // cols, idx[a] % cols, idx[c] % cols
            anchor = "middle"
            if ra == rb and cb == ca + 1:
                yc = ya + nh / 2
                d = "M%s %s H%s" % (fmt(xa + nw), fmt(yc), fmt(xb - 1))
                lx, ly = (xa + nw + xb) / 2, yc - 6
            elif ra == rb:
                sgn = 1 if cb > ca else -1
                x1, x2, top = xa + nw / 2 + 12 * sgn, xb + nw / 2 - 12 * sgn, ya - 14
                d = "M%s %s V%s H%s V%s" % (fmt(x1), fmt(ya), fmt(top), fmt(x2), fmt(yb - 1))
                lx, ly = (x1 + x2) / 2, top - 5
            else:
                x1, x2 = xa + nw / 2, xb + nw / 2
                if rb > ra:
                    y0, mid, y1 = ya + nh, ya + nh + rowgap / 2, yb - 1
                else:
                    y0, mid, y1 = ya, ya - rowgap / 2, yb + nh + 1
                if abs(x1 - x2) < 0.5:
                    d = "M%s %s V%s" % (fmt(x1), fmt(y0), fmt(y1))
                    lx, ly, anchor = x1 + 8, mid + 4, "start"
                else:
                    d = "M%s %s V%s H%s V%s" % (fmt(x1), fmt(y0), fmt(mid), fmt(x2), fmt(y1))
                    lx, ly = (x1 + x2) / 2, mid - 5
            edges_svg.append('<path d="%s" fill="none" stroke="%s" stroke-width="1.5"%s/>' % (d, ink, mk))
            if lab:
                labels_svg.append(
                    '<text x="%s" y="%s" text-anchor="%s" font-size="11" fill="#55555b" stroke="#fff" '
                    'stroke-width="4" paint-order="stroke">%s</text>' % (fmt(lx), fmt(ly), anchor, esc(lab)))
        for name in names:
            x, yy = pos[name]
            tl, sl, th = wrapped[name]
            emph = lane["nodes"][name]["emph"]
            f, st, sw = fill, stroke, "1"
            if emph:
                sw = "2.4"
                if not lane["tone"]:
                    f, st = "#e8f0fa", "#2563a8"
            nodes_svg.append('<rect x="%s" y="%s" width="%s" height="%s" rx="8" fill="%s" stroke="%s" '
                             'stroke-width="%s"/>' % (fmt(x), fmt(yy), fmt(nw), fmt(nh), f, st, sw))
            ty = yy + (nh - th) / 2 + 13
            for t in tl:
                nodes_svg.append('<text x="%s" y="%s" text-anchor="middle"%s>%s</text>'
                                 % (fmt(x + nw / 2), fmt(ty), ' font-weight="650"' if emph else "", esc(t)))
                ty += 17
            ty += -3 + 2 if sl else 0
            for t in sl:
                nodes_svg.append('<text x="%s" y="%s" text-anchor="middle" font-size="11" fill="#55555b">%s</text>'
                                 % (fmt(x + nw / 2), fmt(ty), esc(t)))
                ty += 14
        rows = int(math.ceil(n / float(cols)))
        y += rows * nh + (rows - 1) * rowgap + 20
    H = y - 12
    defs = "".join(
        '<marker id="%s%s" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">'
        '<path d="M0 0 L8 4 L0 8z" fill="%s"/></marker>' % (fid, t, TONES[t][2]) for t in tones)
    svg = ('<svg viewBox="0 0 %d %s" role="img" aria-label="%s"><defs>%s</defs>'
           '<g font-family="-apple-system,PingFang SC,sans-serif" font-size="13" fill="#1c1c1e">%s%s%s</g></svg>'
           % (W, fmt(H), esc("流程图:" + "；".join(desc)), defs,
              "".join(edges_svg), "".join(nodes_svg), "".join(labels_svg)))
    cap = '<div class="cap">%s</div>' % inline(b["cap"]) if b["cap"] else ""
    return '<div class="fig flow">%s%s</div>' % (svg, cap)


def render_bars(b, ctx):
    top = max([r["val"] for r in b["rows"]] + [0]) or 1.0
    out = ['<div class="fig"><div class="bars">']
    for r in b["rows"]:
        mx = r["max"] if r["max"] else top
        pct = max(0, min(100, int(round(r["val"] / mx * 100)))) if mx else 0
        out.append('<div class="bar"><span>%s</span><div class="track"><div class="fill%s" style="width:%d%%">'
                   '</div></div><span class="v">%s</span></div>'
                   % (inline(r["label"]), " ok" if r["ok"] else "", pct, inline(r["right"])))
    out.append("</div>")
    if b["cap"]:
        out.append('<div class="cap">%s</div>' % inline(b["cap"]))
    out.append("</div>")
    return "".join(out)


def render_compare(b, ctx):
    out = ['<div class="ba">']
    for key, mark in (("bad", "✕"), ("good", "✓")):
        c = b["cols"].get(key)
        if not c:
            continue
        out.append('<div class="%s"><div class="h">%s %s</div>' % (key, mark, inline(c["title"])))
        for _, t, wall in c["lines"]:
            out.append('<div class="%s">%s</div>' % ("wall" if wall else "ln", inline(t)))
        if c["cap"]:
            out.append('<div class="cap">%s</div>' % inline(c["cap"]))
        out.append("</div>")
    out.append("</div>")
    return "".join(out)


def render_steps(b, ctx):
    out = ['<div class="steps">']
    for r in b["rows"]:
        out.append('<div class="step"><div class="d">%s</div><h3>%s</h3>%s</div>'
                   % (inline(r["head"]), inline(r["title"]),
                      "<p>%s</p>" % inline(r["desc"]) if r["desc"] else ""))
    out.append("</div>")
    return "".join(out)


def render_decision(d, ctx):
    did = esc(d["id"])
    out = ['<div class="decision" id="%s" data-q="%s">' % (did, esc(plain(d["q"]))),
           '<div class="k">要你定</div><div class="ans" hidden></div>',
           "<h3>%s</h3>" % inline(d["q"])]
    if d["cost"]:
        out.append('<div class="cost">%s</div>' % inline(d["cost"]))
    out.append('<div class="opts">')
    for o in d["opts"]:
        out.append('<label class="opt"><input type="radio" name="%s" value="%s"%s><span><b>%s%s</b>%s</span></label>'
                   % (did, esc(plain(o["title"])), ' checked data-sug="1"' if o["sug"] else "",
                      inline(o["title"]), ' <span class="sug">建议</span>' if o["sug"] else "",
                      "<small>%s</small>" % inline(o["desc"]) if o["desc"] else ""))
    out.append('<label class="opt other"><input type="radio" name="%s" value="%s" data-other="1"><span>'
               "<b>%s</b><small>都不是的话选这个,在下面写你的说法。</small></span></label>"
               % (did, esc(OTHER), esc(OTHER)))
    out.append("</div>")
    out.append('<textarea class="note" name="%s-note" rows="2" placeholder="想补一段、或者都不选自己说一个,写在这里(可不填)">'
               "</textarea></div>" % did)
    return "".join(out)


def render_list(b):
    out, stack = [], []
    for it in b["items"]:
        while stack and it["indent"] < stack[-1][0]:
            out.append("</li></%s>" % stack.pop()[1])
        if stack and it["indent"] == stack[-1][0]:
            out.append("</li>")
        else:
            tag = "ol" if it["ordered"] else "ul"
            out.append("<%s>" % tag)
            stack.append((it["indent"], tag))
        out.append("<li>" + inline(join_lines([t for _, t in it["lines"]])))
    while stack:
        out.append("</li></%s>" % stack.pop()[1])
    return "".join(out)


def render_table(b):
    rows = b["rows"]
    ncol = max(len(c) for _, c in rows)
    out = ['<div class="tw"><table>']
    for k, (_, cells) in enumerate(rows):
        cells = cells + [""] * (ncol - len(cells))
        tag = "th" if k == 0 else "td"
        out.append("<tr>%s</tr>" % "".join("<%s>%s</%s>" % (tag, inline(c), tag) for c in cells))
    out.append("</table></div>")
    return "".join(out)


def render_blocks(blocks, ctx):
    out = []
    for b in blocks:
        k = b["kind"]
        if k == "para":
            text = join_lines([t for _, t in b["lines"]])
            m = _IMG.fullmatch(text.strip())
            if m:
                out.append('<div class="fig">%s%s</div>'
                           % (inline(text), '<div class="cap">%s</div>' % esc(m.group(1)) if m.group(1) else ""))
            else:
                out.append("<p>%s</p>" % inline(text))
        elif k == "h":
            tag = "h3" if b["level"] <= 3 else "h4"
            out.append("<%s>%s</%s>" % (tag, inline(b["text"]), tag))
        elif k == "hr":
            out.append("<hr>")
        elif k == "list":
            out.append(render_list(b))
        elif k == "quote":
            out.append("<blockquote><p>%s</p></blockquote>" % inline(join_lines([t for _, t in b["lines"]])))
        elif k == "table":
            out.append(render_table(b))
        elif k == "code":
            out.append("<pre><code>%s</code></pre>" % esc("\n".join(t for _, t in b["lines"])))
        elif k == "fold":
            out.append('<details class="fold"><summary>%s</summary>%s</details>'
                       % (inline(b["title"]), render_blocks(b["blocks"], ctx)))
        elif k == "draft":
            out.append('<section class="draft"><div class="draft-h">原稿 · %s</div>%s</section>'
                       % (inline(b["title"]), render_blocks(b["blocks"], ctx)))
        elif k == "decision":
            out.append(render_decision(b, ctx))
        elif k == "flow":
            out.append(render_flow(b, ctx))
        elif k == "bars":
            out.append(render_bars(b, ctx))
        elif k == "compare":
            out.append(render_compare(b, ctx))
        elif k == "steps":
            out.append(render_steps(b, ctx))
    return "\n".join(out)


def render_section(s):
    nd = len(decisions_in(s["blocks"]))
    tag = '<span class="tag">%d 件要你定</span>' % nd if nd else ""
    return ('\n<section id="s%d">\n<h2><span class="n">%d</span><span class="t">%s</span>%s</h2>\n%s\n</section>\n'
            % (s["num"], s["num"], inline(s["title"]), tag,
               render_blocks(s["blocks"], {"sec": "s%d" % s["num"], "fig": 0})))


def render_meta(doc):
    m, nd = doc["meta"], len(all_decisions(doc))
    parts = [m.get("line", ""), m.get("date", ""), m.get("status", "")]
    parts.append("有 %d 件要你定" % nd if nd else "没有要你定的")
    return '<div class="meta">%s</div>' % esc(" · ".join(p for p in parts if p))


def render_toc(doc):
    nd = len(all_decisions(doc))
    out = ['<details class="toc"><summary>目录 · %d 节%s</summary>'
           % (len(doc["sections"]), " · %d 件要你定" % nd if nd else "")]
    for d in decisions_in(doc["pre"]):
        out.append('<a class="d" href="#%s" data-d="%s">%s</a>' % (esc(d["id"]), esc(d["id"]), esc(plain(d["q"]))))
    for s in doc["sections"]:
        out.append('<a href="#s%d">%d %s</a>' % (s["num"], s["num"], esc(plain(s["title"]))))
        for d in decisions_in(s["blocks"]):
            out.append('<a class="d" href="#%s" data-d="%s">%s</a>'
                       % (esc(d["id"]), esc(d["id"]), esc(plain(d["q"]))))
    out.append("</details>")
    return "\n".join(out)


def render_lead(doc):
    out = ""
    if doc["lead"]:
        out = '<div class="lead">%s</div>' % inline(join_lines([t for _, t in doc["lead"]["lines"]]))
    if doc["pre"]:
        out += "\n" + render_blocks(doc["pre"], {"sec": "s0", "fig": 0})
    return out


SRC_OPEN = '<script type="text/plain" id="plan-source">'
SRC_CLOSE = "</script>"


def enc_source(text):
    return text.replace("&", "&amp;").replace("<", "&lt;")


def dec_source(s):
    return s.replace("&lt;", "<").replace("&amp;", "&")


def _kit(name):
    with open(os.path.join(KIT, name), encoding="utf-8") as f:
        return f.read().strip()


def M(name):
    return "<!--plan:%s-->" % name, "<!--/plan:%s-->" % name


def build(doc):
    """整页 HTML。同一份草稿永远拼出同一串字节(patch 靠这一点)。"""
    m = doc["meta"]
    css, js = _kit("plan.css"), _kit("plan.js")
    if "</style" in css.lower() or "</script" in js.lower():
        raise SystemExit("plan-kit 里的 CSS / JS 含有结束标签,不能内联")
    p = ["<!doctype html>", '<html lang="zh">', "<head>", '<meta charset="utf-8">',
         '<meta name="viewport" content="width=device-width,initial-scale=1">',
         '<meta name="color-scheme" content="light">', '<meta name="generator" content="plan.py">',
         "<title>%s</title>" % esc(m.get("title", "")), "<style>", css, "</style>", "</head>", "<body>",
         '<div class="wrap">',
         '<main id="plan" data-title="%s" data-date="%s">' % (esc(m.get("title", "")), esc(m.get("date", ""))),
         "<h1>%s</h1>" % esc(m.get("title", ""))]
    for name, body in (("meta", render_meta(doc)), ("toc", render_toc(doc)), ("lead", render_lead(doc))):
        a, b = M(name)
        p.append(a + body + b)
    for s in doc["sections"]:
        a, b = M("sec %d" % s["num"])
        p.append(a + render_section(s) + b)
    p += ["</main>", "</div>",
          '<div class="float"><button id="next" type="button">要你定的 ↓</button>'
          '<button id="resp" type="button">生成回复</button></div>',
          '<dialog id="dlg"><div class="hd"><span>你的回复</span><button id="close" type="button">关闭</button></div>'
          '<div class="bd"><div class="hint">复制后粘回和这条线的对话。这里只复制,不会自动发送。</div>'
          '<pre id="out"></pre><button id="copy" type="button">复制回复</button> <span id="ok"></span></div></dialog>',
          SRC_OPEN + enc_source(doc["text"]) + SRC_CLOSE,
          "<script>", js, "</script>", "</body>", "</html>", ""]
    return "\n".join(p)


# ───────────────────────── 命令 ─────────────────────────

def write_in_place(path, data):
    """已存在的文件原地写(它可能是硬链接,改名会断开);不存在才新建。"""
    if os.path.exists(path):
        with open(path, "r+b") as f:
            f.seek(0)
            f.write(data)
            f.truncate()
    else:
        with open(path, "wb") as f:
            f.write(data)


def read_draft(path):
    if path == "-":
        return sys.stdin.read(), "<stdin>"
    with open(path, encoding="utf-8") as f:
        return f.read(), path


def cmd_lint(path, strict=False, text=None):
    if text is None:
        text, name = read_draft(path)
    else:
        name = path
    issues, stats = lint_doc(parse_doc(text))
    return 0 if report(issues, stats, name, strict, out=sys.stdout) else 1


def cmd_render(path, out_path, strict=False, text=None):
    if text is None:
        text, name = read_draft(path)
    else:
        name = path
    if not out_path:
        if path == "-":
            print("从标准输入读草稿时必须用 -o 指定输出文件", file=sys.stderr)
            return 2
        out_path = os.path.splitext(path)[0] + ".html"
    doc = parse_doc(text)
    issues, stats = lint_doc(doc)
    if not report(issues, stats, name, strict):
        print("没有生成页面:先把上面的 error 改掉。", file=sys.stderr)
        return 1
    data = build(doc).encode("utf-8")
    write_in_place(out_path, data)
    print("已生成 %s(%d 字节 · %d 节 · %d 道题)" % (out_path, len(data), stats["sections"], stats["decisions"]))
    return 0


def _region(page, a, b):
    i = page.find(a)
    if i < 0 or page.find(a, i + 1) >= 0:
        return None
    j = page.find(b, i + len(a))
    return (i + len(a), j) if j >= 0 else None


def find_section(doc, want):
    want = want.strip()
    secs = doc["sections"]
    if want.isdigit():
        hit = [s for s in secs if s["num"] == int(want)]
    else:
        hit = [s for s in secs if plain(s["title"]).strip() == want or s["title"].strip() == want]
        if not hit:
            hit = [s for s in secs if want and want in plain(s["title"])]
    return hit


def patch_page(page, want, new_md, strict=False, name="<patch>"):
    """返回 (新页面 or None, 出错说明)。只换一节;其余字节不动。"""
    r = _region(page, SRC_OPEN, SRC_CLOSE)
    if r is None:
        return None, "页面里没有内嵌草稿原文(%s…),不是 plan.py 生成的页面,没法只换一节" % SRC_OPEN
    src = dec_source(page[r[0]:r[1]])
    doc = parse_doc(src)
    hit = find_section(doc, want)
    if len(hit) != 1:
        have = "；".join("%d %s" % (s["num"], plain(s["title"])) for s in doc["sections"])
        why = "找不到" if not hit else "有 %d 节都对得上" % len(hit)
        return None, "%s「%s」这一节。页面里现有:%s" % (why, want, have)
    sec = hit[0]
    new_lines = new_md.replace("\r\n", "\n").replace("\r", "\n").strip("\n").split("\n")
    probe = parse_blocks([(k + 1, t) for k, t in enumerate(new_lines)], [])
    h2 = [b for b in probe if b["kind"] == "h" and b["level"] == 2]
    if not probe or probe[0]["kind"] != "h" or probe[0]["level"] != 2 or len(h2) != 1:
        return None, "新的一节必须以一行「## 标题」开头,而且只能有这一个 ## 标题(现在有 %d 个)" % len(h2)
    lines = doc["lines"]
    before, after = lines[:sec["line"] - 1], lines[sec["end"]:]
    merged = before + new_lines + ([""] + after if after else [""])
    new_src = "\n".join(merged)
    new_doc = parse_doc(new_src)
    issues, stats = lint_doc(new_doc)
    if not report(issues, stats, name, strict):
        return None, "换上新的一节后检查不过,页面没有动。"
    if len(new_doc["sections"]) != len(doc["sections"]):
        return None, "换完后节数变了,页面没有动。"
    out = page
    swaps = [(M("sec %d" % sec["num"]), render_section(new_doc["sections"][sec["num"] - 1])),
             (M("meta"), render_meta(new_doc)), (M("toc"), render_toc(new_doc)),
             ((SRC_OPEN, SRC_CLOSE), enc_source(new_src))]
    for (a, b), body in swaps:
        r = _region(out, a, b)
        if r is None:
            return None, "页面里找不到标记 %s,不是 plan.py 生成的页面(或被手改过),页面没有动。" % a
        out = out[:r[0]] + body + out[r[1]:]
    return out, ""


def cmd_patch(html_path, want, new_md, strict=False):
    try:
        with open(html_path, "rb") as f:
            page = f.read().decode("utf-8")
    except (OSError, UnicodeDecodeError) as e:
        print("读不了 %s:%s" % (html_path, e), file=sys.stderr)
        return 1
    out, err = patch_page(page, want, new_md, strict, name=html_path)
    if out is None:
        print("patch 失败:" + err, file=sys.stderr)
        return 1
    data = out.encode("utf-8")
    with open(html_path, "r+b") as f:      # 原地写:这个文件是硬链接,不许写临时文件再改名
        f.seek(0)
        f.write(data)
        f.truncate()
    print("已换掉「%s」这一节:%s(%d 字节)" % (want, html_path, len(data)))
    return 0


# ───────────────────────── 自测 ─────────────────────────

FM = "---\ntitle: 测试用的方案\nline: 测试线\ndate: 2026-10-06\nstatus: 提议中\n---\n\n"
LEAD = "**结论:这页只做一件事。** 把草稿拼成网页。\n\n"
SEC1 = ("## 第一节讲清楚要做什么\n\n这里是一小段说明文字。\n\n"
        "```flow\n写草稿 -> !出页面: 检查\n出页面 -> 你点选项\n```\n\n"
        "```decision\n这件事归谁管？\ncost: 不定的话没人能动。\n- *甲线接管 | 结构归甲线。\n- 乙线接管 | 交给乙线。\n```\n\n")
SEC2 = "## 第二节给出数字和步骤\n\n```bars\n没有图 | 45 | 94 | 45 / 94\n超长 | 19 | 94 | 19 / 94 | ok\n```\n\n"
SEC3 = "## 不改什么\n\n别的都不动。\n"
GOOD = FM + LEAD + SEC1 + SEC2 + SEC3
SENT = "这是一句用来凑字数的普通句子。"     # 15 字


def _codes(text, level=None):
    issues, _ = lint_doc(parse_doc(text))
    return {c for _, lv, c, _ in issues if level is None or lv == level}


def _dec(body):
    return FM + LEAD + "## 第一节讲清楚要做什么\n\n```decision\n" + body + "\n```\n"


def _quiet(fn, *a, **k):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
        rc = fn(*a, **k)
    return rc, buf.getvalue()


def selftest():
    tests = []

    def t(name):
        def deco(fn):
            tests.append((name, fn))
            return fn
        return deco

    def pair(code, bad, near, level="error"):
        tests.append(("%s:该报的报了" % code, lambda: code in _codes(bad, level)))
        tests.append(("%s:不该报的没报" % code, lambda: code not in _codes(near)))

    tests.append(("合格草稿:0 error 0 warn", lambda: _codes(GOOD) == set()))
    pair("meta", GOOD.replace("status: 提议中", "status: 进行中"), GOOD.replace("status: 提议中", "status: 已定"))
    tests.append(("meta:缺 date 报了", lambda: "meta" in _codes(GOOD.replace("date: 2026-10-06\n", ""))))
    tests.append(("meta:没有 frontmatter 报了", lambda: "meta" in _codes(LEAD + SEC1)))
    pair("lead-missing", FM + SEC1, GOOD)
    pair("lead-long", FM + "结" * 121 + "\n\n" + SEC1, FM + "结" * 120 + "\n\n" + SEC1)
    pair("head-short", GOOD.replace("## 第一节讲清楚要做什么", "## 五个字标题"),
         GOOD.replace("## 第一节讲清楚要做什么", "## 六个字的标题"))
    tests.append(("head-short:「不改什么」放行", lambda: "head-short" not in _codes(FM + LEAD + SEC3)))
    pair("head-colon", GOOD.replace("## 第一节讲清楚要做什么", "## 我们卡在这两处："),
         GOOD.replace("## 第一节讲清楚要做什么", "## 结论:我们卡在这两处"))
    wall = FM + LEAD + "## 这一节全是大段文字\n\n" + SENT * 21 + "\n"            # 315 字
    pair("sec-wall", wall, FM + LEAD + "## 这一节全是大段文字\n\n" + SENT * 20 + "\n")   # 300 字
    tests.append(("sec-wall:有图就不报", lambda: "sec-wall" not in _codes(
        wall + "\n```steps\n第 1 步 | 先做这个 | 说明\n```\n")))
    _DRAFT = FM + LEAD + "## 第一篇小红书稿请你审\n\n```draft 小红书正文\n" + SENT * 80 + "\n\n![封面](img/a.png)\n![第二张](img/b.png)\n```\n"
    _DRAFT0 = FM + LEAD + "## 第一篇小红书稿请你审\n\n```draft X 串推七条\n" + SENT * 30 + "\n```\n"
    tests.append(("draft:要审的稿字再多也不算页面字数(1028)", lambda: not ({"sec-wall", "page-long", "nofig"} & set(_codes(_DRAFT)))
                  and not ({"sec-wall", "page-long"} & set(_codes(_DRAFT0)))))
    tests.append(("draft:没写标题报 syntax", lambda: "syntax" in _codes(_DRAFT.replace("```draft 小红书正文", "```draft"))))
    tests.append(("draft:题写进原稿里报 dec-fold", lambda: "dec-fold" in _codes(
        FM + LEAD + "## 第一篇小红书稿请你审\n\n````draft 正文\n```decision\n" + ok_dec + "\n```\n````\n")))
    tests.append(("draft:渲染成单列原稿块,图照出", lambda: all(x in build(parse_doc(_DRAFT)) for x in (
        '<section class="draft"><div class="draft-h">原稿 · 小红书正文</div>', '<img src="img/a.png" alt="封面"')))) 
    tests.append(("sec-wall:字收进 fold 就不报", lambda: "sec-wall" not in _codes(
        FM + LEAD + "## 这一节全是大段文字\n\n```fold 细节\n" + SENT * 21 + "\n```\n")))
    tests.append(("sec-wall:只在 fold 里有图仍然报", lambda: "sec-wall" in _codes(
        wall + "\n````fold 细节\n```steps\n第 1 步 | 先做这个 | 说明\n```\n````\n")))

    def many(n_sec, per, fig=True):
        out = FM + LEAD
        for k in range(n_sec):
            out += "## 第 %d 节也是一句完整的话\n\n%s\n\n" % (k + 1, SENT * per)
            if fig:
                out += "| 项 | 值 |\n|---|---|\n| 甲 | 1 |\n\n"
        return out

    pair("page-long", many(10, 18), many(8, 18))
    pair("page-nofig", many(4, 18, fig=False), many(4, 18, fig=True))
    tests.append(("page-nofig:800 字以内没图不报", lambda: "page-nofig" not in _codes(many(2, 18, fig=False))))
    ok_dec = "这件事归谁管？\ncost: 不定就没人能动。\n- *甲线 | 说明\n- 乙线 | 说明"
    pair("dec-opts", _dec("这件事归谁管？\ncost: 不定就没人能动。\n- *甲线 | 说明"), _dec(ok_dec))
    tests.append(("dec-opts:题没选项报了", lambda: "dec-opts" in _codes(_dec("这件事归谁管？\ncost: 会卡住。"))))
    pair("dec-sug", _dec(ok_dec.replace("- *甲线", "- 甲线")), _dec(ok_dec))
    tests.append(("dec-sug:两个建议报了", lambda: "dec-sug" in _codes(_dec(ok_dec.replace("- 乙线", "- *乙线")))))
    pair("dec-cost", _dec(ok_dec.replace("cost: 不定就没人能动。\n", "")), _dec(ok_dec))
    two = _dec(ok_dec) + "\n```decision\n" + ok_dec + "\n```\n"
    pair("dec-dup", two, _dec(ok_dec) + "\n```decision\nid: second\n" + ok_dec + "\n```\n")
    pair("dec-fold", FM + LEAD + "## 第一节讲清楚要做什么\n\n````fold 细节\n```decision\n" + ok_dec + "\n```\n````\n",
         _dec(ok_dec) + "\n```fold 细节\n这里只是说明。\n```\n")
    pair("rel-date", GOOD.replace("这里是一小段说明文字。", "这件事今晚就能做完。"),
         GOOD.replace("这里是一小段说明文字。", "界面上那个 `今天新增` 的按钮 10-06 做完。"))
    tests.append(("rel-date:fold 里的不报", lambda: "rel-date" not in _codes(
        GOOD + "\n```fold 细节\n昨天的记录在这里。\n```\n")))
    tests.append(("rel-date:表格和题里的也报", lambda: "rel-date" in _codes(
        GOOD.replace("- 乙线接管 | 交给乙线。", "- 乙线接管 | 明天交给乙线。"))))
    pair("syntax", GOOD.replace("没有图 | 45 | 94", "没有图 | 很多 | 94"), GOOD)
    _tb = "\n| 项 | 说明 |\n|---|---|\n| 甲 | %s |\n"
    pair("cell-long", GOOD + _tb % (SENT * 5), GOOD + _tb % (SENT * 3))
    tests.append(("cell-long:fold 里的表格不报", lambda: "cell-long" not in _codes(
        GOOD + "\n```fold 细节\n" + _tb % (SENT * 5) + "```\n")))
    tests.append(("syntax:围栏没关报了", lambda: "syntax" in _codes(GOOD + "\n```flow\nA -> B\n")))
    tests.append(("syntax:compare 缺一栏报了", lambda: "syntax" in _codes(
        GOOD + "\n```compare\n✕ 现在\n全是字\n```\n")))
    tests.append(("syntax:普通代码块不报", lambda: "syntax" not in _codes(GOOD + "\n```python\nprint(1)\n```\n")))
    long_s = "这是一句特别长的话" + "很长" * 19 + "。"                                  # 47 字
    pair("sent-long", GOOD.replace("这里是一小段说明文字。", long_s),
         GOOD.replace("这里是一小段说明文字。", "这是一句话" + "很长" * 20 + "。"), level="warn")   # 45 字
    tests.append(("sent-long:代码和链接地址不算", lambda: "sent-long" not in _codes(GOOD.replace(
        "这里是一小段说明文字。", "看 [这页](https://example.com/" + "a" * 60 + ") 和 `" + "x" * 60 + "` 就行。"))))
    pair("para-long", GOOD.replace("这里是一小段说明文字。", "短句。" * 7),
         GOOD.replace("这里是一小段说明文字。", "短句。" * 6), level="warn")

    with tempfile.TemporaryDirectory(prefix="plan-selftest-") as tmp:
        src, out = os.path.join(tmp, "good.md"), os.path.join(tmp, "good.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(GOOD)
        state = {}

        @t("render:合格草稿出页面,退出码 0")
        def _():
            rc, _o = _quiet(cmd_render, src, out)
            state["page"] = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
            return rc == 0 and state["page"].startswith("<!doctype html>")

        @t("render:有 error 不出页面,退出码 1")
        def _():
            bad, bo = os.path.join(tmp, "bad.md"), os.path.join(tmp, "bad.html")
            with open(bad, "w", encoding="utf-8") as f:
                f.write(wall)
            rc, o = _quiet(cmd_render, bad, bo)
            return rc == 1 and not os.path.exists(bo) and "写对的例子" in o and "bad.md:" in o

        @t("render:--strict 时 warn 也拦")
        def _():
            w, wo = os.path.join(tmp, "warn.md"), os.path.join(tmp, "warn.html")
            with open(w, "w", encoding="utf-8") as f:
                f.write(GOOD.replace("这里是一小段说明文字。", long_s))
            rc1, _o = _quiet(cmd_render, w, wo, True)
            gone = not os.path.exists(wo)
            rc2, _o = _quiet(cmd_render, w, wo, False)
            return rc1 == 1 and gone and rc2 == 0 and os.path.exists(wo)

        @t("lint:报错带草稿行号")
        def _():
            issues, _s = lint_doc(parse_doc(wall))
            return [ln for ln, _l, c, _m in issues if c == "sec-wall"] == [10]

        @t("页面:没有任何外部资源引用")
        def _():
            p = state["page"].lower()
            return not re.search(r"https?://|<link\b|@import|url\((?!#)|\bsrc=|<iframe|xmlns", p)

        @t("页面:作者自己写的链接和图片保留,链接新标签页打开")
        def _():
            d = parse_doc(GOOD + "\n见 [文档](https://example.com/a) 和 ![示意](img/a.png)\n")
            p = build(d)
            return ('<a href="https://example.com/a" target="_blank" rel="noopener noreferrer">文档</a>' in p
                    and '<img src="img/a.png" alt="示意"' in p and p.count("https://") == 2)

        @t("页面:单栏 820px,没有侧边栏式两栏布局")
        def _():
            p = state["page"]
            cols = re.findall(r"grid-template-columns\s*:\s*([^;}]+)", p)
            fixed = [c for c in cols if re.match(r"\s*[\d.]+(px|em|rem|ch|vw|%)", c)]
            return (bool(cols) and not fixed and "max-width:820px" in p and "<aside" not in p
                    and "position:sticky" not in p)

        @t("页面:浅色底,没有深色样式")
        def _():
            p = state["page"]
            return "prefers-color-scheme" not in p and "--bg:#f6f4ee" in p and "color-scheme:light" in p

        @t("页面:目录是顶部默认收起的 details")
        def _():
            p = state["page"]
            return '<details class="toc"><summary>目录 · 3 节 · 1 件要你定</summary>' in p and "<details open" not in p \
                and 'class="toc" open' not in p and re.search(r'<a class="d" href="#d\w+" data-d="d\w+">这件事归谁管？</a>', p)

        @t("页面:每道题都带「其他」选项和多行补充框")
        def _():
            d = parse_doc(_dec(ok_dec) + "\n```decision\nid: second\n" + ok_dec + "\n```\n")
            p = build(d)
            return (p.count('class="decision"') == 2 and p.count('data-other="1"') == 2
                    and p.count('<textarea class="note"') == 2 and p.count(esc(OTHER)) >= 4
                    and p.count(' checked data-sug="1"') == 2 and p.count('<span class="sug">建议</span>') == 2)

        @t("页面:浮动按钮、生成回复、只复制不发送")
        def _():
            p = state["page"]
            js = p[p.rfind("<script>"):]
            return ('id="next"' in p and 'id="resp"' in p and 'id="copy"' in p and "复制回复" in p
                    and "没点开，按建议" in js and "/_answer" in js and "/_answers?page=" in js
                    and js.count("fetch(") == 2 and "XMLHttpRequest" not in js and "sendBeacon" not in js
                    and "WebSocket" not in js)

        @t("页面:零件都渲染出来(flow 的 SVG / 强调节点 / bars / steps / compare / fold)")
        def _():
            d = parse_doc(GOOD + "\n```steps\n第 1 步 · 2 天 | 先做这个 | 一句说明\n```\n\n```compare\n✕ 现在\n全是字\n"
                          "✓ 改成\n有图\n```\n\n```fold 细节在这里\n- 一条\n- 两条\n```\n\n| 甲 | 乙 |\n|---|---|\n| 1 | 2 |\n")
            p = build(d)
            return all(x in p for x in ("<svg viewBox=", 'stroke-width="2.4"', "marker-end=", 'class="bar"',
                                         'class="fill ok" style="width:20%"', 'class="step"', 'class="ba"',
                                         '<details class="fold"><summary>细节在这里</summary>', "<th>甲</th>",
                                         '<div class="lead"><b>结论:这页只做一件事。</b>'))

        @t("flow:节点多了自动折行,图不超出画布")
        def _():
            chain = " -> ".join("第%d个节点" % k for k in range(1, 10))
            b = parse_flow([(1, chain)], 1, [])
            svg = render_flow(b, {"sec": "s9", "fig": 0})
            xs = [float(x) for x in re.findall(r'<rect x="([\d.]+)"', svg)]
            ys = {y for y in re.findall(r'<rect x="[\d.]+" y="([\d.]+)"', svg)}
            return len(xs) == 9 and max(xs) < 760 and len(ys) >= 2

        @t("页面:草稿里的 HTML 被转义,内嵌原文能原样取回")
        def _():
            raw = GOOD + "\n<script>alert(1)</script> 和 </script> 以及 A&B\n"
            p = build(parse_doc(raw))
            r = _region(p, SRC_OPEN, SRC_CLOSE)
            return "<script>alert(1)" not in p and r is not None and dec_source(p[r[0]:r[1]]) == raw

        @t("render:同一份草稿两次生成逐字节相同")
        def _():
            return build(parse_doc(GOOD)) == build(parse_doc(GOOD)) == state["page"]

        new2 = "## 第二节换成新的数字和图\n\n```bars\n没有图 | 10 | 94 | 10 / 94\n```\n\n```decision\n新加的一道题怎么定？\ncost: 不定就卡住。\n- *做 | 好\n- 不做 | 省事\n```\n"

        def chunks(p):
            parts = re.split(r"(<!--/?plan:[a-z]+(?: \d+)?-->)", p)
            d, k = {}, 0
            while k < len(parts):
                if parts[k].startswith("<!--plan:"):
                    d[parts[k]] = parts[k + 1]
                    k += 2
                else:
                    d.setdefault("outside", []).append(parts[k])
                    k += 1
            return d

        @t("patch:只动目标那一节,其余逐字节相同")
        def _():
            link = os.path.join(tmp, "link.html")
            os.link(out, link)
            state["ino"] = os.stat(out).st_ino
            before = open(out, "rb").read().decode("utf-8")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                rc = cmd_patch(out, "2", new2)
            after = open(out, "rb").read().decode("utf-8")
            state["after"], state["link"] = after, link
            a, b = chunks(before), chunks(after)
            same = ["<!--plan:lead-->", "<!--plan:sec 1-->", "<!--plan:sec 3-->"]
            src_a, src_b = _region(before, SRC_OPEN, SRC_CLOSE), _region(after, SRC_OPEN, SRC_CLOSE)
            return (rc == 0 and all(a[k] == b[k] for k in same) and a["<!--plan:sec 2-->"] != b["<!--plan:sec 2-->"]
                    and before[:before.find("<!--plan:meta-->")] == after[:after.find("<!--plan:meta-->")]
                    and before[src_a[1]:] == after[src_b[1]:]
                    and "第二节换成新的数字和图" in b["<!--plan:sec 2-->"] and "新加的一道题怎么定？" in b["<!--plan:toc-->"]
                    and "有 2 件要你定" in b["<!--plan:meta-->"])

        @t("patch:原地写(inode 不变,硬链接没断)")
        def _():
            return (os.stat(out).st_ino == state["ino"] == os.stat(state["link"]).st_ino
                    and open(state["link"], encoding="utf-8").read() == state["after"]
                    and not [f for f in os.listdir(tmp) if f.endswith((".tmp", ".bak", "~"))])

        @t("patch:结果等于拿新草稿整页重新生成")
        def _():
            r = _region(state["after"], SRC_OPEN, SRC_CLOSE)
            return build(parse_doc(dec_source(state["after"][r[0]:r[1]]))) == state["after"]

        @t("patch:按节标题找也行")
        def _():
            with contextlib.redirect_stderr(io.StringIO()):
                p, err = patch_page(state["after"], "不改什么", "## 不改什么\n\n配色和结构都不动。\n")
            return p is not None and "配色和结构都不动。" in p and "别的都不动。" not in p

        def untouched(fn):
            before = open(out, "rb").read()
            rc, o = _quiet(fn)
            return rc == 1 and open(out, "rb").read() == before and os.stat(out).st_ino == state["ino"], o

        @t("patch:找不到那一节 ⇒ 报错,文件不动")
        def _():
            ok, o = untouched(lambda: cmd_patch(out, "根本没有的一节", new2))
            return ok and "找不到" in o

        @t("patch:新的一节检查不过 ⇒ 报错,文件不动")
        def _():
            ok, o = untouched(lambda: cmd_patch(out, "2", "## 这一节全是大段文字\n\n" + SENT * 21 + "\n"))
            return ok and "sec-wall" in o

        @t("patch:新的一节没有 ## 标题 ⇒ 报错,文件不动")
        def _():
            ok, o = untouched(lambda: cmd_patch(out, "2", "只有正文没有标题。\n"))
            return ok and "## 标题" in o

        @t("patch:页面里没有内嵌原文 ⇒ 报错,文件不动")
        def _():
            bare = os.path.join(tmp, "bare.html")
            with open(bare, "w", encoding="utf-8") as f:
                f.write("<!doctype html><title>手写的</title><section id=\"s1\">x</section>")
            before = open(bare, "rb").read()
            rc, o = _quiet(cmd_patch, bare, "1", new2)
            return rc == 1 and open(bare, "rb").read() == before and "没有内嵌草稿原文" in o

        @t("1020 输入时停靠在屏幕底部:聚焦就停靠、原位留同高空白、失焦放回;样式是 fixed")
        def _():
            js, css = _kit("plan.js"), _kit("plan.css")
            return ("note(d).addEventListener('focus',function(){dock(d,true);});" in js
                    and "note(d).addEventListener('blur',function(){dock(d,false);});" in js
                    and "sp.style.height=n.offsetHeight+'px'" in js and "d.classList.remove('docked')" in js
                    and ".decision.docked .note{position:fixed;" in css)

        @t("selftest:只在临时目录里写")
        def _():
            return os.path.realpath(out).startswith(os.path.realpath(tmp))

        failed = 0
        for k, (name, fn) in enumerate(tests, 1):
            try:
                ok = bool(fn())
                why = ""
            except Exception as e:      # 自测里任何异常都算这一条没过
                ok, why = False, "  (%s: %s)" % (type(e).__name__, e)
            failed += not ok
            print("%s %2d  %s%s" % ("ok  " if ok else "FAIL", k, name, why))
    print("selftest: %d 条,%d 过,%d 没过" % (len(tests), len(tests) - failed, failed))
    return 1 if failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="plan.py", description="方案板生成器:Markdown 草稿 → 一页带检查的网页")
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("render", help="草稿 → 网页(先检查,有 error 不出页面)")
    a.add_argument("draft", help="草稿 .md;- 表示从标准输入读")
    a.add_argument("-o", "--output", help="输出 .html(缺省:草稿同名 .html)")
    a.add_argument("--strict", action="store_true", help="warn 也当 error")
    a = sub.add_parser("lint", help="只检查")
    a.add_argument("draft")
    a.add_argument("--strict", action="store_true")
    a = sub.add_parser("patch", help="只换已生成页面里的一节(新的一节从标准输入读)")
    a.add_argument("html")
    a.add_argument("--section", required=True, help="节标题或序号")
    a.add_argument("--strict", action="store_true")
    sub.add_parser("selftest", help="自测(不联网,只写临时目录)")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "render":
            return cmd_render(args.draft, args.output, args.strict)
        if args.cmd == "lint":
            return cmd_lint(args.draft, args.strict)
        if args.cmd == "patch":
            return cmd_patch(args.html, args.section, sys.stdin.read(), args.strict)
        if args.cmd == "selftest":
            return selftest()
    except FileNotFoundError as e:
        print("找不到文件:%s" % e.filename, file=sys.stderr)
        return 2
    ap.print_help()
    return 2


if __name__ == "__main__":
    if os.name == "nt":          # 1023:Windows 下 stdout 缺省是本地代码页,打印 ⛔ ⭐ 这类字符会崩;文件读写本文件都写了 encoding
        for _s in (sys.stdout, sys.stderr):
            try:
                _s.reconfigure(encoding="utf-8", errors="replace")
            except (AttributeError, ValueError):
                pass
    sys.exit(main())
