#!/usr/bin/env python3
"""plan.py — 方案板生成器。

AI 只写一份很短的 Markdown 草稿,本工具把它拼成一页网页,并在生成时检查;
不合格就不出页面。草稿格式见 plan-kit/README.md。

  python3 plan.py render <草稿.md> -o <输出.html>     ('-' 表示从标准输入读)
  python3 plan.py lint   <草稿.md> [--strict]
  python3 plan.py patch  <已生成.html> --section "<节标题或序号>" < 新的一节.md
  python3 plan.py coldread <草稿.md> [--save <冷读者的回答> | --check]
  python3 plan.py selftest

讲数量先给框(一行一种额度;1117 负责人:「这两个是不同的额度，那这里面用的都是多少呢？」):
  ```quota
  导出额度 | 200 次 / 周 | 180–200 | 30 | 每天早上下载一份销量榜
  查询额度 | 3,000 次 / 月 | 2,400 | 300 | 补商品详情
  ```
  名称 | 上限与周期 | 一个周期用多少 | 接下来再多用多少 | 用在哪;机器折合每天几次、画刻度条、算够不够。

发之前冷读(1117 负责人:「我根本都看不懂在说什么玩意」):带题的页没有通过的冷读记录 ⇒ render / patch 不出页面。
  plan.py coldread 草稿.md            导出他会看到的全部文字 + 印给冷读者的任务书
  plan.py coldread 草稿.md --save 回答  存冷读者回的 JSON(草稿.coldread.json)
  plan.py coldread 草稿.md --check     冷读者标 blocks:true(挡路)的都清空才算过;false 的只印参考

按组批量定(一题定一组条目;1113 负责人:「我不可能点105次」):
  ```batch
  这 87 条都下架？
  cost: 不定的话这批链接继续占着广告预算。
  - *都下架 | 30 天 0 单,留着只花钱。
  - 都先留着 | 等大促后再看。
  items:
  - 链接 A-001 | 30 天 0 单
  - 链接 A-002 | 退货率 40%
  ```
  他点一个选项就定了整组;展开清单可以把个别条目勾成「例外」,回答里带上例外的条目名。

只用 Python 3 标准库;页面里的 CSS / JS 全部内联,不引任何外部网址。
"""
import argparse
import contextlib
import hashlib
import html as _html
import io
import json
import math
import os
import re
import sys
import tempfile
import time

import board_paths as BP

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
# 依据: 负责人 11-13 18:26 在选品 105 道题的页上:「我不可能点105次,这完全是有问题的……我需要大量的去挨个去处理好多个回答的情况下,状态板或者方案板该怎么设计?」
#   ⇒ 一页超过 10 道题就提醒(只提醒、--strict 也不拦):把同类的合成按组批量定(```batch)。
DEC_MANY = 10
# 依据: 同上;按组题清单一条一个例外勾,条目名就是回答里的例外标识,太短太长都认不出 ⇒ 按表格一格的上限卡条目名。
BATCH_ITEM_MAX = 60
# 依据: 逐行题最多 5 个选项;boards-server.py 的 choice 字段保留前 600 个字符。
ROW_OPTIONS_MAX, ROW_CHOICE_MAX = 5, 600
# 依据: 逐行回答要求用「没选」标记空行。
ROW_UNANSWERED = "没选"
# 依据: 逐行题的作者自定义 id 不允许点号，默认节内题 id 因此不会与其冲突。
SECTION_PICK_ID = "pick.per-section"
# 依据: boards-server.py 的 q 字段保留前 400 个字符。
ROW_TITLE_MAX = 400
NEVER_BLOCK = ("dec-many",)   # 只提醒的代码:--strict 也不当 error
# 依据: 04850cfc5 规定表格单格超过60字报错，防止将长文放进表格绕过字数检查。
CELL_MAX = 60         # 表格一格上限(error:长文塞进表格能躲过每节 / 全页字数,所以按格卡)
REL_WORDS = ("今天", "今晚", "明天", "昨天", "明早", "今早")
STATUSES = ("提议中", "已定")
KEEP_TITLE = "不改什么"   # 这一节标题短也放行(鼓励写)
OTHER = "其他(我自己写)"
# 依据: 负责人 11-17 12:30 看一页只有表格和段落的额度盘点页:「你这种盘点啊,真的全都是文字,你下次给我它可视化好吧?
#   ……你这个表真的可视性可读性几乎为零。」那页 lint 通过,因为表格也算「图」⇒ 表格不再算图(page-nofig);
#   一节用表格比数字却没图 ⇒ 报 nums-nofig(warn,默认印出来,--strict 拦),文案带照这张表拼好的 ```bars。
#   sec-wall 照旧把表格算图(表格里的字本来就不算正文字数,这条只管大段正文)。
FIG_KINDS = ("flow", "compare", "bars", "steps", "quota")
NUMS_ROWS = 3         # 表格至少几行数据才查 nums-nofig
NUMS_SHARE = 0.6      # 一列里数字格占非空格的比例到这么多 = 数字列
NUMS_LIST = 30        # 超过这么多行数据是清单(删哪些链接这种),不是在比数字
# 依据: 负责人 11-17 看一页已经换成条形图的额度盘点页:「每周约270次指的是导出，是吗？我没搞懂啊」「你现在我先它分成两个事情，
#   第一个事情它是导出的额度，第二个事情是用那个MCP的额度。那么这两个是不同的额度，那这里面用的都是多少呢？」「哪怕你可视化以后我也看不懂」。
#   ⇒ 有没有图不是根因:讲数量没有固定的框,作者就会漏掉「哪一种额度 / 上限多少 / 折合每天几次 / 够不够」。
#   ```quota 一行一种额度,五格必填,够不够由机器算(作者不填结论);页面在讲额度却没有 quota 块 ⇒ quota-missing(warn,--strict 拦,同 nums-nofig)。
QUOTA_FIELDS = ("名称", "上限与周期", "已用", "接下来要用", "用在哪")
# 依据: 状态板线 11-17 brief「月按 30 天」。只用来折合「≈ 每天几次」做量级判断:大小月差 1 天(≤3.4%),不改够不够的结论。
PERIOD_DAYS = {"天": 1, "日": 1, "周": 7, "星期": 7, "月": 30}
PERIOD_WORD = {"天": "每天", "日": "每天", "周": "每周", "星期": "每周", "月": "每月"}
PERIOD_ONE = {"天": "一天", "日": "一天", "周": "一周", "星期": "一周", "月": "一个月"}   # 结论句里每个数都带上周期(冷读:「每月已用」读不出是哪个月)
# 依据: 同上 brief「出现额度 / 配额 / 限额 / 上限 … 次这类说法 ≥2 处」才报:提一次「额度」可能只是顺带一句,两处以上就是在讲用量。
QUOTA_HITS = 2
_QUOTA_TALK = re.compile(r"额度|配额|限额|限流|(?:上限|最多)[^。；;\n]{0,12}?\d[\d,]*\s*次"
                         r"|\d[\d,]*\s*次\s*/\s*(?:天|日|周|月)|每(?:天|日|周|月)\s*(?:约|大约|最多|上限)?\s*\d[\d,]*\s*次")

# 依据: 状态板线 11-17 brief(负责人 11-17:「我根本都看不懂在说什么玩意」「就是完全没有讲人话」「就读的也很累」):
#   作者带着上下文写,自己看不出哪里没讲清;机器也判不了「讲没讲清」⇒ 发之前让一个不带上下文的读者读一遍(冷读),
#   读者标 blocks:true(挡路)的不懂的词 / 答不上的问题清空了才出页面(带题的页 error;纯展示页 warn);blocks:false 只印参考。
#   ⛔ 否过:做一张「内部词词表」来查术语 —— 同义词换个说法就绕过去,业务词是无限的,表永远补不完。
#   ⛔ 否过:让作者自己答冷读题 —— 作者有上下文,读自己的页什么都懂,等于没查。
#   ⛔ 否过:让冷读者「宁多勿少」、所有条目都清空才过 —— 实测好例子改 8 轮、每轮五万多 token 仍有挑刺,只能满页写豁免;
#      改成读者给每条标 blocks(挡不挡路),只拦挡路的(验收方 11-17 改判法)。
# 依据: 同上 brief「理由 ≥8 个字」:挡住「不改」「没必要」这种一两个词的敷衍;8 个字刚够写一句「这个词页面外人人都懂」。
COLDREAD_REASON_MIN = 8
HINTS_ENV = "PLAN_HINTS_LOG"          # 提醒日志路径(测试指到临时目录);缺省 state_dir/board-hints.log,与 board.py 写行提醒共用一份

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
    "dec-many": "同类的题合成一道按组批量定:\n```batch\n这 87 条都下架？\ncost: 不定的话这批链接继续占着广告预算。\n- *都下架 | 30 天 0 单。\n- 都先留着 | 等大促后再看。\nitems:\n- 链接 A-001 | 30 天 0 单\n- 链接 A-002 | 退货率 40%\n```",
    "batch-items": "items: 下面每条一行「- 条目名 | 一句理由(可不写)」,至少 2 条、条目名不重复:\nitems:\n- 链接 A-001 | 30 天 0 单\n- 链接 A-002",
    # 依据: 逐行题沿用 batch 的 items 清单。
    "batch-row-options": "在 items: 前写「每行选: 涨 | 不涨」,替换整组选项。",
    "rel-date": "写成日期:「10-06 新落的行」;要引用界面上的字就放进反引号:`今天新增`",
    "syntax": "```flow\n写草稿 -> 工具拼页面: 检查\n```   (围栏块要有开头和结尾两行 ```)",
    "sent-long": "拆成两句:「上线前 254 条里 18 条。上线后 144 条里 11 条,比例没变。」",
    "para-long": "一段只讲一件事;超过 6 句就拆成两段,或改成列表 / 表格",
    "cell-long": "一格只放一个短语或一个数:| 方案板 | 94 页里 45 页没有图 |   长的说明挪到表格下面写成一段,或放进 ```fold",
    "nums-nofig": "```bars\n每天全扫 | 1750 | | 约 1,750 次/周\n分档轮转 | 860 | | 约 860 次/周\n按店名筛导出 | 270 | | 约 270 次/周 | ok\n```\n"
                  "```fold 明细表\n(原来的表格挪到这里)\n```",
    "quota": "一行一种额度,五格:名称 | 上限与周期 | 已用(一个周期用多少,可写区间) | 接下来要用(每个周期再多用多少,不多用写 0) | 用在哪\n"
             "```quota\n导出额度 | 200 次 / 周 | 180–200 | 30 | 每天早上下载一份销量榜\n"
             "查询额度 | 3,000 次 / 月 | 2,400 | 300 | 程序逐个问商品详情,问一次扣一次\n```",
    "quota-missing": "先说清是哪一种额度,一行一种:\n```quota\n导出额度 | 200 次 / 周 | 180–200 | 30 | 每天早上下载一份销量榜\n"
                     "查询额度 | 3,000 次 / 月 | 2,400 | 300 | 程序逐个问商品详情,问一次扣一次\n```\n"
                     "机器会写出「每周最多 200 次 ≈ 每天 29 次」、画刻度条、算够不够。",
}

SYNTAX_EX = {   # 语法类报错按零件给例子
    "decision": EXAMPLES["dec-opts"],
    "batch": EXAMPLES["dec-many"].split("\n", 1)[1],
    "flow": "```flow\n写草稿 -> !工具拼页面: 检查\n工具拼页面 -> 你点选项 | 答案写回这一页\n```",
    "compare": "```compare\n✕ 现在\n32 步纯文字\n✓ 改成\n标题是结论,图在前\n```",
    "bars": "```bars\n一张图都没有 | 45 | 94 | 45 / 94\n```",
    "steps": "```steps\n第 1 步 · 2 天 | 方案板工具第一版 | 拿一页真方案重做给你看。\n```",
    "quota": "```quota\n导出额度 | 200 次 / 周 | 180–200 | 30 | 每天早上下载一份销量榜\n```",
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


# 依据: 11-13 示例-基建满屏 base64 实例
_VISIBLE_BASE64 = re.compile(r"[A-Za-z0-9+/=]{200,}")
# 依据: 11-13 方案页仅允许不含脚本的常见图片 data URI。
_IMAGE_DATA = re.compile(r"data:image/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]+={0,2})", re.I)


def _img_sub(m):
    url = _html.unescape(m.group(2))
    data = _IMAGE_DATA.fullmatch(url)
    if url.lower().startswith("data:"):
        import base64, binascii
        try:
            if not data or not base64.b64decode(data.group(1), validate=True):
                raise ValueError()
        except (ValueError, binascii.Error):
            raise ValueError("图片「%s」地址不安全或格式不对；请用相对路径或 data:image/png;base64,..." % _html.unescape(m.group(1)))
    elif not _SAFE_URL.match(url):
        raise ValueError("图片「%s」地址不安全或格式不对；请用相对路径或 data:image/png;base64,..." % _html.unescape(m.group(1)))
    return '<img src="%s" alt="%s" loading="lazy">' % (m.group(2), m.group(1))


def _link_sub(m):
    if not _SAFE_URL.match(_html.unescape(m.group(2))):
        return m.group(1)
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
# 依据: 节内选使用顶层独立行。
_PICK = re.compile(r"^选\s*[:：]\s*(.*)$")
# 依据: 建议紧接「选:」，其余位置的「建议:」仍可作正文。
_PICK_SUG = re.compile(r"^建议\s*[:：]\s*(.*)$")


def _starts_block(s):
    return bool(_FENCE.match(s) or _HEAD.match(s) or _LIST.match(s) or s.lstrip().startswith(">"))


def parse_blocks(items, issues, section_picks=False):
    """items = [(行号, 文字)];返回块列表。issues 收语法问题 (行号, 级别, 代码, 说明)。"""
    blocks, i, n = [], 0, len(items)
    while i < n:
        ln, s = items[i]
        if not s.strip():
            i += 1
            continue
        pick = _PICK.match(s) if section_picks else None
        if pick:
            i += 1
            sug = _PICK_SUG.match(items[i][1]) if i < n else None
            blocks.append({"kind": "section-pick", "line": ln, "row_opts": [v.strip() for v in pick[1].split("|")],
                           "suggestion": plain(sug[1]).strip() if sug else None})
            if sug:
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
            while (j < n and items[j][1].strip() and "|" in items[j][1]
                   and not (section_picks and _PICK.match(items[j][1]))):
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
            if j > i and (_starts_block(items[j][1]) or (section_picks and _PICK.match(items[j][1]))):
                break
            lines.append(items[j])
            j += 1
        blocks.append({"kind": "para", "lines": lines, "line": ln})
        i = j
    return blocks


def make_fence(lang, arg, body, line, issues):
    if lang == "decision":
        return parse_decision(body, line, issues)
    if lang == "batch":
        return parse_decision(body, line, issues, batch=True)
    if lang == "flow":
        return parse_flow(body, line, issues)
    if lang == "compare":
        return parse_compare(body, line, issues)
    if lang == "bars":
        return parse_bars(body, line, issues)
    if lang == "steps":
        return parse_steps(body, line, issues)
    if lang == "quota":
        return parse_quota(body, line, issues)
    if lang == "draft":
        # 1028(内容助理转,负责人:「六张图根本没有办法点开放大」「那个方案版的模板是为了选品上架设计的,不应该套用到别的方案板去」):
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


def parse_decision(body, line, issues, batch=False):
    """```decision 一道题;batch=True(```batch,1113)= 按组批量定:题面 / cost / 选项同 decision,`items:` 之后每行一条「- 条目名 | 理由」。
    条目名就是回答里「例外」记的那个名字(d["items"] = [{title, desc, line}];普通题 d["items"] = None)。"""
    d = {"kind": "decision", "line": line, "q": "", "q_line": line, "cost": "", "cost_line": line,
         "id": "", "opts": [], "items": [] if batch else None, "row_opts": None}
    in_items = False
    w = "batch" if batch else "decision"
    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        m = re.fullmatch(r"每行选\s*[:：]\s*(.*)", s) if batch and not in_items else None
        if m:
            if d["row_opts"] is not None:
                issues.append((ln, "error", "batch-row-options", "每个 batch 只能写一行「每行选:」"))
            d["row_opts"] = [v.strip() for v in m.group(1).split("|")]
            d["row_opts_line"] = ln
            continue
        if batch and re.fullmatch(r"(items|清单)\s*[:：]", s):
            in_items = True
            continue
        if in_items:
            m = re.match(r"^[-+*]\s*(.*)$", s)
            if not m or not m.group(1).strip():
                issues.append((ln, "error", "batch-items", "batch 的 items: 下面每条一行「- 条目名 | 理由」,这一行看不懂"))
                continue
            parts = m.group(1).split("|", 1)
            title = parts[0].strip()
            if not title:
                issues.append((ln, "error", "batch-items", "batch 的条目缺名字,写法:- 条目名 | 理由"))
                continue
            d["items"].append({"title": title, "desc": parts[1].strip() if len(parts) > 1 else "", "line": ln})
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
                issues.append((ln, "error", "syntax", "%s 的 id 只能用字母、数字、- 和 _,且以字母开头" % w))
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
                issues.append((ln, "error", "syntax", "%s 的选项缺标题,写法:- 标题 | 说明" % w))
                continue
            d["opts"].append({"title": title, "desc": parts[1].strip() if len(parts) > 1 else "",
                              "sug": sug, "line": ln})
            continue
        if not d["q"]:
            d["q"], d["q_line"] = s, ln
        else:
            issues.append((ln, "error", "syntax",
                           "%s 里这一行看不懂(只认:问题一行、cost: …、id: …、- 标题 | 说明%s)" % (w, "、items: 后面的条目" if batch else "")))
    if not d["q"]:
        issues.append((line, "error", "syntax", "%s 缺问题:围栏里第一行写要他定的那个问题" % w))
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
    group, gline, pend = "", line, None        # 1117 分组:「@ 组名」一行起一组(几种方案比几项用量),同一张图共用一把尺子
    for ln, t in body:
        s = t.strip()
        if not s:
            continue
        c = _cap(s)
        if c is not None:
            b["cap"], b["cap_line"] = c, ln
            continue
        if s.startswith("@") and "|" not in s:
            group, gline = s[1:].strip(), ln
            if not group:
                issues.append((ln, "error", "syntax", "bars 分组行要写组名,写法:@ 3C 24 家 / 周"))
            if pend:
                issues.append((pend[0], "error", "syntax", "bars 分组「%s」下面一条都没有,写法:@ 组名 换行后写 标签 | 数值" % pend[1]))
            pend = (ln, group)
            continue
        pend = None
        f = [x.strip() for x in s.split("|")]
        val = _num(f[1]) if len(f) > 1 else None
        mx = _num(f[2]) if len(f) > 2 and f[2] else None
        if not (2 <= len(f) <= 5) or not f[0] or val is None or (len(f) > 2 and f[2] and mx is None):
            issues.append((ln, "error", "syntax",
                           "bars 这一行不对,写法:标签 | 数值 | 满格值 | 右侧文字(数值和满格值必须是数字)"))
            continue
        b["rows"].append({"label": f[0], "val": val, "max": mx,
                          "right": f[3] if len(f) > 3 and f[3] else f[1],
                          "ok": len(f) > 4 and f[4].lower() == "ok", "line": ln, "group": group, "gline": gline})
    if pend:
        issues.append((pend[0], "error", "syntax", "bars 分组「%s」下面一条都没有,写法:@ 组名 换行后写 标签 | 数值" % pend[1]))
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


_AMT = r"(\d[\d,]*(?:\.\d+)?)\s*(万)?"


def _amt_val(n, wan):
    v = float(n.replace(",", ""))
    return v * 10000 if wan else v


def quota_amount(s):
    """「约 180–200 次」→ (180, 200);「3,000」→ (3000, 3000);「1.2 万」→ (12000, 12000)。看不懂 → None。"""
    t = plain(s).strip()
    m = re.fullmatch(r"(?:约|大约|近|~|～|≈)?\s*" + _AMT + r"(?:\s*(?:–|—|-|~|～|到|至)\s*" + _AMT + r")?\s*[^\d\s]{0,4}", t)
    if not m:
        return None
    lo = _amt_val(m.group(1), m.group(2))
    hi = _amt_val(m.group(3), m.group(4)) if m.group(3) else lo
    return (lo, hi) if hi >= lo else None


def quota_limit(s):
    """「200 次 / 周」「200次/每周」「每周最多 200 次」「每月 3,000 次」→ (200, '次', '周');看不懂 → None。周期只认 天 / 日 / 周 / 星期 / 月。"""
    t = plain(s).strip()
    m = re.fullmatch(r"(?:每|一)?\s*(天|日|周|星期|月)\s*(?:最多|上限|限)?\s*" + _AMT + r"\s*([^\d\s/]{0,4})", t)
    if m:
        per, n, wan, unit = m.groups()
    else:
        m = re.fullmatch(r"(?:最多|上限|限)?\s*" + _AMT + r"\s*([^\d\s/每]{0,4}?)\s*(?:/\s*每?|每)\s*(天|日|周|星期|月)", t)
        if not m:
            return None
        n, wan, unit, per = m.groups()
    v = _amt_val(n, wan)
    return (v, unit or "次", per) if v > 0 else None


def parse_quota(body, line, issues):
    """```quota(1117):一行一种额度「名称 | 上限与周期 | 已用 | 接下来要用 | 用在哪」,五格必填。"""
    b = {"kind": "quota", "line": line, "rows": [], "cap": "", "cap_line": line}
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
        who = "「%s」" % f[0] if f[0] else "这一行"
        if len(f) > len(QUOTA_FIELDS):
            issues.append((ln, "error", "quota", "quota %s写了 %d 格,多了:只写五格 %s"
                           % (who, len(f), " | ".join(QUOTA_FIELDS))))
            continue
        f += [""] * (len(QUOTA_FIELDS) - len(f))
        miss = [QUOTA_FIELDS[k] for k, x in enumerate(f) if not x]
        if miss:
            issues.append((ln, "error", "quota", "quota %s缺「%s」—— 五格都要写:%s"
                           % (who, "」「".join(miss), " | ".join(QUOTA_FIELDS))))
            continue
        lim, used, nxt = quota_limit(f[1]), quota_amount(f[2]), quota_amount(f[3])
        bad = []
        if not lim:
            bad.append("「上限与周期」看不懂(现在是「%s」):写成「200 次 / 周」或「每月 3,000 次」,周期只认 天 / 周 / 月" % f[1])
        if not used:
            bad.append("「已用」要是一个数或区间(如 180–200),现在是「%s」" % f[2])
        if not nxt:
            bad.append("「接下来要用」要是一个数或区间(不再多用就写 0),现在是「%s」" % f[3])
        if bad:
            issues.append((ln, "error", "quota", "quota %s:%s" % (who, ";".join(bad))))
            continue
        b["rows"].append({"name": f[0], "raw": f, "limit": lim, "used": used, "next": nxt, "where": f[4], "line": ln})
    if not b["rows"] and len(issues) == n0:
        issues.append((line, "error", "quota", "quota 是空的,一行写一种额度:%s" % " | ".join(QUOTA_FIELDS)))
    return b


def qn(x):
    """额度里的数:10 以上取整(200 / 7 写「29」,他要的是量级)、带千分位;10 以下留一位小数。"""
    if abs(x) >= 10 or abs(x - round(x)) < 0.05:
        return "{:,}".format(int(round(x)))
    return ("%.1f" % x).rstrip("0").rstrip(".")


def qrange(lo, hi):
    a, b = qn(lo), qn(hi)
    if ("." in a) != ("." in b) and hi < 100:          # 7.6–10 → 7.6–10.4:一个区间两头同样精度
        a, b = [("%.1f" % x).rstrip("0").rstrip(".") for x in (lo, hi)]
    return a if a == b else "%s–%s" % (a, b)


def quota_view(r):
    """一种额度要给他看的几句话(渲染和冷读导出共用,保证他看到的和冷读者读到的是同一串字)。
    返回 dict:big 大字 / day 折合每天 / used 已用 / next 接下来 / say 够不够那句 / tone ok|bad|maybe / scale 刻度条满格值。"""
    lim, unit, per = r["limit"]
    days, pw, one = PERIOD_DAYS[per], PERIOD_WORD[per], PERIOD_ONE[per]
    ul, uh = r["used"]
    nl, nh = r["next"]
    tl, th = ul + nl, uh + nh
    head = "%s用 %s + 接下来再多用 %s = %s %s,上限 %s %s,所以" % (one, qrange(ul, uh), qrange(nl, nh), qrange(tl, th), unit, qn(lim), unit)
    if th <= lim:
        tone = "ok"
        say = "够,%s还剩 %s %s" % (one, qrange(lim - th, lim - tl), unit)
        if days > 1:
            say += "(≈ 每天 %s %s)" % (qrange((lim - th) / days, (lim - tl) / days), unit)
    elif tl > lim:
        tone, say = "bad", "不够,%s超出 %s %s" % (one, qrange(tl - lim, th - lim), unit)
    else:
        tone, say = "maybe", "可能不够:用得多的%s超出 %s %s" % (one, qn(th - lim), unit)
    return {"big": "%s最多 %s %s" % (pw, qn(lim), unit),
            "day": "≈ 每天 %s %s" % (qn(lim / days), unit) if days > 1 else "",
            "used": "%s用 %s" % (one, qrange(ul, uh)), "next": "接下来再多用 %s" % qrange(nl, nh), "lim": "上限 %s" % qn(lim),
            "say": head + say + "。", "tone": tone, "scale": max(lim, th)}


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
    blocks = parse_blocks(items, issues, section_picks=True)
    doc = {"text": text, "lines": lines, "meta": meta, "meta_lines": meta_lines, "issues": issues,
           "lead": None, "pre": [], "sections": [], "section_pick": None, "body_line": start + 1}
    cur = None
    for b in blocks:
        if b["kind"] == "h" and b["level"] == 2:
            cur = {"title": b["text"], "line": b["line"], "blocks": [], "num": len(doc["sections"]) + 1,
                   "end": len(lines)}
            if doc["sections"]:
                doc["sections"][-1]["end"] = b["line"] - 1
            doc["sections"].append(cur)
        elif b["kind"] == "section-pick":
            if cur is None or cur.get("pick"):
                issues.append((b["line"], "error", "section-pick", "「选:」必须写在 ## 节内，每节一行。"))
            else:
                cur["pick"] = b
        elif cur is not None:
            cur["blocks"].append(b)
        elif doc["lead"] is None and not doc["pre"] and b["kind"] == "para":
            doc["lead"] = b
        else:
            doc["pre"].append(b)
    picks = [s for s in doc["sections"] if s.get("pick")]
    if picks:
        doc["section_pick"] = {
            "id": meta.get("pick_id") or SECTION_PICK_ID,
            "q": meta.get("pick_question") or "请逐节选择",
            "cost": meta.get("pick_cost") or "",
            "line": picks[0]["pick"]["line"],
            "sections": picks,
        }
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


def decision_count(doc):
    return len(all_decisions(doc)) + bool(doc["section_pick"])


def lint_row_options(iss, opts, ln, q, code):
    labels = [plain(o).strip() for o in opts]
    if not all(labels):
        iss.append((ln, "error", code, "「%s」的选项不能为空" % q))
    if len(labels) > ROW_OPTIONS_MAX:
        iss.append((ln, "error", code, "「%s」的选项超过 %d 个" % (q, ROW_OPTIONS_MAX)))
    if len(labels) != len(set(labels)) or ROW_UNANSWERED in labels:
        iss.append((ln, "error", code, "选项不能重名,「%s」留给未填的行" % ROW_UNANSWERED))
    if any(len(label) > ROW_CHOICE_MAX for label in labels):
        iss.append((ln, "error", code, "选项不能超过 %d 字" % ROW_CHOICE_MAX))
    return labels


def lint_section_picks(doc, iss, decision_ids):
    group = doc["section_pick"]
    if not group:
        return
    if any(d["row_opts"] is not None for d in all_decisions(doc)):
        iss.append((group["line"], "error", "section-pick", "同一页只能用节内「选:」和 batch「每行选:」中的一种。"))
    if "pick_id" in doc["meta"]:
        ln = doc["meta_lines"]["pick_id"]
        if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", doc["meta"]["pick_id"]):
            iss.append((ln, "error", "section-pick", "pick_id 只能用字母、数字、- 和 _,且以字母开头"))
        elif group["id"] in decision_ids:
            iss.append((ln, "error", "dec-dup", "pick_id 与另一道题的 id 相同(%s),答案会记串" % group["id"]))
    names = set()
    for s in doc["sections"]:
        title = plain(s["title"]).strip()
        if title in names:
            iss.append((s["line"], "error", "section-pick", "节名「%s」重名，回答按节名区分。" % title))
        names.add(title)
        pick = s.get("pick")
        if pick:
            if not title or len(title) > ROW_TITLE_MAX:
                iss.append((s["line"], "error", "section-pick", "回答里的节名必须有字，最多 %d 字。" % ROW_TITLE_MAX))
            labels = lint_row_options(iss, pick["row_opts"], pick["line"], title, "section-pick")
            if pick["suggestion"] is not None and (not pick["suggestion"] or pick["suggestion"] not in labels):
                iss.append((pick["line"] + 1, "error", "section-pick", "「建议:」要写一个本节已有的选项。"))


# ───────────────────────── 检查 ─────────────────────────

def _is_image_para(b):
    return b["kind"] == "para" and any(_IMG.search(t) for _, t in b["lines"])


def has_figure(blocks, tables=False):
    """露在外面的图:flow / compare / bars / steps / 图片(fold 里的不算)。
    tables=True 时表格也算(只给 sec-wall 用:表格里的字不算正文字数,那条只管大段正文;
    page-nofig / nums-nofig 不算表格 —— 1117 负责人:只有表格的盘点页「可视性可读性几乎为零」)。"""
    for b in blocks:
        if b["kind"] in FIG_KINDS or _is_image_para(b) or (tables and b["kind"] == "table"):
            return True
        if b["kind"] == "list" and any(_IMG.search(t) for it in b["items"] for _, t in it["lines"]):
            return True
        if b["kind"] == "draft" and has_figure(b["blocks"], tables):
            return True
    return False


# 1117 数字格:开头是个量(可带「约 / 近 / ≈ / ¥」之类前缀和 % / 万 / 次 / 天 / ms / GB 之类单位)。
#   日期(11-17、2026-11-17)、时刻(13:30)、版本号(1.2.3)、提交号(80a39ab54)、「3C」这种名字不算。
_QTY = re.compile(r"^(?:约|各约|大约|近|共|合计|实测|平均|最多|最少|上限|~|～|≈|<|>|≤|≥|＜|＞|\+|-|−)?\s*"
                  r"[¥￥$€£]?\s*(\d[\d,]*(?:\.\d+)?)(.*)$")
_QTY_UNIT = re.compile(r"^(?:[kKwWmMgGtT][bB]?|ms|s|h|d|x|px|pt)(?![A-Za-z])")


def qty(cell, unit=False):
    """表格一格是个量 ⇒ 返回数值(unit=True 时返回 (数值, 单位));否则 None。
    10 位以上不带逗号的整数是编号(商品号、订单号),不算量。"""
    s = plain(cell).strip()
    if re.fullmatch(r"[0-9a-f]{7,40}", s) and re.search(r"[a-f]", s):
        return None
    m = _QTY.match(s)
    if not m:
        return None
    num, rest = m.group(1), m.group(2)
    if rest[:1].isascii() and rest[:1].isalpha() and not _QTY_UNIT.match(rest):
        return None
    if re.match(r"[:.]\d", rest):                                   # 13:30 / 1.2.3
        return None
    d = re.match(r"-(\d{1,2})(?!\d)", rest)
    if d and "," not in num and "." not in num and (
            re.fullmatch(r"(19|20)\d\d", num) or (1 <= int(num) <= 12 and 1 <= int(d.group(1)) <= 31)):
        return None                                                  # 11-17 / 2026-11-17(55-60 这种区间算量)
    if re.fullmatch(r"\d{10,}", num):                               # 0000000000001 这种编号
        return None
    try:
        v = float(num.replace(",", ""))
    except ValueError:
        return None
    if not unit:
        return v
    u = re.match(r"\s*[万千百亿]?\s*(%|[A-Za-z]+|[\u4e00-\u9fff])?", rest).group(1) or ""
    return v, u


def nums_table(b):
    """表格在比数字 ⇒ 返回 (数字列号, 标签列号);否则 None。至少 NUMS_ROWS 行数据,某一列非空格里 ≥NUMS_SHARE 是量、且至少 NUMS_ROWS 格。
    超过 NUMS_LIST 行是清单不查;一列数全一样(全是 0)不算;1、2、3… 这种序号列不算;一列里单位不止一种(次 / 行 / 分钟 / 小时)不算 —— 那是每行一个不同指标,不是同一个量在比。"""
    rows = [cells for _, cells in b["rows"][1:]]
    if not NUMS_ROWS <= len(rows) <= NUMS_LIST:
        return None
    ncol = max(len(c) for c in rows)
    best, label = None, None
    for j in range(ncol):
        cells = [c[j] if j < len(c) else "" for c in rows]
        filled = [c for c in cells if plain(c).strip() not in ("", "—", "-", "–", "/", "N/A", "n/a")]
        vals = [qty(c, unit=True) for c in filled]
        hit = [v[0] for v in vals if v is not None]
        units = {v[1] for v in vals if v is not None and v[1]}
        if len(units) > 1 or len(set(hit)) < 2:                      # 42 次 / 25 行 / 8 处:每行是不同的指标;全是 0:没什么可比
            continue
        if filled and len(hit) >= NUMS_ROWS and len(hit) >= NUMS_SHARE * len(filled):
            if hit == [float(k) for k in range(1, len(hit) + 1)] and len(hit) == len(filled):
                continue                                             # 序号列
            if best is None or len(hit) > best[1]:
                best = (j, len(hit))
        elif label is None and filled:
            label = j
    if best is None:
        return None
    return best[0], (label if label is not None else (0 if best[0] else min(1, ncol - 1)))


def nums_bars_example(b, j, lab):
    """拿这张表自己的前几行拼一段可照抄的 ```bars。"""
    head = b["rows"][0][1]
    out = []
    for _, cells in b["rows"][1:]:
        c = cells[j] if j < len(cells) else ""
        v = qty(c)
        if v is None:
            continue
        name = re.sub(r"[((][^))]*[))]", "", plain(cells[lab] if lab < len(cells) else "")).replace("|", "/")
        name = re.split(r"[((]", name)[0].strip()[:18] or "第 %d 行" % (len(out) + 1)
        right = re.split(r"[((，;；]|,(?!\d)", plain(c).replace("|", "/"))[0].strip()[:16]
        out.append("%s | %s" % (name, fmt(v)) + ("" if right == fmt(v) else " | | " + right))
        if len(out) == 3:
            break
    cap = plain(head[j] if j < len(head) else "").strip()
    return ("```bars\n" + "\n".join(out) + ("\ncap: " + cap if cap else "") + "\n```\n"
            "```fold 明细表\n(原来的表格挪到这里,当明细留着)\n```")


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
            if b["row_opts"] is not None:
                out += [(b["row_opts_line"], o, "decision") for o in b["row_opts"]]
                for it in b["items"]:
                    out.append((it["line"], it["title"], "decision"))
                    if it["desc"]:
                        out.append((it["line"], it["desc"], "decision"))
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
            out += [(r["gline"], r["group"], "figure") for k2, r in enumerate(b["rows"])
                    if r.get("group") and (k2 == 0 or b["rows"][k2 - 1].get("group") != r["group"])]
            if b["cap"]:
                out.append((b["cap_line"], b["cap"], "cap"))
        elif k == "steps":
            out += [(r["line"], " ".join((r["head"], r["title"], r["desc"])), "figure") for r in b["rows"]]
        elif k == "quota":
            out += [(r["line"], " ".join(r["raw"]), "figure") for r in b["rows"]]
            if b["cap"]:
                out.append((b["cap_line"], b["cap"], "cap"))
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
    nums_ex = {}                                  # (行号, 代码) → 照这张表拼的例子,report 优先印它

    def nums_check(blocks, where):
        if has_figure(blocks):
            return
        for b in blocks:
            if b["kind"] == "table":
                hit = nums_table(b)
                if hit:
                    head = b["rows"][0][1]
                    col = plain(head[hit[0]] if hit[0] < len(head) else "").strip() or "第 %d 列" % (hit[0] + 1)
                    iss.append((b["line"], "warn", "nums-nofig",
                                "%s的表格在比数字(「%s」这一列),这里却没有一张图 —— 他得一格格读数、自己比大小。"
                                "先用 ```bars 把差距画出来,表格留作明细(收进 ```fold)。"
                                "负责人 11-17:「你这个表真的可视性可读性几乎为零」" % (where, col)))
                    nums_ex[(b["line"], "nums-nofig")] = nums_bars_example(b, hit[0], hit[1])
                    return

    nums_check(doc["pre"], "结论下面")
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
        fig = has_figure(s["blocks"], tables=True)
        any_fig = any_fig or has_figure(s["blocks"])
        nums_check(s["blocks"], "第 %d 节「%s」" % (s["num"], title))
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
                    "这一页 %d 字,超过 %d 字,却一张图都没有(flow / compare / bars / steps / 图片;表格不算图)"
                    % (total, NOFIG_MAX)))

    # 1117 讲额度没有给框(见 QUOTA_FIELDS 上方原话):露在外面的字里 ≥QUOTA_HITS 处在讲额度 / 上限 / 每周几次,全页却没有 quota 块
    talk = []
    for items, _ in groups:
        for _ln, t, _cat in items:
            talk += [m.group(0) for m in _QUOTA_TALK.finditer(plain(t, code=False))]
    talk = [m.group(0) for m in _QUOTA_TALK.finditer(meta.get("title", ""))] + talk
    has_quota = any(b["kind"] == "quota" for b in doc["pre"] + [x for s in doc["sections"] for x in s["blocks"]])
    if len(talk) >= QUOTA_HITS and not has_quota:
        iss.append((doc["body_line"], "warn", "quota-missing",
                    "这一页 %d 处在讲额度 / 上限 / 每周几次(如「%s」),却没有一个 ```quota 块 —— 读者分不清是哪一种额度、"
                    "上限多少、折合每天几次、够不够。一行一种额度写进 ```quota,够不够由机器算。"
                    "负责人 11-17:「那么这两个是不同的额度，那这里面用的都是多少呢？」"
                    % (len(talk), "」「".join(list(dict.fromkeys(talk))[:3]))))

    # 要他定的题
    seen = {}
    for d in all_decisions(doc):
        q = plain(d["q"]) or "(没写问题)"
        row_opts = d["row_opts"]
        if row_opts is not None:
            ln = d["row_opts_line"]
            lint_row_options(iss, row_opts, ln, q, "batch-row-options")
            if d["opts"]:
                iss.append((ln, "error", "batch-row-options", "「每行选:」和整组选项只能用一种"))
        elif len(d["opts"]) < 2:
            iss.append((d["line"], "error", "dec-opts",
                        "「%s」只有 %d 个选项,至少要 2 个" % (q, len(d["opts"]))))
        nsug = sum(1 for o in d["opts"] if o["sug"])
        if row_opts is None and d["opts"] and nsug != 1:
            iss.append((d["line"], "error", "dec-sug",
                        "「%s」%s,必须恰好标出一个建议" % (q, "没有标出建议" if nsug == 0 else "标了 %d 个建议" % nsug))
                       )
        if not d["cost"]:
            iss.append((d["line"], "error", "dec-cost", "「%s」没写 cost:(不定会卡住什么)" % q))
        if d.get("items") is not None:            # 1113 按组批量定
            its = d["items"]
            if len(its) < 2:
                iss.append((d["line"], "error", "batch-items",
                            "「%s」是按组批量定,清单只有 %d 条,至少要 2 条(1 条就写普通 ```decision)" % (q, len(its))))
            names = {}
            for it in its:
                nm = plain(it["title"]).strip()
                if row_opts is not None and not nm:
                    iss.append((it["line"], "error", "batch-items", "每行的条目名不能为空"))
                if nm in names:
                    iss.append((it["line"], "error", "batch-items",
                                "「%s」的条目「%s」和第 %d 行重名 —— %s" % (q, nm[:20], names[nm],
                                "回答按条目名区分" if row_opts is not None else "例外按条目名记,重名就分不清是哪一条")))
                else:
                    names[nm] = it["line"]
                if nchars(nm) > BATCH_ITEM_MAX:
                    iss.append((it["line"], "error", "batch-items",
                                "「%s」的条目名 %d 个字,超过 %d 个字:条目名要短(理由写在 | 后面)" % (q, nchars(nm), BATCH_ITEM_MAX)))
        if d["id"] in seen:
            iss.append((d["line"], "error", "dec-dup",
                        "「%s」和第 %d 行那道题的 id 相同(%s),答案会记串" % (q, seen[d["id"]], d["id"])))
        else:
            seen[d["id"]] = d["line"]

    lint_section_picks(doc, iss, seen)
    _nd = decision_count(doc)
    if _nd > DEC_MANY:                            # 1113:题太多(只提醒,见 DEC_MANY 上方原话)
        iss.append((doc["body_line"], "warn", "dec-many",
                    "这一页 %d 道题,超过 %d 道 —— 题太多,把同类的合成按组批量定(```batch:一题定一组,个别勾例外)。"
                    "负责人 11-13:「我不可能点105次」" % (_nd, DEC_MANY)))

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
    stats = {"chars": total, "sections": len(doc["sections"]), "decisions": _nd,
             "lead": lead_n, "examples": nums_ex}
    return iss, stats


def report(issues, stats, name, strict=False, out=None):
    """打印检查结果;返回 True = 可以出页面。"""
    out = out or sys.stderr
    ne = nw = soft = 0
    for ln, level, code, msg in issues:
        if level == "error":
            ne += 1
        else:
            nw += 1
        nb = level != "error" and code in NEVER_BLOCK     # 只提醒的:--strict 也不拦
        soft += nb
        shown = "error" if (level == "error" or (strict and not nb)) else "warn"
        print("%s:%d: %s [%s] %s" % (name, ln, shown, code, msg), file=out)
        ex = stats.get("examples", {}).get((ln, code)) or EXAMPLES.get(code, "")
        if code == "syntax" and msg.split(" ")[0] in SYNTAX_EX:
            ex = SYNTAX_EX[msg.split(" ")[0]]
        if ex:
            print("      写对的例子: " + ex.replace("\n", "\n        "), file=out)
    ok = ne == 0 and not (strict and nw - soft)
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
    g = None
    for r in b["rows"]:
        if r.get("group") and r["group"] != g:          # 1117 分组标题
            out.append('<div class="bar-g">%s</div>' % inline(r["group"]))
        g = r.get("group")
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


def render_quota(b, ctx):
    """一张卡一种额度:名称、大字「每周最多 200 次 ≈ 每天 29 次」、刻度条(已用 / 接下来要用 / 上限)、机器算的够不够、用在哪。"""
    out = ['<div class="fig"><div class="quota">']
    for r in b["rows"]:
        v = quota_view(r)
        sc = v["scale"] or 1.0
        pc = lambda x: fmt(max(0.0, min(100.0, x / sc * 100)))
        lim = r["limit"][0]
        (ul, uh), (_nl, nh) = r["used"], r["next"]
        seg = ['<i class="q-u" style="left:0;width:%s%%"></i>' % pc(ul)]
        if uh > ul:
            seg.append('<i class="q-u q-r" style="left:%s%%;width:%s%%"></i>' % (pc(ul), pc(uh - ul)))
        if nh > 0:
            seg.append('<i class="q-n" style="left:%s%%;width:%s%%"></i>' % (pc(uh), pc(nh)))
        seg.append('<b class="q-l" style="left:%s%%"></b>' % pc(lim))
        out.append('<div class="q-card"><div class="q-name">%s</div>'
                   '<div class="q-big">%s%s</div>'
                   '<div class="q-bar">%s</div>'
                   '<div class="q-key"><span><i class="q-u"></i>%s</span><span><i class="q-n"></i>%s</span>'
                   '<span><i class="q-lk"></i>%s</span></div>'
                   '<div class="q-say %s">%s</div><div class="q-where">用在哪:%s</div></div>'
                   % (inline(r["name"]), esc(v["big"]), ' <span class="q-day">%s</span>' % esc(v["day"]) if v["day"] else "",
                      "".join(seg), esc(v["used"]), esc(v["next"]), esc(v["lim"]), v["tone"], esc(v["say"]), inline(r["where"])))
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
    if d["row_opts"] is not None:
        return render_batch_rows(d)
    did = esc(d["id"])
    _bn = (' data-batch="%d"' % len(d["items"])) if d.get("items") is not None else ""
    # ⚠ class 必须正好是 "decision":伺服 _ans_suggestion 按 `<div class="decision" id=` 找题读建议项 ⇒ 按组题用 data-batch 标,不加类
    out = ['<div class="decision" id="%s" data-q="%s"%s>' % (did, esc(plain(d["q"])), _bn),
           '<div class="k">要你定</div><div class="ans" hidden></div>',
           "<h3>%s</h3>" % inline(d["q"])]
    if d["cost"]:
        out.append('<div class="cost">%s</div>' % inline(d["cost"]))
    if d.get("items") is not None:
        out.append('<div class="batch-n">按组批量定:点一个选项就定了下面整组 %d 条</div>' % len(d["items"]))
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
    its = d.get("items")
    if its is not None:
        # 1113 按组批量定:点上面一个选项 = 定了整组;清单收起,个别条目勾「例外」(勾的条目名随回答一起记下,AI 收到时知道哪几条除外)
        out.append('<details class="batch-list"><summary>展开这 %d 条 · 个别不按整组办就勾「例外」<span class="batch-exc-n"></span></summary>'
                   '<ul class="batch-items">' % len(its))
        for it in its:
            out.append('<li class="batch-item"><label class="batch-exc"><input type="checkbox" class="batch-exc-c" value="%s">'
                       '<span class="batch-exc-l">例外</span></label><span class="batch-it"><b>%s</b>%s</span></li>'
                       % (esc(plain(it["title"]).strip()), inline(it["title"]),
                          "<small>%s</small>" % inline(it["desc"]) if it["desc"] else ""))
        out.append("</ul></details>")
    out.append('<textarea class="note" name="%s-note" rows="2" placeholder="想补一段、或者都不选自己说一个,写在这里(可不填)">'
               "</textarea></div>" % did)
    return "".join(out)


def render_batch_rows(d):
    did = esc(d["id"])
    out = ['<div class="batch-rows" id="%s"><h3>%s</h3>' % (did, inline(d["q"]))]
    out.append('<p class="cost">%s</p>' % inline(d["cost"]))
    out.append('<p class="batch-n">每行选一项，也可以留空。</p>')
    for it in d["items"]:
        out.append(render_pick_row(d["id"], it["title"], d["row_opts"], desc=it["desc"]))
    return "".join(out) + "</div>"


def pick_row_id(group_id, title):
    # 依据: 草稿 id 不允许点号;行 ID 按题和条目名稳定生成,短于伺服的 120 字上限。
    return "row." + hashlib.sha256((group_id + "\n" + plain(title).strip()).encode("utf-8")).hexdigest()


def render_pick_row(group_id, title, opts, desc="", heading_id=None, suggestion=None):
    rid = pick_row_id(group_id, title)
    name = esc(plain(title).strip())
    inline_section = ' data-section-pick' if heading_id else ''
    out = ['<div class="decision" id="%s" data-q="%s" data-row-of="%s"%s><div class="ans" hidden></div>'
           % (rid, name, esc(group_id), inline_section)]
    if not heading_id:
        heading_id = rid + "-title"
        out.append('<h4 id="%s">%s</h4>' % (heading_id, inline(title)))
    if desc:
        out.append('<div class="cost">%s</div>' % inline(desc))
    out.append('<div class="opts" role="radiogroup" aria-labelledby="%s">' % heading_id)
    for o in opts:
        value = plain(o).strip()
        badge = ' <span class="sug">建议</span>' if value == suggestion else ''
        out.append('<label class="opt"><input type="radio" name="%s" value="%s"><span>%s%s</span></label>'
                   % (rid, esc(value), inline(o), badge))
    out.append('<button type="button" class="row-clear" hidden>取消选择</button></div>')
    out.append('<textarea class="note" rows="2" maxlength="8000" aria-label="%s的补充" '
               'placeholder="补充（可不填）"></textarea></div>' % name)  # 依据: 伺服 note 保留前 8000 字。
    return "".join(out)


def render_pick_summary(group):
    if not group:
        return ""
    out = ['<section id="pick.summary" aria-labelledby="pick.summary-title"><h2 id="pick.summary-title">已选汇总</h2>',
           '<p>%s</p>' % inline(group["q"])]
    if group["cost"]:
        out.append('<p class="cost">%s</p>' % inline(group["cost"]))
    out.append('<ul>')
    for s in group["sections"]:
        rid = pick_row_id(group["id"], s["title"])
        out.append('<li><a href="#s%d">%s <span aria-hidden="true">→</span> <span id="%s-summary">%s</span></a></li>'
                   % (s["num"], esc(plain(s["title"]).strip()), rid, ROW_UNANSWERED))
    return "\n".join(out + ['</ul></section>'])


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
        elif k == "quota":
            out.append(render_quota(b, ctx))
    return "\n".join(out)


def render_section(s, group=None):
    nd = len(decisions_in(s["blocks"]))
    tag = '<span class="tag">%d 件要你定</span>' % nd if nd else ""
    sec = "s%d" % s["num"]
    body = render_blocks(s["blocks"], {"sec": sec, "fig": 0})
    title_attr = ""
    if s.get("pick"):
        heading_id = sec + ".title"
        title_attr = ' id="%s"' % heading_id
        pick = s["pick"]
        body += "\n" + render_pick_row(group["id"], s["title"], pick["row_opts"],
                                      heading_id=heading_id, suggestion=pick["suggestion"])
    return ('\n<section id="%s">\n<h2%s><span class="n">%d</span><span class="t">%s</span>%s</h2>\n%s\n</section>\n'
            % (sec, title_attr, s["num"], inline(s["title"]), tag, body))


def meta_text(doc):
    m, nd = doc["meta"], decision_count(doc)
    parts = [m.get("line", ""), m.get("date", ""), m.get("status", "")]
    parts.append("有 %d 件要你定" % nd if nd else "没有要你定的")
    return " · ".join(p for p in parts if p)


def render_meta(doc):
    return '<div class="meta">%s</div>' % esc(meta_text(doc))


def render_toc(doc):
    nd = decision_count(doc)
    out = ['<details class="toc"><summary>目录 · %d 节%s</summary>'
           % (len(doc["sections"]), " · %d 件要你定" % nd if nd else "")]
    for d in decisions_in(doc["pre"]):
        out.append('<a class="d" href="#%s" data-d="%s">%s</a>' % (esc(d["id"]), esc(d["id"]), esc(plain(d["q"]))))
    for s in doc["sections"]:
        out.append('<a href="#s%d">%d %s</a>' % (s["num"], s["num"], esc(plain(s["title"]))))
        for d in decisions_in(s["blocks"]):
            out.append('<a class="d" href="#%s" data-d="%s">%s</a>'
                       % (esc(d["id"]), esc(d["id"]), esc(plain(d["q"]))))
    if doc["section_pick"]:
        out.append('<a class="d" href="#pick.summary">%s</a>' % esc(plain(doc["section_pick"]["q"])))
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
        p.append(a + render_section(s, doc["section_pick"]) + b)
    a, b = M("pick summary")
    p.append(a + render_pick_summary(doc["section_pick"]) + b)
    p += ["</main>", "</div>",
          '<div class="float"><button id="next" type="button">要你定的 ↓</button>'
          '<button id="resp" type="button">生成回复</button></div>',
          '<dialog id="dlg"><div class="hd"><span>你的回复</span><button id="close" type="button">关闭</button></div>'
          '<div class="bd"><div class="hint">复制后粘回和这条线的对话。这里只复制,不会自动发送。</div>'
          '<pre id="out"></pre><button id="copy" type="button">复制回复</button> <span id="ok"></span></div></dialog>',
          SRC_OPEN + enc_source(doc["text"]) + SRC_CLOSE,
          "<script>", js, "</script>", "</body>", "</html>", ""]
    return "\n".join(p)


# ───────────────────────── 冷读(1117,依据见 COLDREAD_REASON_MIN 上方) ─────────────────────────

def _cr_blocks(blocks, out, ind=""):
    """块 → 他会看到的纯文字(按阅读顺序)。折叠的标【折叠】,要点开才看到。"""
    for b in blocks:
        k = b["kind"]
        if k == "para":
            text = join_lines([t for _, t in b["lines"]])
            m = _IMG.fullmatch(text.strip())
            out.append(ind + ("[图片:%s]" % (m.group(1) or "无说明") if m else plain(text)))
        elif k == "h":
            out.append(ind + "### " + plain(b["text"]))
        elif k == "list":
            for it in b["items"]:
                out.append(ind + " " * it["indent"] + ("1. " if it["ordered"] else "- ") + plain(join_lines([t for _, t in it["lines"]])))
        elif k == "quote":
            out.append(ind + "> " + plain(join_lines([t for _, t in b["lines"]])))
        elif k == "table":
            out.append(ind + "【表格】")
            out += [ind + " | ".join(plain(c) for c in cells) for _, cells in b["rows"]]
        elif k == "code":
            out.append(ind + "【代码】")
            out += [ind + t for _, t in b["lines"]]
        elif k == "fold":
            out.append(ind + "【折叠 · 要点开才看到】" + plain(b["title"]))
            _cr_blocks(b["blocks"], out, ind + "    ")
            out.append(ind + "【折叠结束】")
        elif k == "draft":
            out.append(ind + "【原稿】" + plain(b["title"]))
            _cr_blocks(b["blocks"], out, ind + "    ")
            out.append(ind + "【原稿结束】")
        elif k == "decision":
            out.append(ind + "【要你定】" + plain(b["q"]))
            if b["cost"]:
                out.append(ind + "    " + plain(b["cost"]))
            if b["row_opts"] is not None:
                out.append(ind + "    每行选一项，也可以留空。")
                for it in b["items"]:
                    out.append(ind + "    " + plain(it["title"]) +
                               (" —— " + plain(it["desc"]) if it["desc"] else ""))
                    out += [ind + "        ○ " + plain(o) for o in b["row_opts"]]
                    out.append(ind + "        补充（可不填）")
                continue
            if b.get("items") is not None:
                out.append(ind + "    按组批量定:点一个选项就定了下面整组 %d 条" % len(b["items"]))
            for o in b["opts"]:
                out.append(ind + "    ○ %s%s%s" % (plain(o["title"]), "(建议)" if o["sug"] else "",
                                                 " —— " + plain(o["desc"]) if o["desc"] else ""))
            out.append(ind + "    ○ %s —— 都不是的话选这个,在下面写你的说法。" % OTHER)
            if b.get("items") is not None:
                out.append(ind + "    【折叠 · 要点开才看到】展开这 %d 条 · 个别不按整组办就勾「例外」" % len(b["items"]))
                out += [ind + "        - " + plain(it["title"]) + (" —— " + plain(it["desc"]) if it["desc"] else "") for it in b["items"]]
                out.append(ind + "    【折叠结束】")
        elif k == "flow":
            out.append(ind + "【流程图】")
            for l in b["lanes"]:
                if l["title"]:
                    out.append(ind + "  " + {"bad": "✕ ", "good": "✓ "}.get(l["tone"], "") + plain(l["title"]))
                nm = lambda n: plain(n) + ("(%s)" % plain(l["nodes"][n]["sub"]) if l["nodes"][n]["sub"] else "")
                out += [ind + "  %s → %s%s" % (nm(a), nm(c), "(%s)" % plain(lab) if lab else "") for a, c, lab, _ in l["edges"]]
                lone = [n for n in l["nodes"] if not any(n in (a, c) for a, c, _, _ in l["edges"])]
                out += [ind + "  " + nm(n) for n in lone]
            if b["cap"]:
                out.append(ind + "  图注:" + plain(b["cap"]))
        elif k == "compare":
            out.append(ind + "【前后对比】")
            for key, mark in (("bad", "✕"), ("good", "✓")):
                c = b["cols"].get(key)
                if c:
                    out.append(ind + "  %s %s" % (mark, plain(c["title"])))
                    out += [ind + "    " + plain(t) for _, t, _ in c["lines"]]
                    if c["cap"]:
                        out.append(ind + "    图注:" + plain(c["cap"]))
        elif k == "bars":
            out.append(ind + "【条形图】")
            g = None
            for r in b["rows"]:
                if r.get("group") and r["group"] != g:
                    out.append(ind + "  " + plain(r["group"]))
                g = r.get("group")
                out.append(ind + "    %s:%s" % (plain(r["label"]), plain(r["right"])))
            if b["cap"]:
                out.append(ind + "  图注:" + plain(b["cap"]))
        elif k == "steps":
            out.append(ind + "【分步】")
            out += [ind + "  %s · %s%s" % (plain(r["head"]), plain(r["title"]), " —— " + plain(r["desc"]) if r["desc"] else "")
                    for r in b["rows"]]
        elif k == "quota":
            out.append(ind + "【额度】")
            for r in b["rows"]:
                v = quota_view(r)
                out.append(ind + "  %s:%s%s" % (plain(r["name"]), v["big"], " " + v["day"] if v["day"] else ""))
                out.append(ind + "    " + v["say"])
                out.append(ind + "    用在哪:" + plain(r["where"]))
            if b["cap"]:
                out.append(ind + "  图注:" + plain(b["cap"]))
        elif k == "hr":
            out.append(ind + "———")


def coldread_text(doc):
    """他打开页面会看到的全部文字(标题、页头、结论、每节、图里的字、题面与选项),按他阅读的顺序。"""
    out = [doc["meta"].get("title", ""), meta_text(doc), ""]
    if doc["lead"]:
        out += [plain(join_lines([t for _, t in doc["lead"]["lines"]])), ""]
    if doc["pre"]:
        _cr_blocks(doc["pre"], out)
        out.append("")
    for s in doc["sections"]:
        out.append("## %d %s" % (s["num"], plain(s["title"])))
        _cr_blocks(s["blocks"], out)
        pick = s.get("pick")
        if pick:
            for o in pick["row_opts"]:
                label = plain(o).strip()
                out.append("    ○ " + label + ("(建议)" if label == pick["suggestion"] else ""))
            out.append("    补充（可不填）")
        out.append("")
    group = doc["section_pick"]
    if group:
        out += ["## 已选汇总", plain(group["q"])]
        if group["cost"]:
            out.append(plain(group["cost"]))
        out += [plain(s["title"]).strip() + " → " + ROW_UNANSWERED for s in group["sections"]]
    return "\n".join(x.rstrip() for x in out).strip() + "\n"


def coldread_fp(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]


COLDREAD_TASK = """你是「冷读者」:对这件事一无所知,不认识作者,也不知道他们在做什么项目。
只许读这一份文本:{txt}
不许查任何别的文件、代码、网页,也不许猜作者「大概是想说」什么。文本是一页方案页上读者会看到的全部文字,
按阅读顺序排;标着【折叠 · 要点开才看到】的部分默认收起。

读完回答(全部用中文):
① summary:这页在讲什么事,两句话。
② asks:页面要读者定什么;每个选项选了会怎样、代价是什么。没有要定的写 []。
③ numbers:页面里每一个数 —— 它是什么东西的数、单位是什么、按天 / 周 / 月哪个周期算、跟哪个上限比。
   页面没交代清的,在那一项里写「没交代:……」。
④ unclear_terms:页面没先解释就直接用、你读不懂的词、数、缩写、内部叫法(做法名、工具名、简称、「某某额度」到底是哪一种)。
   页面里已经用一句话解释过的不要列;页头那行(组名 · 日期 · 状态 · 有几件要定)、每道题自带的「其他(我自己写)」也不用列。
⑤ open_questions:读完你仍答不上的问题。
④⑤ 每条写成 {{"text": "…", "blocks": true 或 false}}。blocks 是「这一条挡不挡路」,只有两类标 true:
   a. 不懂这个词 / 这个数,就读不懂这页在讲什么,或答不了页面要你定的那道题
      (要你选的选项里有没解释过的做法名、只能靠猜它具体怎么做,也算这一类);
   b. 要做页面要你做的那个决定,必需却没给的信息 —— 比如说的是哪一种额度、上限多少、现在用了多少、每个选项的代价。
   其余一律标 false:想多了解一点、样本够不够稳、还能不能更省、有没有别的办法、举例没列全。
   例子(一页问「会议室按小时租还是按月租」):
   - 页面没解释「工位券」,而月租的价钱就是按它算的 → true(不懂它就比不了两个选项)
   - 选项写「弹性租」,页面没说弹性租是怎么租的 → true(不知道选了它是什么)
   - 只说「月租更划算」,没写月租多少钱、按小时现在每月花多少 → true(决定必需的数没给)
   - 「按小时的价格明年会不会涨?」→ false(延伸追问)
   - 「三个月的用量样本够不够?」→ false(样本稳不稳)
   - 「附近有没有更便宜的场地?」→ false(还能不能更省)
   挡路的(true)一条都别漏;不挡路的(false)最多列 3 条,挑最要紧的。

只输出一个 JSON 对象,不要别的字:
{{"fp": "<文本第一行【指纹 …】里那串字母数字,原样抄>", "summary": "…", "asks": ["…"],
 "numbers": [{{"value": "…", "what": "…", "unit_period": "…", "compared_to": "…"}}],
 "unclear_terms": [{{"text": "…", "blocks": true}}], "open_questions": [{{"text": "…", "blocks": false}}]}}
unclear_terms、open_questions 确实没有就写 []。"""

# 1117 冷读者派法:精简子代理(lean-worker,没有就 worker)+ 便宜模型。精简子代理不带 MCP 工具和技能清单,开局固定开销约小一半
#   (实测见 README「发之前:冷读」);prompt 开头写 [no-worktree]:冷读者只读,不需要也不该建工作树,不写会被派活钩子拦下。
COLDREAD_DISPATCH = ("用精简子代理(subagent_type 写 lean-worker,没有就 worker)+ 便宜模型(如 haiku);"
                     "prompt 开头写 [no-worktree],其余只给上面的任务书(里面带 txt 路径)。"
                     "为什么:精简子代理不带 MCP 工具和技能清单,开局固定开销小一半;[no-worktree] 免得只读的冷读者被建工作树的钩子拦下")

COLDREAD_KEYS = ("fp", "summary", "asks", "numbers", "unclear_terms", "open_questions")


def hints_path():
    return os.environ.get(HINTS_ENV) or BP.state("board-hints.log")


def hint_log(key, page, **extra):
    """记一行到提醒日志(与 board.py 同一份、同一格式:{"ts","board","keys",…});只记,不拦,写不了就算了。"""
    try:
        f = hints_path()
        os.makedirs(os.path.dirname(f) or ".", exist_ok=True)
        rec = {"ts": int(time.time()), "board": os.path.basename(str(page)), "keys": [key]}
        rec.update(extra)
        with open(f, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return True
    except OSError:
        return False


def _cr_blocking(x):
    """这一条挡不挡路。1117 改判法(宁多勿少收不敛:好页 8 轮、每轮五万多 token,还逼人满页写豁免):
    只有 blocks:true 的才拦;没写 blocks 的(旧记录、纯字符串)一律按 true —— 宁可多拦一次,不放过挡路的。"""
    if not isinstance(x, dict) or "blocks" not in x:
        return True
    v = x["blocks"]
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() not in ("false", "no", "0", "否", "不挡")
    return True


def _cr_item(x):
    """冷读记录里的一条:字符串,或 {"term"/"text"/"q"/"question": …, "blocks": true|false, "waived": "为什么不改"}。
    → (文字, 豁免理由, 挡不挡路)。"""
    if isinstance(x, dict):
        txt = next((str(x[k]) for k in ("term", "text", "q", "question") if x.get(k)), "")
        return txt or json.dumps(x, ensure_ascii=False), str(x.get("waived") or "").strip(), _cr_blocking(x)
    return str(x), "", True


def coldread_status(rec, fp):
    """→ (致命问题[], 挡路没清的[(类别, 文字, 豁免理由太短?)], 已豁免[(类别, 文字, 理由)], 不挡路的参考[(类别, 文字)])。"""
    if not isinstance(rec, dict):
        return ["冷读记录不是一个 JSON 对象"], [], [], []
    lack = [k for k in COLDREAD_KEYS if k not in rec]
    if lack:
        return ["冷读记录缺 %s(冷读者要按任务书回全六项)" % " / ".join(lack)], [], [], []
    if not str(rec.get("summary") or "").strip():
        return ["冷读记录的 summary 是空的 —— 像是没真读过"], [], [], []
    if str(rec.get("fp")) != fp:
        return ["正文改过了:冷读记录读的是指纹 %s 的版本,现在是 %s —— 要重新冷读" % (rec.get("fp"), fp)], [], [], []
    pend, waived, ref = [], [], []
    for key, label in (("unclear_terms", "不懂的词"), ("open_questions", "答不上的问题")):
        val = rec.get(key)
        if not isinstance(val, list):
            return ["冷读记录的 %s 要是一个列表" % key], [], [], []
        for x in val:
            txt, why, blocks = _cr_item(x)
            if not blocks:
                ref.append((label, txt))
            elif why and nchars(why) >= COLDREAD_REASON_MIN:
                waived.append((label, txt, why))
            else:
                pend.append((label, txt, bool(why)))
    return [], pend, waived, ref


def coldread_load(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), ""
    except FileNotFoundError:
        return None, "还没有冷读记录(%s)" % path
    except (OSError, ValueError) as e:
        return None, "冷读记录读不了(%s):%s" % (path, e)


def coldread_steps(target, extra=""):
    me = "python3 " + os.path.abspath(__file__)
    return ("  冷读三步(发之前让一个不带上下文的读者读一遍):\n"
            "    1. %s coldread %s%s   —— 导出他会看到的全部文字,印出给冷读者的任务书\n"
            "    2. 派冷读者:%s。它回的 JSON 存下来:\n"
            "       %s coldread %s --save <它的回答文件>%s\n"
            "    3. %s coldread %s --check%s   —— 标 blocks:true(挡路)的都清空才算过(改正文);blocks:false 的只印出来参考,不拦\n"
            "    没法派子代理时:加 --no-coldread \"原因(至少 %d 个字)\",会记进提醒日志"
            % (me, target, extra, COLDREAD_DISPATCH, me, target, extra, me, target, extra, COLDREAD_REASON_MIN))


def coldread_gate(doc, record, page, strict=False, skip=None, target="草稿.md", extra=""):
    """render / patch 出页面前查冷读记录。返回 True = 可以出页面。带题的页没过 ⇒ error;纯展示页 ⇒ warn(--strict 拦)。"""
    err = sys.stderr
    if skip is not None:
        if nchars(skip) < COLDREAD_REASON_MIN:
            print("--no-coldread 的原因只有 %d 个字,至少 %d 个字(写清为什么这页没法冷读)" % (nchars(skip), COLDREAD_REASON_MIN), file=err)
            return False
        hint_log("plan-coldread-skip", page, why=skip)
        print("冷读:跳过(--no-coldread:%s),已记进提醒日志" % skip, file=err)
        return True
    fp = coldread_fp(coldread_text(doc))
    rec, why = coldread_load(record)
    fatal, pend, waived, ref = coldread_status(rec, fp) if rec is not None else ([why], [], [], [])
    for label, t in ref:
        print("冷读参考(不挡路,不拦):%s「%s」" % (label, t), file=err)
    if not fatal and not pend:
        if waived:
            hint_log("plan-coldread-waive", page, fp=fp, items=[{"kind": k, "text": t, "waived": w} for k, t, w in waived])
            print("冷读:通过(%d 条豁免,已记进提醒日志)" % len(waived), file=err)
        else:
            print("冷读:通过", file=err)
        return True
    block = bool(decision_count(doc)) or strict
    lv = "error" if block else "warn"
    for x in fatal:
        print("%s: %s [coldread] %s" % (page, lv, x), file=err)
    for label, t, short in pend:
        print("%s: %s [coldread] 冷读者标了挡路的%s:「%s」%s" % (page, lv, label, t, "(waived 理由不足 %d 个字)" % COLDREAD_REASON_MIN if short else ""), file=err)
    if pend:
        print("  改正文:第一次出现就用一句话解释那个词 / 把答案写进页面,再重新冷读。确实不该改的,在记录里把那一条写成"
              " {\"text\": \"…\", \"waived\": \"为什么不改(至少 %d 个字)\"}。" % COLDREAD_REASON_MIN, file=err)
    print(coldread_steps(target, extra), file=err)
    if block:
        print("没有生成页面:%s,发给他之前先过冷读。" % ("这页有要他定的题" if decision_count(doc) else "--strict"), file=err)
    return not block


def _default_record(base):
    return os.path.splitext(base)[0] + ".coldread.json"


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


def _check_visible(page):
    from html.parser import HTMLParser
    class Visible(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.hidden = 0
            self.parts = []
        def handle_starttag(self, tag, attrs):
            if tag in ("script", "style", "head"):
                self.hidden += 1
        def handle_endtag(self, tag):
            if tag in ("script", "style", "head") and self.hidden:
                self.hidden -= 1
        def handle_data(self, data):
            if not self.hidden:
                self.parts.append(data)
    parser = Visible()
    parser.feed(page)
    visible = "".join(parser.parts)
    if "![" in visible:
        raise ValueError("正文出现未渲染的图片标记 ![；请改用相对路径或 data:image/png;base64,...")
    if _VISIBLE_BASE64.search(visible):
        raise ValueError("正文出现过长的 base64；请改用相对路径或 data:image/png;base64,...")


def cmd_render(path, out_path, strict=False, text=None, no_coldread=None, coldread=None):
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
    record = coldread or _default_record(out_path if path == "-" else path)
    target = path if path != "-" else "<先把草稿存成文件>.md"
    if not coldread_gate(doc, record, name, strict, no_coldread, target):
        return 1
    try:
        page = build(doc)
        _check_visible(page)
    except ValueError as e:
        print("没有生成页面:%s" % e, file=sys.stderr)
        return 1
    data = page.encode("utf-8")
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


def page_source(page):
    r = _region(page, SRC_OPEN, SRC_CLOSE)
    return dec_source(page[r[0]:r[1]]) if r else None


def merge_section(src, want, new_md):
    """草稿原文里换掉一节 → (旧 doc, 那一节, 新草稿原文 or None, 出错说明)。patch 和 coldread --section 共用。"""
    doc = parse_doc(src)
    hit = find_section(doc, want)
    if len(hit) != 1:
        have = "；".join("%d %s" % (s["num"], plain(s["title"])) for s in doc["sections"])
        why = "找不到" if not hit else "有 %d 节都对得上" % len(hit)
        return doc, None, None, "%s「%s」这一节。页面里现有:%s" % (why, want, have)
    sec = hit[0]
    new_lines = new_md.replace("\r\n", "\n").replace("\r", "\n").strip("\n").split("\n")
    probe = parse_blocks([(k + 1, t) for k, t in enumerate(new_lines)], [])
    h2 = [b for b in probe if b["kind"] == "h" and b["level"] == 2]
    if not probe or probe[0]["kind"] != "h" or probe[0]["level"] != 2 or len(h2) != 1:
        return doc, sec, None, "新的一节必须以一行「## 标题」开头,而且只能有这一个 ## 标题(现在有 %d 个)" % len(h2)
    lines = doc["lines"]
    before, after = lines[:sec["line"] - 1], lines[sec["end"]:]
    merged = before + new_lines + ([""] + after if after else [""])
    return doc, sec, "\n".join(merged), ""


def patch_page(page, want, new_md, strict=False, name="<patch>"):
    """返回 (新页面 or None, 出错说明)。只换一节;其余字节不动。"""
    src = page_source(page)
    if src is None:
        return None, "页面里没有内嵌草稿原文(%s…),不是 plan.py 生成的页面,没法只换一节" % SRC_OPEN
    doc, sec, new_src, err = merge_section(src, want, new_md)
    if new_src is None:
        return None, err
    new_doc = parse_doc(new_src)
    issues, stats = lint_doc(new_doc)
    if not report(issues, stats, name, strict):
        return None, "换上新的一节后检查不过,页面没有动。"
    if len(new_doc["sections"]) != len(doc["sections"]):
        return None, "换完后节数变了,页面没有动。"
    if any(d["row_opts"] is not None for d in all_decisions(new_doc)) and "function submitRows(" not in page:
        return None, "旧页面脚本不支持「每行选:」,请用新草稿重新 render。"
    summary_marker = M("pick summary")
    group = new_doc["section_pick"]
    if (doc["section_pick"] or group) and summary_marker[0] not in page:
        return None, "旧页面脚本不支持节内「选:」,请用新草稿重新 render。"
    out = page
    swaps = [(M("sec %d" % sec["num"]), render_section(new_doc["sections"][sec["num"] - 1], group)),
             (M("meta"), render_meta(new_doc)), (M("toc"), render_toc(new_doc)),
             ((SRC_OPEN, SRC_CLOSE), enc_source(new_src))]
    if doc["section_pick"] or group:
        swaps.append((summary_marker, render_pick_summary(group)))
    for (a, b), body in swaps:
        r = _region(out, a, b)
        if r is None:
            return None, "页面里找不到标记 %s,不是 plan.py 生成的页面(或被手改过),页面没有动。" % a
        out = out[:r[0]] + body + out[r[1]:]
    return out, ""


def cmd_patch(html_path, want, new_md, strict=False, no_coldread=None, coldread=None):
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
    # 1117 改了正文指纹就变 ⇒ 换完的整页要重新冷读(记录缺省在页面旁边:<页面>.coldread.json)
    if not coldread_gate(parse_doc(page_source(out)), coldread or _default_record(html_path), html_path, strict, no_coldread,
                         html_path, ' --section "%s" < 新的一节.md' % want):
        print("patch 没做:页面没有动。", file=sys.stderr)
        return 1
    data = out.encode("utf-8")
    with open(html_path, "r+b") as f:      # 原地写:这个文件是硬链接,不许写临时文件再改名
        f.seek(0)
        f.write(data)
        f.truncate()
    print("已换掉「%s」这一节:%s(%d 字节)" % (want, html_path, len(data)))
    return 0


def _first_json(raw):
    """从冷读者的回答里取出第一个 JSON 对象(它可能包在 ```json 里、前后带几句话)。"""
    dec = json.JSONDecoder()
    for k, c in enumerate(raw):
        if c == "{":
            try:
                obj, _n = dec.raw_decode(raw[k:])
            except ValueError:
                continue
            if isinstance(obj, dict):
                return obj
    return None


def cmd_coldread(src, section=None, new_md=None, check=False, save=None, record=None):
    """导出 / 存回答 / 检查。src 是草稿 .md,或已生成的 .html(配 --section 时读标准输入里的新一节,查的是换完的整页)。"""
    err = sys.stderr
    if src.endswith(".html"):
        with open(src, "rb") as f:
            text = page_source(f.read().decode("utf-8"))
        if text is None:
            print("%s 里没有内嵌草稿原文,不是 plan.py 生成的页面" % src, file=err)
            return 1
        if section is not None:
            _d, _s, text, why = merge_section(text, section, new_md or "")
            if text is None:
                print("coldread 失败:" + why, file=err)
                return 1
    else:
        if section is not None:
            print("--section 只配 .html(查换完一节后的整页);草稿 .md 直接改了再冷读", file=err)
            return 2
        text, _n = read_draft(src)
    base = os.path.splitext(src)[0]
    record = record or base + ".coldread.json"
    doc = parse_doc(text)
    body = coldread_text(doc)
    fp = coldread_fp(body)
    target = src + (' --section "%s" < 新的一节.md' % section if section is not None else "")
    if save is not None:
        if save == "-":
            raw = sys.stdin.read()
        else:
            with open(save, encoding="utf-8") as f:
                raw = f.read()
        rec = _first_json(raw)
        fatal, _p, _w, _r = coldread_status(rec, fp) if rec is not None else (["回答里找不到 JSON 对象"], [], [], [])
        if fatal:
            for x in fatal:
                print("没有存:" + x, file=err)
            if rec is not None and "fp" in rec and str(rec.get("fp")) != fp:
                print("  冷读者读的不是现在这一版:重跑 %s coldread %s 导出新文本,再让冷读者读一遍。"
                      % ("python3 " + os.path.abspath(__file__), target), file=err)
            return 1
        rec = dict([(k, rec[k]) for k in COLDREAD_KEYS] + [(k, v) for k, v in rec.items() if k not in COLDREAD_KEYS])
        write_in_place(record, (json.dumps(rec, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
        print("已存冷读记录:%s" % record)
        check = True
    if check:
        rec, why = coldread_load(record)
        fatal, pend, waived, ref = coldread_status(rec, fp) if rec is not None else ([why], [], [], [])
        for x in fatal:
            print("冷读没过:" + x, file=err)
        for label, t in ref:
            print("参考(不挡路,不拦):%s「%s」" % (label, t))
        for label, t, short in pend:
            print("冷读没过:冷读者标了挡路的%s:「%s」%s" % (label, t, "(waived 理由不足 %d 个字)" % COLDREAD_REASON_MIN if short else ""), file=err)
        for label, t, w in waived:
            print("豁免:%s「%s」—— %s" % (label, t, w))
        if fatal or pend:
            if pend:
                print("  改正文:第一次出现就用一句话解释那个词 / 把答案写进页面,再重新冷读(导出 → 冷读者 → --save)。"
                      "确实不该改的,把那一条写成 {\"text\": \"…\", \"waived\": \"为什么不改(至少 %d 个字)\"}。" % COLDREAD_REASON_MIN, file=err)
            return 1
        print("冷读通过:%s(指纹 %s)" % (record, fp))
        return 0
    txt = base + ".coldread.txt"
    write_in_place(txt, ("【指纹 %s】\n" % fp + body).encode("utf-8"))
    lint_e = [x for x in lint_doc(doc)[0] if x[1] == "error"]
    print("已导出他会看到的全部文字:%s(%d 字,指纹 %s)" % (txt, nchars(body), fp))
    if lint_e:
        print("⚠ 这份草稿还有 %d 个 lint error:先改完再冷读,改了正文指纹就变,这次冷读会作废。" % len(lint_e))
    print("\n──────── 给冷读者的任务书(原样交给一个不带上下文的子代理)────────\n")
    print(COLDREAD_TASK.format(txt=os.path.abspath(txt)))
    me = "python3 " + os.path.abspath(__file__)
    print("\n──────── 作者下一步 ────────\n"
          "  1. 派冷读者:%s。⛔ 别自己答(你有上下文,等于没查)\n"
          "  2. %s coldread %s --save <它的回答文件>     (从标准输入给就写 --save -)\n"
          "  3. 标 blocks:true 的没清空就改正文,重跑这三步;过了再 render / patch" % (COLDREAD_DISPATCH, me, target))
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
    _SKIP = "自测旧用例:这一条不测冷读这一环"

    def R(*a, **k):            # 1117 之前的用例只测排版和检查,冷读环节由下面「1117 冷读」那组测
        k.setdefault("no_coldread", _SKIP)
        return cmd_render(*a, **k)

    def P(*a, **k):
        k.setdefault("no_coldread", _SKIP)
        return cmd_patch(*a, **k)

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
    tests.append(("draft:要审的稿字再多也不算页面字数(1028 内容助理)", lambda: not ({"sec-wall", "page-long", "nofig"} & set(_codes(_DRAFT)))
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
            if fig == "table":                     # 1117:只有表格不算图
                out += "| 项 | 值 |\n|---|---|\n| 甲 | 1 |\n\n"
            elif fig:
                out += "```bars\n甲 | 1 | 2\n```\n\n"
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

    # ──────────── 1117 数字对比只有表格(负责人 11-17:「你这个表真的可视性可读性几乎为零」)
    _NT = "| 做法 | 每周次数 | 说明 |\n|---|---|---|\n| 每天全扫 | 约 1,750 | 最全 |\n| 分档轮转 | 约 860 | 折中 |\n| 按店名筛导出 | 约 270 | 最省 |\n"
    _NBARS = "```bars\n每天全扫 | 1750\n分档轮转 | 860\n按店名筛导出 | 270 | | 约 270 | ok\n```\n"

    def _nsec(body, title="## 对标店铺怎么盯最省额度"):
        return FM + LEAD + title + "\n\n这一节比三种做法。\n\n" + body + "\n"

    pair("nums-nofig", _nsec(_NT), _nsec(_NBARS + "\n```fold 明细表\n" + _NT + "```\n"), level="warn")
    tests.append(("nums-nofig:是 warn 不是 error(默认出页面)", lambda: "nums-nofig" not in _codes(_nsec(_NT), "error")))
    tests.append(("nums-nofig:配了 bars 表格照样露在外面也不报(表格不禁)", lambda: "nums-nofig" not in _codes(_nsec(_NBARS + "\n" + _NT))))
    tests.append(("nums-nofig:flow / compare / steps / 图片也算有图", lambda: all("nums-nofig" not in _codes(_nsec(fig + "\n" + _NT)) for fig in (
        "```flow\n甲 -> 乙\n```\n", "```compare\n✕ 现在\n全是字\n✓ 改成\n有图\n```\n", "```steps\n第 1 步 | 先做 | 说明\n```\n",
        "![示意](img/a.png)\n"))))
    tests.append(("nums-nofig:只有 2 行数据不报", lambda: "nums-nofig" not in _codes(_nsec(_NT.rsplit("| 按店名", 1)[0]))))
    tests.append(("nums-nofig:纯文字说明表不报", lambda: "nums-nofig" not in _codes(_nsec(
        "| 谁 | 管什么 |\n|---|---|\n| 甲线 | 结构 |\n| 乙线 | 检查 |\n| 丙线 | 样式 |\n"))))
    tests.append(("nums-nofig:序号列 1/2/3 不算数字列", lambda: "nums-nofig" not in _codes(_nsec(
        "| 序号 | 事 |\n|---|---|\n| 1 | 写草稿 |\n| 2 | 出页面 |\n| 3 | 你点选项 |\n"))))
    tests.append(("nums-nofig:日期 / 时刻 / 提交号列不算数字列", lambda: "nums-nofig" not in _codes(_nsec(
        "| 什么时候 | 几点 | 提交 |\n|---|---|---|\n| 11-17 | 13:30 | 80a39ab54 |\n| 11-18 | 14:40 | c4d36951d |\n| 2026-11-19 | 15:30 | e15824873 |\n"))))
    tests.append(("nums-nofig:一列里数字不到六成不报", lambda: "nums-nofig" not in _codes(_nsec(
        "| 事 | 量 |\n|---|---|\n" + "".join("| 事%d | %s |\n" % (k, v) for k, v in enumerate(("12", "30", "45", "很多", "不定", "看情况")))))))
    tests.append(("nums-nofig:bars 只在 fold 里仍然报", lambda: "nums-nofig" in _codes(_nsec(_NT + "\n````fold 图\n" + _NBARS + "````\n"), "warn")))
    tests.append(("nums-nofig:表格在 fold 里不报(收起的明细)", lambda: "nums-nofig" not in _codes(_nsec("```fold 明细\n" + _NT + "```\n"))))
    tests.append(("nums-nofig:结论下面、第一节之前的表格也查", lambda: "nums-nofig" in _codes(FM + LEAD + _NT + "\n" + SEC3, "warn")))
    tests.append(("nums-nofig:量的认法(约 / ¥ / % / 区间 / 单位算;日期 / 时刻 / 版本 / 提交号 / 3C 不算)", lambda: (
        [qty(c) for c in ("约 1,750", "¥12.9", "40%", "55–60", "13MB", "30 ms", "各约 10(上限 40)", "1234567")]
        == [1750.0, 12.9, 40.0, 55.0, 13.0, 30.0, 10.0, 1234567.0]
        and all(qty(c) is None for c in ("11-17", "2026-11-17", "13:30", "1.2.3", "80a39ab54", "9d4c2a1f0", "3C 起量快", "第 1 步", "—", "")))))

    def _nex():
        issues, stats = lint_doc(parse_doc(_nsec(_NT)))
        ln = [l for l, _v, c, _m in issues if c == "nums-nofig"]
        ex = stats["examples"].get((ln[0], "nums-nofig"), "") if ln else ""
        return ex
    tests.append(("nums-nofig:例子是拿这张表自己的前三行拼的 ```bars,能直接过检查", lambda: (
        _nex().startswith("```bars\n每天全扫 | 1750 | | 约 1,750\n分档轮转 | 860 | | 约 860\n按店名筛导出 | 270 | | 约 270\ncap: 每周次数\n```")
        and "```fold 明细表" in _nex()
        and _codes(_nsec(_nex().replace("(原来的表格挪到这里,当明细留着)", _NT.strip()))) == set())))
    tests.append(("nums-nofig:例子里标签去掉括号注释、右侧文字和数值相同就不重复写", lambda: (lambda b: nums_bars_example(b, *nums_table(b)).startswith(
        "```bars\n补资料 | 30\n起量快 | 12 | | 各约 12\n换图 | 8\ncap: 次数\n```"))(parse_blocks([(k + 1, t) for k, t in enumerate(
        "| 用途 | 次数 |\n|---|---|\n| 补资料(3C / 女装) | 30 |\n| 起量快 | 各约 12(上限 60) |\n| 换图(兜底 | 8 |".split("\n"))], [])[0])))
    tests.append(("nums-nofig:编号列(10 位以上的商品号)不算数字列", lambda: "nums-nofig" not in _codes(_nsec(
        "| 款 | 商品号 |\n|---|---|\n| 甲 | 0000000000001 |\n| 乙 | 0000000000002 |\n| 丙 | 0000000000003 |\n"))))
    tests.append(("nums-nofig:一列单位不一(次 / 行 / 处)= 每行不同指标,不报;单位一致照报", lambda: (
        "nums-nofig" not in _codes(_nsec("| 指标 | 这周 |\n|---|---|\n| 问进度 | 42 次 |\n| 在做的行 | 25 行 |\n| 拒写 | 196 处 |\n"))
        and "nums-nofig" in _codes(_nsec("| 到期 | 条数 |\n|---|---|\n| 甲 | 58 条 |\n| 乙 | 64 条 |\n| 丙 | 91 条 |\n"), "warn")
        and qty("15 分钟", unit=True) == (15.0, "分") and qty("8.6 万 tokens", unit=True) == (8.6, "tokens"))))
    tests.append(("nums-nofig:一列数全一样(全是 0)不报", lambda: "nums-nofig" not in _codes(_nsec(
        "| 链接 | 30 天单 |\n|---|---|\n| 甲 | 0 |\n| 乙 | 0 |\n| 丙 | 0 |\n"))))
    _NL = lambda n: _nsec("| 链接 | 30 天单 |\n|---|---|\n" + "".join("| 链接 %d | %d |\n" % (k, k % 7 + 2) for k in range(n)))
    tests.append(("nums-nofig:超过 30 行是清单不报,30 行照报", lambda: "nums-nofig" not in _codes(_NL(31)) and "nums-nofig" in _codes(_NL(30), "warn")))
    tests.append(("nums-nofig:数字格不到 3 个不报(— 空格不算)", lambda: "nums-nofig" not in _codes(_nsec(
        "| 事 | 量 |\n|---|---|\n| 甲 | 12 |\n| 乙 | 30 |\n| 丙 | — |\n| 丁 | — |\n"))))
    tests.append(("page-nofig:只有表格不算图(1117)", lambda: "page-nofig" in _codes(many(4, 18, fig="table"))))
    tests.append(("sec-wall:表格照旧算图(这条只管大段正文)", lambda: "sec-wall" not in _codes(
        wall + "\n| 项 | 值 |\n|---|---|\n| 甲 | 1 |\n")))
    _BG = "```bars\n@ 3C 24 家 / 周\n每天全扫 | 950\n按店名筛 | 150 | | 约 150 | ok\n@ 女装 10 家 / 周\n每天全扫 | 400\n按店名筛 | 60\n```\n"
    tests.append(("bars 分组:@ 起一组,组名渲染成组标题、全图共用一把尺子、不报错", lambda: (
        _codes(_nsec(_BG)) == set() and (lambda p: p.count('<div class="bar-g">') == 2 and "3C 24 家 / 周" in p
            and p.index("3C 24 家") < p.index('style="width:100%"') < p.index("女装 10 家") and 'style="width:6%"' in p
            and bool(re.search(r"\.bar-g(?![\w-])", _kit("plan.css"))))(build(parse_doc(_nsec(_BG)))))))
    tests.append(("bars 分组:空组 / 没写组名报 syntax", lambda: (
        "syntax" in _codes(_nsec("```bars\n@ 空的一组\n@ 3C\n甲 | 1\n```\n"))
        and "syntax" in _codes(_nsec("```bars\n@ 3C\n甲 | 1\n@ 落在最后的空组\n```\n"))
        and "syntax" in _codes(_nsec("```bars\n@\n甲 | 1\n```\n")))))
    tests.append(("bars 分组:组名也查相对日期(露在外面的字)", lambda: "rel-date" in _codes(_nsec(_BG.replace("@ 女装 10 家", "@ 明天女装")))))

    with tempfile.TemporaryDirectory(prefix="plan-selftest-") as tmp:
        _old_hints = os.environ.get(HINTS_ENV)
        os.environ[HINTS_ENV] = os.path.join(tmp, "hints.log")     # ⛔ 自测不写真的 state_dir/board-hints.log
        src, out = os.path.join(tmp, "good.md"), os.path.join(tmp, "good.html")
        with open(src, "w", encoding="utf-8") as f:
            f.write(GOOD)
        state = {}

        @t("render:合格草稿出页面,退出码 0")
        def _():
            rc, _o = _quiet(R, src, out)
            state["page"] = open(out, encoding="utf-8").read() if os.path.exists(out) else ""
            return rc == 0 and state["page"].startswith("<!doctype html>")

        @t("render:有 error 不出页面,退出码 1")
        def _():
            bad, bo = os.path.join(tmp, "bad.md"), os.path.join(tmp, "bad.html")
            with open(bad, "w", encoding="utf-8") as f:
                f.write(wall)
            rc, o = _quiet(R, bad, bo)
            return rc == 1 and not os.path.exists(bo) and "写对的例子" in o and "bad.md:" in o

        @t("render:--strict 时 warn 也拦")
        def _():
            w, wo = os.path.join(tmp, "warn.md"), os.path.join(tmp, "warn.html")
            with open(w, "w", encoding="utf-8") as f:
                f.write(GOOD.replace("这里是一小段说明文字。", long_s))
            rc1, _o = _quiet(R, w, wo, True)
            gone = not os.path.exists(wo)
            rc2, _o = _quiet(R, w, wo, False)
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
                rc = P(out, "2", new2)
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
            ok, o = untouched(lambda: P(out, "根本没有的一节", new2))
            return ok and "找不到" in o

        @t("patch:新的一节检查不过 ⇒ 报错,文件不动")
        def _():
            ok, o = untouched(lambda: P(out, "2", "## 这一节全是大段文字\n\n" + SENT * 21 + "\n"))
            return ok and "sec-wall" in o

        @t("patch:新的一节没有 ## 标题 ⇒ 报错,文件不动")
        def _():
            ok, o = untouched(lambda: P(out, "2", "只有正文没有标题。\n"))
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

        def image_case(body, good, expected):
            target = os.path.join(tmp, "1113-result.html")
            if os.path.exists(target): os.remove(target)
            rc, message = _quiet(R, "1113.md", target, text=GOOD.replace("这里是一小段说明文字。", body))
            page = open(target, encoding="utf-8").read() if os.path.exists(target) else ""
            return (rc == 0 and expected in page) if good else (rc == 1 and not page and expected in message)

        tests.extend([
            ("1113 方案页图片 data png", lambda: image_case("![像素](data:image/png;base64,aGVsbG8=)", True, '<img src="data:image/png;base64,aGVsbG8="')),
            ("1113 方案页图片 svg 拒绝", lambda: image_case("![矢量](data:image/svg+xml;base64,aGVsbG8=)", False, "图片「矢量」")),
            ("1113 方案页图片 javascript 拒绝", lambda: image_case("![恶图](javascript:alert)", False, "图片「恶图」")),
            ("1113 方案页图片 未完成标记拒绝", lambda: image_case("![未完成", False, "未渲染的图片标记")),
            ("1113 方案页图片 正文长 base64 拒绝", lambda: image_case("A" * 200, False, "过长的 base64")),
            ("1113 方案页图片 拒绝链接转文字", lambda: inline("[标题](javascript:alert)") == "标题"),
        ])
        # ──────────── 1113 按组批量定(```batch;负责人 11-13 18:26:「我不可能点105次」)
        def _bt(items=None, opts="- *都下架 | 三十天零单。\n- 都先留着 | 等大促后再看。", head="这 10 条都下架？\ncost: 不定的话这批链接继续占着广告预算。\nid: delist-10"):
            if items is None:
                items = "\n".join("- 链接 A-%03d%s" % (i, " | 三十天零单" if i % 3 else "") for i in range(1, 11))
            return FM + LEAD + "## 第一节讲清楚要做什么\n\n```batch\n" + head + "\n" + opts + "\nitems:\n" + items + "\n```\n"

        def _bt_page(md):
            target = os.path.join(tmp, "1113-batch.html")
            if os.path.exists(target): os.remove(target)
            rc, o = _quiet(R, "1113-batch.md", target, text=md)
            return rc, o, (open(target, encoding="utf-8").read() if os.path.exists(target) else "")

        def _bt_styled(cls):
            return bool(re.search(r"\.%s(?![\w-])" % re.escape(cls), _kit("plan.css")))

        def _bt_render():
            rc, o, page = _bt_page(_bt())
            m = re.search(r'<div class="decision" id="delist-10"[^>]*data-batch="10"[^>]*>(.*?)<textarea', page, re.S)
            blk = m.group(1) if m else ""
            radios = re.findall(r'<input type="radio"[^>]*value="([^"]+)"', blk)
            exc = re.findall(r'<input type="checkbox" class="batch-exc-c" value="([^"]+)"', blk)
            classes = set(c for cl in re.findall(r'class="([^"]+)"', blk) for c in cl.split() if c.startswith("batch"))
            return all([rc == 0, bool(m), "按组批量定" in blk and "整组 10 条" in blk,
                        "都下架" in radios and "都先留着" in radios and len(radios) == 3,
                        '<details class="batch-list">' in blk and blk.index('<details class="batch-list">') > blk.index('type="radio"'),
                        exc == ["链接 A-%03d" % i for i in range(1, 11)], blk.count("<small>三十天零单</small>") == 7,
                        len(classes) >= 8 and all(_bt_styled(c) for c in classes),
                        '<div class="decision" id="delist-10"' in page])          # 伺服认题靠这串原文,按组题不能多出别的 class

        def _bt_items_lint():
            bad = {"少于 2 条": _bt(items="- 链接 A-001"), "重名": _bt(items="- 链接 A-001\n- 链接 A-001 | 又一次"),
                   "条目名太长": _bt(items="- " + "名" * 61 + "\n- 链接 A-002"), "没有 - 开头": _bt(items="链接 A-001\n- 链接 A-002"),
                   "空清单": _bt(items="")}
            ok_bad = all("batch-items" in _codes(v, "error") for v in bad.values())
            ok_good = "batch-items" not in _codes(_bt()) and _codes(_bt()) <= set() | {"nofig"} and "batch-items" not in _codes(_bt(items="- " + "名" * 60 + "\n- 链接 A-002"))
            rc, o, page = _bt_page(bad["重名"])
            return ok_bad and ok_good and rc == 1 and page == "" and "items:" in o

        def _bt_many():
            def page_n(n):
                secs = "".join("## 第 %d 道题要你来拍板\n\n```decision\n第 %d 题选哪个？\ncost: 不定就拖着。\n- *选甲 | 理由甲。\n- 选乙 | 理由乙。\n```\n\n" % (i, i) for i in range(1, n + 1))
                return FM + LEAD + secs
            w11, w10 = _codes(page_n(11), "warn"), _codes(page_n(10))
            rc_s, o_s = _quiet(cmd_lint, "many.md", strict=True, text=page_n(11))
            rc_r, o_r, pg = _bt_page(page_n(11))
            return all(["dec-many" in w11, "dec-many" not in _codes(page_n(11), "error"), "dec-many" not in w10,
                        rc_s == 0 and "题太多" in o_s and "按组批量定" in o_s, rc_r == 0 and pg.count('class="decision"') == 11,
                        "dec-many" in NEVER_BLOCK and DEC_MANY == 10])

        def _bt_js():
            import json
            import subprocess as _sp
            js = _kit("plan.js")
            a = js.index("  function isBatch(d)"); b = js.index("  function paint(")
            s1 = js.index("  function postAnswer("); s2 = js.index("  function record(")
            p1 = js.index("  function apply(ans){"); p2 = js.index("  function load(){")
            harness = r'''
var kept={},touched={},stamp={},timers={},decs=[],pendingWrites=[],online=true,page='p.html',SENT=null;
function saveLocal(){} function paint(){} function fetch(u,o){SENT=JSON.parse(o.body);return Promise.resolve({ok:true})}
function note(d){return d._note}
function D(id,batch,names){var d={id:id,_note:{value:''},_attrs:batch?{'data-batch':String(names.length),'data-q':'这批?'}:{'data-q':'普通?'},
  _r:[{value:'都下架',checked:false,type:'radio'},{value:'都先留着',checked:false,type:'radio'}],
  _c:names.map(function(n){return {value:n,checked:false,type:'checkbox'}})};
 d.hasAttribute=function(k){return k in d._attrs};d.getAttribute=function(k){return d._attrs[k]||null};
 d.querySelector=function(s){if(s==='input[type=radio]:checked')return d._r.filter(function(r){return r.checked})[0]||null;return null};
 d.querySelectorAll=function(s){if(s==='input.batch-exc-c:checked')return d._c.filter(function(c){return c.checked});if(s==='input.batch-exc-c')return d._c;if(s==='input[type=radio]')return d._r;return []};
 return d}
''' + js[a:b] + js[s1:s2] + js[p1:p2] + r'''
var bd=D('b',true,['链接 A-001','链接 A-002','链接 A-003']),pd=D('p',false,[]);decs=[bd,pd];
bd._r[0].checked=true;bd._c[1].checked=true;
var c=cur(bd),s1=batchSaid(bd,c);send(bd);var body1=SENT;
bd._c[1].checked=false;var c0=cur(bd),s0=batchSaid(bd,c0);send(bd);var body0=SENT;
pd._r[1].checked=true;send(pd);var body2=SENT;
var nb=D('b',true,['链接 A-001','链接 A-002','链接 A-003']);decs=[nb];apply({b:{choice:'都下架',note:'',except:['链接 A-003','不在清单的'],ts:'t'}});
console.log(JSON.stringify([JSON.stringify(c.exc)==='["链接 A-002"]', s1.indexOf('整组 3 条')>=0&&s1.indexOf('链接 A-002')>=0,
 JSON.stringify(body1.except)==='["链接 A-002"]'&&body1.choice==='都下架', Array.isArray(body0.except)&&body0.except.length===0&&s0.indexOf('没有例外')>=0,
 !('except' in body2)&&batchSaid(pd,cur(pd))==='', nb._c.map(function(x){return x.checked}).join()==='false,false,true'&&nb._r[0].checked]));
'''
            r = _sp.run(["node", "-e", harness], capture_output=True, text=True, timeout=30)  # 依据: 跟 board.py 的 node 自检同一个防挂死时限。
            got = json.loads(r.stdout.strip() or "[]")
            return len(got) == 6 and all(got)

        tests.extend([
            ("1113 按组批量定 渲染:一组选项 + 收起的条目清单 + 每条一个「例外」勾,所用类都在 plan.css 有样式,伺服认题那串原文不变", _bt_render),
            ("1113 按组批量定 items 检查:少于 2 条 / 重名 / 名太长 / 格式不对 ⇒ 报 batch-items 不出页面;合格的不报", _bt_items_lint),
            ("1113 按组批量定 一页超过 10 题提醒合并:11 题报 dec-many(只提醒,--strict 也照样出页面),10 题不报", _bt_many),
            ("1113 按组批量定 页面脚本(node 真跑):勾的例外进回答 except,取消后是空数组;普通题不带;服务器回来的例外能勾回去", _bt_js),
        ])

        def _row_md(opts="涨 | 不涨", items="- 甲品 | 建议涨\n- 乙品\n- 丙品"):
            return _bt(items=items, opts="每行选: " + opts)

        @t("逐行批量定:每行一组 radio、无预选、每行一个补充框")
        def _():
            rc, _o, page = _bt_page(_row_md())
            radios = re.findall(r'<input type="radio" name="([^"]+)" value="([^"]+)"([^>]*)>', page)
            return (rc == 0 and len(radios) == 6
                    and len({name for name, _, _ in radios}) == 3
                    and all([v for n, v, _ in radios if n == name] == ["涨", "不涨"] for name, _, _ in radios)
                    and all(not attrs for _, _, attrs in radios)
                    and page.count('<textarea class="note"') == 3 and 'data-batch=' not in page)

        @t("逐行批量定 lint:空选项报 error")
        def _():
            return all("batch-row-options" in _codes(_row_md(opts), "error") for opts in ("", "涨 | | 不涨"))

        @t("逐行批量定 lint:重复行名报 error")
        def _():
            return "batch-items" in _codes(_row_md(items="- 甲品\n- **甲品**"), "error")

        @t("逐行批量定 lint:6 项报 error,5 项通过")
        def _():
            return ("batch-row-options" in _codes(_row_md("甲|乙|丙|丁|戊|己"), "error")
                    and "batch-row-options" not in _codes(_row_md("甲|乙|丙|丁|戊"), "error"))

        @t("逐行批量定冷读:每个条目下列全选项与补充")
        def _():
            body = coldread_text(parse_doc(_row_md()))
            return ("甲品 —— 建议涨\n        ○ 涨\n        ○ 不涨\n        补充（可不填）" in body
                    and "乙品\n        ○ 涨\n        ○ 不涨" in body
                    and "丙品\n        ○ 涨\n        ○ 不涨" in body)

        @t("逐行批量定 patch:已支持逐行题的页面可换节,包含更新的选项")
        def _():
            rc, _o, page = _bt_page(_row_md())
            md = _row_md("涨 | 不涨 | 再看").split("## ", 1)[1]
            patched, err = patch_page(page, "1", "## " + md)
            return rc == 0 and not err and patched.count('value="再看"') == 3

        def _row_submit(rows=None):
            import json
            import subprocess
            js = _kit("plan.js")
            a = js.index("  function isBatch(d)")
            b = js.index("  function paint(")
            s = js.index("  function postAnswer(")
            end = js.index("  if(online&&decs.some(isRow))")
            harness = r'''
var main={},button={},page='row.html',online=true,stamp={},touched={},kept={},timers={},pendingWrites=[];
var posts=[],answers={},done;
function paint(){} function saveLocal(){} function note(d){return {value:d.extra};}
function row(id,q,pick,extra){
 return {id:id,extra:extra,hasAttribute:function(k){return k==='data-row-of';},
  getAttribute:function(){return q;},querySelector:function(){return pick?{value:pick}:null;}};
}
var decs=ROWS.map(function(args){return row.apply(null,args);});
function fetch(url,opts){
 var body=opts.body?JSON.parse(opts.body):null;
 if(body){posts.push(body);if(body.id)answers[body.id]=body;}
 var result=body&&body.submit?{submitted:body.submit.length}:{answers:answers};
 return Promise.resolve({ok:true,json:function(){return Promise.resolve(result);}});
}
'''
            if rows is None:
                rows = [["a", "甲品", "涨", ""], ["b", "乙品", "不涨", "等两周"], ["c", "丙品", "", ""]]
            harness = ("var ROWS=" + json.dumps(rows) + ";\nvar ROW_UNANSWERED=" + json.dumps(ROW_UNANSWERED) + ";\n"
                       + harness + js[a:b] + js[s:end] + r'''
submitRows(button);
setImmediate(function(){console.log(JSON.stringify([button.textContent,posts]));});
''')
            r = subprocess.run(["node", "-e", harness], capture_output=True, text=True, timeout=30)  # 依据: 沿用上面的 Node 自检防挂死时限。
            caption, posts = json.loads(r.stdout)
            return caption, posts

        @t("逐行批量定提交:一次整页提交,两行所选及补充按原接口字段记录")
        def _():
            caption, posts = _row_submit()
            return (caption == "已发给 AI ✓" and len(posts) == 4
                    and [(x["q"], x["choice"], x["note"]) for x in posts[:2]]
                    == [("甲品", "涨", ""), ("乙品", "不涨", "等两周")]
                    and posts[3] == {"page": "row.html", "submit": ["a", "b", "c"]})

        @t("逐行批量定提交:未动的行也带行名及「没选」")
        def _():
            _caption, posts = _row_submit()
            return posts[2]["q"] == "丙品" and posts[2]["choice"] == "没选"

        def _pick_md(opts="涨 | 不涨", second="第二款方形桌面镜", suggestion="涨"):
            return (FM + LEAD + "## 第一款帆布收纳袋\n"
                    + "选: " + opts + "\n建议: " + suggestion + "\n"
                    + "这里是甲品价格。\n\n## " + second + "\n"
                    + "这里是乙品价格。\n选: 涨 | 不涨\n\n"
                    + "## 第三款可折叠衣架\n选: 涨 | 不涨\n")

        @t("节内选渲染:选项跟在正文后、留在本节末，建议标记但默认留空")
        def _():
            page = build(parse_doc(_pick_md()))
            section = page.split('<section id="s1">', 1)[1].split("</section>", 1)[0]
            return (re.search(r'甲品价格。.*data-section-pick.*value="涨"><span>涨.*class="sug".*textarea.*</div>\s*$', section, re.S)
                    and " checked" not in section and page.count("data-section-pick><div") == 3)

        @t("节内选汇总:只算一道题，按节顺序列齐未选项并链接节标题")
        def _():
            doc = parse_doc(_pick_md())
            page = build(doc)
            summary = page.split('<!--plan:pick summary-->')[1].split('<!--/plan:pick summary-->')[0]
            return (lint_doc(doc)[1]["decisions"] == 1 and "有 1 件要你定" in page
                    and re.findall(r'<li><a href="#(s\d+)">([^<]+) <span[^>]*>→</span> <span[^>]*>没选</span>', summary)
                    == [(f"s{s['num']}", s["title"]) for s in doc["sections"]])

        @t("节内选提交:同题同名与每行选生成相同的请求，补充和没选一起提交")
        def _():
            import html
            titles = [s["title"] for s in parse_doc(_pick_md())["sections"]]
            inline_md = _pick_md().replace("status: 提议中", "status: 提议中\npick_id: same-pick")
            batch_md = _row_md(items="\n".join("- " + title for title in titles)).replace("id: delist-10", "id: same-pick")
            envelopes = []
            for md in (inline_md, batch_md):
                page = build(parse_doc(md))
                rows = re.findall(r'<div class="decision" id="([^"]+)" data-q="([^"]+)" data-row-of="same-pick"', page)
                if [html.unescape(q) for _, q in rows] != titles:
                    return False
                caption, posts = _row_submit([[rid, html.unescape(q), pick, note] for (rid, q), (pick, note)
                                             in zip(rows, [("涨", ""), ("不涨", "等两周"), ("", "")])])
                if caption != "已发给 AI ✓" or len(posts) != 4:
                    return False
                envelopes.append([{k: v for k, v in post.items() if k != "ts"} for post in posts])
            return (envelopes[0] == envelopes[1]
                    and [(p["choice"], p["note"]) for p in envelopes[0][:3]]
                    == [("涨", ""), ("不涨", "等两周"), ("没选", "")])

        for label, md, expected in (
            ("空选项", _pick_md("涨 | "), "选项不能为空"),
            ("超过五项", _pick_md("涨 | A | B | C | D | E"), "选项超过 5 个"),
            ("选项重名", _pick_md("涨 | **涨**"), "选项不能重名"),
            ("节标题重名", _pick_md(second="**第一款帆布收纳袋**"), "重名，回答按节名区分"),
            ("混用每行选", _pick_md() + "\n```batch" + _row_md().split("```batch", 1)[1], "中的一种"),
            ("建议不在选项中", _pick_md(suggestion="另议"), "已有的选项"),
        ):
            tests.append(("节内选 lint: " + label, lambda md=md, expected=expected: any(
                level == "error" and code == "section-pick" and expected in msg
                for _, level, code, msg in lint_doc(parse_doc(md))[0])))

        @t("节内选冷读:每节末导出自己的选项和建议，页末导出已选汇总")
        def _():
            body = coldread_text(parse_doc(_pick_md()))
            return ("甲品价格。\n    ○ 涨(建议)\n    ○ 不涨\n    补充（可不填）\n\n## 2" in body
                    and "乙品价格。\n    ○ 涨\n    ○ 不涨\n" in body
                    and body.endswith("第三款可折叠衣架 → 没选\n"))

        @t("节内选 patch:改节名更新选项和汇总，结果与 render 逐字节一致")
        def _():
            page = build(parse_doc(_pick_md()))
            out, err = patch_page(page, "2", "## 换成另一款桌面镜\n选: 涨 | 不涨")
            return not err and out == build(parse_doc(page_source(out))) and "换成另一款桌面镜 → 没选" in coldread_text(parse_doc(page_source(out)))
        # ──────────── 1117 数字对比只有表格:默认出页面但印出来,--strict 拦;例子印在报错下面
        def _nums_render():
            target = os.path.join(tmp, "1117-nums.html")
            rc1, o1 = _quiet(R, "1117-nums.md", target, text=_nsec(_NT))
            made = os.path.exists(target)
            if made: os.remove(target)
            rc2, o2 = _quiet(R, "1117-nums.md", target, True, text=_nsec(_NT))
            return (rc1 == 0 and made and "warn [nums-nofig]" in o1 and "写对的例子: ```bars" in o1
                    and "每天全扫 | 1750 | | 约 1,750" in o1 and "cap: 每周次数" in o1 and rc2 == 1 and not os.path.exists(target)
                    and "error [nums-nofig]" in o2)

        def _nums_examples():
            ex = os.path.join(KIT, "examples")
            good = open(os.path.join(ex, "good-numbers-as-bars.md"), encoding="utf-8").read()
            bad = open(os.path.join(ex, "bad-numbers-only-table.md"), encoding="utf-8").read()
            bad_iss, _s = lint_doc(parse_doc(bad))
            return _codes(good) == set() and [c for _l, _v, c, _m in bad_iss if c == "nums-nofig"] == ["nums-nofig"] * 2

        tests.extend([
            ("1117 数字对比只有表格 render:默认出页面并印 nums-nofig 和照表拼的 bars,--strict 不出页面", _nums_render),
            ("1117 数字对比只有表格 examples:好例子 0 报,坏例子两张表各报一次 nums-nofig", _nums_examples),
        ])

        # ──────────── 1117 讲数量先给框(```quota;负责人 11-17:「这两个是不同的额度，那这里面用的都是多少呢？」)
        _Q = ("```quota\n导出额度 | 200 次 / 周 | 180–200 | 30 | 每天早上下载一份销量榜\n"
              "查询额度 | 每月 3,000 次 | 2,400 | 300 | 程序逐个问商品详情\ncap: 已用是近一个周期的实际次数。\n```\n")

        def _qsec(body, title="## 两种额度各用了多少"):
            return FM + LEAD + title + "\n\n这一节讲用量。\n\n" + body + "\n"

        def _q_render():
            p = build(parse_doc(_qsec(_Q)))
            cls = set(c for cl in re.findall(r'class="(q-[^"]+)"', p) for c in cl.split())
            return all([_codes(_qsec(_Q)) == set(), p.count('<div class="q-card">') == 2,
                        "每周最多 200 次 <span class=\"q-day\">≈ 每天 29 次</span>" in p,
                        "一周用 180–200 + 接下来再多用 30 = 210–230 次,上限 200 次,所以不够,一周超出 10–30 次。" in p,
                        '<div class="q-say bad">' in p and '<div class="q-say ok">' in p,
                        "每月最多 3,000 次 <span class=\"q-day\">≈ 每天 100 次</span>" in p,
                        "一个月用 2,400 + 接下来再多用 300 = 2,700 次,上限 3,000 次,所以够,一个月还剩 300 次(≈ 每天 10 次)。" in p,
                        "用在哪:每天早上下载一份销量榜" in p,
                        '<i class="q-u" style="left:0;width:78.3%"></i>' in p,             # 180 / 230
                        '<i class="q-u q-r" style="left:78.3%;width:8.7%"></i>' in p,      # 180→200
                        '<i class="q-n" style="left:87%;width:13%"></i>' in p,             # 再 30
                        '<b class="q-l" style="left:87%"></b>' in p,                       # 上限 200 / 230
                        "一周用 180–200" in p and "接下来再多用 30" in p and "上限 200" in p,
                        {"q-card", "q-name", "q-big", "q-day", "q-bar", "q-u", "q-r", "q-n", "q-l", "q-key", "q-lk", "q-say", "q-where"} <= cls,
                        all(re.search(r"\.%s(?![\w-])" % c, _kit("plan.css")) for c in cls | {"quota", "ok", "bad", "maybe"})])

        def _q_fields():
            md = _qsec("```quota\n导出额度 | 200 次 / 周 | | 30\n```\n")
            rc, o = _quiet(cmd_lint, "q.md", text=md)
            many_f = _qsec("```quota\n导出额度 | 200 次 / 周 | 10 | 30 | 下载 | 多一格\n```\n")
            return (rc == 1 and "error [quota]" in o and "缺「已用」「用在哪」" in o and "写对的例子:" in o and "```quota" in o
                    and "quota" in _codes(many_f, "error") and "多了" in _quiet(cmd_lint, "q.md", text=many_f)[1]
                    and "quota" in _codes(_qsec("```quota\ncap: 只有图注\n```\n"), "error")
                    and "quota" not in _codes(_qsec(_Q)))

        def _q_limit():
            return ([quota_limit(x) for x in ("200 次 / 周", "200次/每周", "每周最多 200 次", "每月 3,000 次", "1.2 万次 / 月", "每天 50 个")]
                    == [(200.0, "次", "周"), (200.0, "次", "周"), (200.0, "次", "周"), (3000.0, "次", "月"), (12000.0, "次", "月"), (50.0, "个", "天")]
                    and all(quota_limit(x) is None for x in ("200 次", "200 次 / 年", "很多", "0 次 / 周"))
                    and "quota" in _codes(_qsec("```quota\n导出额度 | 200 次 | 10 | 30 | 下载\n```\n"), "error")
                    and "quota" in _codes(_qsec("```quota\n导出额度 | 200 次 / 周 | 很多 | 30 | 下载\n```\n"), "error")
                    and "quota" in _codes(_qsec("```quota\n导出额度 | 200 次 / 周 | 10 | 不定 | 下载\n```\n"), "error")
                    and PERIOD_DAYS["月"] == 30 and PERIOD_DAYS["周"] == 7 and PERIOD_DAYS["天"] == 1)

        def _qv(lim, used, nxt, per="周"):
            return quota_view({"limit": (lim, "次", per), "used": used, "next": nxt})

        def _q_say():
            a, b, c, d = _qv(200, (100, 120), (50, 50)), _qv(200, (180, 200), (30, 30)), _qv(200, (150, 200), (20, 20)), _qv(200, (170, 170), (30, 30))
            e = _qv(50, (40, 40), (5, 5), "天")
            return (a["tone"] == "ok" and a["say"].endswith("所以够,一周还剩 30–50 次(≈ 每天 4.3–7.1 次)。")
                    and b["tone"] == "bad" and b["say"].endswith("所以不够,一周超出 10–30 次。")
                    and c["tone"] == "maybe" and c["say"].endswith("所以可能不够:用得多的一周超出 20 次。")
                    and d["tone"] == "ok" and d["say"].endswith("所以够,一周还剩 0 次(≈ 每天 0 次)。")          # 正好用到上限算够
                    and e["day"] == "" and e["big"] == "每天最多 50 次" and e["say"].endswith("所以够,一天还剩 5 次。")
                    and _qv(3000, (0, 0), (0, 0), "月")["day"] == "≈ 每天 100 次" and _qv(200, (0, 0), (0, 0))["day"] == "≈ 每天 29 次")

        def _q_amount():
            return ([quota_amount(x) for x in ("180–200", "约 2,400 次", "1.5 万", "0", "30-40 次", "100 到 120")]
                    == [(180.0, 200.0), (2400.0, 2400.0), (15000.0, 15000.0), (0.0, 0.0), (30.0, 40.0), (100.0, 120.0)]
                    and all(quota_amount(x) is None for x in ("很多", "200–180", "")))

        def _q_missing():
            two = FM + LEAD + "## 盘点导出用了多少次\n\n导出额度快用完了。按店名筛每周约 270 次。\n"
            one = FM + LEAD + "## 盘点导出用了多少次\n\n导出额度快用完了。\n"
            rc_s, o_s = _quiet(cmd_lint, "q.md", strict=True, text=two)
            rc_n, o_n = _quiet(cmd_lint, "q.md", text=two)
            return ("quota-missing" in _codes(two, "warn") and "quota-missing" not in _codes(two, "error")
                    and "quota-missing" not in _codes(one) and "quota-missing" not in _codes(two + "\n" + _Q)
                    and "quota-missing" not in _codes(two.replace("额度", "那份表"))
                    and "quota-missing" in _codes(two.replace("导出额度快用完了。", "") .replace("盘点导出", "接口额度盘点导出"), "warn")   # 标题也算
                    and rc_s == 1 and rc_n == 0 and "```quota" in o_n and "不同的额度" in o_n)

        tests.extend([
            ("1117 额度框 渲染:一张卡一种额度,大字折合每天、刻度条三段 + 上限线、机器算的够不够、用在哪,类都有样式", _q_render),
            ("1117 额度框 五格缺哪格报 quota 并点名缺哪格、给可照抄的例子;多一格 / 空块也报", _q_fields),
            ("1117 额度框 上限与周期认法(次 / 周、每周最多、每月、万);周期不是天周月 / 没写周期 / 已用接下来看不懂 ⇒ 报", _q_limit),
            ("1117 额度框 够不够三支(够还剩多少折合每天 / 不够差多少 / 可能不够)+ 正好到上限算够 + 月按 30 天", _q_say),
            ("1117 额度框 数的认法:区间 / 约 / 千分位 / 万;倒着的区间和文字不认", _q_amount),
            ("1117 额度框 讲额度 ≥2 处没有 quota 块报 quota-missing(warn,--strict 拦);1 处 / 有块 / 不讲额度不报", _q_missing),
            ("1117 额度框 算图:只有 quota 块的长页不报 page-nofig", lambda: "page-nofig" not in _codes(many(4, 18, fig=False) + "\n" + _Q)),
        ])

        # ──────────── 1117 冷读(发之前让不带上下文的读者读一遍;负责人 11-17:「我根本都看不懂在说什么玩意」)
        _CR_FOLD = "\n````fold 细节在这里\n收起的说明。\n````\n"
        CRD = GOOD + _CR_FOLD + "\n## 两种额度各用了多少\n\n" + _Q

        def _rec(fp, unclear=(), questions=(), **kw):
            r = {"fp": fp, "summary": "讲把草稿拼成网页这件事。", "asks": [], "numbers": [],
                 "unclear_terms": list(unclear), "open_questions": list(questions)}
            r.update(kw)
            return r

        def _fp(md):
            return coldread_fp(coldread_text(parse_doc(md)))

        def _w(path, data):
            with open(path, "w", encoding="utf-8") as f:
                f.write(data if isinstance(data, str) else json.dumps(data, ensure_ascii=False))
            return path

        def _cr_export():
            t = coldread_text(parse_doc(CRD))
            want = ["测试用的方案", "测试线 · 2026-10-06 · 提议中 · 有 1 件要你定", "结论:这页只做一件事。 把草稿拼成网页。",
                    "## 1 第一节讲清楚要做什么", "这里是一小段说明文字。", "【流程图】", "写草稿 → 出页面(检查)",
                    "【要你定】这件事归谁管？", "不定的话没人能动。", "○ 甲线接管(建议) —— 结构归甲线。", "○ 乙线接管 —— 交给乙线。",
                    "○ 其他(我自己写)", "## 2 第二节给出数字和步骤", "【条形图】", "没有图:45 / 94", "## 3 不改什么",
                    "【折叠 · 要点开才看到】细节在这里", "    收起的说明。", "【折叠结束】", "## 4 两种额度各用了多少", "【额度】",
                    "导出额度:每周最多 200 次 ≈ 每天 29 次", "所以不够,一周超出 10–30 次。", "用在哪:程序逐个问商品详情", "图注:已用是近一个周期的实际次数。"]
            pos = [t.find(x) for x in want]
            return all(p >= 0 for p in pos) and pos == sorted(pos) and t.splitlines()[0] == "测试用的方案"

        def _cr_cover():
            # 每种零件里埋一个记号,导出里都要有(他看得到的字,冷读者都要读到)
            md = (FM + LEAD + "## 每种零件都放一个记号\n\n段落记号甲。\n\n### 小标题记号乙\n\n- 列表记号丙\n  - 缩进记号丁\n\n> 引用记号戊\n\n"
                  "| 表头记号己 | 值 |\n|---|---|\n| 格子记号庚 | 1 |\n\n```python\n代码记号辛\n```\n\n"
                  "```compare\n✕ 对比坏记号壬\n坏行记号癸\ncap: 对比图注记号子\n✓ 对比好记号丑\n好行记号寅\n```\n\n"
                  "```steps\n步头记号卯 | 步题记号辰 | 步说明记号巳\n```\n\n```bars\n@ 分组记号午\n条记号未 | 3 | | 右字记号申\n```\n\n"
                  "```flow\n✕ 泳道记号酉\n节点记号戌 | 小字记号亥 -> 节点二: 箭头记号一\n孤点记号二\n```\n\n![图片记号三](img/a.png)\n\n"
                  "````draft 原稿记号四\n稿文记号五\n````\n\n```batch\n题面记号六？\ncost: 代价记号七\n- *选项记号八 | 说明记号九\n- 选项二 | 说明\n"
                  "items:\n- 条目记号十 | 理由记号十一\n- 条目二\n```\n")
            t = coldread_text(parse_doc(md))
            marks = re.findall(r"[一-鿿]+记号[一-鿿]+", md)
            miss = [m for m in marks if m not in t]
            return len(marks) >= 30 and not miss and "按组批量定:点一个选项就定了下面整组 2 条" in t and "[图片:图片记号三]" in t

        def _cr_fp():
            base = _fp(CRD)
            return (len(base) == 12 and _fp(CRD.replace("\n\n", "\n\n\n")) == base
                    and _fp(CRD.replace("这里是一小段说明文字。", "这里是一小段说明文字!")) != base
                    and _fp(CRD.replace("line: 测试线", "line: 别的线")) != base           # 页头那行他也看得到
                    and _fp(CRD.replace("收起的说明。", "收起的说明!")) != base)          # 折叠里的改了也算

        def _cr_cmd_export():
            md = _w(os.path.join(tmp, "cr1.md"), CRD)
            rc, o = _quiet(cmd_coldread, md)
            txt = os.path.join(tmp, "cr1.coldread.txt")
            body = open(txt, encoding="utf-8").read() if os.path.exists(txt) else ""
            return (rc == 0 and body == "【指纹 %s】\n" % _fp(CRD) + coldread_text(parse_doc(CRD))
                    and all(x in o for x in ("一无所知", "只许读这一份文本:" + os.path.abspath(txt), "unclear_terms", "open_questions",
                                             "\"blocks\": true", "没解释过的做法名", "挡路的(true)一条都别漏", "最多列 3 条", "原样抄", "--save",
                                             "⛔ 别自己答", "哪一种额度", "lean-worker", "[no-worktree]", "开局固定开销小一半"))
                    and "宁多勿少" not in o
                    and not os.path.exists(os.path.join(tmp, "cr1.coldread.json")))

        def _cr_save():
            md = _w(os.path.join(tmp, "cr2.md"), CRD)
            rec_path = os.path.join(tmp, "cr2.coldread.json")
            reply = _w(os.path.join(tmp, "reply.txt"), "好的,下面是结果:\n```json\n%s\n```\n读完了。" % json.dumps(_rec(_fp(CRD)), ensure_ascii=False))
            rc1, o1 = _quiet(cmd_coldread, md, save=reply)
            saved = json.load(open(rec_path, encoding="utf-8")) if os.path.exists(rec_path) else {}
            os.remove(rec_path)
            _w(reply, json.dumps(_rec("000000000000")))
            rc2, o2 = _quiet(cmd_coldread, md, save=reply)
            gone2 = not os.path.exists(rec_path)
            _w(reply, json.dumps({k: v for k, v in _rec(_fp(CRD)).items() if k != "open_questions"}))
            rc3, o3 = _quiet(cmd_coldread, md, save=reply)
            return (rc1 == 0 and saved.get("fp") == _fp(CRD) and list(saved)[:6] == list(COLDREAD_KEYS) and "冷读通过" in o1
                    and rc2 == 1 and gone2 and "读的不是现在这一版" in o2 and rc3 == 1 and "缺 open_questions" in o3
                    and not os.path.exists(rec_path))

        def _cr_check():
            md = _w(os.path.join(tmp, "cr3.md"), CRD)
            rp = os.path.join(tmp, "cr3.coldread.json")
            fp = _fp(CRD)
            res = []
            for rec, want_rc, want in ((_rec(fp), 0, "冷读通过"), (_rec(fp, ["分档轮扫"]), 1, "「分档轮扫」"),
                                       (_rec(fp, [], ["每周 270 次是哪种额度?"]), 1, "答不上的问题:「每周 270 次是哪种额度?」"),
                                       (_rec(fp, [{"term": "分档轮扫", "waived": "太短"}]), 1, "理由不足 8 个字"),
                                       (_rec(fp, [{"term": "分档轮扫", "waived": "这个词下一节专门解释过了"}]), 0, "豁免:不懂的词「分档轮扫」"),
                                       (_rec(fp, summary=""), 1, "summary 是空的"), (_rec("abcdefabcdef"), 1, "正文改过了"),
                                       # 1117 blocks 判法:false 只印参考不拦、不用豁免;true / 没写 blocks / 写成字符串 "true" 都拦;字符串 "false" 不拦
                                       (_rec(fp, [{"text": "分档轮扫", "blocks": False}], [{"text": "样本够不够稳?", "blocks": False}]), 0,
                                        "参考(不挡路,不拦):答不上的问题「样本够不够稳?」"),
                                       (_rec(fp, [{"text": "分档轮扫", "blocks": True}]), 1, "挡路的不懂的词:「分档轮扫」"),
                                       (_rec(fp, [{"text": "分档轮扫"}]), 1, "挡路的不懂的词:「分档轮扫」"),
                                       (_rec(fp, [], [{"q": "上限多少?", "blocks": "false"}]), 0, "参考(不挡路,不拦)"),
                                       (_rec(fp, [], [{"q": "上限多少?", "blocks": "true"}]), 1, "挡路的答不上的问题:「上限多少?」")):
                _w(rp, rec)
                rc, o = _quiet(cmd_coldread, md, check=True)
                res.append(rc == want_rc and want in o)
            os.remove(rp)
            rc, o = _quiet(cmd_coldread, md, check=True)
            res.append(rc == 1 and "还没有冷读记录" in o)
            return all(res) and len(res) == 13

        def _cr_render():
            md = _w(os.path.join(tmp, "cr4.md"), CRD)
            html, rp = os.path.join(tmp, "cr4.html"), os.path.join(tmp, "cr4.coldread.json")
            rc1, o1 = _quiet(cmd_render, md, html)
            made1 = os.path.exists(html)
            _w(rp, _rec(_fp(CRD)))
            rc2, o2 = _quiet(cmd_render, md, html)
            made2 = os.path.exists(html)
            os.remove(html)
            _w(md, CRD.replace("这里是一小段说明文字。", "这里改了一句说明。"))
            rc3, o3 = _quiet(cmd_render, md, html)
            return (rc1 == 1 and not made1 and all(x in o1 for x in ("error [coldread]", "coldread " + md, "--save", "--check",
                                                                     "--no-coldread", "这页有要他定的题", "没有生成页面",
                                                                     "lean-worker", "[no-worktree]", "blocks:true"))
                    and rc2 == 0 and made2 and "冷读:通过" in o2 and rc3 == 1 and not os.path.exists(html) and "正文改过了" in o3)

        def _cr_show_only():
            show = FM + LEAD + SEC2 + SEC3                                   # 没有题的纯展示页
            md = _w(os.path.join(tmp, "cr5.md"), show)
            html = os.path.join(tmp, "cr5.html")
            rc1, o1 = _quiet(cmd_render, md, html)
            made1 = os.path.exists(html)
            if made1: os.remove(html)
            rc2, o2 = _quiet(cmd_render, md, html, True)
            bt = _w(os.path.join(tmp, "cr5b.md"), _bt())                    # 按组批量定也是题
            rc3, o3 = _quiet(cmd_render, bt, os.path.join(tmp, "cr5b.html"))
            return (rc1 == 0 and made1 and "warn [coldread]" in o1 and rc2 == 1 and not os.path.exists(html) and "error [coldread]" in o2
                    and rc3 == 1 and "这页有要他定的题" in o3 and not os.path.exists(os.path.join(tmp, "cr5b.html")))

        def _cr_blocks_gate():
            # render 闸同 --check:只有 blocks:true 且没豁免的拦;blocks:false 印成参考照出页面、不进豁免日志
            md = _w(os.path.join(tmp, "cr9.md"), CRD)
            html, rp = os.path.join(tmp, "cr9.html"), os.path.join(tmp, "cr9.coldread.json")
            _w(rp, _rec(_fp(CRD), [{"text": "甲线", "blocks": False}]))
            n0 = len(_hints())
            rc1, o1 = _quiet(cmd_render, md, html)
            made1, new1 = os.path.exists(html), _hints()[n0:]
            if made1: os.remove(html)
            _w(rp, _rec(_fp(CRD), [{"text": "甲线", "blocks": True}]))
            rc2, o2 = _quiet(cmd_render, md, html)
            _w(rp, _rec(_fp(CRD), ["甲线"]))                                  # 旧格式纯字符串 ⇒ 按挡路
            rc3, o3 = _quiet(cmd_render, md, html)
            return (rc1 == 0 and made1 and new1 == [] and "冷读参考(不挡路,不拦):不懂的词「甲线」" in o1 and "冷读:通过" in o1
                    and rc2 == 1 and "error [coldread] 冷读者标了挡路的不懂的词:「甲线」" in o2 and rc3 == 1 and "挡路的不懂的词:「甲线」" in o3
                    and not os.path.exists(html))

        def _hints():
            f = os.environ[HINTS_ENV]
            return [json.loads(x) for x in open(f, encoding="utf-8")] if os.path.exists(f) else []

        def _cr_skip():
            md = _w(os.path.join(tmp, "cr6.md"), CRD)
            html = os.path.join(tmp, "cr6.html")
            rc1, o1 = _quiet(cmd_render, md, html, no_coldread="来不及")
            made1 = os.path.exists(html)
            n0 = len(_hints())
            rc2, o2 = _quiet(cmd_render, md, html, no_coldread="这台机器派不了子代理")
            new = _hints()[n0:]
            return (rc1 == 1 and not made1 and "至少 8 个字" in o1 and rc2 == 0 and os.path.exists(html)
                    and [h["keys"] for h in new] == [["plan-coldread-skip"]] and new[0]["why"] == "这台机器派不了子代理"
                    and new[0]["board"] == "cr6.md")

        def _cr_waive_log():
            md = _w(os.path.join(tmp, "cr7.md"), CRD)
            _w(os.path.join(tmp, "cr7.coldread.json"), _rec(_fp(CRD), [{"term": "甲线", "waived": "读这页的人都认识甲线乙线"}]))
            n0 = len(_hints())
            rc, o = _quiet(cmd_render, md, os.path.join(tmp, "cr7.html"))
            new = _hints()[n0:]
            return (rc == 0 and len(new) == 1 and new[0]["keys"] == ["plan-coldread-waive"] and new[0]["fp"] == _fp(CRD)
                    and new[0]["items"] == [{"kind": "不懂的词", "text": "甲线", "waived": "读这页的人都认识甲线乙线"}] and "1 条豁免" in o)

        def _cr_patch():
            md = _w(os.path.join(tmp, "cr8.md"), CRD)
            html = os.path.join(tmp, "cr8.html")
            _w(os.path.join(tmp, "cr8.coldread.json"), _rec(_fp(CRD)))
            rc0, _o = _quiet(cmd_render, md, html)
            before = open(html, "rb").read()
            rc1, o1 = _quiet(cmd_patch, html, "2", new2)
            same = open(html, "rb").read() == before
            merged = merge_section(CRD, "2", new2)[2]
            reply = _w(os.path.join(tmp, "reply8.txt"), json.dumps(_rec(_fp(merged))))
            rc2, o2 = _quiet(cmd_coldread, html, "2", new2, save=reply)
            rc3, o3 = _quiet(cmd_patch, html, "2", new2)
            after = open(html, encoding="utf-8").read()
            return (rc0 == 0 and rc1 == 1 and same and "patch 没做" in o1 and '--section "2" < 新的一节.md' in o1
                    and rc2 == 0 and rc3 == 0 and "第二节换成新的数字和图" in after and page_source(after) == merged
                    and _quiet(cmd_coldread, md, "2", new2)[0] == 2)

        def _cr_hints_path():
            inside = os.path.realpath(hints_path()).startswith(os.path.realpath(tmp))
            keep = os.environ.pop(HINTS_ENV)
            try:
                dflt = hints_path()
            finally:
                os.environ[HINTS_ENV] = keep
            return inside and dflt == BP.state("board-hints.log")

        def _cr_examples():
            ex = os.path.join(KIT, "examples")
            good_p, bad_p = os.path.join(ex, "good-numbers-as-bars.md"), os.path.join(ex, "bad-jargon-no-frame.md")
            good, bad = open(good_p, encoding="utf-8").read(), open(bad_p, encoding="utf-8").read()
            rec, _why = coldread_load(_default_record(good_p))

            def clean(r):                       # 好例子要「挡路的为 0 且不靠豁免」
                f, pd, wv, _rf = coldread_status(r, _fp(good)) if r else (["没有记录"], [], [], [])
                return not f and not pd and not wv
            leaned = dict(rec or {}, unclear_terms=[{"text": "某个词", "blocks": True, "waived": "这一条靠豁免才过的"}])
            rc, o = _quiet(cmd_render, os.path.join(tmp, "bad-jargon.md"), os.path.join(tmp, "bad-jargon.html"), text=bad)
            return (_codes(good) == set() and clean(rec) and not clean(leaned) and "```quota" in good
                    and "quota-missing" in _codes(bad, "warn") and rc == 1 and "error [coldread]" in o
                    and not os.path.exists(os.path.join(tmp, "bad-jargon.html")))

        tests.extend([
            ("1117 冷读 导出:标题 / 页头 / 结论 / 各节 / 图里的字 / 题面和选项(含「其他」)/ 折叠标明,按阅读顺序", _cr_export),
            ("1117 冷读 导出覆盖所有零件:每种零件里埋的记号都读得到", _cr_cover),
            ("1117 冷读 指纹:只多空行不变;正文 / 页头 / 折叠里改一个字就变", _cr_fp),
            ("1117 冷读 coldread 导出:写 .coldread.txt(第一行指纹)+ 印任务书和下一步,不建记录", _cr_cmd_export),
            ("1117 冷读 --save:从夹着别的字的回答里取 JSON 存记录;指纹不对 / 缺项 ⇒ 不存", _cr_save),
            ("1117 冷读 --check:挡路的清空才过,blocks:false 只印参考;没写 blocks 按挡路;waived 理由 ≥8 字才算;summary 空 / 指纹旧 / 没记录都不过", _cr_check),
            ("1117 冷读 render:带题的页没记录 ⇒ 不出页面且印全三步;有记录出页面;改了正文 ⇒ 又拦", _cr_render),
            ("1117 冷读 render:纯展示页只 warn(--strict 拦);按组批量定也算题", _cr_show_only),
            ("1117 冷读 blocks 判法 render:false 只印参考照出页面、不记豁免;true / 旧格式字符串拦", _cr_blocks_gate),
            ("1117 冷读 --no-coldread:原因不足 8 字拦;够了出页面并记 plan-coldread-skip", _cr_skip),
            ("1117 冷读 豁免记进提醒日志 plan-coldread-waive(带指纹和条目)", _cr_waive_log),
            ("1117 冷读 patch:换完的整页没冷读 ⇒ 页面不动;coldread 页面 --section 存好记录后 patch 通过;.md 配 --section 拒", _cr_patch),
            ("1117 冷读 提醒日志:自测时写临时目录,缺省才是 state_dir/board-hints.log", _cr_hints_path),
            ("1117 冷读 examples:好例子 0 报且附的冷读记录对得上当前正文、挡路的为 0 且不靠豁免;坏例子报 quota-missing、render 被冷读拦", _cr_examples),
        ])
        failed = 0
        for k, (name, fn) in enumerate(tests, 1):
            try:
                ok = bool(fn())
                why = ""
            except Exception as e:      # 自测里任何异常都算这一条没过
                ok, why = False, "  (%s: %s)" % (type(e).__name__, e)
            failed += not ok
            print("%s %2d  %s%s" % ("ok  " if ok else "FAIL", k, name, why))
        if _old_hints is None:
            os.environ.pop(HINTS_ENV, None)
        else:
            os.environ[HINTS_ENV] = _old_hints
    print("selftest: %d 条,%d 过,%d 没过" % (len(tests), len(tests) - failed, failed))
    return 1 if failed else 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="plan.py", description="方案板生成器:Markdown 草稿 → 一页带检查的网页",
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__[__doc__.index("讲数量先给框("):__doc__.index("只用 Python 3")].rstrip())   # 1113:--help 就能看到按组批量定怎么写
    sub = ap.add_subparsers(dest="cmd")
    a = sub.add_parser("render", help="草稿 → 网页(先检查,有 error 不出页面)",
                       formatter_class=argparse.RawDescriptionHelpFormatter,
                       epilog="逐行批量题:在 ```batch 的 items: 之前加「每行选: 涨 | 不涨」,\n"
                              "替换整组选项。items: 下仍写「- 条目名 | 理由」,每行可留空或补充,整页一起交。")
    a.add_argument("draft", help="草稿 .md;- 表示从标准输入读")
    a.add_argument("-o", "--output", help="输出 .html(缺省:草稿同名 .html)")
    a.add_argument("--strict", action="store_true", help="warn 也当 error")
    a.add_argument("--no-coldread", metavar="原因", help="这次不查冷读(原因至少 %d 个字,记进提醒日志)" % COLDREAD_REASON_MIN)
    a.add_argument("--coldread", metavar="记录.json", help="冷读记录(缺省:草稿同名 .coldread.json)")
    a = sub.add_parser("lint", help="只检查")
    a.add_argument("draft")
    a.add_argument("--strict", action="store_true")
    a = sub.add_parser("patch", help="只换已生成页面里的一节(新的一节从标准输入读)")
    a.add_argument("html")
    a.add_argument("--section", required=True, help="节标题或序号")
    a.add_argument("--strict", action="store_true")
    a.add_argument("--no-coldread", metavar="原因", help="这次不查冷读(原因至少 %d 个字,记进提醒日志)" % COLDREAD_REASON_MIN)
    a.add_argument("--coldread", metavar="记录.json", help="冷读记录(缺省:页面同名 .coldread.json)")
    a = sub.add_parser("coldread", help="发之前冷读:导出他会看到的全部文字 + 任务书 / --save 存回答 / --check 检查")
    a.add_argument("src", help="草稿 .md;或已生成的 .html(配 --section,新的一节从标准输入读)")
    a.add_argument("--section", help="只配 .html:查换掉这一节后的整页(同 patch)")
    a.add_argument("--save", metavar="回答文件", help="冷读者回的 JSON(可夹在别的字里);- 表示从标准输入读")
    a.add_argument("--check", action="store_true", help="检查冷读记录:指纹对得上、标 blocks:true 的都清空")
    a.add_argument("--record", metavar="记录.json", help="冷读记录路径(缺省:同名 .coldread.json)")
    sub.add_parser("selftest", help="自测(不联网,只写临时目录)")
    args = ap.parse_args(argv)
    try:
        if args.cmd == "render":
            return cmd_render(args.draft, args.output, args.strict, no_coldread=args.no_coldread, coldread=args.coldread)
        if args.cmd == "lint":
            return cmd_lint(args.draft, args.strict)
        if args.cmd == "patch":
            return cmd_patch(args.html, args.section, sys.stdin.read(), args.strict, args.no_coldread, args.coldread)
        if args.cmd == "coldread":
            if args.section is not None and args.save == "-":
                print("--section 的新一节从标准输入读,--save 就不能再写 -:把冷读者的回答存成文件", file=sys.stderr)
                return 2
            return cmd_coldread(args.src, args.section, sys.stdin.read() if args.section is not None else None,
                                args.check, args.save, args.record)
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
