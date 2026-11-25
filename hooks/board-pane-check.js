#!/usr/bin/env node
/**
 * 状态板 · 面板死活检查(给 UserPromptSubmit / Stop hook 用,也可手跑)
 *
 * 负责人 2026-09-07:「这个状态板老是一休眠回来就没掉了,你得彻底解决掉。」
 * 事故史(incidents-archive#pane-volatile)早就诊断清楚:面板是易失的,休眠/重开对话后整个 pane 没了,
 * **只有 session 能重开,他自己打不开**;而对策一直是一条「碰板前先开」的提醒 —— 提醒必腐,所以老是复发。
 *
 * 机制:板在面板里时每 15–60 秒会回来拉一次(kit.js),`boards-server.py` 把每块板最近一次被拉取的时间
 * 记在 ~/.status-board/board-server/last-fetch.json。**超过 STALE 秒没被拉 = 没有任何面板在显示它。**
 * 本脚本在每轮开头判本 session 自己那块板:死了就把一行硬提示塞进上下文,逼这一轮第一件事先 navigate。
 *
 * ⛔ 纪律(与 board-freshness-check.js 同一类):只看文件系统、零 token、永远 exit 0、出错静默、
 *   本 session 从没写过板 ⇒ 静默(宁可漏报不可误报)。
 * 手跑:node board-pane-check.js --session <cliSessionId>   或   node board-pane-check.js --board ios.html
 *
 * ⭐ 1110 面板归属(状态板线):上面的判法不分是哪个会话的面板在拉 ⇒ 别的会话的面板开着这块板,本会话也判成「开着」
 *   (负责人 11-09 一天问了 4 次「我根本找不到」)。新判法:本会话标记 mark = sha1(hook 输入的 session_id) 前 10 位
 *   (board.py _pane_mark 从 _cli_session_id() 算同一个数:writes.jsonl 的 sid 就是它,下面 ownBoard 用 e.sid === sid 对的正是它),
 *   看伺服记的 ~/.status-board/board-server/pane-fetch.json 里本标记的面板此刻是不是在拉这块板。
 *   ⛔ 这一周只记不改行为:什么时候注入仍只看老判法;新判法的结论和老结论一起记进日志(old=… new=… mark=… board=…),
 *   注入那句的 navigate 地址带上 ?s=<mark>(这样面板一打开就带标记)。11-18 前后对比 old / new 再定要不要切换。
 *
 * 否过什么、为什么:
 *   · 不挂 Stop —— 面板在 AI 收尾后的空闲期才被拆(Desktop 写死 30 分钟不可见即 teardown),收尾那一刻面板必在,查了等于没查(出处:ee48e1ae 09-07;2026-09-08-ai-harness-v1-7-ledger.md)
 *   · 不靠「碰板前先开」的文字提醒 —— 提醒必腐,面板丢失一直复发(出处:ee48e1ae 09-07,本头注释)
 *   · 不改用浏览器固定标签 / 索引页放板 —— 负责人 09-07 第 N 次否决:他在几十个会话间切,要点开哪个对话右边就是哪块板(出处:记忆卡 feedback-board-must-be-in-session-pane-not-browser-tab.md 09-07)
 *   · 新判法(按本会话面板标记)暂不切成注入依据 —— 没有对比数据,这一周只记日志,11-18 对比 old/new 再定(出处:444afc3e 11-10)
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const STALE = 180;                                  // 3 次轮询都没来
const FETCH = path.join(os.homedir(), '.status-board', 'board-server', 'last-fetch.json');
const { isRetiredBoard } = require('./own-board');   // 1113:认板跳过已退场的板(见 own-board.js)
const WRITES = path.join(os.homedir(), '.status-board', 'board-stop-hook', 'writes.jsonl');
const STATE = path.join(os.homedir(), '.status-board', 'board-stop-hook', 'state.json');
const LOG = path.join(os.homedir(), '.status-board', 'board-pane-check.log');
const PANE = path.join(os.homedir(), '.status-board', 'board-server', 'pane-fetch.json');   // 1110 面板归属:伺服记的「哪个标记的面板此刻在拉哪块板」
// ⭐ 每次调用都记一行(0907 状态板线 case:它那轮「零注入」,而「判绿静默」「没被调用」「异常被吞」三者在
//    上下文里长得一模一样 —— 正是本脚本要治的那种静默)。看这个文件就能分清是哪一种。永不抛。
function log(line) { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch (_) {} }

function ownBoard(sid) {
  if (!sid) return null;
  try {                                              // ① stop hook 学出来的 own(按 sid::cwd 键)—— 先信它:它是「这条线自己写过的板」
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const k of Object.keys(st)) if (k.startsWith(sid + '::') && st[k].own && !isRetiredBoard(st[k].own)) return st[k].own;
  } catch (e) { log('state.json unreadable: ' + (e && e.message)); }
  try {                                              // ② 退到 board.py touch 写的声明,取本 sid 最后一条
    //    ⚠ 0907 实撞:`board.py sync --all` 曾把 13 块板都以调用者的 sid 登记进来,末条会指向别人的板(已改成 --all 不登记)
    const lines = fs.readFileSync(WRITES, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const e = JSON.parse(lines[i]); if (e.sid === sid && e.board && !isRetiredBoard(e.board)) return path.basename(e.board); } catch (_) {}
    }
  } catch (e) { log('writes.jsonl unreadable: ' + (e && e.message)); }
  return null;
}
// ⭐ 1013(状态板 v1.6,负责人定):板的首屏原有一块按「你上次在这条线发话之后做完的」算(现在的区名:「要你的」里的「待你验收」;1020 起改按最近 24 小时)⇒ 他发话那一刻在这里记一笔,
//   写到 ~/.claude/boards-web/_said/<板名>.json({"t":"YYYY-MM-DDTHH:MM"} 本地时间,和板上每行记的时间同一种写法),kit.js paintFirstScreen 来取。
//   只认他亲手发的:别的线发来的消息、后台任务的完成通知都以 `<` 开头的包装到达,不算;读不到 prompt ⇒ 不记(宁可漏记不可错记)。
const SAID_DIR = path.join(os.homedir(), '.claude', 'boards-web', '_said');
function promptKind(input) {
  const p = typeof input.prompt === 'string' ? input.prompt.trim() : null;
  if (p === null) return 'none';
  if (!p) return 'empty';
  // 1013 晚实撞:会话内定时提醒(CronCreate)到点也走 UserPromptSubmit,而且是裸文本 —— 本线 21:03 那条被记成了他发话。
  //   钩子输入里有没有能分出它的字段还没查到(下面日志多记一栏 keys= 就是为了查);先按约定认:以「【」开头的不算他亲手发的。
  if (p[0] === '【') return 'bracket';
  return p[0] === '<' ? 'wrapped' : (p[0] === '/' ? 'command' : 'human');
}
function noteSaid(board) {
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  const t = `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
  fs.mkdirSync(SAID_DIR, { recursive: true });
  const f = path.join(SAID_DIR, board.replace(/\.html$/, '') + '.json'), tmp = f + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ t }));
  fs.renameSync(tmp, f);
}
// 1110 面板归属:本会话标记(与 board.py _pane_mark 同一算法);sid 为空 ⇒ ''
function paneMark(sid) {
  if (!sid) return '';
  // 依据: 10 位与 board.py PANE_MARK_LEN、boards-server.py PANE_MARK_LEN 同长
  try { return crypto.createHash('sha1').update(String(sid), 'utf8').digest('hex').slice(0, 10); } catch (_) { return ''; }
}
// 1110 面板归属 · 新判法(这一周只记):open = 本会话的面板此刻在拉这块板 · other(X) = 在拉别的板 · none = 核不到 / 过期 · nomark = 没有标记
function checkNew(board, mark) {
  if (!mark) return 'nomark';
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(PANE, 'utf8'))[mark] || null; } catch (_) {}
  if (!rec || typeof rec !== 'object' || !rec.board || !(Date.now() / 1000 - Number(rec.t) < STALE)) return 'none';
  return rec.board === board ? 'open' : 'other(' + rec.board + ')';
}
function check(board, mark) {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(FETCH, 'utf8'))[board] || null; } catch (_) {}
  const age = last ? Math.round(Date.now() / 1000 - last) : null;
  if (age !== null && age < STALE) return null;
  const when = age === null ? '从来没被面板拉取过(服务器重启后也会这样)' : Math.round(age / 60) + ' 分钟没被面板拉取';
  return '⚠ 状态板面板检查:「' + board + '」' + when + ' ⇒ 面板上多半没有这块板(休眠/重开对话会把 pane 整个丢掉,只有你能重开)。'
       + '**本轮第一件事**:mcp__Claude_Browser__navigate({ url: "http://127.0.0.1:8777/' + encodeURIComponent(board) + (mark ? '?s=' + mark : '') + '" }),再做别的。'
       + '(判据:板在面板里时每 ≤60 秒会自己回来拉一次;' + STALE + ' 秒没来 = 没人在看。)';
}
// ⭐ 1020 晚(负责人:「最近几个新开的对话,右边那个栏都没有办法直接启动对应的状态板」):接班的新会话还没写过板 ⇒ 上面两条链都查不到
//   ⇒ 本钩子沉默,面板停在空白页。19:25 换棒的 4 条线(AI平台总控 / 示例-基建 / 示例-选品 / 示例-投流)全是 board=none。
//   ⇒ 兜底:会话标题去掉版本号(「 vX.Y」及其后)、去掉「-」和空格,与 boards-web 里的板名同样处理后**完全相等**才认(不做模糊匹配:认错比不认糟)。
const WEB = path.join(os.homedir(), '.claude', 'boards-web');
function boardByTitle(title) {
  // 1117 #a7c3:与 board.py _title_tail_cut 同一套 —— 先去掉标题末尾的「(等…)」和「·要你进来」(子线停下等人时按规矩改的名)。
  const tail = (x) => String(x || '').replace(/\s*[(\uff08]\s*等[^()\uff08\uff09]*[)\uff09]\s*$/, '').replace(/\s*[·・]\s*要你进来\s*$/, '');
  const norm = (x) => tail(x).replace(/\s+v\d+(\.\d+)*.*$/i, '').replace(/[-\s]+/g, '').toLowerCase();
  const want = norm(title); if (!want) return null;
  // 第二档:一边少了项目前缀(标题「状态板 v1.7」↔ 板「示例项目-状态板」;标题「示例项目-IOS」↔ 板「ios」)。两档都只认唯一一块。
  const strip = (x) => tail(x).replace(/\s+v\d+(\.\d+)*.*$/i, '').replace(/^[^-\s]+-/, '').replace(/[-\s]+/g, '').toLowerCase();
  let files = [];
  try { files = fs.readdirSync(WEB).filter((f) => f.endsWith('.html') && !f.startsWith('_') && f !== 'index.html' && !f.includes('-留档')); }
  catch (e) { log('boards-web unreadable: ' + (e && e.message)); return null; }
  for (const eq of [(b) => norm(b) === want, (b) => strip(b) === want || norm(b) === strip(title)]) {
    const hits = files.filter((f) => eq(f.replace(/\.html$/, '')));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;                                                     // 对上不止一块 ⇒ 不猜
  }
  return null;
}
// ⭐ 1110 子线投影(状态板线;负责人 11-10 17:40 批「行,照图做」):带父板声明的子线 / 单开板,卡和一句进度投影到父板上 ——
//   他只看父板,⛔ 别再逼这条子线「把板送进面板」(那会把子线自己的面板翻成子板)。只认 boards-web 里那份子板 wrap 上的 data-parent。
function childParent(board) {
  if (!/^(单开|子线)-/.test(String(board || ''))) return null;
  try {
    const src = fs.readFileSync(path.join(WEB, board), 'utf8');
    const m = /<div\s+class="wrap"([^>]*)>/.exec(src); if (!m) return null;
    const p = /\sdata-parent="([^"]*)"/.exec(m[1]);
    const v = p ? p[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim() : '';
    return v || null;
  } catch (_) { return null; }
}
function main(input) {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--board'), si = argv.indexOf('--session');
  const sid = si >= 0 ? argv[si + 1] : (input.session_id || '');
  const tt = argv.indexOf('--title'), title = tt >= 0 ? argv[tt + 1] : (input.session_title || '');
  let board = bi >= 0 ? argv[bi + 1] : ownBoard(sid), via = 'own';
  if (!board && title) { board = boardByTitle(title); via = 'title'; }
  if (!board) { log(`sid=${String(sid).slice(0, 8)} board=none title=${JSON.stringify(String(title).slice(0, 30))} verdict=silent(no-board)`); return; }
  const kind = si >= 0 || bi >= 0 ? 'manual' : promptKind(input);
  if (kind === 'human') { try { noteSaid(board); } catch (e) { log('noteSaid threw: ' + (e && e.message)); } }
  // 10-20 晚扫描:别线消息 / 后台通知 / 定时提醒叫醒的轮(没人在看)也逼「第一件事 navigate」,CI 一轮触发两次 ⇒ 只在他亲手发话(或读不到 prompt)时提示
  const par = childParent(board);   // 1110 子线投影:子板投影在父板上 ⇒ 不逼送面板,只记一行
  if (par) { log(`sid=${String(sid).slice(0, 8)} board=${board} via=${via} verdict=silent(child-of=${par}) prompt=${kind}`); return; }
  const mark = paneMark(sid), oldMsg = check(board, mark), nv = checkNew(board, mark);   // 1110:old 照旧决定注入;new 只记
  const msg = kind === 'wrapped' || kind === 'bracket' ? null : oldMsg;
  let age = null; try { const l = JSON.parse(fs.readFileSync(FETCH, 'utf8'))[board]; age = l ? Math.round(Date.now() / 1000 - l) : null; } catch (_) {}
  log(`sid=${String(sid).slice(0, 8)} board=${board} via=${via} age=${age === null ? 'never' : age + 's'} verdict=${msg ? 'RED(printed)' : 'green(silent)'} prompt=${kind} keys=${Object.keys(input).sort().join(',')} old=${oldMsg ? 'dead' : 'open'} new=${nv} mark=${mark || '-'}`);
  if (msg) process.stdout.write(msg + '\n');
}
if (process.stdin.isTTY || process.argv.includes('--board') || process.argv.includes('--session') || process.argv.includes('--title')) {
  try { main({}); } catch (e) { log('main threw (argv mode): ' + (e && e.stack || e)); }
} else {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try { main(JSON.parse(input || '{}')); }
    catch (e) { log('main threw (stdin mode): ' + (e && e.stack || e) + ' | input=' + input.slice(0, 200)); }
    process.exit(0);
  });
}
