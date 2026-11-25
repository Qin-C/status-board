#!/usr/bin/env node
/**
 * 信箱 —— 不急的跨线消息不叫醒对方(负责人 10-20 拍,板卡 ask-4473e0a9「照建议改」)。
 * 原话:「沉睡的session被唤醒确实是一个很大的一个浪费……除非他真的有必要唤醒他」;
 *       急 = 「需要这个 Session 给你立刻的反馈」或「需要他立刻去做某件事情」;「考虑一下 token 效率」。
 * 11-10 负责人板上批(方案页 handoffs/2026-11-10-ask-deadline-plan.md,卡 ask-deadline):【要你做】必须写最晚什么时候要;
 *       现在 / 拿不准 ⇒ 仍直发;当天内 / 某一天 ⇒ 进信箱,到点还没读由看门(due)叫醒对方。
 * 规则正本 = rules/common/cross-session-messaging.md;本文件只是机制。
 *
 * 发:  node ~/.claude/scripts/inbox.js send --to "<对方标题或线名>" --tag 知会|回执|回执#a1b2 --text "结论 + 链接" [--fyi]
 *       【知会】里出现请你 / 要你 / 请核 / 讨论这类词会拒投(要对方做事 = 【要你做】);确实只是告知加 --fyi
 *      node ~/.claude/scripts/inbox.js send --to "<线名>" --tag 要你做#a1b2 --by today|MM-DD --text "要做什么 + 链接"
 *       today = 投递后 2 小时;MM-DD = 那天 09:00;到点没读 ⇒ 看门叫醒对方。没 --by / --by now / 已过 ⇒ 拒收,改 SendMessage 直发
 *      node ~/.claude/scripts/inbox.js withdraw --to "<线名>" --id a1b2   作废一条对方还没读的【要你做】(中途变急、改直发时用)
 *      回执#编号(或正文第一行带【回执#编号】):落信箱后机器判收件线在不在等(板上有行写着 #编号 / 在等发件线 / 它 3 天内发过同号【要你做】),
 *       在等 ⇒ 叫醒它一次(同号一次;10 分钟内已叫过 ⇒ 合并给看门)。--wake 明知对方在等、强制叫一次;--no-wake 不叫。日志 ~/.status-board/inbox-receipt-wake.log
 *      node ~/.claude/scripts/inbox.js receipt-dry --to "<收件线>" [--codes 9c41,d2e6]   只读回放:信箱里的真回执会不会叫醒、命中哪条(不送、不写)
 * 看:  node ~/.claude/scripts/inbox.js list            各线未读数
 *      node ~/.claude/scripts/inbox.js read <线名> [--peek]  全文(钩子贴进去的被截断时用;--peek 不标已读,发信方替对方看时用)
 *      node ~/.claude/scripts/inbox.js report [--since YYYY-MM-DD]   【要你做】试跑四个数(日志 ~/.status-board/inbox-deadline.log)
 * 看门: node ~/.claude/scripts/inbox.js due [--dry]   LaunchAgent com.status-board.inbox-deadline 每 10 分钟跑:到期未读的【要你做】⇒ 叫醒收件线
 *       (把它全部未读拼一条送进去);叫不醒 ⇒ 给发信线投【知会】并试着叫醒发信线。同一条只升级一次。叫醒走 board.py 的
 *       _wake_live_sessions / _wake_send(⛔ 别在这里另抄 socket 协议)。
 * 钩子(同一个文件,按 hook_event_name 分):
 *   UserPromptSubmit —— 这条线下次被叫醒(他说话 / 收到直发消息)时,把未读贴进去并标已读(【要你做】排最前);没有未读 ⇒ 零输出、零 token。
 *   Stop —— 自己发出的信挂满 24 小时没人读 ⇒ 提醒一次:改用 SendMessage 直发一条汇总(不让它沉底)。
 * 信箱按「线名」取键(标题去掉末尾版本号):换棒后接班会话照样收到。存 ~/.status-board/inbox/<线名>.jsonl(不进 git)。
 * 否过什么、为什么(1117 回执叫醒):
 *   · 不做成所有回执都叫醒 —— 11-10 负责人定过不急的不叫醒(叫醒一次 = 对方整段上下文重读一轮),只叫「板上 / 发信记录里看得出在等」的。
 *   · 不靠回执方自觉判断「对方在不在等」—— 11-17 三条回执就是这么漏的:回执方照规矩走了信箱,发起方板上写着在等,却没人叫醒它。
 * 测试换路径:INBOX_DIR / INBOX_REGISTRY / INBOX_LOG / INBOX_SESS_DIR / INBOX_BOARD_DIR / INBOX_NOW(毫秒或 ISO)/ INBOX_WAKE_CMD(假叫醒命令)/
 *   INBOX_BOARDROWS_CMD(假板)/ INBOX_TRANSCRIPTS_DIR / INBOX_RECEIPT_STATE / INBOX_RECEIPT_LOG。
 */
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const HOME = os.homedir();
const DIR = process.env.INBOX_DIR || path.join(HOME, '.status-board', 'inbox');
const REG = process.env.INBOX_REGISTRY || path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const LOG = process.env.INBOX_LOG || path.join(HOME, '.status-board', 'inbox-deadline.log');
const SESS = process.env.INBOX_SESS_DIR || path.join(HOME, '.claude', 'sessions');
const BOARD_DIR = process.env.INBOX_BOARD_DIR || __dirname;
// 未验证: 2bd6ada定义3天未读提醒但未说明为何3天,无处理时延分布;11-03按信箱未读年龄与催办有效性复盘。
const STALE_MS = 24 * 3600e3;   // 负责人 11-04 板上拍(复盘 limits.md:挂过 3 天的 25 封里 18 封再没人读;24 小时后才读的只有 12/474)
// 未验证: 依据信箱 7 天 P90 读到间隔 69 分钟,试一周后调。
const TODAY_MS = 2 * 3600e3;
// 依据: 方案页「那天早上 9 点还没读,机器叫醒」。
const DAY_HOUR = 9;
// 依据: MM-DD 比今天早超过半年 ⇒ 当作明年(12 月写 01-05);半年内的过去日期 = 写错了,拒收。
const ROLL_MS = 183 * 86400e3;
// 依据:1500 字为展示预算,未展示的信保留未读并提示 read 全文。
const HOOK_CAP = 1500;
// 依据:300 字仅为预览长度,正文截断时不标已读。
const ITEM_CAP = 300;
const TAG_OK = /^(?:知会|回执(?:#[0-9a-f]{4})?|要你做#[0-9a-f]{4})$/i;   // 回执 / 要你做带 4 位编号(peer-ask-receipt.js 按号配对)
const ASK_TAG = /^要你做#([0-9a-f]{4})$/i;
const DIRECT = '写不出最晚什么时候要 / 拿不准 / 现在就要 ⇒ 用 SendMessage 直发,第一行标【要你做#编号】。';

const now = () => { const v = process.env.INBOX_NOW; if (!v) return Date.now(); return /^\d+$/.test(v) ? Number(v) : new Date(v).getTime(); };
const lineOf = (title) => String(title || '').trim().replace(/\s*v\d+(\.\d+)*\s*$/i, '').trim();
const fileOf = (line) => path.join(DIR, `${line.replace(/[\/\\:]/g, '_')}.jsonl`);
const stamp = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
const isAsk = (m) => !!m.ask;
const unreadOf = (box) => box.filter((m) => !m.readAt);
// 要你做排最前(期限早的在前),其余保持投递顺序
const ordered = (list) => [...list.filter(isAsk).sort((a, b) => a.by - b.by), ...list.filter((m) => !isAsk(m))];
// ⭐ 下游钩子按这一行匹配,格式别改(11-10 brief 第 2 条原样)
const rowOf = (m, body) => isAsk(m)
  ? `- [要你做#${m.ask}] ${stamp(m.at)} 来自 ${m.from}(最晚 ${stamp(m.by)} 前要;做完回执带 #${m.ask}):${body}`
  : `- [${m.tag}] ${stamp(m.at)} 来自 ${m.from}:${body}`;

function sessions() {
  const out = [];
  let accts = [];
  try { accts = fs.readdirSync(REG); } catch { return out; }
  for (const a of accts) {
    let orgs = []; try { orgs = fs.readdirSync(path.join(REG, a)); } catch { continue; }
    for (const o of orgs) {
      let files = []; try { files = fs.readdirSync(path.join(REG, a, o)); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(REG, a, o, f), 'utf8'));
          out.push({ id: d.sessionId, cli: d.cliSessionId, title: d.title || '', archived: !!d.isArchived, at: d.lastActivityAt || 0 });
        } catch {}
      }
    }
  }
  return out;
}
// 切过账号的机器上同一会话有多份副本 ⇒ 取未归档 + 最新那份(rules/common/cross-session-messaging.md「怎么发」第 3 条 + history §10-24)
function myTitle(cli) {
  const mine = sessions().filter((s) => s.cli === cli).sort((x, y) => (x.archived - y.archived) || (y.at - x.at));
  return mine[0]?.title || '';
}
// 线名 → 未归档会话的 cliSessionId,最新的在前(同一线可能同时开着旧棒和新棒;叫醒时取第一条活着的)
function clisOf(line) {
  return [...new Set(sessions().filter((s) => !s.archived && s.cli && lineOf(s.title) === line).sort((x, y) => y.at - x.at).map((s) => s.cli))];
}
function readBox(line) {
  try { return fs.readFileSync(fileOf(line), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function writeBox(line, items) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = fileOf(line) + '.tmp';
  fs.writeFileSync(tmp, items.map((m) => JSON.stringify(m)).join('\n') + (items.length ? '\n' : ''));
  fs.renameSync(tmp, fileOf(line));
}
function log(event, m, to, extra) {
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, JSON.stringify({ ts: now(), event, id: m.ask, from: m.from, to, by: m.by, ...extra }) + '\n');
  } catch {}
}
// 标已读;【要你做】记 read 日志(读到时刻 − 期限,分钟;正数 = 晚了)
function markRead(line, list, t, via) {
  for (const m of list) {
    m.readAt = t;
    if (isAsk(m)) log('read', m, line, { readAt: t, lateMin: Math.round((t - m.by) / 60000), via });
  }
}
function arg(name) { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; }

// 期限:today ⇒ +2 小时;MM-DD ⇒ 那天 09:00 本地;其余 / 已过 ⇒ 返回 { err }
function deadline(by, t) {
  if (!by) return { err: `⛔ 【要你做】进信箱必须带 --by today|MM-DD(最晚什么时候要)。${DIRECT}` };
  if (/^(now|现在|拿不准)$/i.test(by)) return { err: `⛔ --by ${by}:现在就要 / 拿不准的不进信箱。${DIRECT}` };
  if (/^today$/i.test(by)) return { by: t + TODAY_MS };
  const m = String(by).match(/^(\d{2})-(\d{2})$/);
  if (!m) return { err: `⛔ --by 只认 today 或 MM-DD(如 11-12),收到「${by}」。${DIRECT}` };
  const y = new Date(t).getFullYear(), mo = Number(m[1]) - 1, d = Number(m[2]);
  let at = new Date(y, mo, d, DAY_HOUR).getTime();
  if (new Date(at).getMonth() !== mo || new Date(at).getDate() !== d) return { err: `⛔ --by ${by} 不是一个真实日期。` };
  if (t - at > ROLL_MS) at = new Date(y + 1, mo, d, DAY_HOUR).getTime();
  if (at <= t) return { err: `⛔ --by ${by} 算出来是 ${stamp(at)},已经过了。${DIRECT}` };
  return { by: at };
}

function send() {
  const to = arg('--to'), tag = arg('--tag'), text = arg('--text');
  if (!to || !tag || !text) { console.error('用法:inbox.js send --to "<对方标题或线名>" --tag 知会|回执|要你做#a1b2 [--by today|MM-DD] --text "结论 + 链接"'); process.exit(2); }
  if (/^要你做$/.test(tag)) { console.error('⛔ 【要你做】要带 4 位十六进制编号:--tag "要你做#a1b2"(回执按号配对)。'); process.exit(2); }
  if (!TAG_OK.test(tag)) {
    console.error(`⛔ 信箱只收【知会】【回执】【要你做#编号】(后者要带 --by)。【急】或你要对方立刻回 / 立刻动手的 ⇒ 直接 SendMessage。`);
    process.exit(2);
  }
  const wakeFlag = process.argv.includes('--wake'), noWake = process.argv.includes('--no-wake');
  if (wakeFlag && noWake) { console.error('⛔ --wake 和 --no-wake 只能选一个。'); process.exit(2); }
  if ((wakeFlag || noWake) && !/^回执/.test(tag)) { console.error('⛔ --wake / --no-wake 只给【回执】用(【要你做】到期由看门叫醒,【知会】不叫醒;急的 SendMessage 直发)。'); process.exit(2); }
  const t = now();
  const askId = (tag.match(ASK_TAG) || [])[1]?.toLowerCase();
  let by;
  if (askId) {
    const r = deadline(arg('--by'), t);
    if (r.err) { console.error(r.err); process.exit(2); }
    by = r.by;
  }
  // 10-22 负责人拍(板 ask-cf7ad326):【知会】里在请对方做事 ⇒ 拒投,改【要你做】。【要你做】不受这条限制。
  //   历史 69 条【知会】里 7 条是这种(请核 / 要你手动再调 / 请你跑部署 / 找你讨论),对方不会为信箱醒,事就搁着。
  const ASK = /请你|请(?:帮|回|看|核|改|确认|分析|给)|帮我|你来|麻烦你|需要你|要你(?!的|做】)|讨论|给出|改法|怎么改|回执请|请回/;
  const hit = tag === '知会' && !process.argv.includes('--fyi') && text.match(ASK);
  if (hit) {
    console.error(`⛔ 这条【知会】里有「${hit[0]}」,像在请对方做事 ⇒ 改投 --tag "要你做#编号" --by today|MM-DD(到点没读机器叫醒),急的 SendMessage 直发。\n   确实只是告知、对方读到即可不用做任何事 ⇒ 加 --fyi 再投。`);
    process.exit(2);
  }
  const line = lineOf(to);
  const live =sessions().filter((s) => !s.archived && lineOf(s.title) === line);
  if (!live.length) {
    const near = [...new Set(sessions().filter((s) => !s.archived && s.title.includes(line.slice(0, 4))).map((s) => s.title))].slice(0, 5);
    console.error(`⛔ 没有叫「${line}」的在用线(标题去掉版本号后比对)。${near.length ? '像的有:' + near.join(' / ') : ''}`);
    process.exit(2);
  }
  const from = myTitle(process.env.CLAUDE_CODE_SESSION_ID || '') || arg('--from') || '(未知线)';
  const box = readBox(line);
  if (askId && box.some((m) => m.ask === askId && !m.readAt)) { console.error(`⛔ 「${line}」信箱里已有一条没读的 #${askId},换个编号,或先 withdraw。`); process.exit(2); }
  const m = { id: `${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: t, from, tag, text };
  if (askId) Object.assign(m, { ask: askId, by });
  box.push(m);
  writeBox(line, box);
  if (askId) log('sent', m, line);
  const unread = unreadOf(box);
  const stale = unread.filter((x) => t - x.at > STALE_MS).length;
  console.log(`✓ 已投进「${line}」的信箱(未读 ${unread.length} 条)。它下次被叫醒时自动贴进去,不会为这条单独醒。`);
  if (askId) console.log(`  最晚 ${stamp(by)} 前要;到点还没读 ⇒ 看门叫醒它。中途变急 ⇒ inbox.js withdraw --to "${line}" --id ${askId},再直发。`);
  // 11-25 负责人:「你说你现在在等状态板回复……他根本就没在干活」—— 信箱里的活对方在到点前不会动。
  if (askId) console.log(`  ⚠ 到 ${stamp(by)} 之前「${line}」不会为这条动。他交代的事要等它的结果才能交差 ⇒ 这不是「当天内」,是「现在就要」:withdraw 后 SendMessage 直发。\n    回复和板上照实写「在 ${line} 的信箱,最晚 ${stamp(by)} 机器叫醒它」,⛔ 别写成「${line} 在做 / 等它回」。`);
  if (stale) console.log(`⚠ 它信箱里有 ${stale} 条挂满 24 小时没读 ⇒ 这条线可能停了;要它知道就 SendMessage 直发一条汇总。`);
  // 1117:带编号的回执 ⇒ 看收件线在不在等,在等就叫醒一次(--wake 强制 / --no-wake 不叫)
  const rcode = receiptCode(tag, text);
  if (rcode || (wakeFlag && /^回执/.test(tag))) {
    let msg;
    try { msg = receiptWake(line, m, rcode, wakeFlag ? 'wake' : noWake ? 'nowake' : 'auto'); }
    catch (e) { rwLog({ code: rcode, from: lineOf(from), to: line, result: 'error', err: String(e && e.message || e).slice(0, 200) }); msg = '判断在不在等时出错,只进了信箱(已记日志)。'; }
    console.log(`  回执:${msg}`);
  }
}

function withdraw() {
  const to = arg('--to'), id = String(arg('--id') || '').toLowerCase();
  if (!to || !/^[0-9a-f]{4}$/.test(id)) { console.error('用法:inbox.js withdraw --to "<线名>" --id a1b2'); process.exit(2); }
  const line = lineOf(to), box = readBox(line);
  const hits = box.filter((m) => m.ask === id);
  const open = hits.find((m) => !m.readAt);
  if (!open) {
    const last = hits[hits.length - 1];
    if (!last) { console.error(`⛔ 「${line}」信箱里没有 #${id}。`); process.exit(2); }
    if (last.withdrawnAt) { console.log(`#${id} 早已作废(${stamp(last.withdrawnAt)})。`); return; }
    console.error(`⛔ 对方已读到 #${id}(${stamp(last.readAt)}),作废不了 ⇒ 要改要停,SendMessage 直发告诉它。`); process.exit(2);
  }
  const t = now();
  open.withdrawnAt = t; open.readAt = t;          // 作废 = 不再贴、不再叫醒(所有「未读」判断都只看 readAt)
  writeBox(line, box);
  log('withdrawn', open, line);
  console.log(`✓ 已作废「${line}」信箱里的 #${id}(对方没读到)。`);
}

function list() {
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')); } catch {}
  if (!files.length) return console.log('信箱全空。');
  for (const f of files) {
    const items = readBox(f.replace(/\.jsonl$/, ''));
    const unread = unreadOf(items);
    console.log(`${f.replace(/\.jsonl$/, '')}:未读 ${unread.length} / 共 ${items.length}${unread.length ? ',最早 ' + stamp(unread[0].at) : ''}`);
  }
}

function read(line) {
  const box = readBox(lineOf(line));
  for (const m of box) console.log(`[${m.tag}] ${stamp(m.at)} 来自 ${m.from}${m.ask ? `(最晚 ${stamp(m.by)})` : ''}${m.withdrawnAt ? '(已作废)' : m.readAt ? '' : '(未读)'}\n${m.text}\n`);
  // --peek:发信方替对方看原文,不算对方读了(11-07 查出:挂满 24 小时的提醒让发信方跑 read,会把对方的信悄悄标已读)
  if (!process.argv.includes('--peek') && box.some((m) => !m.readAt)) { markRead(lineOf(line), unreadOf(box), now(), 'read'); writeBox(lineOf(line), box); }  // 看过原文 = 读了
}

// 叫醒一条线:交给 board.py 现成的 _wake_live_sessions / _wake_send(python 小入口;测试用 INBOX_WAKE_CMD 换成假命令)。
//   回 { status: sent|alive|busy|dead|error, sid?, err? };probe = 只看活没活着,不送。
const WAKE_PY = [
  'import sys, json',
  'd = json.load(sys.stdin); sys.path.insert(0, d["boardDir"]); import board as B',
  'live = B._wake_live_sessions(d["sessDir"]); r = {"status": "dead"}',
  'for c in d["candidates"]:',
  '    if c not in live: continue',
  '    sock, tok, st = live[c]',
  '    if st == "busy": r = {"status": "busy", "sid": c}',
  '    elif d.get("probe"): r = {"status": "alive", "sid": c}',
  '    else:',
  '        e = B._wake_send(sock, tok, d["text"]); r = {"status": "error" if e else "sent", "sid": c, "err": e}',
  '    break',
  'print(json.dumps(r))',
].join('\n');
function wake(line, text, probe) {
  const input = JSON.stringify({ line, candidates: clisOf(line), sessDir: SESS, boardDir: BOARD_DIR, text, probe: !!probe });
  const p = process.env.INBOX_WAKE_CMD
    ? cp.spawnSync(process.env.INBOX_WAKE_CMD, { shell: true, input, encoding: 'utf8', timeout: 15000 })
    : cp.spawnSync('python3', ['-c', WAKE_PY], { input, encoding: 'utf8', timeout: 15000 });
  try { return JSON.parse(String(p.stdout || '').trim().split('\n').pop()); } catch { return { status: 'error', err: String(p.stderr || p.error || '叫醒入口没回话').slice(0, 200) }; }
}
function wakeText(line, unread) {
  const asks = unread.filter(isAsk).length;
  return [`【信箱到点】发给 ${line}:有 ${unread.length} 条到期未读,其中要你做 ${asks} 条`, ...ordered(unread).map((m) => rowOf(m, m.text))].join('\n');
}

// ⭐ 1117 回执到了叫醒在等它的发起方(负责人 11-17:「我自己给你派的这个活,我现在都不知道你到底做成什么样了」)。
//   AI Harness 给状态板 / FDE-总控 派了 #9c41 #d2e6 #f19c,板上写着在等;三条回执 12:51 / 13:57 / 14:19 进了信箱,
//   没有东西叫醒它,负责人 14:2x 自己来问才看到。根因:叫不叫醒全靠回执方猜「对方在不在等」,机器不知道发起方板上有行正等着。
//   ⇒ 带编号的回执落信箱后,机器按三条判据看收件线在不在等(任一成立):
//     a. 收件线板上没做完的行,现状 / 在等里写着这个 #编号(或「回执 编号」);
//     b. 收件线板上没做完的行,在等里写着发件线线名(去掉版本号);
//     c. 收件线自己发过同号【要你做】,且不超过 3 天(信箱记录 / 它的会话转录里 SendMessage 头三行带【要你做#编号】)。
//   在等 ⇒ 叫醒一次(叫醒语只指路,原文由信箱钩子在它醒来那一轮贴出,不另标已读);同号只叫一次;同一收件线 10 分钟内
//   已因回执叫醒过 ⇒ 记成待合并,看门(due)过了 10 分钟仍没读才一次叫醒;对方正在跑 ⇒ 同样留给看门。都读不到 ⇒ 只进信箱、记日志。
//   板只读:board.py 的 _board_claim / _wake_pick_sid / _yours_zone_rows(⛔ 不改 board.py)。
const RECEIPT_TAG = /^回执#([0-9a-f]{4})$/i;
const RECEIPT_HEAD = /【回执#([0-9a-f]{4})】/i;
// 依据: brief 11-17「发出不超过 3 天」—— 派活到回执超过 3 天的,多半已换棒或另有跟进,不再算在等。
const ASK_WINDOW_MS = 3 * 86400e3;
// 依据: brief 11-17「同一收件线 10 分钟内已因回执被叫醒过 ⇒ 合并」;与看门 10 分钟一轮对齐,合并的最多晚一轮送到。
const MERGE_MS = 10 * 60e3;
const RW_STATE = process.env.INBOX_RECEIPT_STATE || path.join(HOME, '.status-board', 'inbox-receipt-wake.json');
const RW_LOG = process.env.INBOX_RECEIPT_LOG || path.join(HOME, '.status-board', 'inbox-receipt-wake.log');
const TRANSCRIPTS = process.env.INBOX_TRANSCRIPTS_DIR || path.join(HOME, '.claude', 'projects');
const receiptCode = (tag, text) => {
  const t = String(tag || '').match(RECEIPT_TAG);
  if (t) return t[1].toLowerCase();
  if (!/^(?:回执|知会)$/.test(String(tag || ''))) return '';
  const first = String(text || '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  const h = first.match(RECEIPT_HEAD);
  return h ? h[1].toLowerCase() : '';
};
function rwLoad() {
  try { const d = JSON.parse(fs.readFileSync(RW_STATE, 'utf8')); return { woken: d.woken || {}, last: d.last || {}, pending: d.pending || {} }; }
  catch { return { woken: {}, last: {}, pending: {} }; }
}
function rwSave(st) {
  try { fs.mkdirSync(path.dirname(RW_STATE), { recursive: true }); const tmp = RW_STATE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(st)); fs.renameSync(tmp, RW_STATE); } catch {}
}
function rwLog(rec) {
  try { fs.mkdirSync(path.dirname(RW_LOG), { recursive: true }); fs.appendFileSync(RW_LOG, JSON.stringify({ ts: now(), at: stamp(now()), ...rec }) + '\n'); } catch {}
}
// 收件线板上没做完的行(只读):[{board, ack, title, wait_for, why}];读不到 ⇒ null。测试用 INBOX_BOARDROWS_CMD 换成假命令。
const BOARDROWS_PY = String.raw`
import sys, json, os, glob, re
d = json.load(sys.stdin); sys.path.insert(0, d["boardDir"]); import board as B
want = d["line"]; out = {"boards": [], "rows": []}
ver = lambda t: re.sub(r"\s*v\d+(\.\d+)*\s*$", "", str(t or "").strip(), flags=re.I).strip()
S = B._registry_sessions(); ctx = None; titles = {}
for f in sorted(glob.glob(os.path.join(B.BP.web_root(), "*.html"))):
    fn = os.path.basename(f)
    if fn.startswith("_"): continue
    try: src = open(f, encoding="utf-8").read()
    except OSError: continue
    if "data-ack" not in src: continue
    owners = {ver(p) for p in str(B._board_claim(f, src, sessions=S) or "").split("、") if p.strip()}
    if not owners:
        if ctx is None:
            ctx = B._wake_ctx(d.get("sessDir")); titles = B._wake_live_titles(ctx[0], ctx[1])
        sid = B._wake_pick_sid(fn, ctx[2], ctx[3], ctx[1])
        if sid: owners = {ver(titles.get(sid))}
    if want not in owners: continue
    out["boards"].append(fn)
    for r in (B._yours_zone_rows(src) or {}).get("facts") or []:
        if r.get("open"): out["rows"].append({"board": fn, "ack": r.get("ack"), "title": r.get("title"), "wait_for": r.get("wait_for") or "", "why": r.get("why") or ""})
print(json.dumps(out, ensure_ascii=False))
`;
function boardRows(line) {
  const input = JSON.stringify({ line, boardDir: BOARD_DIR, sessDir: SESS });
  const p = process.env.INBOX_BOARDROWS_CMD
    ? cp.spawnSync(process.env.INBOX_BOARDROWS_CMD, { shell: true, input, encoding: 'utf8', timeout: 20000 })
    : cp.spawnSync('python3', ['-c', BOARDROWS_PY], { input, encoding: 'utf8', timeout: 20000 });
  try {
    const d = JSON.parse(String(p.stdout || '').trim().split('\n').pop());
    if (!d || !Array.isArray(d.rows)) throw new Error('没有 rows');
    return { boards: d.boards || [], rows: d.rows };
  } catch { return { err: String(p.stderr || p.error || '板读不到').trim().slice(0, 200) }; }
}
const codeIn = (s, code) => new RegExp(`(?:#|回执\\s*)${code}(?![0-9a-z])`, 'i').test(String(s || ''));
// c 的来源二:收件线会话转录里 SendMessage 发出的【要你做#编号】(直发的不进信箱,只有转录里有)
function askInTranscripts(line, code, at) {
  const cut = at - ASK_WINDOW_MS;
  const clis = [...new Set(sessions().filter((s) => s.cli && lineOf(s.title) === line && (s.at || 0) >= cut).map((s) => s.cli))];
  if (!clis.length) return null;
  let dirs = []; try { dirs = fs.readdirSync(TRANSCRIPTS); } catch { return null; }
  const needle = `要你做#${code}`;
  for (const cli of clis) {
    for (const dd of dirs) {
      const f = path.join(TRANSCRIPTS, dd, `${cli}.jsonl`);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (st.mtimeMs < cut) continue;
      let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (!raw.toLowerCase().includes(needle)) continue;
      for (const l of raw.split('\n')) {
        if (!l.toLowerCase().includes(needle)) continue;
        let d; try { d = JSON.parse(l); } catch { continue; }
        const ts = Date.parse(d.timestamp || '');
        if (d.type !== 'assistant' || !(ts >= cut && ts <= at)) continue;
        for (const x of (d.message && Array.isArray(d.message.content) ? d.message.content : [])) {
          if (x.type !== 'tool_use' || !/^(?:SendMessage|.*send_message)$/.test(String(x.name || ''))) continue;
          const msg = String((x.input && (x.input.message || x.input.text || x.input.content)) || '');
          const head = msg.split('\n').map((y) => y.trim()).filter(Boolean).slice(0, 3);
          if (head.some((y) => new RegExp(`【要你做#${code}】`, 'i').test(y))) return { via: 'transcript', at: ts, cli };
        }
      }
    }
  }
  return null;
}
// c 的来源一:信箱里收件线发出的同号【要你做】
function askInInbox(line, code, at) {
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')); } catch { return null; }
  for (const f of files) {
    for (const m of readBox(f.replace(/\.jsonl$/, ''))) {
      if (m.ask === code && lineOf(m.from) === line && m.at <= at && at - m.at <= ASK_WINDOW_MS) return { via: 'inbox', at: m.at, to: f.replace(/\.jsonl$/, '') };
    }
  }
  return null;
}
// 三条判据;rows = boardRows() 的结果(可预先给,回放时同一条线只读一次板)
function receiptJudge(to, fromLine, code, at, rows) {
  const r = rows || boardRows(to);
  const hits = [], why = [];
  if (!r.err) {
    const a = r.rows.find((x) => codeIn(x.wait_for, code) || codeIn(x.why, code));
    if (a) { hits.push('a'); why.push(`a:${a.board} ${a.ack} 写着 #${code}`); }
    const b = fromLine && fromLine !== '(未知线)' && r.rows.find((x) => String(x.wait_for || '').includes(fromLine));
    if (b) { hits.push('b'); why.push(`b:${b.board} ${b.ack} 在等「${fromLine}」`); }
  }
  let c = null;
  try { c = askInInbox(to, code, at) || askInTranscripts(to, code, at); } catch {}
  if (c) { hits.push('c'); why.push(`c:${c.via === 'inbox' ? '信箱' : '转录'}里有它 ${stamp(c.at)} 发出的【要你做#${code}】`); }
  return { hits, why, boardErr: r.err || null, boards: r.boards || [] };
}
function receiptWakeText(line, items) {
  const codes = items.map((x) => '#' + x.code).join(' '), froms = [...new Set(items.map((x) => x.from))].join('、');
  return `【回执到了】发给 ${line}:你等的回执 ${codes} 到了,来自 ${froms}。去读信箱(本轮信箱钩子会贴出原文;没贴全 node ~/.claude/scripts/inbox.js read "${line}"),把结果报给负责人、更新板上在等它的那一行。`;
}
// 落信箱之后调;mode = auto|wake|nowake。⛔ 不抛:出任何错都只记日志,投递照样算成功。
function receiptWake(to, m, code, mode) {
  const t = now(), fromLine = lineOf(m.from), key = `${to}#${code || m.id}`;
  const base = { code: code || null, from: fromLine, to, msg: m.id };
  if (mode === 'nowake') { rwLog({ ...base, result: 'no-wake' }); return '--no-wake:没叫醒,只进了信箱。'; }
  const st = rwLoad();
  if (st.woken[key]) { rwLog({ ...base, result: 'already' }); return `#${code} 已因回执叫醒过对方一次(${stamp(st.woken[key])}),这次只进了信箱。`; }
  let j = { hits: [], why: [] };
  if (mode !== 'wake') {
    j = receiptJudge(to, fromLine, code, m.at);
    if (!j.hits.length) {
      rwLog({ ...base, hits: [], result: 'not-waiting', boardErr: j.boardErr || undefined });
      return `对方没在等(板上没有行在等 #${code} / 「${fromLine}」,也查不到它发过 #${code}${j.boardErr ? ';板这一次没读到' : ''}),只进了信箱。`;
    }
  }
  const hits = mode === 'wake' ? ['--wake'] : j.hits;
  const item = { code: code || m.id, from: fromLine, msg: m.id, at: t };
  if (mode !== 'wake' && st.last[to] && t - st.last[to] < MERGE_MS) {
    (st.pending[to] = st.pending[to] || []).push(item); rwSave(st);
    rwLog({ ...base, hits, why: j.why, result: 'merged' });
    return `对方在等(${j.why.join(';')}),但 ${stamp(st.last[to])} 刚因回执叫醒过它 ⇒ 合并:看门过了 10 分钟它还没读就一次叫醒。`;
  }
  const r = wake(to, receiptWakeText(to, [item]), false);
  if (r.status === 'sent') {
    st.woken[key] = t; st.last[to] = t; rwSave(st);
    rwLog({ ...base, hits, why: j.why, result: 'woken', sid: r.sid });
    return `已叫醒对方(${mode === 'wake' ? '--wake' : j.why.join(';')})。`;
  }
  if (r.status === 'busy') {
    (st.pending[to] = st.pending[to] || []).push(item); rwSave(st);
    rwLog({ ...base, hits, why: j.why, result: 'busy-pending', sid: r.sid });
    return `对方在等,但它正在跑 ⇒ 交给看门:10 分钟内它还没读就叫醒。`;
  }
  rwLog({ ...base, hits, why: j.why, result: r.status === 'dead' ? 'dead' : 'error', err: r.err || undefined });
  return `对方在等,但没开着 / 叫不醒(${r.status}${r.err ? ':' + r.err : ''}),只进了信箱,它下次醒来贴。`;
}
// 看门每轮:合并 / 正在跑而留下的回执,过了 10 分钟还没读 ⇒ 一次叫醒
function receiptDue(dry) {
  const st = rwLoad(), t = now();
  let dirty = false;
  for (const to of Object.keys(st.pending)) {
    const unreadIds = new Set(unreadOf(readBox(to)).map((m) => m.id));
    const left = (st.pending[to] || []).filter((x) => unreadIds.has(x.msg) && !st.woken[`${to}#${x.code}`]);
    if (left.length !== (st.pending[to] || []).length) { dirty = true; }
    if (!left.length) { delete st.pending[to]; dirty = true; continue; }
    st.pending[to] = left;
    if (st.last[to] && t - st.last[to] < MERGE_MS) continue;
    const codes = left.map((x) => '#' + x.code).join(' ');
    if (dry) { console.log(`[dry] ${to} → 会因合并的回执 ${codes} 叫醒一次`); continue; }
    const r = wake(to, receiptWakeText(to, left), false);
    if (r.status === 'busy') { console.log(`${to} → 回执 ${codes} 先不叫:正在跑`); continue; }
    if (r.status === 'sent') {
      for (const x of left) { st.woken[`${to}#${x.code}`] = t; rwLog({ code: x.code, from: x.from, to, msg: x.msg, result: 'woken-merged', sid: r.sid }); }
      st.last[to] = t; delete st.pending[to]; dirty = true;
      console.log(`✓ ${to} → 因回执 ${codes} 叫醒了 ${String(r.sid).slice(0, 8)}`);
      continue;
    }
    for (const x of left) rwLog({ code: x.code, from: x.from, to, msg: x.msg, result: 'merged-undeliverable', why: r.status });
    delete st.pending[to]; dirty = true;
    console.log(`✗ ${to} → 回执 ${codes} 叫不醒(${r.status}),留在信箱`);
  }
  if (dirty && !dry) rwSave(st);
}
// 回放(只读):拿收件线信箱里的真回执跑判断,模拟同号一次 / 10 分钟合并;⛔ 不叫醒、不写状态、不写日志。
function receiptReplay() {
  const to = lineOf(arg('--to') || ''), want = String(arg('--codes') || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!to) { console.error('用法:inbox.js receipt-dry --to <收件线> [--codes 9c41,d2e6]'); process.exit(2); }
  const box = readBox(to).map((m) => ({ m, code: receiptCode(m.tag, m.text) })).filter((x) => x.code && (!want.length || want.includes(x.code)));
  const pick = want.length ? want.map((c) => box.filter((x) => x.code === c).pop()).filter(Boolean) : box.slice(-10);
  pick.sort((x, y) => x.m.at - y.m.at);
  const rows = boardRows(to);
  console.log(`[dry] ${to}:板 ${rows.err ? '读不到(' + rows.err + ')' : (rows.boards.join('、') || '没认出') + `,没做完的行 ${rows.rows.length} 条(板是现在的样子,不是回执到达那一刻)`}`);
  const sim = { last: 0, woken: new Set() };
  for (const { m, code } of pick) {
    const fromLine = lineOf(m.from), j = receiptJudge(to, fromLine, code, m.at, rows);
    let verdict;
    if (sim.woken.has(code)) verdict = '同号已叫过,不再叫';
    else if (!j.hits.length) verdict = '不叫醒,只进信箱';
    else if (sim.last && m.at - sim.last < MERGE_MS) verdict = `合并(${stamp(sim.last)} 刚叫过,交看门)`;
    else { verdict = '叫醒'; sim.last = m.at; sim.woken.add(code); }
    console.log(`  #${code} ${stamp(m.at)} 来自 ${fromLine}:命中 ${j.hits.join('+') || '无'} ⇒ ${verdict}${j.why.length ? '\n     ' + j.why.join('\n     ') : ''}`);
  }
  const p = wake(to, '', true);
  console.log(`  (现在 ${to} ${p.status === 'alive' ? '开着,可叫醒' : p.status === 'busy' ? '正在跑' : '没开着 / ' + p.status};只探活,没送任何东西)`);
}

// ⭐ 1115 大扫除 D3a:机器发信人(名字里带「(机器」)的退信 → 括号前那条线(「状态板(机器:到点该追)」→「状态板」)的信箱,一天每条收件线一条
const MACHINE_FROM = /[（(]机器/;
const dayOf = (ms) => { const d = new Date(ms); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function bounceToOwner(m, line, t) {
  const owner = lineOf(String(m.from || '').replace(/\s*[（(].*$/, '')) || '状态板';
  const key = `${line}|${dayOf(t)}`;
  const sb = readBox(owner);
  let b = sb.find((x) => x.bounce === key && !x.readAt);
  if (!b) {
    b = { id: `${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: t, from: '信箱看门', tag: '知会', fyi: true, bounce: key, asks: [], first: String(m.text || '').slice(0, 200) };
    sb.push(b);
  }
  if (!b.asks.includes(m.ask)) b.asks.push(m.ask);
  b.text = `${m.from} 发给 ${line} 的 ${b.asks.map((a) => '#' + a).join(' ')} 到期了,对方没开着,送不到(机器明天还会再发)⇒ 那条线多半暂停了或没人接:`
    + `看它的板要不要标暂停(board.py pause <板>)或换主人。第一条原文:${b.first}`;
  writeBox(owner, sb);
}

function due() {
  const dry = process.argv.includes('--dry'), t = now();
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')); } catch {}
  const senders = new Set();
  let acted = 0;
  for (const f of files) {
    const line = f.replace(/\.jsonl$/, '');
    const box = readBox(line);
    const hit = box.filter((m) => isAsk(m) && !m.readAt && !m.dueAt && m.by <= t);
    if (!hit.length) continue;
    acted++;
    const unread = unreadOf(box);
    const ids = hit.map((m) => '#' + m.ask).join(' ');
    const r = wake(line, wakeText(line, unread), dry);
    if (r.status === 'busy') { console.log(`${line} → 先不叫:那条线正在跑(${ids} 到期;下一轮再看)`); continue; }
    if (r.status === 'sent' || (dry && r.status === 'alive')) {
      if (dry) { console.log(`[dry] ${line} → 会叫醒 ${String(r.sid).slice(0, 8)}:${ids} 到期,连同全部未读 ${unread.length} 条一起送进去`); continue; }
      for (const m of hit) { m.dueAt = t; m.dueResult = 'woken'; log('woken', m, line, { sid: r.sid, lateMin: Math.round((t - m.by) / 60000) }); }
      markRead(line, unread.filter((m) => !hit.includes(m)), t, 'due');   // 原文已送进去 = 读了(否则它醒来时钩子再贴一遍);到期那几条记 woken
      for (const m of hit) m.readAt = t;
      writeBox(line, box);
      console.log(`✓ ${line} → 叫醒了 ${String(r.sid).slice(0, 8)}:${ids} 到期,送进全部未读 ${unread.length} 条`);
      continue;
    }
    // 叫不醒(没开着 / 送失败)⇒ 记日志、告诉发信线,由它决定直发还是告诉负责人
    if (dry) { console.log(`[dry] ${line} → 叫不醒(${r.status}${r.err ? ':' + r.err : ''}):${hit.map((m) => `#${m.ask} 会知会发信线「${lineOf(m.from)}」`).join(';')}`); continue; }
    for (const m of hit) {
      m.dueAt = t; m.dueResult = 'undeliverable';
      log('undeliverable', m, line, { why: r.status, err: r.err || undefined });
      const back = lineOf(m.from);
      // 发信方是机器(如「状态板(机器:到点该追)」)⇒ 没有会话会读机器名信箱(11-14 压了 8 封死信)。
      // ⭐ 1115 大扫除 D3a:11-14 改成只记日志 ⇒ 送不到这件事就没人知道了 ⇒ 退信投进造这台机器的那条线(括号前的名字,「状态板」)本线信箱,
      //   同一天同一条收件线合成一条(只追加编号),不叫醒(第二天机器会再发,它醒来时信箱钩子贴)。
      if (MACHINE_FROM.test(String(m.from || ''))) { bounceToOwner(m, line, t); continue; }
      if (!back || back === '(未知线)') continue;
      const sb = readBox(back);
      sb.push({ id: `${t.toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: t, from: '信箱看门', tag: '知会', fyi: true,
        text: `你 #${m.ask} 发给 ${line} 的那件到期了,对方没开着,送不到 ⇒ 你来决定直发还是告诉负责人。原文:${m.text}` });
      writeBox(back, sb);
      senders.add(back);
    }
    writeBox(line, box);
    console.log(`✗ ${line} → 叫不醒(${r.status}${r.err ? ':' + r.err : ''}):${ids} 已知会发信线`);
  }
  for (const back of senders) {          // 发信线开着就叫醒它一次(连同它自己的全部未读)
    const sb = readBox(back), unread = unreadOf(sb);
    const r = wake(back, wakeText(back, unread), false);
    if (r.status !== 'sent') { console.log(`  发信线「${back}」没叫醒(${r.status}),知会留在它信箱里,下次醒来贴`); continue; }
    markRead(back, unread, t, 'due');
    writeBox(back, sb);
    console.log(`  ✓ 叫醒了发信线「${back}」`);
  }
  if (!acted && dry) console.log('[dry] 没有到期未读的【要你做】。');
  try { receiptDue(dry); } catch (e) { console.log(`✗ 合并的回执没处理成(${String(e && e.message || e).slice(0, 200)})`); }
}

function report() {
  const since = arg('--since'), from = since ? new Date(`${since}T00:00:00`).getTime() : 0;
  let rows = [];
  try { rows = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((r) => r && r.ts >= from); } catch {}
  const key = (r) => `${r.to}#${r.id}`;
  const uniq = (ev) => [...new Map(rows.filter((r) => r.event === ev).map((r) => [key(r), r])).values()];
  const late = uniq('read').filter((r) => r.lateMin > 0);
  const lost = new Set(uniq('undeliverable').map(key));
  console.log(`【要你做】试跑${since ? '(' + since + ' 起)' : ''}:`);
  console.log(`  进信箱 ${uniq('sent').length} 条`);
  console.log(`  靠看门叫醒 ${uniq('woken').length} 条`);
  console.log(`  晚过期限才被读到 ${late.length} 条${late.map((r) => `\n    - #${r.id} ${r.from} → ${r.to},最晚 ${stamp(r.by)},${stamp(r.readAt)} 才读到(晚 ${r.lateMin} 分钟${lost.has(key(r)) ? ';送不到过' : ''})`).join('')}`);
  console.log(`  送不到 ${uniq('undeliverable').length} 条`);
}

function hook(input) {
  let files = []; try { files = fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')); } catch {}
  if (!files.length) return;                         // 绝大多数时候到这里就结束:零 token
  const title = myTitle(String(input.session_id || ''));
  if (!title) return;
  const t = now();
  if (input.hook_event_name === 'UserPromptSubmit') {
    const line = lineOf(title);
    const box = readBox(line);
    const unread = unreadOf(box);
    if (!unread.length) return;
    let out = `📬 信箱 ${unread.length} 条(别的线发来的,不为它单独叫醒你。【知会】【回执】读到即可,⛔ 不用回「收到」,改变了你手上的事才动;【要你做】要做,做完回执带编号):`;
    let shown = 0;
    const seen = [];
    for (const m of ordered(unread)) {
      const body = m.text.length > ITEM_CAP ? m.text.slice(0, ITEM_CAP) + '…' : m.text;
      const row = '\n' + rowOf(m, body);
      if (out.length + row.length > HOOK_CAP) break;
      out += row; shown++;
      seen.push(m);   // 11-02 复盘:原来截断的信永远不标已读、read 也不标 ⇒ 一封信每条消息重贴(最多 190 次,一周约 428K 字节);贴过一次就算读了
    }
    if (shown < unread.length || unread.some((m) => m.text.length > ITEM_CAP)) out += `\n(没贴全:node ~/.claude/scripts/inbox.js read "${line}")`;
    markRead(line, seen, t, 'hook');
    writeBox(line, box);
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: out } }));
    return;
  }
  if (input.hook_event_name === 'Stop' && !input.stop_hook_active) {
    const late = [];
    // 10-24 复盘:原来只认 from === 本会话标题 ⇒ 换棒后(v2.5 → v2.6)发的信、和脚本代发的「全局事实比对(AI Harness)」永远没人被提醒(眼镜总控 4 条挂了 3 天)。
    // 改成按线名比(去掉版本号),括号里写着线名的代发信也算这条线的。
    const base = (x) => String(x || '').replace(/\s*v\d+(\.\d+)*\s*$/, '').trim();
    const me = base(title);
    const mine = (f) => !!me && (base(f) === me || String(f || '').includes(`(${me})`));
    for (const f of files) {
      const line = f.replace(/\.jsonl$/, '');
      const box = readBox(line);
      let hit = 0;
      for (const m of box) if (!m.readAt && !m.escalated && mine(m.from) && t - m.at > STALE_MS) { m.escalated = t; hit++; }
      if (hit) { writeBox(line, box); late.push(`${line} ${hit} 条`); }
    }
    if (!late.length) return;
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: `你投进信箱的消息挂满 24 小时没人读:${late.join('、')}。对方可能停了 ⇒ 要它知道的,用 SendMessage 直发一条汇总(node ~/.claude/scripts/inbox.js read "<线名>" --peek 看原文);不重要了就不用管。同一批只提醒这一次。`,
    }));
  }
}

const cmd = process.argv[2];
if (cmd === 'send') send();
else if (cmd === 'withdraw') withdraw();
else if (cmd === 'list') list();
else if (cmd === 'read') read(process.argv[3] || '');
else if (cmd === 'due') due();
else if (cmd === 'wake') {   // 给别的脚本用的叫醒入口(11-14 分发员要用,免得各抄一份 WAKE_PY):--to <线> --text <文字> [--probe];打印 JSON 结果
  const to = arg('--to'), text = arg('--text');
  if (!to || (!text && !process.argv.includes('--probe'))) { console.error('用法:inbox.js wake --to <线名> --text <文字> [--probe]'); process.exit(2); }
  console.log(JSON.stringify(wake(lineOf(to), text || '', process.argv.includes('--probe'))));
}
else if (cmd === 'report') report();
else if (cmd === 'receipt-dry') receiptReplay();
else if (cmd === 'hook') {
  let raw = '';
  process.stdin.on('data', (c) => (raw += c));
  process.stdin.on('end', () => { try { hook(JSON.parse(raw || '{}')); } catch {} process.exit(0); });
} else { console.error('用法:inbox.js send|withdraw|list|read <线名>|due [--dry]|report [--since YYYY-MM-DD]|receipt-dry --to <线>|hook'); process.exit(2); }
