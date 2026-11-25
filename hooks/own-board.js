'use strict';
// 找本会话自己的板 + 跑 board.py recheck(要核的行)。post-compact-checkpoint.js 与 daily-recheck.js 共用。
// 找板与 board-answers-inject.js 同一套:stop hook 学出来的 own → touch 写记录;找不到返回 ''。
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const BOARD_PY = path.join(os.homedir(), '.claude', 'scripts', 'board.py');

// ⭐ 1113(客户项目甲-总控报):`board.py retire` 把板挪进 _retired/,8777 上原地留一页「已退场 → 去向」;state.json 里学到的 own 不会自己变。
//   ⇒ 认板时跳过退场的板:8777 上那份是去向页(<title>…(已退场)</title>,board.py _retired_page 写的)⇒ 是退场的。读不到 ⇒ 当没退场(不误杀)。
//   board-pane-check / board-answers-inject / ask-not-on-board / board-freshness-check 都从这里取同一个判断。
const WEB_DIR = process.env.OWN_BOARD_WEB_DIR || path.join(os.homedir(), '.claude', 'boards-web');
function isRetiredBoard(name) {
  if (!name) return false;
  try {
    const fd = fs.openSync(path.join(WEB_DIR, path.basename(String(name))), 'r');
    try { const b = Buffer.alloc(400); const n = fs.readSync(fd, b, 0, 400, 0); return /\(已退场\)<\/title>/.test(b.slice(0, n).toString('utf8')); }
    finally { fs.closeSync(fd); }
  } catch (_) { return false; }
}

function ownBoard(sid, cwd) {
  if (!sid) return '';
  const q = process.env.OWN_BOARD_STATE_DIR || path.join(os.homedir(), '.status-board', 'board-stop-hook');
  let own = null;
  try { const st = JSON.parse(fs.readFileSync(path.join(q, 'state.json'), 'utf8')); for (const k of Object.keys(st)) if (k.startsWith(sid + '::') && st[k].own && !isRetiredBoard(st[k].own)) own = st[k].own; } catch {}
  if (!own) {
    try { const ls = fs.readFileSync(path.join(q, 'writes.jsonl'), 'utf8').trim().split('\n'); for (let i = ls.length - 1; i >= 0 && !own; i--) { try { const e = JSON.parse(ls[i]); if (e.sid === sid && e.board && !isRetiredBoard(e.board)) own = e.board; } catch {} } } catch {}
  }
  if (!own) return '';
  let file = path.isAbsolute(own) ? own : '';
  if (!file) {   // 只记了文件名 ⇒ 按会话目录问 board.py 规范落点(示例业务板在仓里,不在 ~/.claude/boards)
    try { file = cp.execFileSync('python3', [BOARD_PY, 'path', path.basename(own).replace(/\.html$/, '')], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n').pop(); } catch {}
  }
  if (!file || !fs.existsSync(file)) file = path.join(os.homedir(), '.claude', 'boards', path.basename(own));
  return fs.existsSync(file) ? file : '';
}

// 状态板线 a548b58(负责人 11-04 19:57 方案页 dc6e06a「照这套改,两边一起」):没有要核的行 ⇒ 空串。
// 依据:board.py 读一个 HTML,10-28 实测 0.3 秒内;5 秒是给慢盘的余量,超了就不加这段。
function recheck(file) {
  try { return cp.execFileSync('python3', [BOARD_PY, 'recheck', file, '--quiet'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return ''; }
}

module.exports = { ownBoard, recheck, isRetiredBoard, BOARD_PY };
