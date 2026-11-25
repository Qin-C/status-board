#!/usr/bin/env node
/**
 * T2 · 状态板保鲜提示(Stop hook)
 *
 * 立据:`~/.claude/rules/common/status-board.md` 预写的升级阶梯,触发条件是
 * 「两周内负责人 ≥2 次撞到『板是旧的』」—— **2026-08-27 立规第二天就满足了**,两次都是他亲自撞到。
 * 他的原话:「如果状态板不是最新的话,那我如果去根据状态板去做决策,那不是问题很大吗?」
 *
 * ⭐ 挂在 Stop(= 发消息那一刻)而不是别处 —— 上下文线自述指出了失效的确切位置:
 *   「失效不是发生在『该不该写板』上,而是发生在『**什么时候**写』…每一轮都觉得『等这轮跑完一起写』。」
 *   规则的顺序是「先落板 → 消息从板里摘」⇒ 检查点就该在发消息这一刻。
 *
 * ⭐⭐ 它怎么知道「这条 session 该维护哪块板」(v1 在这里栽过,值得记):
 *   v1 取的是**全仓所有板的最新 mtime**。眼镜仓有 5 块板 ⇒ **别的线一更新就把本线的过期掩盖掉**,
 *   实测连跑 5 轮一次都没触发。⇒ 改成按 `session_id` 记状态,并**从行为里学**:
 *   哪块板在这条 session 手里变新过,哪块就是它的。**从没写过任何板的 session 一律静默** ——
 *   宁可漏报,不可误报(这台机器已经因为误伤删过两个 hook)。
 *
 * ⛔ 刻意做成与被删那两个不同类:
 *   · 文件年龄 + 转录中可见的新事实;不调模型
 *   · 确有未落板事实才阻止 Stop;出错一律静默(exit 0)
 *   · 没有板 / 没写过板的线**完全静默**
 *   · 有节流(连续 N 轮 + 确实旧了 + 距上次提示够久)
 *
 * 卸载:删掉 settings.json 里 Stop 数组的这一条即可,状态在 ~/.status-board/board-stop-hook/。
 *
 * 否过什么、为什么:
 *   · 不取全仓所有板的最新 mtime 判过期(v1)—— 别的线一更新就掩盖本线过期,实测连跑 5 轮一次没触发(出处:本头注释 v1 一段,入仓 014fbcb5 08-28)
 *   · 不把 MISS_TURNS 降到 2 —— 打的是各线中位 5–9 分钟写一次板的那批,纯误伤(出处:77701968 09-03)
 *   · 不用纯板龄判 —— 会打到「醒来只答一句话」的休眠线(实测板龄 2511 分钟、miss=1)(出处:77701968 09-03)
 *   · 不留「miss>=2 且板龄>60 分钟」长尾分支(已撤)—— 10-27 复盘出现无新事实误拦,按它自己写的「判一次不该响就撤、别调参」撤掉(出处:e824cee0 10-27,卡 ask-00ee6e10;review-1027/nudge-hooks/report.md)
 *   · 不在没有新事实、只等原卡 / 后台时逼着 touch 板 —— touch 只是盖戳,不是保鲜(出处:e824cee0 10-27)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const STATE_DIR = path.join(os.homedir(), '.status-board', 'board-stop-hook');
const STATE = path.join(STATE_DIR, 'state.json');
const MISS_TURNS = 3;
// 未验证: 014fbcb51 引入20分钟板龄门槛但未记定值理由，下次保鲜钩子验收时回放误拦与漏拦。
const STALE_SECS = 20 * 60;
const NAG_COOLDOWN = 15 * 60;
// 命中日志(给 scripts/hook-hits.py 数,它默认读 ~/.status-board/<钩子名>.log;写失败不影响判定;selftest 流量不记)—— 1115 大扫除:原来没有日志,判不了命中
function hit(m) {
  if (process.env.HOOK_SELFTEST) return;
  try { fs.appendFileSync(path.join(os.homedir(), '.status-board', 'board-freshness-check.log'), `${new Date().toISOString()} ${m}\n`); } catch (_) {}
}
// 10-27 复盘已出现无新事实误拦，依原自我证伪条件撤掉两轮长尾分支。

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => { try { run(JSON.parse(input || '{}')); } catch (_) {} process.exit(0); });
setTimeout(() => { try { run({}); } catch (_) {} process.exit(0); }, 4000).unref();

function readDeclaredOwn(cwd, since, sid) {
  // `board.py` 每次 touch/sync/lint 都会追加一行 {cwd, board, ts}。
  //
  // ⚠⚠ 2026-08-27 v3.9 修:光按 cwd 匹配**是不够的** —— cwd 会跨 session 复用。
  //   两种都在本机真实发生:①交接后新一棒搬进前任的 worktree ②好几条 session 同在仓根。
  //   于是「前任写过 ios.html」这条声明被**新占用者继承**,它就被安上了别人的板。
  //   实测坐实:同 cwd 两个不同 session_id,`own` 都变成 `ios.html`;
  //   而 T2 装上后唯一一次出声(17:42)正是这个 —— **打给 cc控制 线、说的是 iOS 的板**。
  //   ⇒ 加一道时间窗:只认**这条 session 活着期间**写下的声明。
  //   前任留下的声明 ts 早于本 session 的 `since`,因此不会被继承。
  //   ⛔ 这条**只会让它更沉默,不会让它更吵** —— 与本 hook 的既定原则一致
  //      (宁可漏报,不可误报;这台机已因误伤删过两个 hook)。
  //
  //   ⭐⭐ 2026-08-27 又加一层(Harness 线找到路子,iOS 线在自己 session 上独立复验):
  //   `board.py` 现在会把 **hook 看到的那个 `session_id`** 一起写进声明(字段 `sid`)。
  //   于是「谁写的」不再靠 cwd 猜 —— 这把上面时间窗挡不住的那一半(**多条 session 共用
  //   同一个 cwd 且都在写板**,本机实测有 8 条记录挂在仓根)也关掉了。
  //   ⚠ 拿不到 `sid` 是**正常情况**(纯 CLI / cron / 桌面版换版本),此时静默退回 cwd 匹配。
  //     **绝不因为映射失败而改变判断** —— 否则等于把一个实现细节变成新的失效面。
  try {
    const f = path.join(STATE_DIR, 'writes.jsonl');
    if (!fs.existsSync(f)) return null;
    const lines = fs.readFileSync(f, 'utf8').trim().split('\n');
    // ── 第一遍:按 session_id 精确匹配。命中即定论,cwd 无关紧要(同一条 session 换目录也认得出)。
    if (sid) {
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const e = JSON.parse(lines[i]);
          if (e.sid && e.sid === sid) return e.board;
        } catch (_) {}
      }
    }
    // ── 第二遍(回退):按 cwd + 时间窗。⚠ **带着别人 sid 的那些行必须跳过** ——
    //    它们已经明确属于另一条 session,拿 cwd 去认领就是在复现刚修掉的那个 bug。
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.sid && sid && e.sid !== sid) continue;   // 别人的,明确跳过
        if (e.cwd !== cwd) continue;
        if (typeof e.ts !== 'number' || e.ts < since) return null;  // 早于本 session ⇒ 继承来的,不认
        return e.board;
      } catch (_) {}
    }
  } catch (_) {}
  return null;
}

// 声明的最后一个明确 sid 是当前板主;旧会话不能凭自己历史声明继续占板。
function transferred(board, sid, root) {
  const lines = fs.readFileSync(path.join(STATE_DIR, 'writes.jsonl'), 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]);
      if (e.board !== board || !e.sid || !e.cwd) continue;
      const common = execFileSync('git', ['-C', e.cwd, 'rev-parse', '--git-common-dir'],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const ownerRoot = path.dirname(fs.realpathSync(path.resolve(e.cwd, common)));
      if (ownerRoot === root) return e.sid !== sid;
    } catch (_) {}
  }
  return false;
}
function transcriptFacts(file, since) {
  if (!file) return null; // 无转录无法证明有新事实，静默。
  const fd = fs.openSync(file, 'r');
  let data;
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - 4 * 1024 * 1024);
    const buf = Buffer.alloc(size - start); fs.readSync(fd, buf, 0, buf.length, start);
    data = buf.toString('utf8').split('\n'); if (start) data.shift();
  } finally { fs.closeSync(fd); }
  const uses = new Map(); let changed = false, released = false;
  for (const l of data) {
    let d; try { d = JSON.parse(l); } catch (_) { continue; }
    const c = d.message && d.message.content;
    if (!Array.isArray(c)) continue;
    if (d.type === 'assistant') for (const x of c) {
      if (x.type === 'text') {
        // 只认本会话的明确板权移交，不将用户引文/工具结果当作声明。
        if (/(?:板|board|本会话|this session).{0,100}(?:已交给|已移交|已交|归.{0,30}维护|now belongs to|handed (?:over|off) to)/i.test(x.text)
          || /本会话.{0,30}不再.{0,20}(?:维护|写板)/.test(x.text)) released = true;
        if (Date.parse(d.timestamp) / 1000 > since
          && /(?:已上线|已合并|已部署|已上架|已修复|新增.{1,30}(?:进度|结果)|(?:上线|合并|部署|上架|修复).{0,12}(?:完成|成功))/.test(x.text)) changed = true;
      }
      if (x.type === 'tool_use') uses.set(x.id, x);
    }
    if (d.type === 'user' && Date.parse(d.timestamp) / 1000 > since) for (const x of c) {
      if (x.type !== 'tool_result' || x.is_error) continue;
      const u = uses.get(x.tool_use_id); if (!u) continue;
      const cmd = String((u.input || {}).command || '');
      if (/^(?:Write|Edit|MultiEdit)$/.test(u.name)
        || (u.name === 'Bash' && /\bgit\s+(?:commit|push|merge)\b|\bgh\s+pr\s+(?:create|merge)\b|\bdeploy\b/.test(cmd))) changed = true;
    }
  }
  return { changed, released };
}

function boardsIn(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.html') && f !== '_index.html' && !f.endsWith('.bak'))
    .map((f) => path.join(dir, f));
}

function run(hook) {
  const cwd = hook.cwd || process.cwd();
  const sid = hook.session_id || 'unknown';
  // ⚠ 两类消息**必须分开**,因为它们的紧迫度不同(2026-08-28 变异测试当场抓到):
  //   `stale`(板过期)⇒ `decision:block`,拦住收工,因为不拦就等于没提醒;
  //   `notes`(worktree 副本等)⇒ 只提示,**绝不拦人** —— 它是信息性的,
  //   而且与板新旧无关,拦了会在板明明刚更新过时把人堵在原地。
  //   ⭐ 第一版把两者都接进 block,反向变异用例(板才 5 分钟却被拦)当场变红。
  let stale = null;
  const notes = [];

  const common = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'],
    { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const root = path.dirname(fs.realpathSync(path.isAbsolute(common) ? common : path.join(cwd, common)));
  const canonDir = path.join(root, '.claude', 'boards');
  const boards = boardsIn(canonDir);
  if (boards.length === 0) return;                       // 这条线没有板 —— 允许,静默

  const now = Math.floor(Date.now() / 1000);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (_) {}
  const key = `${sid}::${root}`;
  const p = st[key] || { seen: {}, own: null, miss: 0, lastNag: 0, lastDupNag: 0 };
  // 本 session 的起点。首次见到这条 session 时钉住 —— 之后只认晚于它的板声明。
  // 留 GRACE:session 第一轮就跑 board.py 时,那次写入略早于第一次 Stop,不该被误杀。
  // 取 120s:交接换手远长于 2 分钟,所以它挡得住继承,又不误杀本 session 的首次写入。
  if (typeof p.since !== 'number') p.since = Math.floor(Date.now() / 1000) - 120;

  const mt = {};
  for (const b of boards) mt[path.basename(b)] = Math.floor(fs.statSync(b).mtimeMs / 1000);

  // ── 学:这一轮哪些板变新了 ──────────────────────────────────
  // ⚠⚠ v2 在这里又栽了一次(v1 的同一个病的第二层):原来写的是「谁变新谁就是 own」,
  //    于是**别的线一更新他们的板,就把 own 顶成了他们那块** ⇒ 我的板过期照样不报。
  //    实测:仓里 5 块板,只要另一条线在动,本条永远静默。
  //    ⇒ 规则改成:**own 一旦学到就不再改**;别人的板变不变与我无关。
  const touched = Object.entries(mt)
    .filter(([n, m]) => p.seen[n] !== undefined && m > p.seen[n])
    .map(([n]) => n);
  p.seen = mt;

  // ⭐ 主路径:读 board.py 写下的**声明**(按 cwd 匹配),不猜。
  //   ⚠⚠ 2026-08-27 实测(记忆助手线报回,我自己复核后发现比他们说的更糟):
  //   原来只靠下面那条「本轮恰好只有一块板变新」来猜 —— 而这台机同时有 6 块板在被各线维护,
  //   两次 Stop 之间多块板一起变新是**常态**,`touched.length === 1` 反而是少数。
  //   结果 **7 条 session 里 5 条 `own=null`**(含我自己那条,当天改了十几次板)⇒ 它们被**永久豁免**,
  //   而「豁免」和「这条线没有板」输出上一模一样 —— **正是这个 hook 自己要治的静默。**
  //   ⇒ cwd 是天然的 session 判别式(每条线一个 worktree),`board.py` 的 touch/sync/lint 都会登记。
  //   ⛔⛔ 2026-08-27 v3.9 删掉了原来的兜底分支 `else if (!p.own && touched.length === 1)`
  //   (「本轮恰好只有一块板变新就认作己有」)。它是**纯误报发生器**:
  //   实测 —— 一条 `writes.jsonl` 里**一条记录都没有**的 session,只因为总控线更新了
  //   总控的板,`own` 就被写成了 `示例项目-总控.html`。本机 4 条学到 own 的 session
  //   里至少 3 条错在这里。
  //   它原本的用意是「兜住没走 board.py 的线」—— 但那些线本来就不该被念
  //   (规则明写「外壳别再手写,跑 board.py」),而猜错的代价是打扰**别人**。
  //   ⇒ 没有声明 = 静默。这与本 hook 开头写死的原则一致:宁可漏报,不可误报。
  const declared = readDeclaredOwn(cwd, p.since, sid);
  if (declared && mt[declared] !== undefined && !require('./own-board').isRetiredBoard(declared)) {
    if (p.own !== declared) { p.own = declared; p.miss = 0; }
  }
  if (p.own && require('./own-board').isRetiredBoard(p.own)) { p.own = null; p.miss = 0; }   // 1113:学到的板退场了 ⇒ 忘掉,等下一次声明
  if (p.own) {
    const facts = transcriptFacts(hook.transcript_path, mt[p.own] || now);
    if (transferred(p.own, sid, root) || (facts && facts.released)) {
      p.own = null; p.miss = 0; st[key] = p;
      fs.writeFileSync(STATE, JSON.stringify(st)); return;
    }
    // 无法证明有未落板的新事实，只等原卡/后台，不靠 touch 制造“保鲜”。
    if (!facts || !facts.changed) {
      p.miss = 0; st[key] = p; fs.writeFileSync(STATE, JSON.stringify(st)); return;
    }
  }
  if (p.own && touched.includes(p.own)) { p.miss = 0; }
  if (p.own && !touched.includes(p.own) && mt[p.own] !== undefined) {
    p.miss += 1;
    const age = now - mt[p.own];
    const byTurns = p.miss >= MISS_TURNS && age > STALE_SECS;
    if (byTurns && (now - p.lastNag) > NAG_COOLDOWN) {
      stale = `⚠ 状态板 ${path.basename(p.own, '.html')} 已 ${Math.floor(age / 60)} 分钟没动，`
        + `而这是你第 ${p.miss} 轮回复。规则的顺序是「先落板 → 消息从板里摘」，现在是反的。`;
      p.lastNag = now;
    }
  }
  // p.own 还是 null(这条 session 从没写过板)⇒ 什么都不说

  // ── 独立的一条:worktree 副本(board.py 管不到「不经它直接写文件」这条路)──
  const wtRoot = path.join(root, '.claude', 'worktrees');
  if (fs.existsSync(wtRoot) && (now - p.lastDupNag) > NAG_COOLDOWN) {
    const ino = new Map(boards.map((b) => [path.basename(b), fs.statSync(b).ino]));
    const dups = [];
    for (const wt of fs.readdirSync(wtRoot)) {
      for (const f of boardsIn(path.join(wtRoot, wt, '.claude', 'boards'))) {
        const base = path.basename(f);
        if (!ino.has(base) || fs.statSync(f).ino !== ino.get(base)) dups.push(f); // 硬链接同 inode ⇒ 不算
      }
    }
    if (dups.length) {
      notes.push(`⚠ worktree 里有 ${dups.length} 份板副本，他打开的不是它们（如 `
        + `${path.relative(root, dups[0])}）。落点用 \`board.py path <线名>\`，别照 cwd 拼。`);
      p.lastDupNag = now;
    }
  }

  st[key] = p;
  fs.writeFileSync(STATE, JSON.stringify(st));
  // ⭐⭐ 2026-08-28 负责人拍板:提醒必须送给**能执行它的那一方**,也就是 AI —— 不是他。
  //
  //   记忆助手线发现、iOS v4.1 从引擎自带 hook 文档核实:
  //   原来这里写的是 `process.stderr.write(...)` + `exit(0)`,而 Stop hook 的 stderr
  //   **进的是负责人的终端,不进模型上下文**。可这段话通篇是对 AI 说的
  //   (「这是你第 N 轮回复,顺序反了」)⇒ **一句对 AI 说的话,投递给了人。**
  //
  //   三个后果,一个比一个重:
  //     ① 能改正行为的那一方从没收到过;
  //     ② 收到的那一方无法执行 —— 他看到「你第 3 轮回复了」也没法替 AI 落板;
  //     ③ 而他 0828 明说基本只看状态板、连消息都少看 ⇒ 终端恰恰是他最不看的通道。
  //   ⇒ 于是这条提醒事实上**谁都没收到**,而它每一轮都在正确地计数。
  //
  //   他原话:「提醒我是没用的,因为你提醒我,我最后也会发消息给你、发给 AI 去落地。
  //           所以最终还是会要发给 AI,只是相当于还换一手。」
  //
  //   引擎文档原文(`decision` 一节):「"block" for PostToolUse/**Stop**/UserPromptSubmit hooks」,
  //   而 `reason` 是「Explanation for decision」—— 这条是唯一能回到模型上下文的路。
  //   ⚠ 代价要认:`decision:"block"` 会**阻止这条 session 收工**,直到板被更新。
  //     这正是要的效果(逼的是 AI 不是人),但也因此触发条件必须保持保守 ——
  //     miss≥3 且板龄>20 分钟 且 15 分钟节流,三条全中才出声,别放宽。
  if (stale) {
    // 板过期 ⇒ 拦住收工,并把话送进模型上下文(唯一能执行它的那一方)
    hit(`speak sid=${String(sid).slice(0, 8)} board=${p.own} miss=${p.miss} age=${Math.floor((now - (mt[p.own] || now)) / 60)}m notes=${notes.length}`);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason: [stale, ...notes].join('\n')
        + '\n\n⛔ 先把板更新了再收工 —— 规则的顺序是「先落板 → 消息从板里摘」。'
        + '\n落点用 `python3 ~/.claude/scripts/board.py path <线名>`(别照 cwd 拼),'
        + '改完跑 `board.py touch`,并在 touch 之前 grep 一下你这轮新加的内容真的写进去了。',
    }));
  }
  // ⛔⛔ 这里**故意什么都不做**。原来写的是 `systemMessage`(= 显示给负责人),
  //   而 2026-08-28 他当场截图问我:「Stop says … 这个是给你看的还是给我看的?」
  //   那条 notes 的正文是「落点用 `board.py path <线名>`,别照 cwd 拼」——
  //   **一句给 AI 的操作指令,又一次投递给了人**,而他无法执行。
  //   ⭐ 最难看的是时机:我正是在同一轮里把「板过期」那条从 stderr 改成送给 AI 的,
  //     却把这条走了 systemMessage —— **同一个病,在修它的那一轮里又犯一次。**
  //   ⇒ notes 只在**确实要拦人**时随 reason 一起送进模型上下文(见上面的 block 分支);
  //     否则宁可不送。它是低紧迫度的信息,不值得花他一次注意力(D49)。
  //   ⚠ 别改回 systemMessage —— 除非那条消息的读者**真的是人**。
}
