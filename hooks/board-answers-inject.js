#!/usr/bin/env node
/**
 * 状态板 · 把他在板上答了但还没交给这条线的事带进这一轮(给 UserPromptSubmit 用,也可手跑)
 *
 * 负责人 2026-10-06(对状态板线):「就算我可能我点了这个选项,但是我忘了发,那它后面它也会自己先去读到这个事情,那我觉得这也是OK的。
 * 只是说…这个hook的成本会不会高?…这个ROI还是需要计算一下的。」
 * 板上的卡 10-06 起可以直接点选项 / 写补充(记在本机 ~/.status-board/board-server/answers/);本脚本在他每次发话时
 * 跑 `board.py answers <本线的板>`(只读),有待处理的回答就原样塞进这一轮的上下文。
 *
 * 成本设计(他的条件是「成本要低」):
 *   · 答案目录里没有任何非空文件 ⇒ 不起 python,直接静默退出(绝大多数轮走这条,约几十毫秒、0 字)。
 *   · 同一份输出对同一条会话 60 分钟内只带一次(他没粘、这条线也还没处理时,不每轮重复塞)。
 * ⛔ 纪律(与 board-pane-check.js 同一类):只读、永远 exit 0、出错静默、找不到板静默、不拦他发话。
 * ⭐ 1023 晚(示例-基建转负责人:「我这个事情我要还要回复那个示例群成员,这事情怎么就直接被淹没掉了?也没放在状态板上」):
 *   板上登记了对方群的行(`board.py row --chat oc_…`),`board.py chat-watch`(本机每 10 分钟)发现群里别人说了新的、这一行还没重判
 *   ⇒ 行上带 data-chat-new。这里读板文件(纯 JS 正则,不起 python),有就提醒这条线先读群、重判那一行;同一份 60 分钟内只带一次。
 * ⭐ 1026 负责人 18:43 批「收尾再查」(原话:「我板上已经回复了，但是好像你看不到……都得我提醒一下」):
 *   上面那段只在他发话时跑 ⇒ 一轮干活中途他在板上交的回答,这一轮看不到。⇒ 同一脚本也挂 Stop(参数 stop):
 *   本板有他新交的、还没贴给过这条会话的回答 ⇒ 拦一次收尾,把同一段贴进去让这一轮处理;贴过的(和发话时那份同一 key 去重)不再拦;
 *   stop_hook_active(已经被拦过一次)⇒ 不拦,免得来回。草稿(他还在写)board.py 本来就不列 ⇒ 不会因为半截的字拦。
 * 手跑:node board-answers-inject.js --session <cliSessionId>   或   --board <板文件名>   (加 stop = 按收尾那一路跑)
 * 自测:node board-answers-inject.selftest.js
 *
 * 否过什么、为什么:
 *   · 不只在 ~/.claude/boards 找板 —— 别线的板在各仓 .claude/boards/,6 天 772 次找不到板静默,负责人 10-12 在选品板答的两张卡没送到(出处:7eec0fd3 10-12)
 *   · 不每轮重复塞同一份回答 —— 负责人 10-06 的条件是成本要低;同一份 60 分钟内只带一次,答案目录空就不起 python(出处:9d6ab1ff 10-06,本头注释「成本设计」)
 *   · 不把他还在写的草稿当已交 —— 半截的字会被拦下处理;只认点了「交给这条线」或停手到点的(出处:0db1ef79 10-26,负责人 10-26 18:43 批)
 *   · 不让 wake-lines 打断正忙的父板主人 —— 它这一轮收尾时本钩子会把子板回答一起带上(11-23 客户项目甲-总控 #c4a9:子板回答因只查本板被漏)
 */
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync } = require('child_process');
const Q = path.join(os.homedir(), '.status-board');
const ANSWERS = process.env.BOARD_ANSWERS_HOOK_DIR || path.join(Q, 'board-server', 'answers');
const WRITES = process.env.BOARD_ANSWERS_HOOK_WRITES || path.join(Q, 'board-stop-hook', 'writes.jsonl');   // 两个 env 只给自测用
const STATE = process.env.BOARD_ANSWERS_HOOK_STATE || path.join(Q, 'board-stop-hook', 'state.json');
const SEEN = process.env.BOARD_ANSWERS_HOOK_SEEN || path.join(Q, 'board-answers-hook', 'seen.json');
const LOG = process.env.BOARD_ANSWERS_HOOK_LOG || path.join(Q, 'board-answers-hook.log');   // 1020 Harness 审计:自测别写进生产日志
// ⚠ 1012 修:原来只到 ~/.claude/boards 找板,而那里只有 3 块;其余线的板在各仓自己的 .claude/boards/ ⇒ 6 天里
//   772 次 board-file-missing,只有本线自己那块板生效过(状态板 v1.6 查出)。boards-web/ 是全机每块活板的硬链,先找它。
const BOARDS = (process.env.BOARD_ANSWERS_HOOK_BOARDS
  || [path.join(os.homedir(), '.claude', 'boards-web'), path.join(os.homedir(), '.claude', 'boards')].join(path.delimiter)).split(path.delimiter);
// 依据:投影关系记在首个板目录的 _children.json;路径覆盖只给自测用。
const CHILDREN = process.env.BOARD_ANSWERS_HOOK_CHILDREN || path.join(BOARDS[0], '_children.json');
// 依据:board.py _wake_state_file() 记录已送达的板名、卡号与回答 ts;路径覆盖只给自测用。
const WOKEN = process.env.BOARD_ANSWERS_HOOK_WOKEN || path.join(Q, 'board-server', 'woken.json');
const BOARD_PY = process.env.BOARD_ANSWERS_HOOK_BOARD_PY || path.join(os.homedir(), '.claude', 'scripts', 'board.py');
// 未验证: board-answers-hook.log无重复提醒的有效性标注,一小时间隔无对照;11-03按重复提醒/已处理回答复盘。
const REPEAT_MS = 60 * 60 * 1000;
const NONE = '没有待处理的回答';
// ⭐ 1026 晚(投流达人转):他在对话里叫你看板上的回复 = 他认为写完了 ⇒ 板上还没点交的也当作交了(board.py answers --take-drafts)
// 1103 示例-选品 v3.2:他说「板上的事项我都处理完了」没触发 ⇒ 4 张点了「记下」没点「交」的卡被当草稿;加处理完 / 弄完 / 搞定这类说法
const ASKS_BOARD = /(状态板|板上|板里|方案板|方案页)[^。!?！？\n]{0,10}(回复|回了|答了|答完|写了|写完|填了|留言|处理完|处理好|处理了|弄完|弄好|搞定)|(看|瞅|读)[^。!?！？\n]{0,6}(状态板|板上|方案板|方案页)/;
function asksBoard(prompt) { return ASKS_BOARD.test(String(prompt || '')); }
function log(line) { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, new Date().toISOString() + ' ' + line + '\n'); } catch (_) {} }

const { isRetiredBoard } = require('./own-board');   // 1113:认板跳过已退场的板(见 own-board.js)
function ownBoard(sid) {                             // 与 board-pane-check.js 同一套找法:先 stop hook 学出来的 own,再 touch 的声明
  if (!sid) return null;
  try {
    const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    for (const k of Object.keys(st)) if (k.startsWith(sid + '::') && st[k].own && !isRetiredBoard(st[k].own)) return st[k].own;
  } catch (_) {}
  try {
    const lines = fs.readFileSync(WRITES, 'utf8').trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      try { const e = JSON.parse(lines[i]); if (e.sid === sid && e.board && !isRetiredBoard(e.board)) return path.basename(e.board); } catch (_) {}
    }
  } catch (_) {}
  return null;
}
function anyAnswers() {                              // 便宜的前置判断:目录里有没有比 `{}` 大的文件
  try { return fs.readdirSync(ANSWERS).some((f) => f.endsWith('.json') && fs.statSync(path.join(ANSWERS, f)).size > 2); }
  catch (_) { return false; }
}
function unq(v) { return String(v || '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'); }
function chatLines(file) {                           // 1023 晚:登记的对方群里有人说了新的、这一行还没重判(见文件头)
  let t; try { t = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  if (t.indexOf('data-chat-new="') < 0) return [];
  const out = [], re = /<[a-z]+\b[^>]*\bdata-chat-new="[^"]*"[^>]*>/g; let m;
  while ((m = re.exec(t))) {
    const tag = m[0], g = (n) => { const x = new RegExp('\\s' + n + '="([^"]*)"').exec(tag); return x ? unq(x[1]) : ''; };
    if (g('data-status') === 'done' || !g('data-ack')) continue;
    const tm = /<b\b[^>]*>([\s\S]*?)<\/b>/.exec(t.slice(re.lastIndex, re.lastIndex + 3000));
    const title = tm ? unq(tm[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 30) : '';
    out.push(`  · 行 ${g('data-ack')}「${title}」:群 ${g('data-chat').split(',')[0]} 里 ${g('data-chat-new').replace('T', ' ').slice(5, 16)} ${g('data-chat-who') || '对方'} 说:「${g('data-chat-say')}」(共 ${g('data-chat-n') || 1} 条)`);
  }
  return out;
}
function noteSection(file, sid, board) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
  const out = [];
  // 依据: board.py _note_set 在行属性里记 JSON，行首文案另外显示。
  for (const { 0: tag } of src.matchAll(/<[a-z]+\b[^>]*\bdata-machine-notes="[^"]*"[^>]*>/g)) {
    if (!/\sclass="[^"]*\bcrow\b/.test(tag)) continue;
    const ack = /\sdata-ack="([^"]+)"/.exec(tag)?.[1];
    if (!ack) continue;
    const raw = /\sdata-machine-notes="([^"]*)"/.exec(tag)?.[1];
    try {
      for (const record of Object.values(JSON.parse(unq(raw)))) {
        out.push(`  · 行 ${ack}: ${record.fail ? '处理失败，' : ''}${record.text}${record.path ? ' · 产物 ' + record.path : ''}`);
      }
    } catch (_) {}
  }
  if (!out.length || !seenOnce('notes::' + (sid || 'nosid') + '::' + board, out.join('\n'))) return '';
  return '有新结果待接。用 row --ack <行> --say / --review / --checked 接住:\n' + out.join('\n');
}
function seenOnce(key, text) {                       // 同一份输出对同一条会话 60 分钟内只带一次;第一次 ⇒ true
  const h = crypto.createHash('sha1').update(text).digest('hex');
  let seen = {}; try { seen = JSON.parse(fs.readFileSync(SEEN, 'utf8')); } catch (_) {}
  if (seen[key] && seen[key].h === h && Date.now() - seen[key].t < REPEAT_MS) return false;
  seen[key] = { h, t: Date.now() };
  try { fs.mkdirSync(path.dirname(SEEN), { recursive: true }); fs.writeFileSync(SEEN, JSON.stringify(seen)); } catch (_) {}
  return true;
}
function recentAnswers(ms) {                        // 收尾那一路的便宜前置:答案目录里最近 ms 毫秒内有没有改过的文件
  try { const now = Date.now(); return fs.readdirSync(ANSWERS).some((f) => f.endsWith('.json') && now - fs.statSync(path.join(ANSWERS, f)).mtimeMs < ms); }
  catch (_) { return false; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return null; }
}
function boardFile(board) {
  return BOARDS.map((d) => path.join(d, path.basename(board))).find((f) => fs.existsSync(f));
}
function childAnswerFile(board) {
  // 依据:board_paths.answers_file_name 先 unquote、取 basename、去空白;Python quote 额外转义 !'()*。
  const decoded = board.replace(/(?:%[0-9a-f]{2})+/gi, (run) => Buffer.from(run.replace(/%/g, ''), 'hex').toString('utf8'));
  const name = path.basename(decoded).trim();
  if (!/^[^.].*\.html?$/s.test(name) || [...name].length > 200) return null;
  const encoded = encodeURIComponent(name).replace(/[!'()*]/g, (char) => '%' + char.charCodeAt(0).toString(16).toUpperCase());
  return path.join(ANSWERS, encoded + '.json');
}
function childAnswers(board, sid, prefix, take) {
  const children = readJson(CHILDREN)?.[path.basename(board)];
  if (!Array.isArray(children) || !children.length) return [];
  const woken = readJson(WOKEN);
  const sections = [];
  for (const child of children) {
    const name = child?.file;
    if (typeof name !== 'string' || name !== path.basename(name)) continue;
    const childPrefix = `${prefix} child=${name}`;
    const answerFile = childAnswerFile(name);
    let hasAnswers = false;
    try { hasAnswers = answerFile && fs.statSync(answerFile).size > 2; } catch (_) {}
    if (!hasAnswers) { log(`${childPrefix} verdict=silent(no-answers-on-disk)`); continue; }
    const answers = readJson(answerFile);
    if (answers && Object.entries(answers).every(([id, rec]) =>
      !(rec?.choice || rec?.note) || (rec.ts != null && woken?.[name]?.[id] === rec.ts))) {
      log(`${childPrefix} verdict=silent(already-woken)`);
      continue;
    }
    const file = boardFile(name);
    if (!file) { log(`${childPrefix} verdict=silent(board-file-missing)`); continue; }
    const out = pendingAnswers(file, sid, name, childPrefix, take, true);
    if (out) sections.push(`【子线的卡】下面是 ${child.title || name} 的卡(子板 ${name}),他多半是在你板上的投影卡里答的:子线开着就用 SendMessage 带给它,不开着就代它处理并在子板上收卡(answer 的板参数用子板)\n${out}`);
  }
  return sections;
}
const STOP_MODE = process.argv.slice(2).includes('stop');
// 未验证: 0db1ef7批准试行收尾查回复,未说明3小时窗口取值;11-03按回答提交至收尾间隔与漏提醒复盘。
const STOP_WINDOW_MS = 3 * 60 * 60 * 1000;
function pendingAnswers(file, sid, board, prefix, take, child = false) {
  let raw;
  try { raw = execFileSync('python3', [BOARD_PY, 'answers', file].concat(take ? ['--take-drafts'] : []), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch (e) { log(`${prefix} verdict=silent(board.py failed: ${String(e && e.message).slice(0, 120)})`); return ''; }
  if (take && !child) log(`${prefix} take-drafts=1`);
  const out = raw.trim();
  if (!out || out.split('\n')[0].startsWith(NONE)) {
    if (child || !STOP_MODE) log(`${prefix} verdict=silent(none-pending)`);
    return '';
  }
  if (!seenOnce((sid || 'nosid') + '::' + board, out)) {
    log(`${prefix} verdict=silent(${STOP_MODE ? 'already-shown' : 'same-as-last, <60min'})`);
    return '';
  }
  log(`${prefix} verdict=${STOP_MODE ? 'BLOCK' : 'PRINTED'}(${out.length} chars)`);
  return child ? raw : out;
}
function main(input) {
  const argv = process.argv.slice(2);
  const bi = argv.indexOf('--board'), si = argv.indexOf('--session');
  const sid = si >= 0 ? argv[si + 1] : (input.session_id || '');
  const tag = `sid=${String(sid).slice(0, 8)}`;
  const board = bi >= 0 ? argv[bi + 1] : ownBoard(sid);
  if (!board) { log(`${tag} verdict=silent(no-board)`); return; }
  if (STOP_MODE) return stopMain(input, sid, tag, board);
  const file = boardFile(board);
  if (!file) { log(`${tag} board=${board} verdict=silent(board-file-missing)`); return; }
  const notes = noteSection(file, sid, board);
  let output = notes ? notes + '\n' : '';
  const chat = chatLines(file);
  if (chat.length && seenOnce('chat::' + (sid || 'nosid') + '::' + board, chat.join('\n'))) {
    log(`${tag} board=${board} verdict=CHAT(${chat.length} rows)`);
    output = '💬 你板上这几行登记的对方群里,有人在你上次重判这一行之后说了新的(机器每 10 分钟拉一次群,不是他这一轮打的字)。'
      + '这一轮先读群(`lark-cli im +chat-messages-list --as user --chat-id <群> --order desc --page-size 10`),按新情况重判那一行'
      + '(`board.py row <板> --ack <行> --say "现在到哪了" …`,跑完板上红标自动拿掉);要他回对方 ⇒ 挂卡 `board.py ask <板> --row <行> …`:\n' + chat.join('\n') + '\n';
  }
  const prefix = `${tag} board=${board}`;
  const take = asksBoard(input.prompt);
  let own = '';
  if (anyAnswers()) own = pendingAnswers(file, sid, board, prefix, take);
  else log(`${prefix} verdict=silent(no-answers-on-disk)`);
  const sections = childAnswers(board, sid, prefix, take);
  if (own) sections.unshift(own);
  if (sections.length) {
    output += '📋 他在状态板上直接答了下面这些,还没粘给你(机器读的板上记录,不是他这一轮打的字)。这一轮一并处理,做法见每条后面的命令:\n' + sections.join('\n');
    if (!output.endsWith('\n')) output += '\n';
  }
  if (output) process.stdout.write(output);
}
function stopMain(input, sid, tag, board) {
  if (input.stop_hook_active) return;                // 这一轮已经被拦过一次 ⇒ 放行
  const file = boardFile(board);
  if (!file) return;
  const prefix = `${tag} board=${board} stop`;
  const recent = recentAnswers(STOP_WINDOW_MS);
  const own = recent ? pendingAnswers(file, sid, board, prefix, false) : '';
  const sections = recent ? childAnswers(board, sid, prefix, false) : [];
  if (own) sections.unshift(own);
  const notes = noteSection(file, sid, board);
  const answers = sections.length ? '📋 收尾前再查:这一轮里他在状态板上交了下面这些回答(机器读的板上记录,你这一轮还没见过)。'
    + '先照办再收尾,做法见每条后面的命令;只回他一句的,也要在板上收卡:\n' + sections.join('\n') : '';
  const reason = [answers, notes].filter(Boolean).join('\n');
  if (reason) process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
}
if (process.stdin.isTTY || process.argv.includes('--board') || process.argv.includes('--session')) {
  try { main({}); } catch (e) { log('main threw (argv mode): ' + (e && e.stack || e)); }
} else {
  let input = '';
  process.stdin.on('data', (c) => { input += c; });
  process.stdin.on('end', () => {
    try { main(JSON.parse(input || '{}')); } catch (e) { log('main threw (stdin mode): ' + (e && e.stack || e)); }
    process.exit(0);
  });
}
