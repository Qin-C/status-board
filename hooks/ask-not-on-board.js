#!/usr/bin/env node
/**
 * 回复里要负责人做的事,板上「要你的」里没有 ⇒ 下一轮开头提示一次(负责人 10-20 点名的 bad case,Harness v2.5 转状态板 v1.7 设计)。
 * 他的原话:「你这边有两件事情要我干,状态板上只有一件,那如果我只看状态板呢?……这个事情就直接漏了」。
 *
 * ⭐ 为什么不在收尾时直接拦(block):10-20 拿全机近 3 天 71 次收尾回复回放 ——
 *    收窄后 14 次会命中(20%),逐条看真该挂卡的只有六七条(准确率四到五成)。误拦的多是:卡已挂、聊天里换了说法;
 *    别的线板上已有的事;在讲规则 / 界面。block 一次 = 整段上下文重跑一遍,还会把 AI 推去挂凑数的卡(他要「板上每样都有用」)。
 *    ⇒ 收尾时只记下可疑的那几句(零 token);他下一次发话时把它们贴给模型一次,由模型判:真要他做且板上没有 ⇒ 当轮挂卡;不是 ⇒ 不动。
 *
 * 用法(两个挂点,同一个脚本):
 *   Stop             :node ask-not-on-board.js stop    —— 读 last_assistant_message,命中就写 ~/.status-board/ask-not-on-board/<sid>.json
 *   UserPromptSubmit :node ask-not-on-board.js prompt  —— 有记录就印一段提示进上下文,然后删掉记录(每条只提示一次)
 * 板从哪来:与 board-pane-check.js 同一条链(stop hook 学出来的 own → board.py touch 写的声明)。找不到板 ⇒ 不出声。
 * 关掉:touch ~/.status-board/ask-not-on-board/off。命中都记 ~/.status-board/ask-not-on-board.log,10-26 状态板周检时回看准确率。
 *
 * ⭐⭐ 1027 负责人 18:26 在 Harness 板批「按建议做」(卡 ask-00ee6e10;依据 ~/.claude/handoffs/review-1027/nudge-hooks/report.md 逐次判读):
 *   · prompt 挂点「按回复关键词猜漏挂卡」撤掉 —— 98 次抽 30:3 次真抓到、19 次误报、8 次被无视。收尾不再记疑句,下一轮不再贴。
 *     (同一挂点的「没登记的群」提醒是另一件事,照留。)
 *   · pretool(收尾框 ask)收紧 —— 21 次 8 真 13 误,误的多是「卡已在、只差卡号」和「这事根本不用他拍」:
 *     按字面 / 刚挂认出卡 ⇒ 工具把卡号代填进 ask 再放行;认不出才拦,拦时列出板上现有的卡,并先问「真要他拍吗」。
 *   · stop(提问框还挂着已答的问题)留着兜底 —— 17 次 13 真;唯一误伤是他还在板上写、没交:只认交了 / 记下 / 停手到点的回答。
 *
 * 否过什么、为什么:
 *   · 不做收尾时直接拦(block)—— 10-20 回放 71 次收尾回复,收窄后命中 14 次、准确率约四到五成,误拦一次 = 整段重跑还逼出凑数卡(出处:35738af8 10-20;2026-10-20-ai-harness-v2-5-checkpoint.md 第 13 条)
 *   · 不做 prompt 挂点「按回复关键词猜漏挂卡」(已撤)—— 98 次抽 30:3 真、19 误、8 被无视(出处:d28742ef 10-27,卡 ask-00ee6e10;review-1027/nudge-hooks/report.md 结论「撤」)
 *   · 不做 pretool 认不出卡就一律拦 —— 21 次 8 真 13 误,误的多是「卡已在、只差卡号」;改成认得出就代填卡号放行(出处:d28742ef 10-27)
 *   · 不做「群号识别只在正则前缀里补 do / then」(1117)—— `--chat-id $c`(for 循环、同命令里 C=oc_…)照样代不进去,heredoc 正文里写脚本的那串字
 *     照样误认(11-14 FDE 线写 fde-sync.sh 那次,误报了 oc_a9451f…);改成按命令位置走一遍(shell-commands.js 的 shellCommands),7 天回放多认 3 条、少 1 条误认
 */
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = os.homedir();
const DIR = process.env.ASK_NOB_DIR || path.join(HOME, '.status-board', 'ask-not-on-board');
const LOG = process.env.ASK_NOB_LOG || path.join(HOME, '.status-board', 'ask-not-on-board.log');   // 自测别写进生产日志
const WEB = process.env.ASK_NOB_WEB || path.join(HOME, '.claude', 'boards-web');
const STATE = process.env.ASK_NOB_STATE || path.join(HOME, '.status-board', 'board-stop-hook', 'state.json');
const WRITES = process.env.ASK_NOB_WRITES || path.join(HOME, '.status-board', 'board-stop-hook', 'writes.jsonl');

// 要他「现在动手 / 拍板」的说法(收窄到具体动作;10-20 回放调过)
const ASK = /(等你|要你|需要你|请你|得你|只能你|由你|你来|你先|麻烦你).{0,10}(拍|选|定|决定|点|扫|输|粘|删|装|登|回一句|回我|答|看一眼|看看|确认|过目|试|跑|改|开|关|停|给我|一句话)|(拍|选|点|扫|输|粘|删|确认).{0,6}(等你|要你)|等你(一句|一句话|点头|拍|选|答|确认|过目|扫|输)/;
// 不是在要他做事:告知 / 否定 / 过去时 / 以后的事 / 引用界面上的字
const NOT = /「[^」]*(等你|要你)[^」]*」|要你的|要你知道|你要知道|告诉你|不用你|不等你|不用等你|不需要你|无需你|没有.{0,6}(要你|等你|需要你)|(要你|等你).{0,8}(0|零) ?件|你(已经)?(拍过|选了|答了|定了|说过|点了|答过|拍了|确认过)|等你(回来|醒)|放过了|以后|之后再|到时|再请你|再给你|先发给你/;
// 已经指着板 / 卡 / 别的线的板 ⇒ 不算只活在聊天里
// 1020 晚 Harness 全机扫:「回复里却在要你做事」(回 当动词)、「挂卡等你拍」(已经在板上)被当成要他做事 ⇒ 去掉 回/答/定,挂卡算指着板
const REF = /板上|卡上|这张卡|那张卡|ask-[0-9a-f]{8}|「要你的」|线(在|还在)?等你|它的板|那条线|挂(了|好)?卡|挂(到|进)(板|「?要你的)/;
const FILL = /等你|要你|需要你|请你|麻烦你|你|我|的|了|一下|一句|还|在|这|那|件|事|和|是|要|先|再/g;

const { isRetiredBoard } = require('./own-board');   // 1113:认板跳过已退场的板(见 own-board.js)
function ownBoard(sid) {
  if (!sid) return null;
  try { const st = JSON.parse(fs.readFileSync(STATE, 'utf8')); for (const k of Object.keys(st)) if (k.startsWith(sid + '::') && st[k].own && !isRetiredBoard(st[k].own)) return st[k].own; } catch (_) {}
  try {
    const lines = fs.readFileSync(WRITES, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) { try { const e = JSON.parse(lines[i]); if (e.sid === sid && e.board && !isRetiredBoard(e.board)) return path.basename(e.board); } catch (_) {} }
  } catch (_) {}
  return null;
}
function zoneHtml(board) {
  let s; try { s = fs.readFileSync(path.join(WEB, board), 'utf8'); } catch (_) { return null; }
  const m = /<div class="zone"[^>]*>\s*<h2>\s*要你的/.exec(s); if (!m) return null;
  const rest = s.slice(m.index + 10), n = /<div class="zone"/.exec(rest);
  return n ? s.slice(m.index, m.index + 10 + n.index) : s.slice(m.index);
}
function zoneText(board) {
  const h = zoneHtml(board); return h === null ? null : h.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
}
// 「要你的」里有没有 mins 分钟内新挂的卡(data-since 是本机时间,精确到分)。
//   1020 晚 Harness 扫:收尾框的 ask 常是英文,和中文的卡按字比永远对不上 ⇒ 卡 11 秒前刚挂好也照拦(投流 21:31)。
function recentCard(board, mins, now) {
  const h = zoneHtml(board); if (!h) return false;
  const t = now || Date.now();
  for (const m of h.matchAll(/<article\b[^>]*\bdata-since="(\d{4}-\d\d-\d\dT\d\d:\d\d)"/g)) {
    const at = new Date(m[1]).getTime(); if (!isNaN(at) && t - at <= mins * 60e3 && at - t <= 60e3) return true;
  }
  return false;
}
// ⭐ 1022(电商-基建 v1.9 转,负责人截图:「我明明在状态板上都已经回答掉了,为什么还会弹出这种问题啊?」):
//   收尾框问了一句、同时挂了卡;他在板上答了、那条线也收了卡,可之后几轮都是被后台通知 / 钩子叫醒的,没再调收尾框 ⇒ 桌面版的提问框一直挂着旧问题。
//   规则写着「收卡时同时清提问框」,靠自觉没守住。⇒ 收尾框带 ask 时记下「问的是哪张卡」;不带 ask 的收尾框 = 提问框清掉了 ⇒ 删记录。
//   收尾时(Stop)那张卡已经不在「要你的」里、或伺服端已有他的回答,而记录还在 ⇒ 拦一次:先调收尾框把提问框清掉。每一问只拦一次。
const ANS_DIR = process.env.ASK_NOB_ANS || path.join(HOME, '.status-board', 'board-server', 'answers');
function zoneCards(board) {
  const h = zoneHtml(board); if (!h) return null;
  const out = [];
  for (const m of h.matchAll(/<article\b[^>]*\bdata-ack="(ask-[0-9a-f]{8})"[^>]*>([\s\S]*?)<\/article>/g)) {
    const since = (/\bdata-since="([^"]+)"/.exec(m[0]) || [])[1] || '';
    out.push({ id: m[1], text: m[2].replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' '), since });
  }
  return out;
}
function askCards(ask, board) {   // 收尾框这一问指的是哪几张卡:写了卡号 ⇒ 就是它们;没写 ⇒ 字面最像的那张(≥ 三成五)或 30 分钟内刚挂的唯一一张
  const ids = [...new Set(String(ask).match(/ask-[0-9a-f]{8}/g) || [])];
  if (ids.length || !board) return ids;
  const cards = zoneCards(board) || [];
  let best = null, bs = 0;
  for (const c of cards) { const o = overlap(ask, c.text); if (o > bs) { bs = o; best = c; } }
  if (best && bs >= 0.35) return [best.id];
  const t = Date.now(), fresh = cards.filter((c) => { const at = new Date(c.since).getTime(); return !isNaN(at) && t - at <= 30 * 60e3; });
  return fresh.length === 1 ? [fresh[0].id] : [];
}
function wrapRec(sid) { return path.join(DIR, String(sid).replace(/[^\w-]/g, '') + '.wrap.json'); }
// 1027(Harness 判读 stop 第 17 次:他还在板上写、没交,模型被迫清了提问框)⇒ 只认交了的回答,与 board.py _ans_submitted / _ans_kept 同一条:
//   点了「交给这条线」(sub)或「记下」(keep)且不早于最后一次改;没点的,停手到点(只点选项 1 分钟 / 写了字 10 分钟)也算;读不懂时间的老记录算交。
function counted(a, now) {
  if (!a || typeof a !== 'object') return !!a;
  const t = Date.parse(a.ts || ''); if (isNaN(t)) return true;
  const s = Date.parse(a.sub || ''), k = Date.parse(a.keep || '');
  if ((!isNaN(s) && s >= t) || (!isNaN(k) && k >= t)) return true;
  return (now || Date.now()) - t >= (String(a.note || '').trim() ? 600e3 : 60e3);
}
function answered(board, id) {
  try { const a = JSON.parse(fs.readFileSync(path.join(ANS_DIR, encodeURIComponent(board) + '.json'), 'utf8')); return !!(a && a[id]) && counted(a[id]); } catch (_) { return false; }
}
function wrapStale(sid) {   // 提问框还挂着、而它问的卡已经答了 / 收了 ⇒ 那一问;否则 null
  let r; try { r = JSON.parse(fs.readFileSync(wrapRec(sid), 'utf8')); } catch (_) { return null; }
  if (!r || r.told || !r.board || !(r.cards || []).length || Date.now() - r.t > 3 * 864e5) return null;
  const cards = zoneCards(r.board); if (cards === null) return null;   // 读不出「要你的」⇒ 不猜
  const live = new Set(cards.map((c) => c.id));
  const done = r.cards.filter((id) => !live.has(id) || answered(r.board, id));
  return done.length === r.cards.length ? r : null;
}
function overlap(p, zt) { const zb = bigrams(zt), c = bigrams(String(p).replace(FILL, '')); let k = 0; for (const x of c) if (zb.has(x)) k++; return k / Math.max(1, c.size); }
function bigrams(t) { t = t.replace(/[\s\p{P}\p{S}_]+/gu, ''); const o = new Set(); for (let i = 0; i + 1 < t.length; i++) o.add(t.slice(i, i + 2)); return o; }
function segments(text) {
  const out = [];
  for (const l of String(text).split('\n')) for (let p of l.split(/(?=[①②③④⑤⑥⑦⑧⑨])|[;；]/)) {
    p = p.replace(/^[\s\-*>•#|]+|[\s*|]+$/g, '').trim();
    if (p && ASK.test(p) && !NOT.test(p) && !REF.test(p)) out.push(p);
  }
  return out;
}
function candidates(text, zt) {
  const zb = bigrams(zt);
  return segments(text).filter((p) => overlap(p, zt) < 0.35);   // 和「要你的」里的字重合不到三成五 ⇒ 板上多半没有
}
function rec(sid) { return path.join(DIR, String(sid).replace(/[^\w-]/g, '') + '.json'); }
function log(l) { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + ' ' + l + '\n'); } catch (_) {} }

// ⭐ 1023 晚(电商-基建转负责人:「我这个事情我要还要回复那个示例群成员,这事情怎么就直接被淹没掉了?也没放在状态板上」):
//   板上的行可以登记对方群(`board.py row --chat oc_…`),群里别人再说话那一行就亮红(board.py chat-watch,本机每 10 分钟)——
//   但得先有人登记。⇒ 收尾时看这一轮(转录尾 400KB)Bash 里跑过的 `lark-cli im … --chat-id oc_…`:板上哪儿都没出现这个群
//   ⇒ 记下,他下一次发话时提示一次(每个群每个会话只提一次;跟哪件事都无关的群,模型判了不动就行)。零 token、不拦。
// ⚠ 1023 晚首日误报(状态板线自己):heredoc / 引号里写着这串字的(自测数据、脚本源码)也被当成跑过 ⇒ 只认 lark-cli 站在命令位置上:
//   行首、`; & |` / `$(` / 空格加 `(` 之后,可带 `X=y ` 环境变量前缀;前面是引号、逗号、函数名(`tu('lark-cli…`)的不算。
// ⚠ 1117:上面那条正则只认「行首 / ; & | / $( 之后」的 lark-cli —— do / then / { / 函数体里的、`--chat-id $C`(同一条命令里先 C=oc_… 或 for c in oc_…)都漏。
//   改用 shellCommands(把整条命令当小 shell 走一遍,列出真正执行的每条简单命令,同命令里的变量代入;11-17 夜起在 shell-commands.js,三个钩子共用)。
// 依据:群号形状沿用 1023 版的正则(oc_ + 8~64 位字母数字);值整段都得是群号(逗号隔开的多个也认),带引号 / 其他字的不算
const CHAT_ID = /^oc_[0-9A-Za-z]{8,64}$/;
let shellCommands = null;
function chatsInCmd(cmd) {
  if (cmd.indexOf('lark-cli') < 0 || cmd.indexOf('chat-id') < 0) return [];
  if (!shellCommands) shellCommands = require('./shell-commands').shellCommands;   // 三个钩子共用的解析器(11-17 夜从 merge-gate-nudge.js 挪出)
  const out = [];
  for (const { argv } of shellCommands(cmd)) {
    // 依据:im 在前 3 个参数里(lark-cli im … / lark-cli --as user im …);7 天回放 202 条含 chat-id 的命令里没有更靠后的
    if (argv[0] == null || path.basename(argv[0]) !== 'lark-cli' || !argv.slice(1, 4).includes('im')) continue;
    for (let i = 1; i < argv.length; i++) {
      const a = argv[i]; if (a == null) continue;
      const v = a === '--chat-id' ? argv[i + 1] : a.startsWith('--chat-id=') ? a.slice(10) : undefined;
      if (v == null) continue;
      for (const id of v.split(',')) if (CHAT_ID.test(id.trim())) out.push(id.trim());
    }
  }
  return out;
}
function chatsRec(sid) { return path.join(DIR, String(sid).replace(/[^\w-]/g, '') + '.chats.json'); }
function turnChats(tp) {
  let t; try {
    const fd = fs.openSync(tp, 'r'), size = fs.fstatSync(fd).size, n = Math.min(size, 400000), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, size - n); fs.closeSync(fd); t = b.toString('utf8');
  } catch (_) { return []; }
  const out = new Set();
  for (const line of t.split('\n')) {
    if (line.indexOf('lark-cli') < 0 || line.indexOf('tool_use') < 0) continue;
    let o; try { o = JSON.parse(line); } catch (_) { continue; }
    const cs = (o.message && o.message.content) || [];
    for (const c of (Array.isArray(cs) ? cs : [])) {
      if (!c || c.type !== 'tool_use' || !c.input || typeof c.input.command !== 'string') continue;
      try { for (const id of chatsInCmd(c.input.command)) out.add(id); } catch (_) {}   // 解析出错:这条命令不算,不影响别的
    }
  }
  return [...out];
}
function chatNote(input) {
  const sid = input.session_id; if (!sid || !input.transcript_path) return;
  const board = ownBoard(sid); if (!board) return;
  let html; try { html = fs.readFileSync(path.join(WEB, board), 'utf8'); } catch (_) { return; }
  const f = chatsRec(sid); let r = {}; try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) {}
  const told = new Set(r.told || []), pending = new Set(r.pending || []);
  const fresh = turnChats(input.transcript_path).filter((c) => !told.has(c) && html.indexOf(c) < 0);
  if (!fresh.length) return;
  fresh.forEach((c) => { told.add(c); pending.add(c); });
  try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify({ board, told: [...told], pending: [...pending], t: Date.now() })); } catch (_) {}
  log(`chat sid=${String(sid).slice(0, 8)} board=${board} unregistered=${fresh.join(',')}`);
}
function chatPrompt(sid) {
  const f = chatsRec(sid); let r; try { r = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return; }
  if (!r || !r.pending || !r.pending.length) return;
  const p = r.pending; r.pending = []; try { fs.writeFileSync(f, JSON.stringify(r)); } catch (_) {}
  if (Date.now() - (r.t || 0) > 3 * 864e5) return;
  let html = ''; try { html = fs.readFileSync(path.join(WEB, r.board), 'utf8'); } catch (_) {}
  const left = p.filter((c) => html.indexOf(c) < 0); if (!left.length) return;
  log(`chat-prompt sid=${String(sid).slice(0, 8)} board=${r.board} shown=${left.join(',')}`);
  process.stdout.write('💬 上一轮你用 lark-cli 读过 / 发过这几个群,板「' + r.board + '」上没有哪一行登记它们:' + left.join('、') + '\n'
    + '有哪件事在等这个群里的人回话(对方要回复、要报名、要确认…)⇒ 本轮 `board.py row <板> --ack <那一行> --chat <群>`:'
    + '之后群里别人再说话,板上那一行自动亮红、你下次被叫醒时也会提醒(本机每 10 分钟拉一次)。'
    + '跟哪件事都无关(只是查资料 / 发广播)⇒ 不用动,也不用回复这条;这个群本会话不再提。'
    + '负责人 10-23:「我这个事情我要还要回复那个示例群成员,这事情怎么就直接被淹没掉了?也没放在状态板上」\n');
}
function onStop(input) {
  try { chatNote(input); } catch (_) {}
  const sid = input.session_id, text = input.last_assistant_message;
  const w = sid ? wrapStale(sid) : null;
  if (w) {                                                            // 1022:提问框还挂着他已经在板上答掉的问题 ⇒ 拦一次
    try { fs.writeFileSync(wrapRec(sid), JSON.stringify(Object.assign({}, w, { told: Date.now() }))); } catch (_) {}
    log(`wrap-stale sid=${String(sid).slice(0, 8)} board=${w.board} cards=${w.cards.join(',')}`);
    process.stdout.write(JSON.stringify({ decision: 'block', reason:
      '桌面版的提问框还挂着「' + w.ask.slice(0, 60) + '」,而这一问在板上的卡(' + w.cards.join('、') + ')他已经答了 / 已经收了。'
      + '\n⇒ 结束前调一次收尾框(mcp__ccd_turn__wrap_up)把它清掉:不带 ask;此刻确实还有要他答的,就换成那一问(带卡号)。'
      + '负责人 10-22:「我明明在状态板上都已经回答掉了,为什么还会弹出这种问题啊?」(每一问只提醒这一次)' }));
    return;
  }
  // 1027 撤:收尾时按关键词记「像是要他做事」的疑句、下一轮贴回 —— 准头一成(见文件头)。segments / candidates 留作函数,不再接线。
}
function onPrompt(input) {
  const sid = input.session_id; if (!sid) return;
  try { chatPrompt(sid); } catch (_) {}
  try { fs.unlinkSync(rec(sid)); } catch (_) {}                      // 1027 撤:按关键词猜漏挂卡不再贴(撤之前记下的旧疑句一起清掉)
}

// ⭐ 1020 晚(电商-基建 v1.9 转来,负责人:「你现在要我在对话里确认的事情为什么不在状态板上?你这状态板为什么又腐烂了?」):
//   收尾框(mcp__ccd_turn__wrap_up)的 ask 字段 = 正式要他拍板 / 动手 —— 不用像扫回复那样猜,一出现就是要他做事 ⇒ 调用前核一次:
//   本线板「要你的」里找不到对应的卡(字面重合不到三成五,也没写 ask-xxxxxxxx 卡号)⇒ 拒这次调用,先挂卡;本会话还没板 ⇒ 先建板。
//   挂了卡、只是说法不同 ⇒ 在 ask 里带上卡号(ask-xxxxxxxx)就放行。PreToolUse 挂点:matcher = mcp__ccd_turn__wrap_up,命令带 pretool。
function noteWrap(sid, ask, board) {
  try {
    if (!sid) return;
    if (!ask) { fs.unlinkSync(wrapRec(sid)); return; }                // 不带 ask 的收尾框 = 提问框清掉了
    const cards = askCards(ask, board);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(wrapRec(sid), JSON.stringify({ board, ask: ask.slice(0, 200), cards, t: Date.now() }));
  } catch (_) {}
}
function onPreTool(input) {
  const ask = String(((input.tool_input || {}).ask) || '').trim();
  const sid = input.session_id, board = ownBoard(sid);
  noteWrap(sid, ask, board);                                          // 1022:记下这一问指的是哪张卡(见 wrapStale)
  if (!ask || /ask-[0-9a-f]{8}/.test(ask)) return;
  let why, list = '';
  if (!board) why = '本会话还没有状态板。先 `python3 ~/.claude/scripts/board.py new <线名>` 建板,再 `board.py ask` 把这件挂进「要你的」。';
  else {
    const zt = zoneText(board); if (zt === null) return;                    // 读不出「要你的」(老方言)⇒ 不猜
    // 1027:认得出是哪张卡(字面 ≥ 三成五 / 30 分钟内刚挂的唯一一张)⇒ 卡号代填进 ask 再放行(提问框和板上那张卡从此按卡号对上)
    const ids = askCards(ask, board);
    if (ids.length) {
      log(`pretool-fill sid=${String(sid || '').slice(0, 8)} board=${board} cards=${ids.join(',')}`);
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
        updatedInput: Object.assign({}, input.tool_input, { ask: ask + '(' + ids.join('、') + ')' }) } }));
      return;
    }
    if (overlap(ask, zt) >= 0.35) return;
    if (recentCard(board, 30)) { log(`pretool-allow sid=${String(sid || '').slice(0, 8)} board=${board} 30 分钟内刚挂过卡`); return; }
    why = '板「' + board + '」的「要你的」里没认出这件事是哪张卡。';
    const cs = (zoneCards(board) || []).slice(0, 8);
    if (cs.length) list = '\n板上现有的卡(是其中一张 ⇒ 在 ask 里带上它的卡号再调一次):\n'
      + cs.map((c) => '  · ' + c.id + ' ' + c.text.replace(/\s+/g, ' ').trim().slice(0, 50)).join('\n');
  }
  log(`pretool sid=${String(sid || '').slice(0, 8)} board=${board || 'none'} ask=${JSON.stringify(ask.slice(0, 60))}`);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
    permissionDecisionReason: '收尾框里的这一问是要负责人拍板 / 动手的事,得先在状态板上:' + why + list
      + '\n⇒ 先问自己:这件事真要他拍吗?你能自己做 / 已经授权过 / 归别的线 ⇒ 去掉 ask,直接做或转给那条线(⛔ 别为了过这道闸新造一个要他拍的决定)。'
      + '\n⇒ 真要他拍、板上没有:`board.py ask <板> --q "<一个他能直接答的问题>" --rec "…"`(要他动手、包括「在对话里打一句确认」这类:加 --do --steps "起始界面:本会话输入框|怎么做:在对话里打「…」|等多久:…|结果怎么给我:…");'
      + '挂好后在 ask 里带上卡号(ask-xxxxxxxx)再调一次。已有卡只是说法不同 ⇒ 同样带上卡号即可。'
      + '负责人 10-20:「为什么你这边又有事情需要我处理、需要我决策的,但是没有在状态板上」。' } }));
}

if (require.main === module) {
  const mode = process.argv[2];
  if (fs.existsSync(path.join(DIR, 'off'))) process.exit(0);
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => { try { const i = JSON.parse(raw || '{}'); if (mode === 'stop') onStop(i); else if (mode === 'prompt') onPrompt(i); else if (mode === 'pretool') onPreTool(i); } catch (_) {} process.exit(0); });
}
module.exports = { turnChats, chatsInCmd, chatsRec, segments, candidates, zoneText, bigrams, FILL, recentCard, overlap, onPrompt, onPreTool, onStop, askCards, wrapStale, wrapRec };
