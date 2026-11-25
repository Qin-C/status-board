'use strict';
/**
 * shell-commands.js —— 钩子共用的「把一整条 Bash 命令当成一段小 shell 走一遍」解析器。
 *
 * 由来(11-17):outbound-message-gate.js(发消息闸)里有一份完整求值器,merge-gate-nudge.js 里另写了一份轻量版
 *   (当时不许改发消息闸),ask-not-on-board.js 借用轻量版。同一类逻辑两份,两份不一致时同一条命令在不同钩子里会被认成不同的东西
 *   (仓里规矩:两处同逻辑立刻抽成共享模块)⇒ 合成这一份,三个钩子都 require 它。
 *
 * 谁在用:
 *   · outbound-message-gate.js —— evaluate(…, { values: true, onCommand }):要算出发出去的正文(cat / printf / sed / heredoc / 同命令写的文件)
 *   · merge-gate-nudge.js      —— shellCommands():只要「哪条命令、参数是什么」(gh pr merge 的 PR 号 / --repo)
 *   · ask-not-on-board.js      —— shellCommands():lark-cli im 的 --chat-id
 *
 * 两种用法(同一个词法 / 语法 / 展开 / 走命令的核心,只差「值算不算」):
 *   · values: true(求值):$(…) 的输出真的算出来(只模拟 cat / printf / echo / sed / head / tail / tee / cp / mv / cd,
 *     读得到同一条命令里先写后读的文件,也读磁盘上的文件);算不出的值是 Unk(带原因和读不出那段之前已读出的前缀)。
 *   · values: false(列命令,shellCommands):$(…) / 反引号里的命令照样走一遍、照样列出来,但它们的输出一律当读不出(null),
 *     不读磁盘、不模拟输出 —— 只认同一条命令里字面量赋的变量和 for 循环取值。
 *
 * 认得(两种用法都认):
 *   · 按 ; & | && || 换行 ( ) 切成简单命令;do / then / else / { } / ( ) / 函数体(f() { …; } 与 function f { …; })/ if / while 条件里的命令;
 *   · $(…)、反引号、没加引号的 heredoc 正文里的 $(…) / 反引号(这些会真的执行)、VAR=x cmd 里 x 的 $(…);
 *   · bash / sh / zsh -c "…"、bash / sh / zsh <<EOF … EOF 或 <<< "…"(正文交给 shell 执行)、eval 字面量;
 *   · 去掉开头的 VAR=值、env / command / exec / nohup / builtin / noglob / nice / stdbuf / sudo / caffeinate / timeout N / xargs 这类前缀;
 *   · 同一条命令里赋的变量(VAR=…、VAR+=…、export / local / declare)、for v in a b c(每个取值各走一遍)、~ 与 $HOME。
 * 不认(当成数据、不是命令):单 / 双引号里的字、加了引号或没加引号的 heredoc 正文本身(除上面说的 $(…) / 反引号)、# 注释。
 * 认不得(值记成读不出;命令本身照样列出,只是那个参数是 Unk / null):
 *   · 这条命令外面设的变量、函数 / 脚本参数($1 "$@")、read 读进来的、case 分支里赋的、${x%%…} 这类变量加工、$((…)) 算术;
 *   · 列命令用法下所有 $(…) / 反引号的输出;求值用法下闸模拟不了的命令(python / jq / awk …)的输出;
 *   · 不展开:通配符 *、花括号 {a,b}、别名、函数调用(f 被调用时不会再走一遍函数体 —— 函数体在定义处已走过一遍);
 *   · 不进去看:ssh 'cmd'、python -c、node -e、find -exec、bash 脚本文件(不读磁盘脚本)、`cat f | bash`(管道 / 文件喂给 shell)。
 * 认不出时调用方应该怎么办:
 *   · 拿到 Unk / null 的参数 ⇒ 按调用方自己的风险保守处理:拦的闸(发消息)当读不出拦并教改写法;只记不拦的提醒(合并、群登记)记 lookup-failed / 不认,别猜值。
 *   · 本模块抛异常(理论上不该,输入是任意字符串)⇒ 调用方自己 fail-open 或按读不出处理;本模块不吞异常,免得调用方以为「查过了」。
 *   · 本模块没列出某条命令,不等于它不会执行(见上面「不进去看」)⇒ 拦的闸要另有一道按原文兜底的检查(发消息闸的 isSend + 数据区遮罩)。
 *
 * 否过什么、为什么:
 *   · 否了两份各留各的、只把词法(lex)抽出来:展开 / 走命令那一层才是两份不一致的地方(for 循环怎么找 done、前缀认哪些、heredoc 里的 $(…) 走不走),
 *     只抽词法,两边照样会把同一条命令认成不同的东西。
 *   · 否了用 vm 读发消息闸源码取内部函数(11-17 merge-gate 那版否过):它一改名借用方就静默失效。
 *   · 否了列命令用法也模拟 cat / sed 的输出:合并 / 群登记只要命令和字面参数,模拟输出要读磁盘文件,换来的只是 `gh pr merge $(cat f)` 这种 7 天 0 次的写法。
 *   · 否了求值用法真去执行 $(…) / 子命令取值:钩子在命令执行前跑,替它执行会提前产生副作用(写文件、调接口,甚至提前发一次消息)。
 *   · 否了 # 注释按「前一个字符是空白」才认(merge-gate 那版的写法):bash 实测 `echo hi >#b` 是注释(语法错),按 bash 认。
 * 自测:node ~/.claude/hooks/shell-commands.selftest.js
 */
const fs = require('fs'), os = require('os'), path = require('path');
const HOME = os.homedir();

// 依据:合并前两份同款(命令替换 / bash -c 嵌套 > 8 层当读不出);11-17 七天 4.4 万条真实命令回放无一触到
const MAX_DEPTH = 8;
// 依据:合并前两份同款(for 取值 > 50 个当读不出,只走一遍);11-17 七天回放里循环最多 5 个值
const MAX_FOR_VALUES = 50;

class Unk { constructor(why, prefix) { this.why = why; this.prefix = prefix || ''; } }   // prefix = 读不出那段之前已经读出的部分
const isU = (x) => x instanceof Unk;
const withPre = (u, pre) => new Unk(u.why, pre + u.prefix);
const joinU = (parts) => { const k = parts.findIndex(isU); return k < 0 ? parts.join('') : withPre(parts[k], parts.slice(0, k).join('')); };
const firstU = (...xs) => xs.find(isU);

// ── 扫描:从 s[i] 开始的引号 / 替换,返回收尾之后的位置 ──
function scanSingle(s, i) { const j = s.indexOf("'", i + 1); return j < 0 ? s.length : j + 1; }
function scanAnsi(s, i) { let j = i + 2; while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1; return Math.min(j + 1, s.length); }   // s[i..] = $'
function scanBacktick(s, i) { let j = i + 1; while (j < s.length && s[j] !== '`') j += s[j] === '\\' ? 2 : 1; return Math.min(j + 1, s.length); }
function scanDouble(s, i) {
  let j = i + 1;
  while (j < s.length && s[j] !== '"') {
    if (s[j] === '\\') j += 2;
    else if (s[j] === '$' && s[j + 1] === '(') j = scanParen(s, j + 1);
    else if (s[j] === '$' && s[j + 1] === '{') j = scanBrace(s, j + 1);
    else if (s[j] === '`') j = scanBacktick(s, j);
    else j++;
  }
  return Math.min(j + 1, s.length);
}
function scanBrace(s, i) { let d = 0, j = i; for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}' && --d === 0) return j + 1; } return s.length; }
function scanParen(s, i) {   // s[i] === '(';认引号、嵌套
  let d = 0, j = i;
  while (j < s.length) {
    const c = s[j];
    if (c === "'") { j = scanSingle(s, j); continue; }
    if (c === '"') { j = scanDouble(s, j); continue; }
    if (c === '`') { j = scanBacktick(s, j); continue; }
    if (c === '\\') { j += 2; continue; }
    if (c === '(') d++;
    else if (c === ')' && --d === 0) return j + 1;
    j++;
  }
  return s.length;
}

// ── 词法:→ [{w, s, e} | {op} | {op:'<<', hd} | {op:'<<<'} | {op:'<'} | {op:'>', fd, amp, append}];s / e 是词在原文里的位置(给调用方做遮罩用) ──
function unquoteDelim(raw) { return raw.replace(/\\(.)/g, '$1').replace(/['"]/g, ''); }
function lex(src) {
  const toks = [], pend = []; let i = 0; const n = src.length;
  const readWord = () => {
    const st = i;
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\n' || ';&|<>()'.includes(c)) break;
      if (c === "'") i = scanSingle(src, i);
      else if (c === '"') i = scanDouble(src, i);
      else if (c === '`') i = scanBacktick(src, i);
      else if (c === '\\') i += 2;
      else if (c === '$' && src[i + 1] === "'") i = scanAnsi(src, i);
      else if (c === '$' && src[i + 1] === '(') i = scanParen(src, i + 1);
      else if (c === '$' && src[i + 1] === '{') i = scanBrace(src, i + 1);
      else i++;
    }
    return src.slice(st, Math.min(i, n));
  };
  const skipBlank = () => { while (i < n && (src[i] === ' ' || src[i] === '\t')) i++; };
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }   // 只在词首走到这里:词中间的 # 被 readWord 吃掉了
    if (c === '\n') {
      toks.push({ op: '\n' }); i++;
      for (const hd of pend) {   // 换行之后依次读 heredoc 正文(正文是数据,不是命令)
        let body = ''; hd.bs = i;
        for (;;) {
          if (i >= n) break;
          let e = src.indexOf('\n', i); if (e < 0) e = n;
          const line = src.slice(i, e);
          if ((hd.strip ? line.replace(/^\t+/, '') : line) === hd.delim) { hd.done = true; hd.be = i; i = Math.min(e + 1, n); break; }
          i = Math.min(e + 1, n);
          body += line + '\n';
        }
        if (hd.be == null) hd.be = i;
        hd.body = body;
      }
      pend.length = 0; continue;
    }
    const m = /^(?:&&|\|\||;;|\|&|<<<|<<-|<<|&>>|&>|[0-9]*>>|[0-9]*>&[0-9-]?|[0-9]*>\|?|<&[0-9-]?|[0-9]*<|[;&|()])/.exec(src.slice(i, i + 5));
    if (m && !(/^[0-9]/.test(m[0]) && i > 0 && !/[\s;&|()]/.test(src[i - 1]))) {
      const op = m[0]; i += op.length;
      if (op === '<<' || op === '<<-') { skipBlank(); const raw = readWord(); const hd = { delim: unquoteDelim(raw), quoted: /['"\\]/.test(raw), strip: op === '<<-', body: null }; pend.push(hd); toks.push({ op: '<<', hd }); continue; }
      if (op === '<<<') { toks.push({ op: '<<<' }); continue; }
      if (/>&[0-9-]?$|^<&/.test(op)) continue;                       // 2>&1 之类:不影响正文
      if (/>/.test(op)) { toks.push({ op: '>', fd: (op.match(/^[0-9]+/) || ['1'])[0], amp: op.startsWith('&'), append: op.includes('>>') }); continue; }
      if (/</.test(op)) { toks.push({ op: '<' }); continue; }
      toks.push({ op }); continue;
    }
    const s0 = i, w = readWord();
    if (w) toks.push({ w, s: s0, e: i }); else toks.push({ w: src[i++], s: s0, e: i });
  }
  for (const hd of pend) hd.body = null;   // heredoc 起了头没有正文(命令末尾)
  return toks;
}
// ── 语法:→ 简单命令序列 [{words, wr, redirs, pipeIn}];wr[k] = words[k] 在原文里的 [起, 止);重定向的目标不算参数 ──
function parse(src) {
  const cmds = []; let cur = { words: [], wr: [], redirs: [], pipeIn: false }, want = null;
  const flush = (pipe) => { const had = cur.words.length > 0 || cur.redirs.length > 0; if (had) cmds.push(cur); cur = { words: [], wr: [], redirs: [], pipeIn: !!pipe && had }; };
  for (const t of lex(String(src))) {
    if (t.w != null) { if (want) { want.target = t.w; want.ts = t.s; want.te = t.e; cur.redirs.push(want); want = null; } else { cur.words.push(t.w); cur.wr.push([t.s, t.e]); } continue; }
    if (t.op === '<<') { cur.redirs.push({ op: '<<', hd: t.hd }); continue; }
    if (t.op === '<<<' || t.op === '<' || t.op === '>') { want = { ...t }; continue; }
    want = null; flush(t.op === '|' || t.op === '|&');
  }
  flush(false);
  return cmds;
}

const KW = new Set(['then', 'do', 'else', 'elif', 'if', 'while', 'until', '{', '!', 'time']);
const ENDKW = new Set(['fi', 'done', 'esac', '}']);
const LOOPS = new Set(['for', 'while', 'until', 'select']);
const PREFIX = new Set(['env', 'command', 'exec', 'nohup', 'builtin', 'noglob', 'nice', 'stdbuf', 'sudo', 'caffeinate']);
const SHELLS = new Set(['bash', 'sh', 'zsh']);
const ASSIGN = /^[A-Za-z_]\w*\+?=/;
function stripKw(w) { let k = 0; while (k < w.length && KW.has(w[k])) k++; return w.slice(k); }
// 找循环开头 / 结尾用:只去掉 do / then / else / { / ! 这类连接词,留下 while / until / for(它们本身就是循环开头)
function loopHead(w) { let k = 0; while (k < w.length && ['then', 'do', 'else', 'elif', '{', '!', 'time'].includes(w[k])) k++; return w[k]; }

function decodeEsc(s, octal) {
  return s.replace(/\\(?:([nrtabfv\\'"e])|0?([0-7]{1,3})|x([0-9a-fA-F]{1,2}))/g, (all, c, o, x) => {
    if (c) return { n: '\n', r: '\r', t: '\t', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', "'": "'", '"': '"', e: '\x1b' }[c];
    if (o != null) return octal ? String.fromCharCode(parseInt(o, 8)) : all;
    return String.fromCharCode(parseInt(x, 16));
  });
}

// ── 展开 ──
function child(st) { const d = (st.depth || 0) + 1; return d > MAX_DEPTH ? null : { ...st, env: { ...st.env }, depth: d }; }
function lookup(name, st) {
  if (Object.prototype.hasOwnProperty.call(st.env, name)) return st.env[name];
  if (name === 'HOME') return HOME;
  return new Unk(`变量 $${name} 不是在这条命令里赋的值`);
}
function subst(inner, st) {   // $(…):子 shell 里跑,里面的命令照样列出 / 发送照样收;求值用法下输出去掉末尾换行
  const ch = child(st); if (!ch) return new Unk('命令替换嵌套太深');
  if (!st.values) { run(parse(inner), ch, false); return new Unk('用了 $(…) 命令替换'); }
  const out = run(parse(inner), ch, true);
  return isU(out) ? out : out.replace(/\n+$/, '');
}
function backtick(inner, st, why) {   // 反引号:里面的命令照样走一遍,输出一律当读不出
  const ch = child(st); if (ch) run(parse(inner), ch, false);
  return new Unk(why || '用了反引号命令替换');
}
function dollar(s, i, st, inDq) {   // s[i] === '$' → { v: 字符串 | Unk, end };inDq = 在双引号里($'…' 在双引号里不是 ANSI 引号,$ 就是字面 $)
  const c = s[i + 1];
  if (c === "'" && inDq) return { v: '$', end: i + 1 };
  if (c === "'") { const e = scanAnsi(s, i); return { v: decodeEsc(s.slice(i + 2, e - 1), true), end: e }; }
  if (c === '(') {
    const e = scanParen(s, i + 1);
    if (s[i + 2] === '(') return { v: new Unk('用了 $((…)) 算术'), end: e };
    return { v: subst(s.slice(i + 2, e - 1), st), end: e };
  }
  if (c === '{') {
    const e = scanBrace(s, i + 1), name = s.slice(i + 2, e - 1);
    return { v: /^[A-Za-z_]\w*$/.test(name) ? lookup(name, st) : new Unk(`用了 \${${name.slice(0, 20)}} 这类变量加工`), end: e };
  }
  const m = /^[A-Za-z_]\w*/.exec(s.slice(i + 1));
  if (m) return { v: lookup(m[0], st), end: i + 1 + m[0].length };
  if (c && /[0-9@*#?$!-]/.test(c)) return { v: new Unk(`用了 $${c}(函数 / 脚本参数)`), end: i + 2 };
  return { v: '$', end: i + 1 };
}
// 一个词 → 字符串 | Unk。读不出的那段之后照样往下扫:后面的 $(…) / 反引号里的命令还是会执行,要走到、列出来。
function expand(raw, st) {
  let out = '', bad = null, i = 0; const n = raw.length;
  const put = (v) => { if (bad) return; if (isU(v)) bad = withPre(v, out); else out += v; };
  if (raw[0] === '~' && (n === 1 || raw[1] === '/')) { out = HOME; i = 1; }
  const eq = /^[A-Za-z_]\w*=~\//.exec(raw); if (eq) { out = raw.slice(0, eq[0].length - 2) + HOME; i = eq[0].length - 1; }
  while (i < n) {
    const c = raw[i];
    if (c === "'") { const e = scanSingle(raw, i); put(raw.slice(i + 1, e - 1)); i = e; continue; }
    if (c === '"') {
      const e = scanDouble(raw, i); let j = i + 1;
      while (j < e - 1) {
        const d = raw[j];
        if (d === '\\') { const x = raw[j + 1]; put('$`"\\'.includes(x) ? x : x === '\n' ? '' : '\\' + x); j += 2; continue; }
        if (d === '$') { const r = dollar(raw, j, st, true); put(r.v); j = r.end; continue; }
        if (d === '`') { const e2 = scanBacktick(raw, j); put(backtick(raw.slice(j + 1, e2 - 1), st)); j = e2; continue; }
        put(d); j++;
      }
      i = e; continue;
    }
    if (c === '\\') { put(raw[i + 1] ?? ''); i += 2; continue; }
    if (c === '$') { const r = dollar(raw, i, st); put(r.v); i = r.end; continue; }
    if (c === '`') { const e = scanBacktick(raw, i); put(backtick(raw.slice(i + 1, e - 1), st)); i = e; continue; }
    put(c); i++;
  }
  return bad || out;
}
function expandHeredoc(body, st) {   // 没加引号的 heredoc:展开 $VAR / $(…) / \$;里面的 $(…) / 反引号会真的执行
  let out = '', bad = null, i = 0;
  const put = (v) => { if (bad) return; if (isU(v)) bad = withPre(v, out); else out += v; };
  while (i < body.length) {
    const c = body[i];
    if (c === '\\' && '$`\\\n'.includes(body[i + 1])) { put(body[i + 1] === '\n' ? '' : body[i + 1]); i += 2; continue; }
    if (c === '$') { const r = dollar(body, i, st, true); put(r.v); i = r.end; continue; }   // heredoc 里同双引号:$'…' 不是 ANSI 引号
    if (c === '`') { const e = scanBacktick(body, i); put(backtick(body.slice(i + 1, e - 1), st, 'heredoc 里用了反引号')); i = e; continue; }
    put(c); i++;
  }
  return bad || out;
}

// ── 文件(只在求值用法下):同一条命令里先写后读的文件记在 st.vfs,其余读磁盘 ──
function resolveP(p, st) {
  if (isU(p)) return p;
  if (!path.isAbsolute(p) && isU(st.cwd)) return new Unk(`相对路径 ${p} 前面 cd 到了读不出的目录`);
  return path.resolve(isU(st.cwd) ? '/' : st.cwd, p);
}
function readF(p, st) {
  const a = resolveP(p, st); if (isU(a)) return a;
  if (st.vfs.has(a)) return st.vfs.get(a);
  try { return fs.readFileSync(a, 'utf8'); } catch (_) { return new Unk(`读不到文件 ${path.basename(a)}`); }
}
function writeF(p, v, st, append) {
  const a = resolveP(p, st); if (isU(a) || a === '/dev/null') return;
  if (append) { const prev = readF(a, st); v = firstU(prev, v) || (isU(prev) ? prev : prev + v); }
  st.vfs.set(a, v);
}

// ── 求值用法下模拟的几个命令 ──
function printfEmu(fmt, args) {
  if (isU(fmt)) return fmt; const bad = firstU(...args); if (bad) return bad;
  let out = '', k = 0, guard = 0;
  do {
    let unsupported = null;
    out += fmt.replace(/%([-+ #0]*\d*(?:\.\d+)?)([sbdiq%])|\\(?:[nrtabfv\\"']|0?[0-7]{1,3})/g, (all, fl, cv) => {
      if (!cv) return decodeEsc(all, true);
      if (cv === '%') return '%';
      const a = args[k++] ?? '';
      if (cv === 's') return a;
      if (cv === 'b') return decodeEsc(a, true);
      if (cv === 'd' || cv === 'i') return String(parseInt(a, 10) || 0);
      unsupported = cv; return '';
    });
    if (unsupported) return new Unk(`printf 用了 %${unsupported}`);
    if (++guard > 100) break;   // 依据:合并前同款防死循环;printf 格式按参数重复超过 100 轮的真实命令没见过
  } while (k < args.length && /%[-+ #0]*\d*(?:\.\d+)?[sbdi]/.test(fmt));
  return out;
}
function breToJs(re, ere) {
  if (ere) return re;
  return re.replace(/\\([(){}+?|])|([(){}+?|])/g, (a, esc, lit) => esc || '\\' + lit);
}
function sedEmu(scripts, ere, quiet, input) {
  if (isU(input)) return input;
  const lines = input.split('\n'); const trail = input.endsWith('\n'); if (trail) lines.pop();
  const cmds = [];
  for (const sc of scripts) {
    for (const part of sc.split(/\n|;(?=\s*(?:[0-9]|\/|s.|\$))/)) {
      const p = part.trim(); if (!p) continue;
      let m = /^s(.)(.*?)(?<!\\)\1(.*?)(?<!\\)\1([gip0-9]*)$/.exec(p);
      if (m) {
        let rx; try { rx = new RegExp(breToJs(m[2], ere), (m[4].includes('g') ? 'g' : '') + (m[4].includes('i') ? 'i' : '')); } catch (_) { return new Unk('sed 正则闸认不了'); }
        const rep = m[3].replace(/\$/g, '$$$$').replace(/\\([1-9])/g, '$$$1').replace(/(^|[^\\])&/g, '$1$$&').replace(/\\n/g, '\n').replace(/\\(.)/g, '$1');
        cmds.push({ t: 's', rx, rep, p: m[4].includes('p') }); continue;
      }
      const addr = /^(\d+|\$|\/(?:[^/\\]|\\.)*\/)?(?:,(\d+|\$|\/(?:[^/\\]|\\.)*\/))?\s*([pd])$/.exec(p);
      if (addr) {
        const mk = (a) => a == null ? null : a === '$' ? { last: true } : /^\d+$/.test(a) ? { n: +a } : { rx: new RegExp(breToJs(a.slice(1, -1).replace(/\\\//g, '/'), ere)) };
        try { cmds.push({ t: addr[3], a1: mk(addr[1]), a2: mk(addr[2]), on: false }); } catch (_) { return new Unk('sed 正则闸认不了'); }
        continue;
      }
      const ins = /^(\d+)([ia])\\?\s?(.*)$/.exec(p);
      if (ins) { cmds.push({ t: ins[2], n: +ins[1], text: ins[3] }); continue; }
      return new Unk('sed 脚本闸认不了');
    }
  }
  const hit = (a, line, ln, last) => a.last ? last : a.n != null ? ln === a.n : a.rx.test(line);
  const out = [];
  lines.forEach((line0, idx) => {
    let line = line0, del = false; const ln = idx + 1, last = idx === lines.length - 1;
    for (const c of cmds) {
      if (c.t === 's') { const nl = line.replace(c.rx, c.rep); if (c.p && nl !== line) out.push(nl); line = nl; continue; }
      if (c.t === 'i' && ln === c.n) { out.push(c.text); continue; }
      if (c.t === 'a' && ln === c.n) { c.pendA = c.text; continue; }
      let sel;
      if (!c.a1) sel = true;
      else if (!c.a2) sel = hit(c.a1, line, ln, last);
      else if (c.on) { sel = true; if (c.a2.n != null ? ln >= c.a2.n : hit(c.a2, line, ln, last)) c.on = false; }
      else if (hit(c.a1, line, ln, last)) { sel = true; c.on = !(c.a2.n != null && c.a2.n <= ln); }
      else sel = false;
      if (sel && c.t === 'p') out.push(line);
      if (sel && c.t === 'd') { del = true; break; }
    }
    if (!quiet && !del) out.push(line);
    for (const c of cmds) if (c.pendA != null) { out.push(c.pendA); c.pendA = null; }
  });
  return out.length ? out.join('\n') + '\n' : '';
}
function builtin(name, args, st, stdin, out) {   // 求值用法:模拟得了的命令 → 标准输出;模拟不了 ⇒ 原样返回 out(Unk)
  if (name === 'cat') {
    const fl = args.filter((a) => !isU(a) && /^-./.test(a));
    if (fl.length) return new Unk('cat 带了参数');
    const fs_ = args.filter((a) => isU(a) || !/^-./.test(a)); const parts = fs_.length ? fs_.map((f) => f === '-' ? stdin : readF(f, st)) : [stdin]; return joinU(parts);
  }
  if (name === 'printf') {
    if (args[0] === '-v' && !isU(args[1])) { st.env[args[1]] = printfEmu(args[2], args.slice(3)); return ''; }
    return printfEmu(args[0] ?? '', args.slice(1));
  }
  if (name === 'echo') {
    let a = args.slice(), nl = true, esc = false;
    while (a.length && !isU(a[0]) && /^-[neE]+$/.test(a[0])) { if (a[0].includes('n')) nl = false; if (a[0].includes('e')) esc = true; a.shift(); }
    const bad = firstU(...a); return bad || (esc ? decodeEsc(a.join(' '), true) : a.join(' ')) + (nl ? '\n' : '');
  }
  if (name === 'tee') { const fsx = args.filter((x) => isU(x) || !/^-/.test(x)), ap = args.includes('-a'); for (const f of fsx) writeF(f, stdin, st, ap); return stdin; }
  if (name === 'sed' || name === 'gsed') {
    let quiet = false, inplace = false, ere = false; const scripts = [], files = []; let k = 0;
    while (k < args.length) {
      const a = args[k];
      if (isU(a)) { files.push(a); k++; continue; }
      if (a === '-n') quiet = true; else if (a === '-E' || a === '-r') ere = true;
      else if (a === '-i' || a === '--in-place') { inplace = true; if (args[k + 1] === '') k++; }
      else if (/^-i./.test(a)) inplace = true;
      else if (a === '-e') { scripts.push(args[++k]); }
      else if (/^-[nEr]+$/.test(a)) { if (a.includes('n')) quiet = true; if (/[Er]/.test(a)) ere = true; }
      else if (!scripts.length && !a.startsWith('-')) scripts.push(a);
      else files.push(a);
      k++;
    }
    const badS = firstU(...scripts);
    if (inplace) { for (const f of files) writeF(f, badS || sedEmu(scripts, ere, quiet, readF(f, st)), st, false); return ''; }
    const ins = files.length ? files.map((f) => readF(f, st)) : [stdin]; const inp = firstU(...ins) || ins.join(''); return badS || sedEmu(scripts, ere, quiet, inp);
  }
  if (name === 'head' || name === 'tail') {
    let cnt = 10; const files = []; let k = 0, bad = null;
    while (k < args.length) { const a = args[k]; if (isU(a)) { bad = a; break; } if (a === '-n') cnt = parseInt(args[++k], 10); else if (/^-n?\d+$/.test(a)) cnt = parseInt(a.replace(/^-n?/, ''), 10); else if (/^-/.test(a)) { bad = new Unk(`${name} 带了参数 ${a}`); break; } else files.push(a); k++; }
    const inp = bad || (files.length ? readF(files[0], st) : stdin);
    if (isU(inp) || isNaN(cnt)) return isU(inp) ? inp : new Unk(`${name} 参数闸认不了`);
    const ls = inp.split('\n'); const tr = inp.endsWith('\n'); if (tr) ls.pop(); const pick = name === 'head' ? ls.slice(0, cnt) : ls.slice(Math.max(0, ls.length - cnt)); return pick.length ? pick.join('\n') + '\n' : '';
  }
  if (name === 'cp' || name === 'mv') { const fa = args.filter((x) => isU(x) || !/^-/.test(x)); if (fa.length === 2) { writeF(fa[1], readF(fa[0], st), st, false); if (name === 'mv') writeF(fa[0], new Unk('文件已被 mv 走'), st, false); } return ''; }
  if (['true', ':', 'set', 'shift', 'return', 'exit', 'test', '[', '[['].includes(name)) return '';
  return out;
}

// ── 走命令 ──
function doAssign(list, st) {
  for (const a of list) {
    const k = a.indexOf('='), name = a.slice(0, k).replace(/\+$/, ''), v = expand(a.slice(k + 1), st);
    st.env[name] = a[k - 1] === '+' && !isU(v) ? (isU(st.env[name]) ? st.env[name] : (st.env[name] || '') + v) : v;
  }
}
function redirVals(c, st) {   // 先展开 heredoc 正文(没加引号的,里面的 $(…) 会执行)、再展开各重定向目标 → Map(重定向 → 值)
  const v = new Map();
  for (const r of c.redirs) if (r.op === '<<') v.set(r, r.hd.body == null ? new Unk('heredoc 没有收尾') : r.hd.quoted ? r.hd.body : expandHeredoc(r.hd.body, st));
  for (const r of c.redirs) if (r.op !== '<<') v.set(r, expand(r.target, st));
  return v;
}
function stdinOf(c, st, stdin, rv) {   // 这条命令的标准输入(heredoc / <<< / < 文件 / 管道)
  for (const r of c.redirs) {
    const x = rv.get(r);
    if (r.op === '<<') stdin = x;
    else if (r.op === '<<<') stdin = isU(x) ? x : x + '\n';
    else if (r.op === '<') stdin = st.values ? readF(x, st) : new Unk('列命令用法不读文件');
  }
  return stdin === undefined ? new Unk('标准输入不是 heredoc / 文件 / 管道里能读出的内容') : stdin;
}
function applyRedirs(c, st, out, rv) {
  for (const r of c.redirs) if (r.op === '>' && (r.fd === '1' || r.amp)) { if (st.values) writeF(rv.get(r), out, st, r.append); out = ''; }
  return out;
}
function runScript(src, st, onBad) {   // 交给 shell 执行的正文(bash -c / bash <<EOF / eval):读得出 ⇒ 当子 shell 走一遍;读不出 ⇒ 告诉调用方
  if (isU(src)) { if (onBad && st.on.script) st.on.script(src); return; }
  const ch = child(st); if (ch) run(parse(src), ch, false);
}
function evalCmd(c, st, stdin) {   // 一条简单命令 → 标准输出(字符串 | Unk)
  const rv = redirVals(c, st);   // 先于命令本身展开(重定向目标里的 $(…) 先走,列出的先后与合并前列命令那份一致)
  let w = c.words;
  if (w[0] === 'function') w = w.slice(2);
  const all = w;
  { let k = 0; while (k < w.length && (KW.has(w[k]) || ENDKW.has(w[k]))) k++; w = w.slice(k); }
  if (!w.length && all.some((x) => ENDKW.has(x))) return '';   // } / fi / done / esac 收尾
  const assigns = [];
  while (w.length && ASSIGN.test(w[0])) { assigns.push(w[0]); w = w.slice(1); }
  for (;;) {   // 前缀命令:env / command / sudo / timeout 5 / xargs -I{} …
    if (PREFIX.has(w[0])) { w = w.slice(1); while (w.length && (/^-/.test(w[0]) || /^[A-Za-z_]\w*=/.test(w[0]))) w = w.slice(1); continue; }
    if (w[0] === 'timeout' || w[0] === 'gtimeout') { w = w.slice(1); while (w.length && /^-/.test(w[0])) w = w.slice(/^-[ks]$/.test(w[0]) ? 2 : 1); w = w.slice(1); continue; }
    if (w[0] === 'xargs') { w = w.slice(1); while (w.length && /^-/.test(w[0])) w = w.slice(/^-[IinPLsdE]$/.test(w[0]) ? 2 : 1); continue; }
    break;
  }
  if (!w.length) { doAssign(assigns, st); return applyRedirs(c, st, '', rv); }   // 只有赋值(和重定向)
  for (const a of assigns) expand(a.slice(a.indexOf('=') + 1), st);   // VAR=x cmd:只对这条命令生效,但 x 里的 $(…) 照样会跑
  const ew = w.map((r) => expand(r, st));
  stdin = stdinOf(c, st, stdin, rv);
  const name = isU(ew[0]) ? '' : path.basename(ew[0]);
  const args = ew.slice(1);
  let out = new Unk(`${name || '命令'} 的输出闸算不出来`), record = true;
  if (['export', 'local', 'declare', 'typeset', 'readonly'].includes(name)) { doAssign(w.slice(1).filter((x) => ASSIGN.test(x)), st); out = ''; record = false; }
  else if (name === 'unset') { for (const a of args) if (!isU(a)) delete st.env[a]; out = ''; record = false; }
  else if (name === 'read') { for (const a of args) if (!isU(a) && /^[A-Za-z_]\w*$/.test(a)) st.env[a] = new Unk(`变量 $${a} 是 read 读进来的`); out = ''; }
  else if (name === 'cd') { const d = args[0] == null ? HOME : args[0]; st.cwd = isU(d) ? d : path.resolve(isU(st.cwd) ? '/' : st.cwd, d); out = ''; }
  else if (SHELLS.has(name) && args[0] === '-c') { if (args[1] !== undefined) runScript(args[1], st, true); }
  else if (SHELLS.has(name) && !args.length && c.redirs.some((r) => r.op === '<<' || r.op === '<<<')) runScript(stdin, st, true);
  else if (name === 'eval') { if (args.length && !args.some(isU)) runScript(args.join(' '), st, false); }
  else if (st.values) out = builtin(name, args, st, stdin, out);
  if (record && st.on.command) st.on.command({ name, words: w, argv: ew, stdin, st });
  return applyRedirs(c, st, out, rv);
}
function run(cmds, st, capture) {   // 依次执行;capture ⇒ 返回整段的标准输出
  const outs = [];
  for (let k = 0; k < cmds.length; k++) {
    const c = cmds[k], w = stripKw(c.words);
    if (w[0] === 'for' && /^[A-Za-z_]\w*$/.test(w[1] || '')) {   // for v in a b c; do …; done:循环体按每个取值各走一遍
      let e = k + 1, d = 0;
      for (; e < cmds.length; e++) { const f = loopHead(cmds[e].words); if (LOOPS.has(f)) d++; else if (f === 'done') { if (d === 0) break; d--; } }
      const inI = w.indexOf('in');
      let vals = inI > 0 ? w.slice(inI + 1).map((x) => expand(x, st)) : [new Unk('for 循环的取值读不出')];
      if (!vals.length || vals.some(isU) || vals.length > MAX_FOR_VALUES) vals = [vals.find(isU) || new Unk('for 循环的取值读不出')];
      const body = cmds.slice(k + 1, e);
      for (const v of vals) { st.env[w[1]] = v; run(body, st, false); }
      k = e; continue;
    }
    if (w[0] === 'case') {   // case:各分支照样走一遍(里面的命令要列出来),走完把分支里赋过的变量都记成读不出(不知道走的哪一支)
      let e = k; for (; e < cmds.length; e++) if (cmds[e].words.includes('esac')) break;
      evalCmd(c, st, undefined);
      run(cmds.slice(k + 1, e + 1), st, false);
      for (let j = k + 1; j <= e && j < cmds.length; j++) for (const x of cmds[j].words) { const m = /^([A-Za-z_]\w*)\+?=/.exec(x); if (m) st.env[m[1]] = new Unk(`变量 $${m[1]} 在 case 分支里赋值`); }
      k = e; continue;
    }
    let stdin;
    if (c.pipeIn && k > 0) stdin = outs.pop();
    outs.push(evalCmd(c, st, stdin));
  }
  if (!capture) return '';
  return joinU(outs);
}

// 求值:opts = { cwd, vfs, values(默认 true), onCommand({ name, words, argv, stdin, st }), onUnreadableScript(unk) } → 走完的状态 st
function evaluate(src, opts) {
  const o = opts || {};
  const st = { env: {}, cwd: o.cwd || HOME, vfs: o.vfs || new Map(), depth: 0, values: o.values !== false,
    on: { command: o.onCommand || null, script: o.onUnreadableScript || null } };
  run(parse(String(src == null ? '' : src)), st, false);
  return st;
}
// 列命令:整条 Bash 命令 → 每一条会执行的简单命令 [{ argv: (字符串 | null)[], words: 原文词 }](前缀已去掉;读不出的参数是 null)
function shellCommands(src) {
  const out = [];
  evaluate(src, { values: false, onCommand: (x) => out.push({ argv: x.argv.map((v) => (isU(v) ? null : v)), words: x.words }) });
  return out;
}

module.exports = { shellCommands, evaluate, parse, lex, expand, readF, Unk, isU, joinU, withPre, stripKw, KW, ENDKW, MAX_DEPTH, MAX_FOR_VALUES };
