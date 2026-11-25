"""凭据打码(共用):键值形式的 key / secret / token / 密钥… 的值、像凭据的长串 ⇒ 只留前 3 位 + •••。纯函数,无副作用。

来由:11-13 状态板线 #e4c8 —— 群消息摘录里有 App Secret 明文进了板;同一类数据(飞书消息原文)消息分发员也原样落盘。
正则取自 board.py 的 _redact_secrets(1f7085ae),另加两条豁免(见 _long);board.py 那份归状态板线,改这里同时告诉它。
"""
import re

_SECRET_KV_RE = re.compile(r"((?:app[\s_-]?)?(?:key|secret|token|password|passwd|pwd|ak|sk)|密钥|秘钥|密码|口令|令牌|钥匙)"
                           r"(\s*(?:[:：=]|是|为)\s*)([^\s,，;；。「」\"'<>]{6,})", re.I)
#   依据: 飞书 App Secret 32 位、App Key 20~32 位、各家 token 多在 24 位以上;20 位以下的字母数字混合串多是订单号 / 货号,不打
_SECRET_LONG_RE = re.compile(r"(?<![A-Za-z0-9_])((?:sk-|ghp_|gho_|xox[abp]-|AKIA)[A-Za-z0-9_-]{8,}"
                             r"|(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{20,})(?![A-Za-z0-9_])")


_URL_RE = re.compile(r"https?://\S+")
_HEX_RE = re.compile(r"[0-9a-f]+")


def _long(m):
    g = m.group(1)
    # 11-13 消息分发员实测 961 行误打:机器人消息里的 git 提交号(sha= 后 40 位十六进制)、飞书图片 key、文档链接里的 token。
    # 只放过 40 位(git sha1)和 64 位(sha256)纯小写十六进制;32 位十六进制正是不少平台 App Key / Secret 的样子,照打(状态板线 11-13 指出)。
    # 链接里的段不打(另由键值规则管 ?token= 这类)
    if len(g) in (40, 64) and _HEX_RE.fullmatch(g):
        return g
    return g[:3] + "•••"


def _redact_secrets(text):
    """凭据打码:键值形式的值、像凭据的长串 ⇒ 前 3 位 + •••。纯函数。"""
    t = _SECRET_KV_RE.sub(lambda m: m.group(0) if m.group(3).startswith(("img_", "file_")) else m.group(1) + m.group(2) + m.group(3)[:3] + "•••", str(text or ""))  # 飞书 image_key / file_key 不是凭据
    out, last = [], 0
    for u in _URL_RE.finditer(t):
        out.append(_SECRET_LONG_RE.sub(_long, t[last:u.start()])); out.append(u.group(0)); last = u.end()
    out.append(_SECRET_LONG_RE.sub(_long, t[last:]))
    return "".join(out)


redact = _redact_secrets
