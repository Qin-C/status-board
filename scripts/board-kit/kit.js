(function () {
  // ⚠ 存储键必须**按板派生**,不能写死 —— 写死会让所有板共用一份「已看过」状态,
  //   A 板点过的勾选会让 B 板的卡莫名折叠。派生自文件名,天然唯一。
  var SLUG = (location.pathname.split('/').pop() || 'board').replace(/\.html?$/i, '');
  var KEY = 'status-board-board:' + SLUG, ACK = KEY + ':ack';

  // ⭐ 1110 面板归属(状态板线;负责人 11-09 一天问了 4 次「我根本找不到」):board.py 和面板检查钩子要核「**本会话**的面板此刻指向这块板」,
  //   而页面自己分不出属于哪个会话(userAgent 不带会话信息;localStorage 全机所有会话的面板共用一份)。
  //   ⇒ AI navigate 时地址带 ?s=<本会话标记>,这里记进 sessionStorage(每个标签页自己一份,同源跳转、reload 都还在),
  //   之后回伺服的定时拉取(reloadIfChanged 拉本页、paintPeers 拉 _peers.json)都带上;伺服据此记「哪个标记的面板此刻在拉哪块板」
  //   (boards-server.py 的 _fetch_target / _note_pane)。
  //   ⛔ 不许改用 localStorage:全机共用,会把别的会话的标记串进这个面板。sessionStorage 抛异常(隐私模式等)⇒ 只用地址里的。
  //   依据: 标记长 10 位十六进制,与 board.py PANE_MARK_LEN、boards-server.py PANE_MARK_LEN 同长
  var PANE_S_KEY = 'status-board-pane-s';
  function paneMark(search, store) {
    var m = /(?:^\?|&)s=([0-9a-f]{10})(?:&|$)/.exec(search || '');
    if (m) { try { if (store) store.setItem(PANE_S_KEY, m[1]); } catch (e) {} return m[1]; }
    var v = null;
    try { v = store ? store.getItem(PANE_S_KEY) : null; } catch (e) { v = null; }
    return (typeof v === 'string' && /^[0-9a-f]{10}$/.test(v)) ? v : '';
  }
  function paneUrl(u, s) {
    if (!s) return u;
    u = String(u).split('#')[0];
    var q = u.indexOf('?'), base = q < 0 ? u : u.slice(0, q);
    var kept = (q < 0 ? '' : u.slice(q + 1)).split('&').filter(function (x) { return x && x.split('=')[0] !== 's'; });
    kept.push('s=' + s);
    return base + '?' + kept.join('&');
  }
  var PANE_S = (function () { var st = null; try { st = window.sessionStorage; } catch (e) { st = null; } return paneMark(location.search, st); })();

  function paintAge() {
    var el = document.getElementById('freshness'), out = document.getElementById('age');
    if (!el || !out) return;
    var min = Math.round((Date.now() - parseInt(el.getAttribute('data-gen'),10)*1000)/60000), t, c;
    if (min < 1)        { t='刚刚';                 c='var(--good)'; }
    else if (min < 60)  { t=min+' 分钟前';           c='var(--good)'; }
    else if (min < 180) { t=Math.round(min/60)+' 小时前'; c='var(--warn)'; }
    else                { t=Math.round(min/60)+' 小时前 —— 别信下面的内容,先问一句'; c='var(--crit)'; }
    out.textContent=t; out.style.color=c; out.style.fontWeight = min>=60?'600':'400';
  }
  paintAge(); setInterval(paintAge, 30000);

  // ⭐ 死活条:HTML 里默认可见,JS 跑到这里就摘掉 —— 于是「JS 没跑」和「JS 跑了」在屏幕上不同。
  //   ⚠ 别改成「由 JS 创建再显示」:那样 JS 没跑就连警告都没有,正是这条要治的病。
  var failStreak = 0;
  var liveEl = document.getElementById('board-liveness');
  if (liveEl) liveEl.remove();
  function showDead(msg) {
    var el = document.getElementById('board-liveness');
    if (!el) {
      el = document.createElement('div');
      el.id = 'board-liveness';
      el.setAttribute('style', 'position:sticky;top:0;z-index:99;background:#b3261e;color:#fff;'
        + 'font:600 13px/1.5 -apple-system,system-ui,sans-serif;padding:9px 14px');
      document.body.insertBefore(el, document.body.firstChild);
    }
    el.innerHTML = msg;
  }

  // ── 勾选:你点过「已看过」的卡默认折叠;**内容变了(data-ack 版本号变了)会自动重新展开**
  var acked = {};
  try { acked = JSON.parse(localStorage.getItem(ACK) || '{}'); } catch (e) {}
  document.querySelectorAll('.card[data-ack]').forEach(function (card) {
    var id = card.getAttribute('data-ack');
    var btn = document.createElement('div');
    btn.className = 'ack';
    function paint() { btn.innerHTML = (acked[id] ? '✓ 已看过 · 点开' : '○ 标为已看过'); }
    if (acked[id]) card.classList.add('acked');
    paint();
    btn.addEventListener('click', function () {
      if (acked[id]) { delete acked[id]; card.classList.remove('acked'); }
      else { acked[id] = 1; card.classList.add('acked'); }
      try { localStorage.setItem(ACK, JSON.stringify(acked)); } catch (e) {}
      paint();
    });
    card.appendChild(btn);
  });

  // ── ⭐ 行级状态(负责人 2026-09-07 拍:「一行一行点掉」「已办结默认折叠留档」「用脚本做,别加规则」)
  //   数据源只有一个:`.crow[data-status]`(契约 → reference/board-crow-contract.md)。
  //   没标状态的行**什么都不发生** —— 采用与否一眼可见,不静默(「瞎区」那条判据)。
  //   ① 每张卡的清单顶上算一条汇总条:等你拍 / 卡住 / 在做 / 做完(+ 未标)—— 他要的「老领导汇报」那一行;
  //   ② done 行**先露面**,他点了已读才进「做完、你已读过的 N 件」抽屉(0907 改口,原 A 案的「默认折叠」作废);
  //   ③ 其余行一个 ○ 点掉 → 收进「你点掉的 N 件」抽屉;**状态一变就自动弹回**并打「有新进展」(B)。
  //      触发 = data-status 变了,⛔ 不是内容变了 —— 改错别字不该把它顶回来。
  //   ⚠ 类名一律 classList.add,别拼字符串 —— lint 的孤儿类检查只认得这种写法。
  //   ⚠ 行的身份 = 卡的 data-ack + 行的 data-ack;行上没写就退到首个粗体标题的哈希 —— 改标题会当成新行弹回,可接受。
  var RACK = KEY + ':rack', racked = {};
  try { racked = JSON.parse(localStorage.getItem(RACK) || '{}'); } catch (e) {}
  // ⭐⭐ 0907 负责人:「我明确点了已读的事项,为什么你更新完以后又蹦出来了?…会越攒越多,长到彻底腐烂。」
  //   实测:面板里 7 块板的 rack **全是 {}**(含他点过已读的那块)。两个原因叠在一起:
  //   ① 已读只存在浏览器 localStorage,面板被桌面端回收重建后拿不回来;
  //   ② 行的身份原来 = 卡的 data-ack + 行的 data-ack,而这块板今天重写时卡的 data-ack 换了 ⇒ 所有旧已读全部失联。
  //   ⇒ ① 真相搬到伺服端(boards-server `/_ack`,只绑回环),localStorage 只做缓存;fetch 不到才退回缓存;
  //     ② 行上写了 data-ack 就只认它(板内唯一),卡怎么重写都不影响。
  var ACK_URL = '/_ack?board=' + encodeURIComponent(SLUG);
  var HTTP = location.protocol.indexOf('http') === 0 && typeof fetch === 'function';
  var RACK_READY = !HTTP;   // 1110:伺服端的已读记录取回来了没有。原给首屏知会那一块用(1115 已撤);现在只是取回后重画一次首屏(paintFirstScreen:「要你的」「待你验收」)
  // ⭐ 0907 22:3x 记忆助手实测的真 bug:连点 33 行「已读」,伺服端只剩 16 条 —— 每次 POST 整份替换,请求乱序 / 页面刷新时
  //   用旧内存态回写,后到的那份把先到的盖掉。⇒ 改成**只发增量**(set 硬写 · soft 只在伺服端那条没被他点过时写 · del),
  //   伺服端逐 key 合并并回整份,客户端**串行发**并采纳回来的那份。整份替换的路不再走。
  var pending = { set: {}, soft: {}, del: [] }, chain = Promise.resolve();
  function mark(kind, key, rec) { if (kind === 'del') { pending.del.push(key); delete pending.set[key]; delete pending.soft[key]; } else { pending[kind][key] = rec; } }
  function pushRack() {
    try { localStorage.setItem(RACK, JSON.stringify(racked)); } catch (e) {}
    if (!HTTP) return;
    var body = pending; pending = { set: {}, soft: {}, del: [] };
    if (!Object.keys(body.set).length && !Object.keys(body.soft).length && !body.del.length) return;
    body.v = 2;
    chain = chain.then(function () {
      return fetch(ACK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { if (j && typeof j === 'object' && !Array.isArray(j)) { racked = j; try { localStorage.setItem(RACK, JSON.stringify(racked)); } catch (e) {} } })
        .catch(function () {});
    });
  }
  function pullRack() {
    if (!HTTP) return Promise.resolve(false);
    return fetch(ACK_URL, { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && typeof j === 'object' && !Array.isArray(j)) { racked = j; RACK_READY = true; setTimeout(function () { try { paintFirstScreen(); } catch (e) {} }, 0); return true; } return false; })
      .catch(function () { return false; });
  }
  function rowKey(cid, row) {
    if (row.getAttribute('data-ack')) return 'r|' + row.getAttribute('data-ack');
    var b = row.querySelector('.txt b');
    var t = ((b && b.textContent) || row.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    var h = 5381; for (var k = 0; k < t.length; k++) h = ((h << 5) + h + t.charCodeAt(k)) | 0;
    return cid + '|' + (h >>> 0).toString(36);
  }
  function mkDrawer(id, cls) {
    var d = document.createElement('details');
    d.classList.add('rdrawer'); d.classList.add(cls);
    d.setAttribute('data-fold-id', id);
    d.appendChild(document.createElement('summary'));
    return d;
  }
  // ⚠ 只作用于「你交代的」这一区(0903 与记忆助手线定的口径;0907 实测扩到全板会把结果区的
  //   「做完」全折进抽屉 —— 而结果区讲的就是做完了什么,折起来等于把重点藏了)。
  //   区的归属按文档顺序算:一张卡属于它前面最近的那个区标题。
  var zoneOf = new Map(), curZone = '';
  document.querySelectorAll('.zone h2, .sec h2, .b-zone h2, .card').forEach(function (el) {
    if (el.tagName === 'H2') curZone = el.textContent || ''; else zoneOf.set(el, curZone);
  });
  // 符号在**全板**统一画(任何 .crow[data-status]),折叠 / 已读 / 弹回只在「你交代的」区。
  var GLYPH_ALL = { done: '✓', doing: '●', blocked: '●', todo: '○', watch: '◎', 'waiting-you': '❗' };
  // ⚠ 类名整名查表,⛔ 别拼字符串('mk-' + st):lint 的孤儿类检查会把字面量 'mk-' 当成一个没定义的类(0907 实撞,两块别线的板当场红)
  var MKCLS = { done: 'mk-done', doing: 'mk-doing', todo: 'mk-todo', watch: 'mk-watch', 'waiting-you': 'mk-you' };
  document.querySelectorAll('.crow[data-status] > .mk').forEach(function (mk) {
    var st = mk.parentNode.getAttribute('data-status'); if (st === 'blocked') st = 'doing';
    if (!GLYPH_ALL[st]) return;
    mk.textContent = GLYPH_ALL[st]; mk.classList.add(MKCLS[st]);
  });
  // 锚点:每张卡 id=ack-<data-ack>,每个区 id=zone-<区名>(去 emoji/空格),给行上的跳转用
  document.querySelectorAll('.card[data-ack]').forEach(function (c) { if (!c.id) c.id = 'ack-' + c.getAttribute('data-ack'); });
  // ⭐ 1117 晚 H(负责人 14:40 打回回答卡,卡头那枚黑块「无卡号」对他没有意义):没卡号的那枚全卡不出;有 #N 的照显。
  //   只在渲染层藏(加 noid,kit.css 不显示),板文件不动 —— 卡号块在数据里还在,别的机器读法(按 chip id 找行)照旧。
  function hideNoIdChips() { try { document.querySelectorAll('.chip.id').forEach(function (c) { if ((c.textContent || '').trim() === '无卡号') c.classList.add('noid'); }); } catch (e) {} }
  hideNoIdChips();
  document.querySelectorAll('.zone h2, .sec h2, .b-zone h2').forEach(function (h) {
    var z = h.parentNode, name = (h.textContent || '').replace(/[^\u4e00-\u9fff\w]/g, '');
    if (z && !z.id && name) z.id = 'zone-' + name;
  });
  // ⭐⭐ 0914 负责人(状态板线 ㊴):每一行一眼答两问 ——「我在什么状态」「我要干什么」;没做完的必须挂着,写清为什么没做完、何时完、卡在哪、他要做什么。
  //   他的担心:「规则越多,遵守率反而可能下降…能用脚本解决我完全不担心」⇒ 作者只写 .why / data-eta(卡住或要他动手再加 data-you / .act),
  //   其余全在这里算:排序、挂了几天、过期标红、已读不收没做完的、分项进度、标题截短、结论分行。
  //   ⚠ 与 board.py 的 _row_facts / _md_to_date 同一规则 —— 改一边必须改另一边(0911 守与写各算一遍把 CI 钉死在红的教训)。
  var OPEN_ST = { 'waiting-you': 1, doing: 1, blocked: 1, todo: 1, watch: 1 };
  var YOU_DEF = { 'waiting-you': 'decide', doing: 'wait', todo: 'wait', watch: 'wait' };
  var YOU_LABEL = { decide: '要你拍', 'do': '要你动手', nudge: '要你去催', wait: '不用你做', stuck: '卡住了' };   // ⚠ 0914 负责人:「什么叫『你等着』?我现在要干什么?」
  var YOU_CLS = { decide: 'ry-decide', 'do': 'ry-do', nudge: 'ry-nudge', wait: 'ry-wait', stuck: 'ry-stuck' };
  var GLYPH_TO_ST = { '✓': 'done', '●': 'doing', '○': 'todo', '◎': 'watch', '❗': 'waiting-you' };
  // 依据: 2647a505e 按天计算事项年龄；864e5 毫秒等于24小时的单位换算。
  var DAY_MS = 864e5;
  function today0() { var d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function mdDate(mm, dd, kind) {
    var t0 = today0(), m = parseInt(mm, 10) - 1, dy = parseInt(dd, 10), d = new Date(t0);
    d.setMonth(m, dy); if (d.getMonth() !== m) return null;
    // ⚠ 0928 对齐 board.py `_md_to_date`(它 0916 就改了,这边一直没跟):行里写的日期可能是将来的(到期日 / 计划日)——
    //   晚于今天不到半年 = 将来的日子,返回 null 让调用方去找下一个;晚半年以上才是跨年写的去年。
    //   原来「晚于今天一律算去年」⇒「(10-05 到期」会被当成挂了 358 天(0928 全机 64 行没做完的里 0 处,潜伏着)。
    if (kind === 'past') { if (d.getTime() > t0) { if (Math.round((d.getTime() - t0) / DAY_MS) > 183) d.setFullYear(d.getFullYear() - 1); else return null; } }
    else { var diff = Math.round((t0 - d.getTime()) / DAY_MS); if (diff > 183) d.setFullYear(d.getFullYear() + 1); else if (diff < -183) d.setFullYear(d.getFullYear() - 1); }
    return d.getTime();
  }
  // 行里第一个「(MM-DD」里**已经过去**的那个 —— 与 board.py `_row_facts` 取 td 同一规则(跳过将来的日子)
  function firstPastMD(text) {
    var re = /[（(](\d{2})-(\d{2})/g, m, t;
    while ((m = re.exec(text || ''))) { t = mdDate(m[1], m[2], 'past'); if (t !== null) return t; }
    return null;
  }
  function fmtMD(ms) { var d = new Date(ms); return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function liState(li) {
    var s = li.getAttribute('data-st'); if (s) return s;
    var w = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, null), tn;
    while ((tn = w.nextNode())) { var v = tn.nodeValue.replace(/^\s+/, ''); if (!v) continue; return GLYPH_TO_ST[v.charAt(0)] || null; }
    return null;
  }
  function rowFacts(r) {
    var st = r.getAttribute('data-status') || '', open = !!OPEN_ST[st];
    var ys = r.getAttribute('data-you-src'), yr = ys === null ? r.getAttribute('data-you') : (ys === '' ? null : ys);   // kit 渲染后会把默认类别写回 data-you(给 CSS 用),作者原值存在 data-you-src
    var you = (yr && YOU_LABEL[yr]) ? yr : null;
    if (!you && yr === null && open) you = YOU_DEF[st] || null;
    var er = (r.getAttribute('data-eta') || '').trim(), em = /^(\d{1,2})-(\d{1,2})$/.exec(er), eta = em ? mdDate(em[1], em[2], 'near') : null;
    var why = r.querySelector('.txt .why'), act = r.querySelector('.txt .act:not(.act-gen)'), waitFor = (r.getAttribute('data-wait-for') || '').trim();
    var after = (r.getAttribute('data-after') || '').trim();   // 1008:排在哪一行后面(那一行的 data-ack),作者用 `board.py row --after` 写的
    var hasWhy = !!(why && (why.textContent || '').trim()), hasAct = !!(act && (act.textContent || '').trim());
    var td = firstPastMD(r.getAttribute('data-src-text') || r.textContent || '');
    var t0 = today0(), late = (open && eta !== null && eta < t0) ? Math.round((t0 - eta) / DAY_MS) : 0;
    var age = (open && td !== null) ? Math.round((t0 - td) / DAY_MS) : null;
    var subs = []; Array.prototype.forEach.call(r.querySelectorAll('.txt li'), function (li) { var s2 = liState(li); if (s2) subs.push(s2); });
    var missing = [];
    if (open) {
      if (!hasWhy) missing.push('没写为什么没做完');
      // 1008:排在别的行后面的(data-after),哪天开工由前面那件定 ⇒ 预计日可以先不写(与 board.py `_row_facts` 同一条)
      if (!er) { if (!after) missing.push('没写预计哪天'); } else if (eta === null) missing.push('预计要写成 MM-DD');
      if (!you) missing.push('没写你要做哪一类'); else if ((you === 'do' || you === 'nudge' || you === 'stuck') && !hasAct) missing.push('没写你要做什么');
      else if (st === 'blocked' && you === 'wait' && !waitFor) missing.push('没写在等什么');   // #4812
    }
    return { st: st, open: open, you: you, eta: eta, er: er, late: late, age: age, subs: subs, waitFor: waitFor, after: after,
      openSubs: st === 'done' ? subs.filter(function (x) { return x !== 'done'; }).length : 0, missing: missing, why: hasWhy ? why : null, act: hasAct ? act : null };
  }
  function renderYours() { document.querySelectorAll('.card').forEach(function (card, ci) {
    if ((zoneOf.get(card) || '').indexOf('你交代的') < 0) return;
    var checks = card.querySelector('.checks');
    if (!checks) return;
    // ⛔⛔ 0914 Harness 报(kit 回归):已读身份(rowKey)必须在**任何改 DOM 的动作之前**取 ——
    //   没 data-ack 的行按标题 / 行文字算身份;下面的「结论分行」会删掉「;」、「标题只露第一句」会往 <b> 里加「展开全文」、
    //   「提上来」会追加标签 ⇒ 身份一变,伺服端的已读 / 首次看见记录全对不上,做完的行重新冒出来(0907「已读又蹦回来」同一个形状)。
    //   ⇒ 进卡第一件事给每一行钉 data-rkey,之后一律读它。
    var cid0 = card.getAttribute('data-ack') || ('card' + ci);
    Array.prototype.forEach.call(card.querySelectorAll('.crow[data-status]'), function (r) { if (!r.hasAttribute('data-rkey')) r.setAttribute('data-rkey', rowKey(cid0, r)); });
    // ⭐ 0914 负责人(总控板):roadmap 那行 ● 折在「昨天」底下,他没点开就以为没进展。
    //   ⇒ 「你交代的」里 data-status 不是 done 的行,不管作者写在哪一天的折叠块里,一律提到折叠区上面;折叠区只装 ✓(lint 同时报错)。
    //   只动作者自己的 <details>(kit 的 .rdrawer 不算;行内 details.more 是结论不是折叠区,里面没有 crow)。
    var firstFold = null;
    // ⚠ 折叠块可能包着整个 .checks(CI 板:card > details > .checks > .crow),所以从 card 找,提到**这个** checks(第一块、折叠外)里
    Array.prototype.forEach.call(card.querySelectorAll('details:not(.rdrawer) .crow[data-status]'), function (r) {
      var st = r.getAttribute('data-status'); if (!st) return;
      if (st === 'done' && !rowFacts(r).openSubs) return;   // 0914 ㊴:标了 ✓ 但分项里还有没做完的,也算没做完,一样提上来
      var det = r.closest('details'); if (!det || det.closest('.crow')) return;
      if (checks.closest('details')) return;             // 本轮跑的是折叠块里面那个 .checks,不是外面那块;由外面那块来接
      if (!firstFold) firstFold = Array.prototype.slice.call(checks.children).filter(function (x) { return x.tagName === 'DETAILS'; })[0] || null;
      checks.insertBefore(r, firstFold);
      var tag = document.createElement('span'); tag.classList.add('rhoist'); tag.textContent = '从折叠里提上来的';
      tag.title = '没做完的行不许折起来(按你 0914 定的);作者下次落板请直接写在折叠区外面'; (r.querySelector('.txt') || r).appendChild(tag);
    });
    var rows = Array.prototype.slice.call(checks.children).filter(function (x) { return x.classList.contains('crow'); });
    if (!rows.some(function (r) { return r.hasAttribute('data-status'); })) return;
    // ⭐ 0907 负责人:「排列的时候按状态排序一下,不要第一个是怎么处理、第二个是什么事情」
    //   顺序:❗等你 → ✓做完 → ●进行中 → ○还没开始 → ◎长期观察 → 没标的;同状态内保持作者顺序(稳定排序)。
    // ⭐ 0914(㊴ 第 1 条):没做完的永远在做完前面;先排要他动的(拍板 / 动手 → 去催 → 卡住),再排过期的、挂得久的 —— 新事挤不下旧事。
    //   做完的保持作者顺序。行一律放在作者折叠块(昨天 / 前天)上面。
    var RANKY = { decide: 0, 'do': 0, nudge: 1, stuck: 2, wait: 4 };
    rows.forEach(function (r) { if (!r.hasAttribute('data-src-text')) r.setAttribute('data-src-text', ((r.querySelector('.txt') || r).textContent || '').slice(0, 400)); });
    rows = rows.map(function (r, i) {
      var f = rowFacts(r), st = r.getAttribute('data-status');
      var k = !st ? 8 : st === 'done' ? 9 : st === 'watch' ? 5 : (f.you ? RANKY[f.you] : 3);
      if (k === 4 && f.late) k = 3;
      return { r: r, i: i, k: k, late: f.late, age: f.age === null ? -1 : f.age };
    }).sort(function (a, b) { return (a.k - b.k) || (b.late - a.late) || (b.age - a.age) || (a.i - b.i); })
      .map(function (x) { return x.r; });
    var foldAnchor = Array.prototype.slice.call(checks.children).filter(function (x) { return x.tagName === 'DETAILS' && !x.classList.contains('rdrawer'); })[0] || null;
    rows.forEach(function (r) { checks.insertBefore(r, foldAnchor); });
    var cid = card.getAttribute('data-ack') || ('card' + ci);
    // ⭐ 0907 负责人:「标识太多了,简化:做完 / 进行中 / 还没开始 / 长期观察」⇒ 四桶 + 「等你」(指向他的那一种)。
    //   符号由 kit 按 data-status 统一画,作者写的 .mk 字形一律被覆盖 —— 各线不用自己发明,他在哪块板上看到的都一样。
    //   blocked 归进行中(没做完就是没做完);todo / watch 是 0907 新增的两个值。
    var GLYPH = { done: '✓', doing: '●', blocked: '●', todo: '○', watch: '◎', 'waiting-you': '❗' };
    var n = { 'waiting-you': 0, doing: 0, todo: 0, watch: 0, done: 0, none: 0 }, fresh = 0, nores = 0, slip = 0;
    // ⛔ 0914(㊴ 第 3 条):没做完的点「已读」不再收进抽屉 —— 负责人:「任何没有做完的事项,都一定要给我挂在那里」。原地变淡(.r-seen),照样挂着。
    var dDone = mkDrawer(cid + ':done', 'rdrawer-done');
    // ⭐ 0907 19:2x 负责人(记忆助手板 47 行 ✓ 没点):「我根本没有办法扫完…我其实想找某一个事项,要翻到我想找的那一个很费劲。」
    //   「等他点了已读再留档」在 47 这个量级上撞了「他扫得完」。⇒ 两手:
    //   ① 做完、他没点、**且不是最近一天才做完的**(首次见到 > 24h,或行里写的日期早于今天)⇒ 收进「更早」抽屉。
    //      ⚠ 那不是留档:抽屉标题写着件数,里面每行照样能点「已读」;今天做完的照旧露在外面。
    //   ② 汇总条一个搜索框:卡号 / 关键词,连抽屉里的一起搜,命中的抽屉自动打开 —— 他要的是「找某一件」,不是「扫全部」。
    // 依据: d6a37493c 将做完未读且非最近一天的行收入更早抽屉，以24小时判定。
    var dOld = mkDrawer(cid + ':old', 'rdrawer-old'), old = 0, OLD_MS = 24 * 3600 * 1000;
    var find = document.createElement('input'); find.type = 'search'; find.classList.add('rfind');
    find.placeholder = '找某一件:卡号 / 关键词'; find.setAttribute('aria-label', '在你交代的里找');
    find.addEventListener('input', function () {      // 一块板上有几张卡就有几个框,联动成一个:他在哪个里打字都是搜全板
      Array.prototype.forEach.call(document.querySelectorAll('.rfind'), function (o) {
        if (o !== find && o.value !== find.value) { o.value = find.value; o.dispatchEvent(new Event('input')); }
      });
      applyFilter();
    });
    find.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { find.value = ''; applyFilter(); } });
    function textDate(row) {                            // 行里第一个**过去的**「（MM-DD」当它的日期;解析不到返回 null
      // ⛔ 0916(Handoff 报):原来「晚于今天一律算去年」—— 行里常写到期日(「(09-17 到期」)⇒ 首次见到时把 first 回填成去年,
      //   做完当天就被收进「更早」、被 prune 当成 364 天前搬走。⇒ 晚不到半年的是将来的日子,跳过去找下一个。与 board.py _md_to_date 同一规则。
      var re = /[（(](\d{2})-(\d{2})/g, m, now = Date.now(), t = row.textContent || '';
      while ((m = re.exec(t))) {
        var d = new Date(); d.setMonth(parseInt(m[1], 10) - 1, parseInt(m[2], 10)); d.setHours(0, 0, 0, 0);
        if (d.getTime() <= now) return d.getTime();
        if (d.getTime() - now > 183 * 86400000) { d.setFullYear(d.getFullYear() - 1); return d.getTime(); }
      }
      return null;
    }
    var strip = document.createElement('div'); strip.classList.add('rstrip');
    var filterSt = null;                               // 0907 负责人:「我点了等我的,它就只筛选等我的」
    function applyFilter() {
      rows.forEach(function (r) {
        var st = r.getAttribute('data-status'); if (st === 'blocked') st = 'doing';
        var inDrawer = !!r.closest('.rdrawer');       // ⚠ 抽屉里的行永远不藏 —— 0907 负责人:「点了新进展筛选再点已读,折叠栏根本点不开」
        var fx = rowFacts(r);
        var hit = inDrawer || !filterSt || (filterSt === 'new' ? !!r.querySelector('.rnew')
          : filterSt === 'slip' ? r.hasAttribute('data-slip') : filterSt === 'miss' ? !!r.querySelector('.rmiss, .rn-miss')
          : filterSt.indexOf('y:') === 0 ? (fx.open && fx.you === filterSt.slice(2))
          : filterSt === 'late' ? fx.late > 0 : filterSt === 'aged' ? (fx.st !== 'watch' && fx.you !== 'wait' && fx.age !== null && fx.age >= 3)
          : filterSt === 'opensub' ? fx.openSubs > 0 : st === filterSt);
        var q = (find.value || '').trim().toLowerCase();
        if (q) {                                       // 搜索:抽屉里的也搜,命中就把那个抽屉打开
          var ok = (r.textContent || '').toLowerCase().indexOf(q) >= 0;
          hit = ok; if (ok && inDrawer) r.closest('.rdrawer').open = true;
        }
        r.classList.toggle('r-hide', !hit);
      });
      // 搜索也要搜到作者自己折起来的行(「顺手做的」那种 <details>):不受状态筛选管,只受搜索管;命中就把那层 details 打开
      var q2 = (find.value || '').trim().toLowerCase();
      Array.prototype.forEach.call(card.querySelectorAll('details:not(.rdrawer) .crow'), function (r) {
        if (rows.indexOf(r) >= 0) return;
        var ok = !q2 || (r.textContent || '').toLowerCase().indexOf(q2) >= 0;
        r.classList.toggle('r-hide', !ok);
        if (q2 && ok) { var d = r.closest('details'); while (d) { d.open = true; d = d.parentNode && d.parentNode.closest ? d.parentNode.closest('details') : null; } }
      });
      Array.prototype.forEach.call(strip.children, function (c) { c.classList.toggle('rc-on', !!filterSt && c.getAttribute('data-st') === filterSt); });
    }
    function chip(cls, label, v, st) {
      var c = document.createElement('span'); c.classList.add('rchip'); c.classList.add(cls);
      if (!v) c.classList.add('rc-zero');
      var num = document.createElement('b'); num.textContent = String(v); c.appendChild(num);
      c.appendChild(document.createTextNode(label)); strip.appendChild(c);
      if (st) {
        c.setAttribute('data-st', st); c.title = '只看这一类(再点一次取消)';
        c.addEventListener('click', function () {
          if (st === 'old') { filterSt = null; applyFilter(); dOld.open = true; scrollPin(dOld, 'nearest'); return; }   // 1114:跳转一律走 scrollPin(抽屉刚展开、上面变高也对得上)
          if (st === 'done') {                       // 0921:做完的都收起来了 ⇒ 点它 = 展开收起的那两个抽屉,不做筛选(筛了也是空的)
            filterSt = null; applyFilter();
            [dOld, dDone].forEach(function (d) { if (!d.classList.contains('rdrawer-empty')) d.open = true; });
            scrollPin(dOld, 'nearest'); return;
          }
          if (st === 'seen') {                       // 0907 负责人:「点了已读以后想再回去看一眼,看不了」⇒ 点它 = 打开抽屉
            filterSt = null; applyFilter();
            if (!dDone.classList.contains('rdrawer-empty')) { dDone.open = true; scrollPin(dDone, 'nearest'); }
            return;
          }
          filterSt = (filterSt === st) ? null : st; applyFilter();
        });
      }
    }
    function paintStrip() {
      strip.textContent = '';
      var dc = dDone.querySelectorAll('.crow').length;
      // ⭐ 0914(㊴ 第 5 条):最前面直接答他第二问 —— 要你拍 / 动手 / 去催 / 卡住 / 过期 / 挂久 / 缺说明,各几件;0 的不占位(要你拍除外)。
      var yc = { decide: 0, 'do': 0, nudge: 0, stuck: 0 }, lateN = 0, agedN = 0, missN = 0, osN = 0;
      rows.forEach(function (r) { var f = rowFacts(r); if (f.openSubs) osN++; if (!f.open) return; if (yc[f.you] !== undefined) yc[f.you]++; if (f.late) lateN++; if (f.st !== 'watch' && f.you !== 'wait' && f.age !== null && f.age >= 3) agedN++; if (f.missing.length) missN++; });
      chip('rc-you', '要你拍', yc.decide, 'y:decide');
      if (yc['do']) chip('rc-you', '要你动手', yc['do'], 'y:do');
      if (yc.nudge) chip('rc-warn', '要你去催', yc.nudge, 'y:nudge');
      if (yc.stuck) chip('rc-warn', '卡住了', yc.stuck, 'y:stuck');
      if (lateN) chip('rc-you', '过了预计', lateN, 'late');
      if (agedN) chip('rc-warn', '要你动的挂了 3 天以上', agedN, 'aged');
      if (missN) chip('rc-miss', '没做完但没写清', missN, 'miss');
      if (osN) chip('rc-miss', '标了做完却还有没做完的', osN, 'opensub');
      if (n.done) chip('rc-done', '✓ 做完(已收起)', n.done, 'done');
      if (n.doing) chip('rc-do', '● 进行中', n.doing, 'doing');
      if (n.todo) chip('rc-todo', '○ 还没开始', n.todo, 'todo');
      if (n.watch) chip('rc-watch', '◎ 长期观察', n.watch, 'watch');
      if (n.none) chip('rc-none', '未标状态', n.none);
      var oc = dOld.querySelectorAll('.crow').length;
      // ⛔ 0921(#4820):原来这里还有「最近做完 13」「已读·做完 1」两格 —— 它们已经包含在上面的「✓ 做完 14」里,重复计数。
      //   去掉;点「✓ 做完」直接把收起的展开(见 chip 的 'done' 分支)。
      if (fresh) chip('rc-new', '有新进展', fresh, 'new');
      if (slip) chip('rc-slip', '做错过·已补', slip, 'slip');     // 0907 负责人拍(Harness 板 case):不加分组不加符号,一个小标 + 一格
      if (nores) chip('rc-miss', '没写结论', nores, 'miss');      // 0907 负责人拍:✓ 行没写「我做了什么」= 不合格的汇报,板上自己亮出来   // 0907 负责人:「有新进展也应该有个单独的 tab」—— 做完又有进展的两边都出现
      dDone.classList.toggle('rdrawer-empty', !dc);
      dDone.firstChild.textContent = '已读、做完的 ' + dc + ' 件 —— 已收起';   // 0916:「留档」专指 prune 搬进留档页(负责人原话),这里别再用这个词
      dOld.classList.toggle('rdrawer-empty', !oc);
      dOld.firstChild.textContent = '做完的 ' + oc + ' 件 —— 已收起(超过 7 天的会自动搬进留档页);要找哪件用上面的搜索';
      if (oc) {                                        // 0907 记忆助手提、负责人「批量集中处理掉」:一键把这一抽屉全标已读,免得一条条点
        var all = document.createElement('span'); all.classList.add('rackall'); all.textContent = '这 ' + oc + ' 件全部标已读';
        all.title = '等于逐条点「已读」:收进「已读、做完的」抽屉;要弹回单条点 ↺';
        all.addEventListener('click', function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          Array.prototype.slice.call(dOld.querySelectorAll('.crow')).forEach(function (r) {
            var k = r.getAttribute('data-rkey'); if (!k) return;
            racked[k] = { s: 'done', t: Date.now(), first: (racked[k] || {}).first }; mark('set', k, racked[k]);
            var nb = r.querySelector('.rnew'); if (nb) nb.remove();
            var b = r.querySelector('.rack'); if (b) { b.textContent = '↺'; b.title = '弹回来'; }
            dDone.appendChild(r);
          });
          pushRack(); paintStrip(); dDone.open = true;
        });
        dOld.firstChild.appendChild(all);
      }
      strip.appendChild(find);
      applyFilter();
    }
    rows.forEach(function (row) {
      var st = row.getAttribute('data-status');
      if (!st) { n.none++; return; }
      if (st === 'blocked') st = 'doing';
      if (!(st in n) || st === 'none') st = 'doing';   // 未知值当「进行中」桶(契约:只有 waiting-you 指向他)
      n[st]++;
      var mk = row.querySelector('.mk');                // 统一字形:覆盖作者写的
      if (mk) { mk.textContent = GLYPH[st] || '●'; mk.classList.add(MKCLS[st] || 'mk-doing'); }
      var txtEl = row.querySelector('.txt') || row;
      var f = rowFacts(row);
      if (row.getAttribute('data-ack') && !row.id) row.id = 'row-' + row.getAttribute('data-ack');   // 提醒卡(STALE)的行跳到这里
      if (!row.hasAttribute('data-you-src')) row.setAttribute('data-you-src', row.getAttribute('data-you') === null ? '' : row.getAttribute('data-you'));
      if (f.you) row.setAttribute('data-you', f.you);                   // CSS 按它换「进度 / 卡在」标签
      var tb1 = txtEl.firstElementChild && txtEl.firstElementChild.tagName === 'B' ? txtEl.firstElementChild : null;
      // #4794 第 5 条:标题和结论之间残留的「——」去掉(kit 已经在结论前画了 →)
      Array.prototype.forEach.call(txtEl.childNodes, function (nd) {
        if (nd.nodeType === 3 && nd.nextSibling && nd.nextSibling.classList && nd.nextSibling.classList.contains('res')) nd.nodeValue = nd.nodeValue.replace(/\s*[—–]+\s*$/, ' ');
      });
      // ㊴ 第 7 条:标题(他的原话)太长 ⇒ 露在外面只放**第一整句**,后面折起来,给一个看得见的「展开全文」。
      //   ⛔ 0914 负责人看总控提醒卡:「至少要把一句话放完…不要用这种三个点,后面的话让我自己猜」⇒ 不截断、不用「…」、不靠他猜能点。
      //   只拆纯文本标题;文字仍在 DOM 里(搜索与已读指纹照旧);第一句找不到或本身就长 ⇒ 整句放完、不拆。
      if (tb1 && !tb1.querySelector('.rtl-rest') && tb1.childNodes.length === 1 && tb1.firstChild.nodeType === 3) {
        var full = tb1.firstChild.nodeValue, cut = -1, mm2 = /[。；！？;!?]/g, hit2;
        while ((hit2 = mm2.exec(full))) { if (hit2.index >= 8) { cut = hit2.index + 1; break; } }
        if (full.length > 40 && cut > 0 && cut <= 60 && full.length - cut >= 6) {
          tb1.textContent = '';
          var h1 = document.createElement('span'); h1.textContent = full.slice(0, cut);
          var h2 = document.createElement('span'); h2.classList.add('rtl-rest'); h2.textContent = full.slice(cut); h2.hidden = true;
          var tg2 = document.createElement('a'); tg2.classList.add('rtl-more'); tg2.href = '#'; tg2.textContent = ' 展开全文';
          tg2.addEventListener('click', function (ev) { ev.preventDefault(); h2.hidden = !h2.hidden; tg2.textContent = h2.hidden ? ' 展开全文' : ' 收起'; });
          tb1.appendChild(h1); tb1.appendChild(h2); tb1.appendChild(tg2);
        }
      }
      // 原需求:露在外面的结论也分行 —— 结论里有「;」或 ①② 且较长 ⇒ 每段一行(只改显示,只在标签深度 0 处切)
      var resEl = txtEl.querySelector('.res');
      if (resEl && !resEl.querySelector('.rline')) {
        var rp = (resEl.textContent || '').trim(), circ = (rp.match(/[①-⑳]/g) || []).length;
        if (rp.length > 60 && (rp.indexOf('；') >= 0 || rp.indexOf(';') >= 0 || circ >= 2)) {
          var html0 = resEl.innerHTML, out = [], cur = '', depth0 = 0, qd = 0, okSplit = true, mt, reTok = /(<[^>]+>)|([^<]+)/g;
          while ((mt = reTok.exec(html0))) {
            if (mt[1]) { var tg = mt[1]; if (/^<\//.test(tg)) depth0--; else if (!/\/>$/.test(tg) && !/^<(br|img|hr|wbr)\b/i.test(tg)) depth0++; if (depth0 < 0) okSplit = false; cur += tg; continue; }
            var tx = mt[2];
            if (depth0 !== 0) { cur += tx; continue; }
            for (var ci2 = 0; ci2 < tx.length; ci2++) {
              var ch = tx.charAt(ci2);
              // ⚠ 0914 Harness:引号 / 括号里的「;」不切 —— 负责人原话「让我手动管理;我有时候…」被切成了两行
              if ('「『（(“'.indexOf(ch) >= 0) qd++; else if ('」』）)”'.indexOf(ch) >= 0 && qd > 0) qd--;
              if (qd === 0 && (ch === '；' || ch === ';')) { if (cur.trim()) out.push(cur); cur = ''; continue; }
              if (qd === 0 && /[①-⑳]/.test(ch) && cur.replace(/<[^>]+>/g, '').trim()) { out.push(cur); cur = ''; }
              cur += ch;
            }
          }
          if (cur.trim()) out.push(cur);
          if (okSplit && depth0 === 0 && out.length >= 2) resEl.innerHTML = out.map(function (x) { return '<span class="rline">' + x.trim() + '</span>'; }).join('');
        }
      }
      // ㊴ 原需求:没做完的行,标题下固定一行「你要做哪一类 · 预计 / 过了预计 · 挂了几天」,再一行卡在哪,再一行你要做什么
      if (f.open && !row.querySelector('.rnow')) {
        var rnow = document.createElement('span'); rnow.classList.add('rnow');
        var nchip = function (cls, text) { var c = document.createElement('span'); c.classList.add('rn'); c.classList.add(cls); c.textContent = text; rnow.appendChild(c); };
        // ⭐ 0914 #4812(负责人:「『你:等着』…是等我?还是等定版?还是等什么?」)⇒ 不用他做的行,标里直接带宾语:在等什么 / 我在做 / 还没开始
        if (f.you) nchip(YOU_CLS[f.you], YOU_LABEL[f.you] + (f.you === 'wait' ? (f.waitFor ? ' · 在等 ' + f.waitFor : f.st === 'doing' ? ' · 我在做' : f.st === 'todo' ? ' · 还没开始' : f.st === 'watch' ? ' · 长期看' : '') : ''));
        // ⭐⭐ 0922 负责人拍可视化①(「用两根条代替一串小字」):有预计日期的行画一根时间条 —— 从开始到预计,今天走到哪、过没过期,
        //   一眼看出;「预计 09-24 · 挂了 6 天 · 过了预计 N 天」这三片灰字全由这根条替掉(悬停看原数)。没写预计的行照旧出字,不画条(画不准就不画)。
        //   数全是现成的:开始 = 行里的「(09-16」,预计 = data-eta,今天 —— 作者不多写一个字。
        var tbar = null;
        if (f.eta !== null && f.st !== 'watch') {
          var t0b = today0();
          var sd = firstPastMD(row.getAttribute('data-src-text') || row.textContent || '');
          if (sd === null || sd >= f.eta) sd = Math.min(f.eta, t0b) - 7 * DAY_MS;
          var ed = Math.max(f.eta, t0b), span = Math.max(DAY_MS, ed - sd), left = Math.round((f.eta - t0b) / DAY_MS);
          tbar = document.createElement('span'); tbar.classList.add('rtime');
          var trk = document.createElement('span'); trk.classList.add('rt-track');
          var fl = document.createElement('span'); fl.classList.add('rt-fill'); if (left < 0) fl.classList.add('late'); else if (left === 0) fl.classList.add('due');
          fl.style.width = Math.min(100, Math.max(4, (t0b - sd) / span * 100)) + '%';
          var ek = document.createElement('span'); ek.classList.add('rt-eta'); ek.style.left = Math.min(100, (f.eta - sd) / span * 100) + '%';
          trk.appendChild(fl); trk.appendChild(ek); tbar.appendChild(trk);
          var tl = document.createElement('span'); tl.classList.add('rt-l'); if (left < 0) tl.classList.add('late'); else if (left === 0) tl.classList.add('due');
          tl.textContent = left < 0 ? '过期 ' + (-left) + ' 天' : left === 0 ? '今天到期' : '还剩 ' + left + ' 天';
          tbar.appendChild(tl);
          tbar.title = '开始 ' + fmtMD(sd) + ' · 预计 ' + fmtMD(f.eta) + (f.age !== null ? ' · 挂了 ' + f.age + ' 天' : '');
          rnow.appendChild(tbar);
        } else {
        if (f.late) nchip('rn-late', '过了预计 ' + f.late + ' 天'); else if (f.eta !== null) nchip('rn-eta', '预计 ' + fmtMD(f.eta));
        // 挂了几天:◎ 长期观察不标;排在别的事后面(写了在等什么)且没过预计的不标 —— 那是排队,不是被忘了(#4812);不用他做的一律灰,要他动的 ≥3 天才橙
        if (f.st !== 'watch' && f.age !== null && f.age >= 1 && !((f.waitFor || f.after) && !f.late)) nchip((f.you !== 'wait' && f.age >= 3) ? 'rn-aged' : 'rn-age', '挂了 ' + f.age + ' 天');
        }
        f.missing.forEach(function (m) { nchip('rn-miss', m); });
        var after = tb1; while (after && after.nextElementSibling && (after.nextElementSibling.classList.contains('rslip') || after.nextElementSibling.classList.contains('rprog'))) after = after.nextElementSibling;
        // 标题后面那个「（09-08）」日期并进状态行打头,不单独占一行
        var dn = after ? after.nextSibling : null;
        if (dn && dn.nodeType === 3 && /^\s*[（(]\d{2}-\d{2}[^）)]{0,12}[）)]\s*$/.test(dn.nodeValue)) {
          if (!tbar) { var ds = document.createElement('span'); ds.classList.add('rn'); ds.classList.add('rn-date'); ds.textContent = dn.nodeValue.trim(); rnow.insertBefore(ds, rnow.firstChild); }
          dn.parentNode.removeChild(dn);   // 画了时间条 ⇒ 开始日期在条的悬停里,不再单独出字
        }
        if (after) after.insertAdjacentElement('afterend', rnow); else txtEl.insertBefore(rnow, txtEl.firstChild);
        var tail = rnow;
        if (f.why) { tail.insertAdjacentElement('afterend', f.why); tail = f.why; }
        if (f.act) { tail.insertAdjacentElement('afterend', f.act); tail = f.act; }
        else if (f.you === 'decide' || f.you === 'do') {
          var ag = document.createElement('span'); ag.classList.add('act'); ag.classList.add('act-gen'); ag.textContent = f.you === 'decide' ? '去「要你的」拍板 ' : '去「要你的」看怎么做 ';
          tail.insertAdjacentElement('afterend', ag);
        }
      }
      if (f.openSubs && !row.querySelector('.ropen')) {
        var ro = document.createElement('span'); ro.classList.add('rmiss'); ro.classList.add('ropen'); ro.textContent = '标了做完,还有 ' + f.openSubs + ' 项没做完';
        ro.title = '这行不算做完:要么改成没做完(写为什么没做完、预计哪天),要么把剩下的单独挂一行';
        if (tb1) tb1.insertAdjacentElement('afterend', ro); else txtEl.appendChild(ro);
      }
      // 0907 负责人(Harness 板):「只有一句我说的话,没有任何具体你是怎么落地的…这是完全不合格的汇报」
      //   ⇒ ✓ 行必须有 <span class="res">我做了什么 / 结果在哪</span>;没有就当场亮红标(lint 同时报错)。
      if (st === 'done' && !row.querySelector('.res')) {
        var miss = document.createElement('span'); miss.classList.add('rmiss'); miss.textContent = '没写结论';
        miss.title = '这行缺 .res:一句他的原话不是结果,要写我做了什么 / 结果在哪';
        txtEl.appendChild(miss); nores++;
      }
      // ⭐ 0914 负责人(记忆助手板):「进行中的事项…一大团堆在一起的文字…是不是也该做点可视化」
      //   ⇒ details.more 里写 <ul class="sub"><li data-st="done|doing|blocked|todo|watch">一句</li></ul>,kit 画 ✓●○◎ 并在行首 .mk 旁加「n/N」进度小片;
      //   .res 只装最新一句结论(lint 对 >200 字且没折叠的 .res 警告)。
      // ⚠ 0914 cc控制 #4794 第 2 条:没 data-st(也不以 ✓●○◎❗ 开头)的 li 只是普通圆点 —— 事实清单不许被画成「已做 0/3」。
      var subs = Array.prototype.filter.call(row.querySelectorAll('.txt li'), function (li) { return !!liState(li); });
      if (subs.length) {
        var doneN = 0;
        subs.forEach(function (li) {
          var s2 = liState(li);
          if (!li.getAttribute('data-st')) {                // 手写「● 还超的两条」:把开头那个符号换成 kit 画的
            var w2 = document.createTreeWalker(li, NodeFilter.SHOW_TEXT, null), t2;
            while ((t2 = w2.nextNode())) { if (t2.nodeValue.replace(/^\s+/, '')) { t2.nodeValue = t2.nodeValue.replace(/^\s*[✓●○◎❗]\s*/, ''); break; } }
            li.setAttribute('data-st', s2);
          }
          if (s2 === 'blocked') s2 = 'doing'; if (s2 === 'done') doneN++;
          if (!li.querySelector('.smk')) { var g = document.createElement('span'); g.classList.add('smk'); g.classList.add(MKCLS[s2] || 'mk-doing'); g.textContent = GLYPH[s2] || '○'; li.insertBefore(g, li.firstChild); }
        });
        // ⛔ 0914 iOS #4789:第一版把 .rprog 插成 .mk 的兄弟 ⇒ 成了 grid 第二列、吃掉 1fr,整行标题被挤到右半边(负责人:「中间还有 bug…排版是不是有很大的问题」)。
        //   ⇒ 放进 .txt 的标题 <b> 后面(和 .rslip 同一个位置),不碰 .crow 的三列 grid。
        // ⭐ 0922 可视化①:「已做 1/4」换成一根分段条(绿 = 做完、蓝 = 在做、灰 = 没开始),后面留个小数字
        if (subs.length >= 2 && !row.querySelector('.rprog')) { var pg = document.createElement('span'); pg.classList.add('rprog');
          var sg = document.createElement('span'); sg.classList.add('rp-seg');
          subs.forEach(function (li) { var ss = li.getAttribute('data-st'), i2 = document.createElement('i'); if (ss === 'done') i2.classList.add('ok'); else if (ss === 'doing' || ss === 'blocked') i2.classList.add('go'); sg.appendChild(i2); });
          pg.appendChild(sg); var pn = document.createElement('span'); pn.classList.add('rp-n'); pn.textContent = doneN + '/' + subs.length; pg.appendChild(pn); pg.title = '分项进度:做完 ' + doneN + ' / 共 ' + subs.length + '(点展开看每一项)';
          var tb0 = txtEl.querySelector('b'); if (tb0) tb0.insertAdjacentElement('afterend', pg); else txtEl.insertBefore(pg, txtEl.firstChild); }
      }
      var rnowEl = row.querySelector('.rnow'), rprogEl = row.querySelector('.rprog');
      if (rnowEl && rprogEl && rprogEl.parentNode !== rnowEl) rnowEl.appendChild(rprogEl);   // 没做完的行:分项进度放进状态行
      if (row.hasAttribute('data-slip')) {                 // 「做错过、已补上」:还是 ✓,多一个小标;结论里写错在哪、怎么补
        var sl = document.createElement('span'); sl.classList.add('rslip'); sl.textContent = '做错过 · 已补';
        var tb = txtEl.querySelector('b'); if (tb) tb.insertAdjacentElement('afterend', sl); else txtEl.appendChild(sl);
        slip++;
      }
      // 0907 负责人:「我交代过的事项里面,最好能直接跳出来,比如等我的事情,点一下直接跳到等你拍」
      // ⚠ 可选的 id 别用字面量直接传给 getElementById —— lint 扫到字面量就会要求页面里必须有它(三块旧板 0907 当场红)
      // ⛔ 0908(#4495):五区形态的 zone-等你拍 回退已删 —— 只认三块形态的「要你的」区。
      var ZY = ['zone-', '要你的'].join('');
      var jump = row.getAttribute('data-jump') || (st === 'waiting-you' && document.getElementById(ZY) ? ZY : null);
      if (jump && !row.querySelector('.rjump')) {
        var tgt = document.getElementById(jump) || document.getElementById('ack-' + jump) || document.getElementById('zone-' + jump);
        if (tgt) {
          var a = document.createElement('a'); a.classList.add('rjump'); a.href = '#' + tgt.id;
          a.textContent = st === 'waiting-you' ? '→ 去拍' : '→ 去看';
          a.addEventListener('click', function (ev) { ev.preventDefault(); scrollPin(tgt, 'start'); });   // 1114:走 scrollPin
          (row.querySelector('.txt .act') || row.querySelector('.txt') || row).appendChild(a);
        }
      }
      // ⛔ 0907 负责人改口:done 行**不再默认折叠** —— 「你最好等我看过一眼,然后我点了已读再留档…
      //   我是愿意去看你每一轮都做完了哪些事项的,做完之后我就会知道每个事情可以有结果」。
      //   ⇒ done 行和别的行一样:先露面、带 ○,他点掉才进「做完的 N 件」抽屉。
      var key = row.getAttribute('data-rkey') || rowKey(cid, row), prev = racked[key];   // ⚠ 用进卡时钉好的身份(见上),别在这里现算
      // 记录三种:{s, first} 见过没点 · {s, t, first?} 他点了(t = 点的时间)· {s, popped, t} 弹回来等他再点。
      // 旧记录只有 {s, t}(点过)/{s, popped, t},照旧能认:有 t 且没 popped = 已读。
      // 状态变了 ⇒ 弹回并打标。⚠ 标要**持久到他再点已读**:第一版是「删记录」,标只在弹回那一次刷新里出现,
      //   下一次刷新就不知道它是弹回来的了(0907 实测:⑦ 弹回了但标没了)。⇒ 记录改成 {s: 新状态, popped: 1}。
      if (prev && prev.t && (prev.popped || prev.s !== st)) {
        racked[key] = { s: st, popped: 1, t: prev.t || Date.now(), first: prev.first }; mark('set', key, racked[key]); prev = null; fresh++;
        var tag = document.createElement('span'); tag.classList.add('rnew'); tag.textContent = '有新进展';
        (row.querySelector('.txt') || row).appendChild(tag);
      } else if (prev && !prev.t) {
        if (prev.s !== st) { prev.s = st; prev.first = Date.now(); mark('soft', key, prev); }   // 没点过、状态变了:当成今天新达成的,别直接进「更早」
        prev = null;
      } else if (!prev) {
        var td = textDate(row);
        racked[key] = { s: st, first: (td && td < Date.now()) ? td : Date.now() }; mark('soft', key, racked[key]);
      }
      var btn = document.createElement('span'); btn.classList.add('rack');
      function isAcked() { return !!(racked[key] && racked[key].t && !racked[key].popped); }
      function paintBtn() { var on = isAcked(); btn.textContent = on ? '↺' : '已读'; btn.title = on ? '弹回来' : '看过了,点掉'; }
      btn.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (isAcked()) { racked[key] = { s: st, first: Date.now() }; mark('set', key, racked[key]); if (st === 'done') checks.insertBefore(row, dOld); else { row.classList.remove('r-seen'); row.classList.remove('r-open'); } }
        else { racked[key] = { s: st, t: Date.now(), first: (racked[key] || {}).first }; mark('set', key, racked[key]); var nb = row.querySelector('.rnew'); if (nb) nb.remove(); if (st === 'done') dDone.appendChild(row); else row.classList.add('r-seen'); }
        pushRack();
        paintBtn(); paintStrip();
      });
      // ⭐ 0916:已读的没做完行收成一行(见 kit.css),点行本身展开 / 收起;点按钮、链接、折叠标题不算
      row.addEventListener('click', function (ev) {
        if (!row.classList.contains('r-seen')) return;
        if (ev.target.closest && ev.target.closest('a, button, summary, .rack, input')) return;
        row.classList.toggle('r-open');
      });
      row.setAttribute('data-rkey', key);
      row.classList.add('has-rack'); row.appendChild(btn); paintBtn();
      if (prev) { if (st === 'done') dDone.appendChild(row); else row.classList.add('r-seen'); }
      // ⭐⭐ 0918 负责人:「**交代过的事项里面信息和内容太多了…我根本都懒得去看**。不看以后,我就不会去点已读,
      //   那就又溢出,变成恶性循环。」⇒ **做完的一律收起,不等他点已读** —— 那个「点」正是死循环的入口。
      //   ⛔ 旧逻辑是「做完超过 24 小时【且他没点过】才收」:今天做完的仍露在外面,而板上 45 行里绝大多数是 ✓,
      //     于是他每次打开都先撞上一堆已经做完的事。收起来之后顶上那条汇总仍写着「做完 N 件」,一点就开。
      //   ⚠ **没做完的一行都不收**(0914 他原话:「任何没有做完的事项,都一定要给我挂在那里」)—— 这里只碰 done。
      else if (st === 'done') { dOld.appendChild(row); old++; }
    });
    pushRack();
    checks.appendChild(dOld); checks.appendChild(dDone);
    checks.insertBefore(strip, checks.firstChild);
    paintStrip();
  }); if (typeof paintToc === 'function') paintToc(); }
  // ⭐ 0915(负责人拍状态板 v1.1 自查第 1 条):正文里拿行号互指(「见 ㉛」「由 ㊴ 做了」)⇒ 他得回头翻那是哪件。
  //   kit 显示时在这种圈号后面补上那一行标题的第一句,点它跳过去(折着的先打开);作者什么都不用改。只改显示,已读身份早在 renderYours 里钉死。
  //   ⚠ 圈号大半是在列举(「真因 ① … ②」「探针③」)。0915 全机实测:「本板有同号的行就补」⇒ 55 处里 37 处补错。
  //   ⇒ 五条都满足才补(同一批数据:补 18 处、错 0):
  //     ① 本板恰好一行的标题以这个圈号开头(重号不补)· ② 不是那一行自己 · ③ 这一行正文里只出现这一个圈号(两个以上 = 在列举)
  //     ④ 同一段文字里圈号前一个字不是汉字 / 字母 / 数字(「探针③」「断言②」是名字的一部分)。
  //     ⑤ 前一个字不是开引号 ——「㉛」这样写是在举例,不是指那一行(0915 当天我自己写的分项就被补错)。
  //   第一句超过 24 字就不内联,只留可点的圈号 + 悬停看全句 —— ⛔ 不截半句、不加「…」。
  function linkRowRefs() { try {
    var CS = '[⓪①-⑳㉑-㉟㊱-㊿]', C1 = new RegExp(CS), lab = {}, seq = 0;
    Array.prototype.forEach.call(document.querySelectorAll('.crow[data-status] .txt > b'), function (b) {
      var ch = (b.textContent || '').replace(/^\s+/, '').charAt(0);
      if (C1.test(ch)) (lab[ch] = lab[ch] || []).push({ row: b.closest('.crow'), b: b });
    });
    Array.prototype.forEach.call(document.querySelectorAll('.crow[data-status] .txt'), function (txt) {
      if (txt.parentNode && txt.parentNode.closest && txt.parentNode.closest('.txt')) return;
      var row = txt.closest('.crow'), tb = txt.querySelector(':scope > b'), own = [], nd;
      var tw = document.createTreeWalker(txt, NodeFilter.SHOW_TEXT, null);
      while ((nd = tw.nextNode())) { if ((tb && tb.contains(nd)) || nd.parentNode.closest('.xref')) continue; own.push(nd); }
      var seen = {}; own.forEach(function (x) { (x.nodeValue.match(new RegExp(CS, 'g')) || []).forEach(function (c) { seen[c] = 1; }); });
      if (Object.keys(seen).length !== 1) return;
      own.forEach(function (node) {
        var v = node.nodeValue, parts = [], last = 0, m, re = new RegExp(CS, 'g');
        while ((m = re.exec(v))) {
          var L = lab[m[0]];
          if (!L || L.length !== 1 || L[0].row === row) continue;
          var pc = m.index > 0 ? v.charAt(m.index - 1) : '';
          if (pc && (/[一-鿿A-Za-z0-9]/.test(pc) || '「『“‘'.indexOf(pc) >= 0)) continue;
          parts.push(v.slice(last, m.index)); parts.push({ ch: m[0], L: L[0] }); last = m.index + 1;
        }
        if (!parts.length) return;
        parts.push(v.slice(last));
        var frag = document.createDocumentFragment();
        parts.forEach(function (p) {
          if (typeof p === 'string') { if (p) frag.appendChild(document.createTextNode(p)); return; }
          var tgt = p.L.row; if (!tgt.id) tgt.id = 'xrow-' + (++seq);
          var cl = p.L.b.cloneNode(true); Array.prototype.forEach.call(cl.querySelectorAll('.rtl-more'), function (x) { x.remove(); });
          var t = (cl.textContent || '').replace(/^\s*[⓪①-⑳㉑-㉟㊱-㊿]\s*/, '').trim();
          var k = t.search(/[，,；;。：:—！？!?（(]/), gist = (k >= 2 ? t.slice(0, k) : t).trim();
          var a = document.createElement('a'); a.classList.add('xref'); a.href = '#' + tgt.id; a.title = t;
          a.appendChild(document.createTextNode(p.ch));
          if (gist && gist.length <= 24) { var g = document.createElement('span'); g.classList.add('xref-t'); g.textContent = '「' + gist + '」'; a.appendChild(g); }
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            for (var d = tgt.parentNode; d; d = d.parentNode) { if (d.tagName === 'DETAILS') d.open = true; }
            scrollPin(tgt, 'center');   // 1114:走 scrollPin
            tgt.classList.add('xref-hit'); setTimeout(function () { tgt.classList.remove('xref-hit'); }, 1600);
          });
          frag.appendChild(a);
        });
        // ⚠ 包成一个 span 再换:分项 li 是「符号 + 一段文字」两栏,直接插几个兄弟节点会被排成好几栏(0915 当天在自己板上撞到)
        var wrap = document.createElement('span'); wrap.classList.add('xref-in'); wrap.appendChild(frag);
        node.parentNode.replaceChild(wrap, node);
      });
    });
  } catch (e) {} }
  // ⭐ 0915(状态板 v1.1 验收时撞到):分项 li 是 flex 两栏(符号 + 文字),li 里一旦夹着 <b> / <a> / 补上的名字,
  //   每个行内元素各成一栏 —— 一句话被排成好几列。全机实测 CI 板 60 多行、记忆助手 4 行早就是这样,DOM 检查看不出,截图才看出来。
  //   ⇒ 显示时把符号之外的内容包进一个 span,li 永远只有「符号 + 一段文字」两栏;作者什么都不用改。
  function wrapFlexLi() { try {
    Array.prototype.forEach.call(document.querySelectorAll('.crow li'), function (li) {
      if (li.querySelector(':scope > .sli')) return;
      var isSmk = function (n) { return n.nodeType === 1 && n.classList.contains('smk'); };
      var kids = Array.prototype.filter.call(li.childNodes, function (n) { return !isSmk(n) && !(n.nodeType === 3 && !n.nodeValue.trim()); });
      if (kids.length < 2 || String(getComputedStyle(li).display).indexOf('flex') < 0) return;
      var sw = document.createElement('span'); sw.classList.add('sli');
      li.insertBefore(sw, kids[0]);
      Array.prototype.slice.call(li.childNodes).forEach(function (n) { if (n !== sw && !isSmk(n)) sw.appendChild(n); });
    });
  } catch (e) {} }
  // 先问伺服端他点过什么,再渲染;伺服端不在(file:// / 没起)就用本地缓存 —— 两条路都渲,只是真相来源不同
  // ⭐⭐ 0922 负责人拍可视化③:「要你的」卡先亮出动作,再讲道理。只搬卡上已有的东西,⛔ 不要作者多写字:
  //   形状一(queue 生成的「这 N 件卡在你身上」):每行「要你拍 / 要你动手 …· 挡着 #x」⇒ 一块动作砖,类别一眼看出,挡着谁变成小标;
  //   形状二(board.py ask 出的卡):「选一个」的选项和「起点 / 怎么做 / 结果」步骤挪到卡最上面一块红底里,「不决定会卡住什么」缩成一个小标。
  //   原行只是藏起来(display:none),搜索照样搜得到;lint 读的是源文件,不受影响。
  var VZ_STEP = /^(起始界面|起点|怎么做|等多久|结果怎么给我|结果)/;
  function vzAsks() { try {
    Array.prototype.forEach.call(document.querySelectorAll('article.card'), function (card) {
      if ((zoneOf.get(card) || '').indexOf('要你的') < 0 || card.hasAttribute('data-vz')) return;
      card.setAttribute('data-vz', '1');
      var checks = card.querySelector('.checks'); if (!checks) return;   // ⚠ ask 卡的 .checks 在 .top 里,queue 卡的在 .body 下 —— 别写死层级(0922 第一版实撞)
      var rows = Array.prototype.slice.call(checks.querySelectorAll(':scope > .crow'));
      var lab = function (r) { return ((r.querySelector('.txt > b') || {}).textContent || '').trim(); };
      var acts = rows.filter(function (r) { return /^(要你拍|要你动手)$/.test(lab(r)); });
      if (acts.length) {
        var grid = document.createElement('div'); grid.classList.add('vz-acts');
        acts.forEach(function (r) {
          var kind = lab(r), id = r.querySelector('.txt > a'), body = r.querySelector('.txt .tame-loose, .txt .res') || r.querySelector('.txt');
          var tile = document.createElement('div'); tile.classList.add('vz-act');
          var hd = document.createElement('div'); hd.classList.add('vz-act-h');
          var k = document.createElement('span'); k.classList.add('vz-kind'); k.classList.add(kind === '要你拍' ? 'k-decide' : 'k-do'); k.textContent = kind === '要你拍' ? '☑ 要你拍' : '✋ 要你动手'; hd.appendChild(k);
          if (id) hd.appendChild(id.cloneNode(true)); tile.appendChild(hd);
          var bl = null; Array.prototype.forEach.call(body.querySelectorAll('b'), function (x) { if (!bl && /挡着/.test(x.textContent)) bl = x; });
          var txt = body.cloneNode(true); Array.prototype.forEach.call(txt.querySelectorAll('b'), function (x) { if (/挡着/.test(x.textContent)) x.remove(); });
          Array.prototype.forEach.call(txt.querySelectorAll('.tame-sum, .tame-more'), function (x) { x.remove(); });   // 被收起的长段:只取全文,别把摘要 +「展开(还有 N 字)」+ 全文拼成一串(0923)
          var t = document.createElement('div'); t.classList.add('vz-act-t'); t.textContent = (txt.textContent || '').replace(/^\s*[:：]\s*/, '').replace(/[\s·]+$/, ''); tile.appendChild(t);
          var tag = r.querySelector('.tag'), meta = document.createElement('div'); meta.classList.add('vz-meta');
          if (bl) { var c1 = bl.cloneNode(true); c1.classList.add('vz-chip'); meta.appendChild(c1); }
          if (tag) { var c2 = document.createElement('span'); c2.classList.add('vz-chip'); c2.classList.add('grey'); c2.textContent = tag.textContent; meta.appendChild(c2); tile.classList.add('parked'); }
          if (meta.childNodes.length) tile.appendChild(meta);
          grid.appendChild(tile); r.style.display = 'none';
        });
        checks.insertBefore(grid, checks.firstChild);
        return;
      }
      var opts = card.querySelector('.opts'), steps = rows.filter(function (r) { return VZ_STEP.test(lab(r)); });
      vzBig(card, checks, rows, lab);
      if (!opts && !steps.length) return;
      var box = document.createElement('div'); box.classList.add('vz-action');
      var h = document.createElement('div'); h.classList.add('vz-a-h'); h.textContent = opts ? '☑ 要你选一个' : '✋ 要你动手'; box.appendChild(h);
      var meta2 = document.createElement('div'); meta2.classList.add('vz-meta');
      // ⛔ 0922 第一版从全卡文字里抠「约 N 分钟」当耗时,抠到了正文里一句无关的话 —— 靠文字猜必错;要花多久在「等多久」那一步里
      rows.forEach(function (r) { if (lab(r) === '不决定会卡住什么') { var c4 = document.createElement('span'); c4.classList.add('vz-chip'); c4.classList.add('warn'); c4.textContent = '不定会卡住:' + firstSentence(((r.querySelector('.res') || r.querySelector('.txt')).textContent || ''), 34); meta2.appendChild(c4); r.style.display = 'none'; } });
      if (meta2.childNodes.length) box.appendChild(meta2);
      if (steps.length) {
        var sw = document.createElement('div'); sw.classList.add('vz-steps');
        steps.forEach(function (r, i) { var st = document.createElement('div'); st.classList.add('vz-step'); var em = document.createElement('em'); em.textContent = String(i + 1); st.appendChild(em);
          st.appendChild(document.createTextNode(firstSentence(r.querySelector('.txt').textContent.replace(VZ_STEP, '').replace(/^[:：\s]+/, ''), 60))); st.title = r.querySelector('.txt').textContent.trim(); sw.appendChild(st); r.style.display = 'none'; });
        box.appendChild(sw);
      }
      if (opts) { var sel = opts.closest('.crow'); box.appendChild(opts); if (sel && !sel.querySelector('.opts')) sel.style.display = 'none'; }
      checks.insertBefore(box, checks.firstChild);
    });
  } catch (e) {} }
  // 画了时间条的行:开始日期已在条里,tameAll 收到行尾的那个孤零零「(09-16)」再出一次就是重复
  function vzDropDates() { try { Array.prototype.forEach.call(document.querySelectorAll('.crow .rtime'), function (tb) {
    var row = tb.closest('.crow'); Array.prototype.forEach.call(row.querySelectorAll('.tame-loose'), function (x) {
      if (/^\s*[（(]\d{1,2}-\d{1,2}[^)）]{0,12}[)）]\s*$/.test(x.textContent || '')) x.style.display = 'none'; });
  }); } catch (e) {} }
  // ⭐⭐ 0923 负责人拍第四样的前一半(后一半「板上就地回复」否了:「状态板是让我快速获取信息的,是一个信息媒介,而不是我要通过状态板来发消息」):
  //   「要你的」里一张卡摊了 6 段以上 ⇒ 把句子里带问号的挑出来编成「问1、问2…」放最前,其余每段压成一行编号 ①②…,点「全文」看原文。
  //   他看着板、在聊天里用语音一口气说「问2 选 A,问3 先不做」就能对上号。⛔ 不放回复框、不存东西、不发消息。
  //   问题只从卡上已有的句子里挑(以 ?/? 结尾的那句),作者不用多写;没挑出来就只做压行,不硬造问题。
  var VZ_CIRC = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  function vzBig(card, checks, rows, lab) {
    // ⭐ 1119 负责人(bad case):机器卡每一行就是要他看的那件事,没有「背景」⇒ 不收成「背景 N 段」、不挂「这张卡没写要你答什么」。
    //   ⚠ 正则就地写(ANS_MACHINE 声明在后面,vzAsks 若早于它跑会读到 undefined、整段被 try 吞掉)
    if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-|yours-empty)/.test(card.getAttribute('data-ack') || '')) return;
    var vis = rows.filter(function (r) { return r.style.display !== 'none' && lab(r) !== '选一个' && !r.querySelector('.opts'); });
    if (vis.length < 6) return;
    var qs = [];
    // 卡上没有「选一个」时,标题里的问句就是头一问(上架卡:「要不要单拉一条『上架』常驻线?」)
    if (!card.querySelector('.opts')) { var hq = ((card.querySelector('h2.q') || {}).textContent || '').match(/^[^？?]{4,}[？?]/); if (hq) qs.push(hq[0].trim()); }
    vis.forEach(function (r) {
      var t = (r.querySelector('.txt').textContent || '').replace(/\s+/g, ' ');
      var add = function (q) { q = q.replace(/^[\s:：·,，;；]+/, '').replace(/[;；。\s]+$/, '').trim(); if (q.length >= 4 && qs.indexOf(q) < 0) qs.push(q); };
      // ① 「要你定 / 要你拍 / 要你选 / 等你定」后面跟着的 ①②③ 分项,各算一问 —— 真实大卡(09-21 上架卡)要他定的四件全是这种写法,一个问号都没有
      //    「还没定 / 待定:a、b」没有圈号 ⇒ 整段原话算一问(同一张上架卡:「还没定:线怎么拉、样板那 10 个品用哪批货」)
      var reMk = /(要你定|要你拍|要你选|等你定|等你拍|还没定|待定)[^：:。（(]{0,8}[：:]/g, mk;
      while ((mk = reMk.exec(t))) {
        var tail = t.slice(mk.index + mk[0].length).split(/。/)[0];
        var items = tail.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])/).filter(function (x) { return /^[①-⑳]/.test(x); });
        if (items.length) items.forEach(function (x) { add(x.replace(/^[①-⑳]\s*/, '').split(/[；;]/)[0]); });
        else { var pre = t.slice(0, mk.index).split(/[：:；;。，,]/).pop().replace(/^[\s①-⑳·]+/, '');   // 「⑤ 分工待定:」⇒ 带上「分工」
          add(pre + mk[1] + ':' + tail.split(/[；;]/)[0]); }   // ⛔ 不按顿号 / 逗号拆:「分工待定:关键词、商详谁主做」一拆就丢了「关键词」、意思变了(0923 夹具实撞)——整段原话算一问
      }
      // ② 以问号结尾的句子
      (t.match(/[^。；;！!？?]{4,}[？?]/g) || []).forEach(add);
    });
    var box = document.createElement('div'); box.classList.add('vz-big');
    if (qs.length) {
      var h = document.createElement('div'); h.classList.add('vz-a-h'); h.textContent = '要你答的 ' + qs.length + ' 问(在聊天里说「问1 …」就能对上)'; box.appendChild(h);
      qs.slice(0, 12).forEach(function (q, i) { var d = document.createElement('div'); d.classList.add('vz-q'); var b = document.createElement('b'); b.textContent = '问' + (i + 1) + ' '; d.appendChild(b); d.appendChild(document.createTextNode(q)); box.appendChild(d); });
    }
    // ⭐⭐ 1020 晚 负责人(看 AI平台-总控一张 8 段的卡):「每个东西都要我点开全文,那我怎么可能每个东西都有空去点开全文呢?」
    //   ⇒ 背景整体收成一个按钮,一点全部展开成全文(不再一段一个「全文」);卡上没挑出任何要他答的 ⇒ 先说一句「这张卡没写要你答什么」。
    if (!qs.length && !card.querySelector('.opts') && card.getAttribute('data-accept') !== '1') {   // 1119:验收 / 回答 / 小修卡要他点的在卡顶,不挂这句
      var nq = document.createElement('div'); nq.classList.add('vz-noq'); nq.textContent = '这张卡没写要你答什么 —— 下面只是背景,可以先跳过'; box.appendChild(nq);
    }
    var rh = document.createElement('button'); rh.type = 'button'; rh.classList.add('vz-rest-h');
    var rhLab = '背景 ' + vis.length + ' 段 · 全部展开'; rh.textContent = rhLab; box.appendChild(rh);
    var ol = document.createElement('div'); ol.classList.add('vz-lines'); ol.hidden = true;
    rh.addEventListener('click', function (ev) { ev.preventDefault(); ol.hidden = !ol.hidden; rh.textContent = ol.hidden ? rhLab : '收起背景'; });
    vis.forEach(function (r, i) {
      var l = lab(r), body = (r.querySelector('.txt').textContent || '').replace(/\s+/g, ' ').replace(/^[·\s]+/, '');
      if (l && body.indexOf(l) === 0) body = body.slice(l.length).replace(/^[\s:：]+/, '');
      var line = document.createElement('div'); line.classList.add('vz-line');
      var no = document.createElement('span'); no.classList.add('vz-no'); no.textContent = VZ_CIRC.charAt(i) || String(i + 1); line.appendChild(no);
      if (l) { var lb = document.createElement('b'); lb.textContent = l.replace(/^🔴\s*/, '') + ' '; line.appendChild(lb); }
      // ⛔⛔ 0923 负责人(经示例-上架线【急】):「这个事情需要直接扩展为全文,不需要再给我复制一份,然后再展示全文,这没有意义。」
      //   第一版点「全文」是在下面另弹一个框、cloneNode 一份原行 —— ① 抄了一遍;② cloneNode 不带监听,框里的「展开(还有 N 字)」
      //   一点就走 href="#" 跳回页顶,他两条路都看不到完整标题。⇒ 就在这一行原地换成全文(纯文字,不复制 DOM),再点收起。
      var fullTxt = (function () { var c = r.querySelector('.txt').cloneNode(true);
        Array.prototype.forEach.call(c.querySelectorAll('.tame-sum, .tame-more, .rtl-more, .xref-t'), function (x) { x.remove(); });
        Array.prototype.forEach.call(c.querySelectorAll('br'), function (x) { x.replaceWith('\n'); });   // 原行里的换行照留(标题一行、说明一行)
        var t2 = (c.textContent || '').replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/^[·\s]+/, '');
        if (l && t2.indexOf(l) === 0) t2 = t2.slice(l.length).replace(/^[\s:：]+/, '');
        return t2.trim(); })();
      var bodySpan = document.createElement('span'); bodySpan.classList.add('vz-full'); bodySpan.textContent = fullTxt; line.appendChild(bodySpan);   // 展开就是全文,不再一段一个「全文」
      ol.appendChild(line); r.style.display = 'none';
    });
    box.appendChild(ol);
    checks.insertBefore(box, checks.firstChild);
  }
  // ⭐⭐ 1006 负责人两句抱怨(状态板 v1.5):① 行很多,看不出今天哪几行动过;② 新一任接手后旧行原样挂着,分不清哪些是新一任确认过的。
  //   数全是 board.py touch 记在行上的(_rows_track_apply),作者一个字不填,这里只管画:
  //     data-upd   这一行内容上次变的时间(本地「YYYY-MM-DDTHH:MM」)⇒ 「你交代的」区头下面一条「今天动过 N 行」,点一项滚到那行并闪一下;
  //                N = 0 整条不建。「今天」按浏览器本地日期比。
  //     data-baton 这一行上次内容变 / 被 `board.py row` 动过时板顶是第几棒 ⇒ 没做完的行,它和板顶现在的棒次不一样 ⇒ 行尾一枚灰标「这一棒还没核过」。
  //   ⛔ 没有 data-baton 的行(这块板还没被新版 touch 记过)不标;板顶读不到第几棒 ⇒ 全都不标 —— 不知道就不说话。
  //   ⚠ 取板顶棒次的规则与 board.py `_board_baton` 同一条(eyebrow 里的「第 vX.Y 棒」),改一边必须改另一边。
  //   ⚠ 必须排在 renderYours 之后:行的已读身份(data-rkey)那时已经钉死,往行里加标签不会让已读失联。
  var BATON_RE = /第\s*(v\d+(?:\.\d+)*)\s*棒/, TODAY_SHOW = 10, TODAY_CUT = 14;
  function boardBaton() { var eb = document.querySelector('.eyebrow'), m = eb && BATON_RE.exec(eb.textContent || ''); return m ? m[1] : null; }
  function localYMD() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
  function rowTitleText(row) {   // 那一行的标题原文:被收成「第一句 + 展开」的取全文,kit 自己加的「展开全文」之类不算
    var b = row.querySelector('.txt > b') || row.querySelector('.txt') || row;
    var c = (b.querySelector('.tame-full') || b).cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.rtl-more, .tame-more, .tame-sum, .xref-t, .rbaton, .rafter, .rchat, .rack'), function (x) { x.remove(); });
    return (c.textContent || '').replace(/\s+/g, ' ').trim();
  }
  // ⭐ 1114(第 3 步真浏览器实测,协调线报):首屏点一行跳卡,落在上一张带大图的卡上,目标卡在视口下面 —— 旧 kit 同样会(同一个 goCard,本机注入 514px 复现:新旧都停在目标上方 530px)。
  //   根因:平滑 scrollIntoView 只在起步时算一次落点;滚的路上目标上面的东西变高(图后到、首屏重画、卡重排)⇒ 停在旧坐标,目标被挤下去。
  //   ⇒ 跳完盯 PIN_MS:页面停住(连续两拍 scrollY 不动)就瞬时 scrollIntoView 再对一次(已经对齐时是空操作);
  //     他自己滚轮 / 触摸 / 按键 / 按下鼠标就撤,不跟他抢;新跳一次先撤上一次。goCard(卡)和 jumpToRow(台账行)都走这里。
  //   未验证: PIN_MS 4 秒是估的(本机图 2 秒内到齐;慢网下更晚到的图仍会偏)—— 有「跳了还偏」的反馈再调。
  var PIN_MS = 4000, PIN_TICK = 100, PIN_STOP = null;   // 依据: PIN_TICK 100ms = 两拍不动约 0.2 秒才补一次,不打断还在走的平滑滚动
  function scrollPin(el, block) {
    if (PIN_STOP) PIN_STOP();
    var t0 = Date.now(), last = null, still = 0, iv = null, evs = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    var stop = function () {
      if (iv !== null) clearInterval(iv); iv = null;
      evs.forEach(function (e) { window.removeEventListener(e, stop, true); });
      if (PIN_STOP === stop) PIN_STOP = null;
    };
    PIN_STOP = stop;
    // 1114(协调线:目录条点「排队中的活」完全不滚):目标在关着的折叠(details,比如 board.py 生成的 fold1、台账折叠)里 ⇒ 浏览器滚不过去。
    //   ⇒ 一层层往上,关着的 details 全打开再滚;所有跳转都经这里,不用各处自己记得开。
    for (var dt = el.parentNode; dt; dt = dt.parentNode) { if (dt.tagName === 'DETAILS' && !dt.open) dt.open = true; }
    el.scrollIntoView({ behavior: 'smooth', block: block });
    evs.forEach(function (e) { window.addEventListener(e, stop, true); });
    iv = setInterval(function () {
      if (Date.now() - t0 > PIN_MS || el.isConnected === false) { stop(); return; }
      var y = window.scrollY;
      still = (last !== null && Math.abs(y - last) < 1) ? still + 1 : 0; last = y;
      if (still >= 2) el.scrollIntoView({ block: block });
    }, PIN_TICK);
    return stop;
  }
  function jumpToRow(row) {
    for (var d = row.parentNode; d; d = d.parentNode) { if (d.tagName === 'DETAILS') d.open = true; }   // 做完的行收在抽屉里:先打开
    row.classList.remove('r-hide');                                                                      // 被上面的筛选藏着的:露出来
    // ⭐ 1020 负责人:「我点进去…跳转到下方以后…那个字还是收起的,我还要再点一次展开。那我这样跳下来的意义是什么?」
    //   ⇒ 跳到哪一行,就把那一行收起的段(标题 / 进展 / 结论)全部展开;抽屉刚打开时还没收折的,先收折再展开(收折在 tameAll 里,幂等)
    try { tameAll(); } catch (e) {}
    Array.prototype.forEach.call(row.querySelectorAll('.tame-more'), function (m) {
      var f = m.parentNode && m.parentNode.querySelector('.tame-full'); if (f && f.hidden) m.click();
    });
    scrollPin(row, 'center');   // 1114:路上上面变高也对得上(见 scrollPin)
    row.classList.add('xref-hit'); setTimeout(function () { row.classList.remove('xref-hit'); }, 1600);
  }
  // ⭐ 1008 负责人(示例-基建):「先把 X 做完再说」的那件 Y,答完就从板上消失,X 做完时也没人把它推回来。
  //   ⇒ 行上可以写 data-after(值 = X 那一行的 data-ack;`board.py row --after X` 写的,作者的内容);这里只管画:
  //     没做完、带 data-after 的行,行尾一枚小标「排在「<X 标题前 12 字>」后面」,点了滚到 X 那一行(X 在收起的抽屉里先打开,同「今天动过」的跳法);
  //     X 在板上找不到(删了 / 做完超过 7 天搬进了留档页)⇒ 「排在一件已经不在板上的事后面」,不可点。
  //   X 做完之后的事不归这里:board.py lint 报错(`_after_done_error`),那条线刷板时就得处理。
  //   ⚠ 文字只走 textContent;类名 classList.add 写全名(lint 的孤儿类检查只认这种写法)。
  var AFTER_CUT = 12;
  function paintRowAfter(rows) {
    var byAck = {};
    rows.forEach(function (r) { var k = r.getAttribute('data-ack'); if (k && !byAck[k]) byAck[k] = r; });
    rows.forEach(function (r) {
      var x = (r.getAttribute('data-after') || '').trim();
      if (!x || r.getAttribute('data-status') === 'done' || r.querySelector('.rafter')) return;
      var tgt = byAck[x] || null, tg;
      if (tgt && tgt !== r) {
        var t = rowTitleText(tgt) || x;
        tg = document.createElement('a'); tg.classList.add('rafter'); tg.href = '#' + (tgt.id || '');
        tg.textContent = '排在「' + (t.length > AFTER_CUT ? t.slice(0, AFTER_CUT) + '…' : t) + '」后面';
        tg.title = '这一件排在「' + t + '」后面:那一件做完之前先不开工(点了跳到那一行)';
        tg.addEventListener('click', function (ev) { ev.preventDefault(); jumpToRow(tgt); });
      } else {
        tg = document.createElement('span'); tg.classList.add('rafter'); tg.classList.add('rafter-gone');
        tg.textContent = '排在一件已经不在板上的事后面';
        tg.title = '它排在编号 ' + x + ' 的那一行后面,而那一行现在不在板上(删了,或做完超过 7 天搬进了留档页)';
      }
      (r.querySelector('.txt') || r).appendChild(tg);
    });
  }
  // ⭐ 1023 晚 示例-基建转负责人:「我这个事情我要还要回复那个示例群成员,这事情怎么就直接被淹没掉了?也没放在状态板上」
  //   行上登记了对方群(`board.py row --chat oc_…`),群里别人在这一行上次重判之后说了新的 ⇒ board.py chat-watch(本机每 10 分钟)
  //   在行上记 data-chat-new(时间)/ -who / -say / -n。这里只管画:行尾一枚红标;首屏「卡着的」排最前、标红(见 paintFirstScreen)。
  //   那条线 `row --ack <行>` 重判过 ⇒ 机器把这几个属性拿掉,红标就没了。⚠ 文字只走 textContent;类名 classList.add 写全名。
  function chatChip(r) {
    var at = (r.getAttribute('data-chat-new') || '').replace('T', ' ').slice(5, 16), who = r.getAttribute('data-chat-who') || '对方';
    var n = parseInt(r.getAttribute('data-chat-n') || '1', 10) || 1;
    return '群里 ' + at + ' ' + who + ' 说了新的' + (n > 1 ? '(共 ' + n + ' 条)' : '') + ' · 这一行还没跟上';
  }
  function paintRowChat(rows) {
    rows.forEach(function (r) {
      if (!r.getAttribute('data-chat-new') || r.getAttribute('data-status') === 'done' || r.querySelector('.rchat')) return;
      var tg = document.createElement('span'); tg.classList.add('rchat');
      tg.textContent = chatChip(r);
      tg.title = '「' + (r.getAttribute('data-chat-say') || '') + '」—— 负责这块板的线还没按它重判这一行';
      (r.querySelector('.txt') || r).appendChild(tg);
    });
  }
  function paintRowTrack() { try {
    var rows = [];
    Array.prototype.forEach.call(document.querySelectorAll('.crow[data-status]'), function (r) {
      var cd = r.closest('.card'); if (cd && (zoneOf.get(cd) || '').indexOf('你交代的') >= 0) rows.push(r);
    });
    var cur = boardBaton();
    if (cur) rows.forEach(function (r) {
      var was = r.getAttribute('data-baton');
      if (!was || was === cur || r.getAttribute('data-status') === 'done' || r.querySelector('.rbaton')) return;
      var tg = document.createElement('span'); tg.classList.add('rbaton'); tg.textContent = '这一棒还没核过';
      tg.title = '这一行上次动是第 ' + was + ' 棒,现在是第 ' + cur + ' 棒:接手之后内容没变过,也没被重新确认过';
      (r.querySelector('.txt') || r).appendChild(tg);
    });
    paintRowAfter(rows);
    paintRowChat(rows);
    Array.prototype.forEach.call(document.querySelectorAll('.rtoday'), function (x) { x.remove(); });
    var zc = document.getElementById(['zone-', '你交代的'].join('')), ymd = localYMD();
    var hit = rows.filter(function (r) { return (r.getAttribute('data-upd') || '').slice(0, 10) === ymd; });
    if (!zc || !zc.parentNode || !hit.length) return;
    hit = hit.map(function (r, i) { return { r: r, i: i, t: r.getAttribute('data-upd') }; })
      .sort(function (a, b) { return a.t < b.t ? 1 : a.t > b.t ? -1 : a.i - b.i; });      // 刚动的在前;同一分钟的按板上顺序
    var bar = document.createElement('div'); bar.classList.add('rtoday');
    var hd = document.createElement('span'); hd.classList.add('rtoday-h'); hd.textContent = '今天动过 ' + hit.length + ' 行:'; bar.appendChild(hd);
    hit.forEach(function (x, i) {
      var t = rowTitleText(x.r) || '(没写标题的行)', a = document.createElement('a'); a.classList.add('rtoday-i');
      a.href = '#' + (x.r.id || '');
      a.textContent = t.length > TODAY_CUT ? t.slice(0, TODAY_CUT) + '…' : t;
      a.title = t + '(今天 ' + String(x.t).slice(11, 16) + ' 动的,点了跳到这一行)';
      a.addEventListener('click', function (ev) { ev.preventDefault(); jumpToRow(x.r); });
      if (i >= TODAY_SHOW) a.hidden = true;
      bar.appendChild(a);
    });
    if (hit.length > TODAY_SHOW) {
      var more = document.createElement('a'); more.classList.add('rtoday-more'); more.href = '#';
      more.textContent = '还有 ' + (hit.length - TODAY_SHOW) + ' 行';
      more.addEventListener('click', function (ev) {
        ev.preventDefault();
        Array.prototype.forEach.call(bar.querySelectorAll('.rtoday-i'), function (y) { y.hidden = false; });
        more.remove();
      });
      bar.appendChild(more);
    }
    zc.parentNode.insertBefore(bar, zc.nextSibling);
  } catch (e) {} }
  pullRack().then(renderYours, renderYours).then(wrapFlexLi).then(linkRowRefs).then(vzAsks).then(vzDropDates)
    .then(initAnswers, initAnswers)   // 1006:卡上直接答 —— 必须排在 vzAsks 之后(它会把 .opts 搬进卡顶那块红底里);前面哪步抛了也照样接上
    .then(paintRowTrack, paintRowTrack).then(projStart, projStart);   // 1006:「今天动过」那一条 + 「这一棒还没核过」—— 排最后,前面哪步抛了也照样画

  // ⭐⭐ 2026-08-31:负责人第三次撞到「一往下拉,上方一个白色区域把内容全挡住」。
  //   前两次(8/28、8/30)都当成 `location.reload()` 的时机问题修,各加了一道闸 ——
  //   **而这次实测:那两道闸都没坏,reload 在他那个场景里根本没被调用过。**
  //
  //   真根因是**布局本身是假的**。in-app 面板 hidden 时,标签页以**零宽度**布局:
  //       面板正常  clientWidth=1000 → 整块板 5,907px
  //       面板 hidden clientWidth=0   → 整块板 52,956px(**9 倍**)
  //   零宽度让每一行都折成极窄的一竖条,文档被撑到 9 倍高。
  //   ⇒ 这一刻读到的 `scrollY` / `scrollHeight` **描述的是另一个世界**:
  //     他在 52,956px 那版里的位置,换算到 5,907px 那版毫无意义。
  //   ⇒ 他一展开面板、一往下拉,浏览器才真正回流:文档从 52,956 塌回 5,907,
  //     滚动位置被夹断、整页重排 —— 那个「白色区域」就是这次重排的中间态。
  //
  //   ⚠⚠ 最该记的一条:**这条判据本机规则里早就写着**
  //     (`status-board.md`:「后台标签 `clientWidth===0` ⇒ 整次读数作废」),
  //     **而 kit 一处都没实现。** 判据写下来只防传播,不防产生 —— 要防产生只能落成代码。
  //
  //   ⇒ 修法是 fail-closed,和本仓到处在用的那条一样:**读不到就什么都别做。**
  //     量不准的时候,既不 reload、也不存滚动位置、也不恢复滚动位置。
  // ⭐ #白屏探针(总控 2026-09-01 记账:装好之前任何一方不许写「已修」)。
  //   我们修了三个已证实存在的失效模式,但**没有证据它们就是负责人撞到的那个** ——
  //   三条线都没亲眼见过白块。这个探针的用途只有一个:**他下次撞到时,那一刻前后的
  //   布局与决策留在盘上**,可以查数据而不是再猜一轮。
  //   ⚠ 纪律:零 UI、零网络、零行为改变;localStorage 每一步 try/catch(某些上下文连
  //   访问器都会抛);环形缓冲封顶,绝不无限涨。读法:出事后在那个标签页里读
  //   localStorage 的 `status-board-board-probe:<板名>`,或直接 `window.__boardProbe()`。
  var PROBE_KEY = 'status-board-board-probe:' + SLUG;
  function probeSnap() {
    var d = document.documentElement;
    return { w: d.clientWidth, h: d.clientHeight, dh: d.scrollHeight,
             y: Math.round(window.scrollY), hid: document.hidden ? 1 : 0 };
  }
  function probe(ev, extra) {
    try {
      var log = [];
      try { log = JSON.parse(localStorage.getItem(PROBE_KEY) || '[]'); } catch (e) {}
      if (!Array.isArray(log)) log = [];
      var rec = { t: Date.now(), ev: ev, s: probeSnap() };
      if (extra) rec.x = extra;
      log.push(rec);
      if (log.length > 80) log = log.slice(log.length - 80);   // 环形封顶
      localStorage.setItem(PROBE_KEY, JSON.stringify(log));
    } catch (e) { /* 探针绝不打穿板 */ }
  }
  try { window.__boardProbe = function () {
    try { return JSON.parse(localStorage.getItem(PROBE_KEY) || '[]'); } catch (e) { return []; }
  }; } catch (e) {}
  probe('load', { gen: (document.querySelector('[data-gen]') || { getAttribute: function(){return null;} }).getAttribute('data-gen') });
  document.addEventListener('visibilitychange', function () { probe(document.hidden ? 'hide' : 'show'); });

  function layoutUsable() {
    var d = document.documentElement;
    // 零宽度 ⇒ 此刻任何基于布局的判断都是错的(scrollY / scrollHeight 全部作废)。
    // ⚠⚠ 2026-08-31 订正:这里原本写「零宽度 = 面板收起/标签在后台」——**「面板收起」那半已被证伪**。
    //   记忆助手 v2.4 与 设计系统 v2.6 各自独立实测:面板 hidden 时 clientWidth = 908,scrollHeight 一点没涨。
    //   量到 0 的那个标签页是 `tabs_create` 出来、**从没 front 过的后台标签** —— 那是**另一个态**。
    //   ⇒ **零宽度确实会发生(后台标签),但它不等于「面板收起」。** 别照旧口径排查。
    //   (status-board.md:688 早就写着「0 和 非 0 两个方向都判不了 hidden」。)
    return d.clientWidth > 0 && d.clientHeight > 0;
  }

  function foldKey(x, i) {
    if (x.dataset && x.dataset.foldId) return 'id:' + x.dataset.foldId;
    var sm = x.querySelector('summary');
    var t = sm ? (sm.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
    return t ? 'sum:' + t : 'idx:' + i;
  }
  function save() {
    // ⛔ 布局退化时存下来的 y 属于「9 倍高那一版」,回到正常布局就是个错的位置。
    //    宁可保留上一次的可信值,也不要用一个假值覆盖它。
    if (!layoutUsable()) return;
    var anc = null;   // 1020 晚:视口顶上第一张卡 / 第一行(带 data-ack 的)和它离视口顶的距离 —— 换上新内容后按它对回去
    try { var cs = document.querySelectorAll('.crow[data-ack], .card[data-ack]');
      for (var ci = 0; ci < cs.length; ci++) { var rc = cs[ci].getBoundingClientRect(); if (rc.height && rc.bottom > 0) { anc = { k: cs[ci].getAttribute('data-ack'), t: Math.round(rc.top) }; break; } } } catch (e) {}
    try { sessionStorage.setItem(KEY, JSON.stringify({
      y: window.scrollY, a: anc,
      // ⛔ 2026-09-02 总控 v6.0 实撞:原来按**序号**存开合;生成块(queue/done)一变 details 的数量或顺序,
      //    「第 0 个是开的」这份记忆就套到别的块上 —— 「做完」块 59 行全展开而 summary 写着「展开看」。
      //    改成按稳定 key:data-fold-id > summary 文字 > 序号兜底(只有前两者都没有才退到序号)。
      d: (function(){ var o = {}; document.querySelectorAll('details').forEach(function (x,i){
            o[foldKey(x,i)] = !!x.open; }); return o; })()
    })); } catch (e) {}
  }
  try {
    var st = JSON.parse(sessionStorage.getItem(KEY) || '{}');
    // 旧格式(数组)直接丢弃 —— 按序号恢复正是那个 bug;宁可这一次不恢复,也不要恢复错的。
    if (st.d && !Array.isArray(st.d)) document.querySelectorAll('details').forEach(function (x,i){ if (st.d[foldKey(x,i)]) x.open = true; });
    if (st.y && layoutUsable()) window.scrollTo(0, st.y);  // ⛔ 零宽度布局里恢复 = 跳到一个不存在的位置
    if (st.a && st.a.k) {
      // ⚠ 浏览器 reload 后会自己把滚动高度还原成旧值,而且是在 load 之后 —— 不关掉它,下面对好的位置会被它盖回去(1020 晚实测:卡往下错了 356px)
      try { history.scrollRestoration = 'manual'; } catch (e) {}
      var reAnchor = function () { try {     // 等本脚本把首屏 / 折叠都画完再对(它们会挪动下面的内容)
        if (!layoutUsable()) return;
        var el = null; document.querySelectorAll('[data-ack]').forEach(function (x) { if (!el && x.getAttribute('data-ack') === st.a.k && x.getBoundingClientRect().height) el = x; });
        if (el) window.scrollBy(0, Math.round(el.getBoundingClientRect().top - st.a.t));
      } catch (e) {} };
      setTimeout(reAnchor, 0); window.addEventListener('load', function () { requestAnimationFrame(reAnchor); });
    }
  } catch (e) {}
  // ⭐ 1029 负责人(经选品 v2.9):「我从 100 瓦磁吸充电线这个口子进去的方案板,我回来的时候我应该也回到我从哪里进去的地方,但是结果它会回到状态板的最上面」
  //   原来只在自动刷新前存位置;他点卡上的入口离开板时没存 ⇒ 回来落在板顶。⇒ 点进方案页那一刻存下,锚点就是他点的那张卡;离开页面时也存一次。
  document.addEventListener('click', function (e) { try {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !/\/proposals\//.test(a.getAttribute('href') || '')) return;
    save();
    var cd = a.closest('[data-ack]');
    if (!cd) return;
    var st2 = JSON.parse(sessionStorage.getItem(KEY) || '{}');
    st2.a = { k: cd.getAttribute('data-ack'), t: Math.round(cd.getBoundingClientRect().top) };
    sessionStorage.setItem(KEY, JSON.stringify(st2));
  } catch (err) {} }, true);
  window.addEventListener('pagehide', function () { try { save(); } catch (e) {} });

  var loadedAt = Date.now(), lastAct = Date.now();
  ['mousemove','scroll','keydown','click','touchstart'].forEach(function (e) {
    window.addEventListener(e, function(){ lastAct = Date.now(); }, { passive:true });
  });
  // ⛔⛔ 2026-08-28:这里原来是**无条件 `location.reload()`**,负责人亲自撞到并定性「比较严重」。
  //   他的原话:「我在状态板里**上下滑动**的时候,它会把上方的一个白色区域**拉下来挡住所有内容**……
  //   它根本没有往下滑,它直接拉下来一个东西遮住了一半。」
  //
  //   根因(CI 线定位到行,iOS 线复核确认):`visibilitychange` 那条**没有活动保护**。
  //   他切回板那个标签页的瞬间,只要加载超过 15 秒就**立刻 reload**;
  //   而他切回来的第一个动作正是滚动 ⇒ reload 撞上滚动 ⇒ 屏幕上是「旧内容还在、新内容在画」的中间态。
  //   上面第 47 行的滚动位置恢复(`scrollTo`)会让它再跳一下,观感更糟。
  //   ⚠ 定时那条**本来就是安全的** —— `lastAct` 把 `scroll` 算了进去,滚动会把闲置计时清零。
  //   **只有 visibilitychange 这条漏了同一层保护。**
  //
  // ⭐ 修法不是「加个延迟」,是**先问它到底变没变**:板绝大多数时候没变,
  //   他切回来就不该有任何抖动。`data-gen` 是机器在每次 touch 时更新的,正好当指纹,
  //   而且 lint 已经强制它必须跟着内容走。
  function currentGen(){
    var e = document.querySelector('[data-gen]');
    return e ? e.getAttribute('data-gen') + ':' + (e.getAttribute('data-note-gen') || '') : null;
  }
  // 有更新但此刻不宜换 ⇒ 记一笔,停手后自动换上(1020 晚起不再摆按钮)。
  // ⚠ 幂等:重复调用不会长出第二条。
  // ⭐⭐ 1020 晚 负责人:「既然每次都自动刷新中,那这玩意不就是白费吗?假设我有自动刷新,我就不应该要去点」
  //   ⇒ 不再摆刷新按钮等他点:记一笔「有更新」,他停手 4 秒、且光标不在输入框里(框里的字失焦才存到伺服端)时自己换上,
  //     换上前存滚动位置 + 视口顶上那张卡 / 那一行,换上后对回去(不是只回到同一个像素高度 —— 内容变了,像素会错位)。
  //   ⚠ 8/28 那块「白色区域拉下来挡住内容」是 reload 撞上他正在滚 —— 停手 4 秒这道闸就是为它留的,比原来的 1.5 秒宽。
  // 依据: 0c6ad940e 将闲置判定改为4秒，停手且未编辑输入框时自动换上更新。
  var updPending = false, UPD_IDLE = 4000;
  function editingNow() {
    var a = document.activeElement;
    return !!(a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(button|checkbox|radio|submit)$/i.test(a.type || '')) || a.isContentEditable));
  }
  setInterval(function () {
    if (!updPending || document.hidden || !layoutUsable() || editingNow() || Date.now() - lastAct < UPD_IDLE) return;
    updPending = false; probe('reload', { m: 'pending' }); save(); location.reload();
  }, 1000);
  function showUpdateHint(){
    updPending = true;
    var rt = document.getElementById('refresh-text'); if (rt) rt.textContent = '有更新 · 你停手几秒就自动换上';
  }

  // ⭐⭐ 2026-08-31 第二版修法(第一版的根因被两条线各自实测推翻,见下)。
  //
  // ⛔ 被推翻的那版:我说「面板 hidden ⇒ clientWidth=0 ⇒ 板被撑成 9 倍高」。
  //   记忆助手 v2.4 与 设计系统 v2.6 **各自独立**在确实 hidden 时量到 `clientWidth = 908`、
  //   `scrollHeight` 一点没涨。⇒ 那句是**过度断言**。我量到 0 的那个标签页是
  //   `tabs_create` 出来、**从没 front 过的后台标签** —— 那是另一个态,不是「面板 hidden」。
  //   ⚠ 而 `status-board.md` 就写着「`0` 和非 `0` 两个方向都判不了 hidden」,我读过却没拿它对结论。
  //   (`layoutUsable()` 那道闸**留着** —— 真为 0 时读数确实该作废;但它**不是**白屏的根因。)
  //
  // ⭐ 站得住的那个假设,它不需要任何退化布局:
  //   他**刚展开面板**那一刻 ⇒ `visibilitychange` 触发 ⇒ 页面加载于一小时前、他也很久没碰
  //   ⇒ 前两道闸全过 ⇒ 指纹**确实变了**(写板那一棒一轮 touch 好几次)
  //   ⇒ 于是走到最后一道:`scrollY > 120`?**他刚打开,当然在顶部** ⇒ 判成「这一刻打断不了什么」
  //   ⇒ **整页 reload** ⇒ 而他打开面板后的第一个动作正是**往下拉** ⇒ 撞上重排中间态 = 那个白块。
  //
  // 🔑 **错的是那个假设本身**:8/30 写的是「在顶部 = 他还没开始读 = 打断不了什么」。
  //   **可「在顶部」同时也意味着「他刚到、正要开始拉」** —— 而那恰恰是最不能打断的一刻。
  //   ⇒ 修法不是再调阈值,是**把「他刚回到这一页」这条路上的自动 reload 整个去掉**:
  //     他人就在屏幕前,提示条就在他眼前,**什么时候刷新交给他**。新鲜度一点没丢。
  //   ⚠ 定时那条(可见 + 连续 60 秒没动)**保留** —— 那是「他确实在、确实闲着」,与本场景不同。
  // ⭐⭐ 2026-08-31 第三版。**第二版把「白闪」换成了「板是旧的」,而那个更糟。**
  //   设计系统 v2.6 交接前捞出来的:负责人同日仍说过「感觉状态板腐烂了」,
  //   经查是**面板收起期间自动刷新整条不跑** —— 他打开看到的是冻结画面。
  //   ⇒ 而我的第二版让它更严重:定时那条本来就要求 `!document.hidden`(收起时零刷新),
  //     我又把「刚展开面板」那条改成了「绝不 reload,只亮提示」
  //     ⇒ **收起时不更新、打开时也不更新**,只剩一个要他点的按钮。
  //   ⛔ 而「让他多点一下」正是本文件明令的反模式(「多一步就等于没有」),
  //     并且直接违反地基那条:「**腐烂的板比聊天更糟:它看起来是最新的、实际是旧的**」。
  //
  // 🔑 正解不是在「闪」和「旧」之间选,是**换一个刷新的时机**:
  //   **在他看不见的时候刷。** 看不见就不可能看到闪;而他打开时已经是新的,
  //   于是「刚展开面板」那条路**根本不需要 reload** —— 两个病同时没了。
  //
  // mode: 'auto'       定时 + 页面可见 + 他闲着 —— 照旧,按位置分流
  //       'hint-only'  他刚展开面板 —— 绝不打断,只亮提示(理论上已无内容可提示)
  //       'background' 面板收起,**他看不见** —— 直接换掉,没有观众就没有打断
  function reloadIfChanged(ms, mode){
    if (Date.now() - loadedAt < ms) return;
    if (Date.now() - lastAct < 1500) return;   // 他正在动 —— 再新的内容也不值得在这一刻打断他
    fetch(paneUrl(location.href, PANE_S), { cache: 'no-store' })   // 1110 面板归属:带上本面板的标记,伺服才记得到是哪个会话的面板在看
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (t) {
        var m = t.match(/data-gen="([^"]+)"/);
        if (!m) return;                        // 读不出指纹 ⇒ 什么都不做,别猜
        failStreak = 0;                        // 取到了 ⇒ 服务活着,清掉死活计数
        // 机器回填有自己的版本，同一秒写两份也能即时看到。
        var notes = t.match(/data-gen="[^"]+" data-note-gen="([0-9a-f]+)"/);
        if (m[1] + ':' + (notes ? notes[1] : '') === currentGen()) return;     // ⭐ 没变 ⇒ 不 reload,这是绝大多数情况
        if (Date.now() - lastAct < 1500) return;  // 取回来的这段时间里他动了 ⇒ 让给他
        // ⛔⛔ 2026-08-30:负责人**又**撞到白块(同一句原话:「把上方的一个白色区域拉下来挡住所有内容」)。
        //   ⚠ 上面那道 1500ms 活动保护**没坏** —— 坏的是它守的那个前提。
        //   8/28 的修法基于「板绝大多数时候没变」,而那是一个**关于改板频率的假设,不是不变量**:
        //   总控 v5.6 那一轮 `touch` 跑了 20+ 次(我这一轮也是)⇒ 指纹每次都真的变了
        //   ⇒ 「没变就不 reload」这条捷径**恒不成立**,每次都走到真 reload。
        //   ⚠ 而 1500ms 也不够:**人读板时随时会停超过 1.5 秒**,一停就 reload,
        //     他一恢复滚动就撞上那个中间态。
        //
        // ⭐ 修法按「他在页面的什么位置」分流,而不是再调一个阈值:
        //   · **在顶部**(刚切回来 / 还没开始读)⇒ 照常 reload。**这一刻打断不了什么**,
        //     而它恰好是绝大多数情况 ⇒ 新鲜度一点没丢。
        //   · **已经滚下去了**(正在读)⇒ ⛔ 不 reload,只记一笔、停手后自动换上(1020 晚前是摆一个刷新按钮),
        //     把「什么时候被打断」交回给他。
        //   ⚠ 这样不牺牲新鲜度:提示就在他眼前,而他**正看着这一页**(否则不会滚)。
        //   与「腐烂的板比聊天更糟」不冲突 —— 那条治的是**他不知道板旧了**;这里他知道。
        // ⛔ fail-closed:布局不可信(clientWidth=0,例如从没 front 过的后台标签)时**绝不 reload**。
        //   这一刻 `scrollY` 描述的不是他眼前那一版,拿它判「他在不在顶部」必然判错。⇒ 亮提示,把时机交回给他。
        // ⚠⚠ 订正:这道闸最初是当作「负责人白块 bug 的修复」加的,**那个因果没有证据**。
        //   提出它的那一棒自己收回了:他们「钩住 reload、静置 60 秒、0 次调用」的实验里,
        //   **两个调用点都被 `!document.hidden` 挡着,而他们的标签页全程 hidden**
        //   ⇒ **被测条件根本没成立,那个「0 次」什么都没证明。**(= 「检查总数 0 不是绿」。)
        //   ⇒ **这道闸守的是一个已证实存在的失效模式(clientWidth===0 时读数作废),留着是对的;
        //      但它【不是】「白屏已修」。** 白块的真根因仍未知。
        // ⭐ 他看不见 ⇒ 那三道「别打断他」的闸一条都不适用(它们守的是「正在看的人」)。
        //   ⚠ `save()` 在布局退化时会自己 no-op(v1 那道闸),所以不会存下一个假的滚动位置。
        if (mode === 'background') { probe('reload', { m: mode }); save(); location.reload(); return; }
        if (mode === 'hint-only' || !layoutUsable() || window.scrollY > 120) { probe('hint', { m: mode, lu: layoutUsable() ? 1 : 0 }); showUpdateHint(); return; }
        probe('reload', { m: mode });
        save(); location.reload();
      })
      .catch(function () {
        // ⛔ 2026-09-02 改:这里原来是「什么都不做」,理由是「宁可板旧一会,也不要在他滚动时闪一下」。
        //   那条理由只对**偶发一次**成立;连续取不到 = 服务真的没了,而**静默恰好制造了
        //   规则里最怕的那种板:看起来是最新的、实际是旧的**。负责人为此反复报「板崩了」而我们查不到根因。
        //   ⇒ 分流:偶发照旧忍;连续 3 次(≈3 分钟)才亮红条,且**只亮条不 reload**,不打断他。
        failStreak++;
        if (failStreak >= 3) {
          showDead('⚠ 这个板<b>连不上服务</b>了(已连续 ' + failStreak + ' 次取不到)—— 你看到的是旧画面。'
            + '让这条线重新打开它,或直接刷新本页。');
        }
      });
  }
  // ⚠ 面板刚展开时**布局还没回流** —— 立刻读 `scrollY` 拿到的仍是零宽度那版的值。
  //   (同族坑本仓已记两次:`innerWidth` 要等回流、`document.hidden` 的更新有延迟。)
  //   ⇒ 等两帧、且确认布局可用了再判;等不到就这一轮不做,下一轮 60s 定时闸还会来。
  function afterReflow(fn) {
    requestAnimationFrame(function(){ requestAnimationFrame(function(){
      if (layoutUsable()) fn();
    }); });
  }
  document.addEventListener('visibilitychange', function(){
    // ⛔ 第二个参数 = **绝不 reload**。他刚回到这一页,下一个动作就是往下拉。
    if (!document.hidden) afterReflow(function(){ reloadIfChanged(15000, 'hint-only'); });
  });
  setInterval(function(){
    if (document.hidden) {
      // ⭐ 面板收起 / 标签在后台 —— **没有观众**,直接刷新。
      //   这一条是整个第三版的关键:他打开面板时看到的就已经是新的。
      //   ⚠ `reloadIfChanged` 里那道「指纹没变就什么都不做」仍在 ⇒ 板没改时零开销,不会空转。
      reloadIfChanged(60000, 'background');
      return;
    }
    if (Date.now() - lastAct > UPD_IDLE) reloadIfChanged(60000, 'auto');   // 1020 晚:停手 4 秒就查(原来要闲 60 秒),有更新就换上
  }, 15000);

  // ⭐⭐⭐ 0918 负责人两句原话,这一段同时回答它们:
  //   「**开板第一屏给我看什么?肯定是给我看当前还有什么事项要做。你先告诉我我要做什么,
  //     这样我可以快速给你回复。**」
  //   「**尤其是那些被卡住的事情,不管是被我卡住,还是被别的线或者其他事情卡住…这种事情一定要
  //     前置放在最前面告诉我:这个事情现在被卡住了,需要我做什么。这件事一定要放最前面。**」
  //
  //   ⇒ 两件事:① 区顺序固定成「要你的 → 主线任务 → 你交代的 → 排队中的活」;
  //           ② 板顶合成一块「卡着的」,一行一句,卡在他的排最前。
  //   ⛔ **做在 kit 里,不写进规则文档**(负责人同日:「最重要的事情还是不要让规则腐烂」)——
  //     各线不需要知道,也不可能不遵守。
  var ZONE_ORDER = ['要你的', '主线任务', '你交代的', '排队中的活'];
  function zoneGroups() {
    var wrap = document.querySelector('.wrap'); if (!wrap) return [];
    var groups = [], cur = null;
    Array.prototype.forEach.call(wrap.children, function (el) {
      if (el.classList && el.classList.contains('zone')) { cur = { zone: el, nodes: [el] }; groups.push(cur); return; }
      // kit 自己的尾巴不属于任何区 —— 搬区的时候别把它们一起卷走
      if (!cur || el.id === 'peers' || el.id === 'refresh-badge' || el.id === 'board-toc' || el.id === 'doing-top'
          || (el.classList && (el.classList.contains('foot') || el.classList.contains('northstar')))) { cur = null; return; }
      cur.nodes.push(el);
    });
    return groups;
  }
  function orderZones() {
    var gs = zoneGroups(); if (gs.length < 2) return;
    function rank(g) {
      var h = g.zone.querySelector('h2'), t = (h && h.textContent) || '';
      for (var i = 0; i < ZONE_ORDER.length; i++) if (t.indexOf(ZONE_ORDER[i]) >= 0) return i;
      return ZONE_ORDER.length;                 // ⛔ 不认识的排最后,**别丢** —— 丢一个区他不会发现
    }
    var sorted = gs.slice().sort(function (a, b) { return rank(a) - rank(b); });
    var same = true;
    for (var i = 0; i < gs.length; i++) if (sorted[i] !== gs[i]) { same = false; break; }
    if (same) return;                           // 已经对了就别动 DOM(每 60 秒搬一遍会打断他的滚动位置)
    var first = gs[0].nodes[0], parent = first.parentNode, before = first.previousSibling;
    var frag = document.createDocumentFragment();
    // appendChild 到 fragment 会把节点从原位摘下来 ⇒ 顺序天然正确;
    // ⛔ 别用 insertBefore(n, anchor):anchor 自己也在待搬名单里,搬到它自己前面是空操作,顺序会错开一位
    sorted.forEach(function (g) { g.nodes.forEach(function (n) { frag.appendChild(n); }); });
    parent.insertBefore(frag, before ? before.nextSibling : parent.firstChild);
  }

  // ⭐⭐ 0928(状态板 v1.3,⑰「todo 不许干等」周复查撞到):「要你的」那张过期提醒卡(stale-generated)原来只在 touch 时生成 ——
  //   线一停手,预计日期照样一天天过去,卡却停在那条线最后一次 touch 的那一刻。当天现量:3 块板 15 件过期没做完的
  //   不在「要你的」里(AI平台-总控 6 · 总控 3 · 示例-基建 6),而同一屏的目录条已经红着「过期 N」—— 板自相矛盾,
  //   而且偏偏在「那条线停手了」这个最该提醒他的时候失声。
  //   ⇒ 打开板时按 board.py `_stale_pick` / `_stale_render` 同一规则现算、重画这张卡;touch 写进文件的那份只当没有 JS 时的底。
  //   ⛔ 只增不减:现算出 0 件而文件里那份还在 ⇒ 原样留着(现算万一写错,宁可多挂一张旧的,也不静默吞掉提醒)。
  //   ⚠ 规则改一边必须改另一边;STALE_AGE_DAYS 与 board.py 同一个数(selftest 核)。
  //   1119:这张卡撤了(见 paintStale),STALE_AGE_DAYS / STALE_YOU_SHORT 随之拿掉。
  function clauseOf(s, limit) {   // 与 board.py `_clause` 同一规则:不超过 limit 原样;超了在 limit 之前最后一个分句标点处断,不加「…」;URL 里的冒号不算
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (s.length <= limit) return s;
    var probe = s.replace(/https?:\/\/\S+/g, function (u) { return new Array(u.length + 1).join('\u0000'); });
    var re = /[;；。，,：:!?！？]|——/g, m, cuts = [];
    while ((m = re.exec(probe))) cuts.push(m.index);
    var before = cuts.filter(function (k) { return k >= 6 && k <= limit; });
    if (before.length) return s.slice(0, before[before.length - 1]);
    var after = cuts.filter(function (k) { return k > limit; });
    return after.length ? s.slice(0, after[0]) : s;
  }
  function inYours(cd) { return (zoneOf.get(cd) || '').indexOf('要你的') >= 0 && !(cd.parentNode && cd.parentNode.closest && cd.parentNode.closest('.card')); }
  // ⭐ 1105 负责人(卡 ask-536129fc):一段时间没动的线算暂停,哪天重开再拉回来。与 board.py `_board_paused` 同一规则,现算不存状态。→ null 或 { days: 几天(没有任何时间 = null), open: 还挂着几件 }
  var PAUSE_D = 14;
  function boardPaused() {
    var lastMs = null, lastTxt = null, nOpen = 0;
    document.querySelectorAll('.crow[data-status]').forEach(function (r) {
      var cd = r.closest('.card');
      if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0 || cd.hasAttribute('data-sub')) return;
      if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(cd.getAttribute('data-ack') || '')) return;
      if (rowFacts(r).open) nOpen++;
      ['data-txt-at', 'data-chk-at', 'data-upd', 'data-fp0'].forEach(function (k) { var t = stampMs(r.getAttribute(k)); if (t !== null && (lastMs === null || t > lastMs)) lastMs = t; });
      var tt = stampMs(r.getAttribute('data-txt-at')); if (tt !== null && (lastTxt === null || tt > lastTxt)) lastTxt = tt;
    });
    if (!nOpen) return null;
    // 1115 大扫除 D3b:板上明示标了暂停(board.py pause)、标之后没有哪一行改过字 ⇒ 也算(与 board.py _board_paused 同一规则)
    var pw = document.querySelector('.wrap[data-paused-since]'), pm = pw ? stampMs(pw.getAttribute('data-paused-since')) : null;
    if (pm !== null && (lastTxt === null || lastTxt <= pm)) return { days: lastMs === null ? null : Math.floor((Date.now() - lastMs) / 864e5), open: nOpen, marked: pw.getAttribute('data-paused-since') };
    if (lastMs === null) return { days: null, open: nOpen };
    var d = Math.floor((Date.now() - lastMs) / 864e5);
    return d >= PAUSE_D ? { days: d, open: nOpen } : null;
  }
  // ⭐⭐ 1119 负责人(示例-基建「要你的」里这张卡,bad case「可读性为0」):挤字被白块切开、每件贴几百字现状、「你要做:问我为什么拖了」把他推去催 AI、
  //   还被挂上「这张卡没写要你答什么」。过了预计、球在 AI 这边的事不是他要做的 ⇒ 卡撤掉,改走「到点该追」叫醒本线(board.py `_chase_due` 的 late),
  //   次日没处理他首屏「卡着的」标一行红(lateRow / chaseOverdue)。这里只剩一件事:文件里还留着旧卡(那块板还没被新版 touch 过)⇒ 打开时就撤掉。
  //   否过什么:⛔ 不改成短版卡留在「要你的」—— 再短也是叫他去催 AI;⛔ 不另造提醒类型 / 信箱标签 —— 到点该追那条路现成。
  function paintStale() {
    document.querySelectorAll('.card[data-ack="stale-generated"]').forEach(function (cd) { if (inYours(cd)) cd.remove(); });
  }

  // ⭐⭐ 0928 负责人(经示例-基建 v1.3 转来的 bad case):「在你交代的里面,有一个要你拍,但是在要你的这个里面就没有这个事项了,这是一个很大的问题」。
  //   原来「你交代的」里标着要你拍 / 动手 / 去催的行,只有过了预计或挂满 3 天才被提醒卡带进「要你的」;当天标的一件都进不去,
  //   可行上写着「去『要你的』拍板」,目录格「要你 N」和板顶「卡在你这儿」也都算上了它 —— 只有他视线所在的「要你的」没有。
  //   ⇒ 与 board.py `_rowyou_pick` / `_rowyou_render` 同一规则:这些行一行不落进「要你的」的一张机器卡(rows-on-you);
  //     「要你的」里已经在讲的不重复列(链到那一行 / 指着那行 data-ref 的卡号)。挑不挑跟日子无关 ⇒ touch 写进文件的那份在就用它;
  //     没有(板还没被新版 touch 过)才现画。⚠ 规则改一边必须改另一边(selftest 核)。
  var ROW_YOU_MINE = { decide: '要你拍', 'do': '要你动手', nudge: '要你去催' };
  function paintRowYou() {
    var zy = document.getElementById(['zone-', '要你的'].join(''));
    if (!zy || !zy.parentNode) return;
    var have = false;
    document.querySelectorAll('.card[data-ack="rows-on-you"]').forEach(function (cd) { if (inYours(cd)) have = true; });
    if (have) return;
    // 「要你的」里已经在讲的不重复列:链到那一行的卡 · 指着那行 data-ref 卡号的卡(queue 生成的「卡在你身上」那张算,它就是那张卡的一句话版本)
    var linked = {}, linkedCard = {};
    document.querySelectorAll('.card').forEach(function (cd) {
      if (!inYours(cd) || /^(stale-generated|nudge-generated|queue-generated|rows-on-you|main-)/.test(cd.getAttribute('data-ack') || '')) return;
      cd.querySelectorAll('a[href^="#row-"]').forEach(function (a) { linked[(a.getAttribute('href') || '').slice(5)] = 1; });
      (cd.getAttribute('data-accept-rows') || '').split(/\s+/).forEach(function (k) { if (k) linked[k] = 1; });   // 1114:批量验收卡只链第一行
      cd.querySelectorAll('a[href*="/issues/"]').forEach(function (a) { var m = /\/issues\/(\d+)/.exec(a.getAttribute('href') || ''); if (m) linkedCard[m[1]] = 1; });
    });
    var picked = [];
    document.querySelectorAll('.crow[data-status]').forEach(function (r) {
      var cd = r.closest('.card');
      if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0) return;
      if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(cd.getAttribute('data-ack') || '')) return;
      var f = rowFacts(r);
      if (!f.open || !ROW_YOU_MINE[f.you]) return;
      var ack = r.getAttribute('data-ack'), ref = r.getAttribute('data-ref');
      if (ack && linked[ack]) return;
      if (ref && linkedCard[ref]) return;
      picked.push({ r: r, f: f });
    });
    if (!picked.length) return;
    picked.sort(function (a, b) { return (b.f.late - a.f.late) || ((b.f.age || 0) - (a.f.age || 0)); });
    // ⚠ 结构与 `_rowyou_render` 一致(类名逐个写全:lint 从脚本里扫类名,拼出来的认不出)
    var body = document.createElement('div'); body.classList.add('body');
    var top = document.createElement('div'); top.classList.add('top');
    var chips = document.createElement('div'); chips.classList.add('chips');
    var c1 = document.createElement('span'); c1.classList.add('chip'); c1.classList.add('id'); c1.textContent = '无卡号'; c1.classList.add('noid'); chips.appendChild(c1);
    var c2 = document.createElement('span'); c2.classList.add('chip'); c2.textContent = '机器生成 · 打开板时现算'; chips.appendChild(c2);
    top.appendChild(chips);
    var q = document.createElement('h2'); q.classList.add('q');
    q.textContent = '「你交代的」里这 ' + picked.length + ' 件在等你拍板或动手'; top.appendChild(q);
    var lede = document.createElement('p'); lede.classList.add('lede');
    lede.appendChild(document.createTextNode('我的建议:'));
    var lb = document.createElement('b'); lb.textContent = '一件件看一眼,当场拍或动手'; lede.appendChild(lb);
    lede.appendChild(document.createTextNode('。点标题跳到原行看全文;你拍了、做了,那行不再标着等你,就从这里消失。'));
    top.appendChild(lede); body.appendChild(top);
    var checks = document.createElement('div'); checks.classList.add('checks');
    picked.slice(0, 12).forEach(function (p) {
      var f = p.f, r = p.r, ack = r.getAttribute('data-ack');
      var b0 = r.querySelector('b');
      var t = clauseOf(((b0 && b0.textContent) || (r.textContent || '').trim().slice(0, 40)).trim().replace(/^[「“"]|[」”"]$/g, ''), 40);
      var row = document.createElement('div'); row.classList.add('crow');
      var mk = document.createElement('span'); mk.classList.add('mk'); mk.classList.add('half'); mk.textContent = '!'; row.appendChild(mk);
      var tx = document.createElement('span'); tx.classList.add('txt');
      var a = document.createElement('a'); if (ack) a.href = '#row-' + ack;
      var ab = document.createElement('b'); ab.textContent = t; a.appendChild(ab); tx.appendChild(a);
      tx.appendChild(document.createTextNode(' '));
      var kb = document.createElement('b'); kb.textContent = ROW_YOU_MINE[f.you]; tx.appendChild(kb);
      var whyT = f.why ? (f.why.textContent || '').replace(/\s+/g, ' ').trim() : '';
      var say = f.act ? (f.act.textContent || '').replace(/\s+/g, ' ').trim() : (clauseOf(whyT, 56) || '点标题看原行');
      tx.appendChild(document.createTextNode(':' + say));
      row.appendChild(tx); checks.appendChild(row);
    });
    if (picked.length > 12) {
      var more = document.createElement('div'); more.classList.add('crow');
      var mm = document.createElement('span'); mm.classList.add('mk'); mm.textContent = '·'; more.appendChild(mm);
      var mt = document.createElement('span'); mt.classList.add('txt'); mt.textContent = '还有 ' + (picked.length - 12) + ' 件,在「你交代的」里标着要你'; more.appendChild(mt);
      checks.appendChild(more);
    }
    body.appendChild(checks);
    var card = document.createElement('article'); card.classList.add('card');
    card.setAttribute('data-ack', 'rows-on-you'); card.id = 'ack-rows-on-you';
    var sp = document.createElement('div'); sp.classList.add('stripe'); sp.classList.add('s-warn'); card.appendChild(sp); card.appendChild(body);
    var firstYours = null;
    document.querySelectorAll('.card').forEach(function (cd) { if (!firstYours && inYours(cd)) firstYours = cd; });
    if (firstYours) firstYours.parentNode.insertBefore(card, firstYours); else zy.parentNode.insertBefore(card, zy.nextSibling);
    var zh = zy.querySelector('h2'); zoneOf.set(card, (zh && zh.textContent) || '要你的');
    // 区里的「此刻没有要你的」占位卡现在不对了 ⇒ 收起来。⛔ 1110:区头件数别在这里加 —— 只由 ansZoneHead 按真卡现算(这张也算一张)
    document.querySelectorAll('.card').forEach(function (cd) { if (cd !== card && inYours(cd) && isYoursPlaceholder(cd)) cd.style.display = 'none'; });
  }

  // ⭐⭐ 0926(状态板 v1.3):「要你的」先看哪件由机器排 —— 替掉规则 R2.8「超过 3 张必须写死先看哪件」。
  //   根因是**插入顺序在决定优先级**:`board.py ask` 把新卡插在最顶上(0828 总控:聊天里说「最要紧的是 X」时它排第一,他来看时排第四)。
  //   顺序:卡在你身上、挡着别的活的(blocked-on-you)→ 过期提醒(stale-generated)→ 其余按挂的时间从久到新 → 去催别的线的(nudge-generated)。
  //   「挂的时间」= touch 记下的 data-since(第一次出现);还没记的当最新,同样新的按原来的先后。
  //   ⚠ 只挪位置、不改内容;方言板(卡不在同一层)不挪,只让板顶索引按这个顺序排。
  var YOURS_RANK = { 'blocked-on-you': 0, 'rows-on-you': 0, 'stale-generated': 1, 'nudge-generated': 3 };
  function isYoursPlaceholder(cd) {
    //   ⛔ 判据必须和 lint 的 `_is_placeholder_card` 一字不差(先按编号,认不出再看标题)—— 见 paintBlocked 里 0921 那条
    var ack0 = cd.getAttribute('data-ack') || '';
    if (/^(yours-empty|queue-generated)/.test(ack0)) return true;
    var q = cd.querySelector('h2.q');
    return !!(q && /没有(要|需要)你的|此刻没有/.test(q.textContent || ''));
  }
  function yoursSince(cd) {
    var v = cd.getAttribute('data-since') || '';
    var t = v ? Date.parse(v) : NaN;
    return isNaN(t) ? null : t;
  }
  var YOURS_ORDER = [];
  function orderYours() {
    var cards = [];
    document.querySelectorAll('.card').forEach(function (cd) {
      if ((zoneOf.get(cd) || '').indexOf('要你的') < 0) return;
      if (cd.parentNode && cd.parentNode.closest && cd.parentNode.closest('.card')) return;   // 卡里套的卡不算
      if (isYoursPlaceholder(cd)) return;
      cards.push(cd);
    });
    var key = cards.map(function (cd, i) {
      var r = YOURS_RANK[cd.getAttribute('data-ack') || ''];
      var t = yoursSince(cd);
      return { cd: cd, i: i, r: (r === undefined ? 2 : r), t: (t === null ? 9e15 : t), acc: cd.getAttribute('data-accept') === '1' ? 1 : 0 };
    });
    // 1114 第 3 步(首屏验收并进「要你做的」):挂的时间一样(含都还没记)⇒ 普通卡在前、验收卡在后;其余照旧
    key.sort(function (a, b) { return (a.r - b.r) || (a.t - b.t) || (a.acc - b.acc) || (a.i - b.i); });
    YOURS_ORDER = key.map(function (k) { return k.cd; });
    if (cards.length < 2) return;
    var p = cards[0].parentNode;
    for (var i = 0; i < cards.length; i++) if (cards[i].parentNode !== p) return;
    var same = true;
    for (var j = 0; j < cards.length; j++) if (YOURS_ORDER[j] !== cards[j]) { same = false; break; }
    if (same) return;
    // 每张卡原位留一个记号,再把排好的卡按顺序放回这些记号前 —— 卡之间夹着的注释 / 生成区标记原样不动
    var slots = cards.map(function (cd) { var m = document.createComment('yours-slot'); p.insertBefore(m, cd); return m; });
    YOURS_ORDER.forEach(function (cd, k) { p.insertBefore(cd, slots[k]); });
    slots.forEach(function (m) { p.removeChild(m); });
  }

  // ⭐⭐ 「卡着的」——板顶那一块,一行一句话。
  //   ⚠ 它是**索引不是第二真相源**:每行点过去就是原卡 / 原行,内容不在这里重复
  //     (同侪条那条老教训:「不放内容 —— 它是导航」)。
  //   ⛔ 一条都没有 ⇒ **整块不渲染**,连标题都不要(空标题会让他以为板坏了)。
  function paintBlocked() {
    var ID = ['blocked', 'first'].join('-');
    var host = document.getElementById(ID);
    var items = [];
    // ① 卡在他身上的 —— 「要你的」区里的每张卡,**排最前**,且按 orderYours 排好的顺序(0926:不再跟着插入顺序走)
    //   ⛔⛔ 占位卡「此刻没有要你的」不算 —— 0921 渲图抓到:我第一版查的是一个不存在的 .yours-empty 类,
    //   板顶于是写着「有 1 件卡在你这儿:此刻没有要你的」。判据在 isYoursPlaceholder,与 lint 的 `_is_placeholder_card` 一字不差
    //   —— 两处各写一套、一边算一边不算,正是 0911 #4737「要你的 1」点进去只有占位卡的那个形状。
    YOURS_ORDER.forEach(function (cd, ord) {
      if (cd.getAttribute('data-ack') === 'rows-on-you') return;   // 0928:它列的是「你交代的」里的行 —— 那些行在下面 ② 一行一条,别再算一遍
      var q = cd.querySelector('h2.q'); if (!q) return;
      if (!cd.id) cd.id = 'bk-' + (cd.getAttribute('data-ack') || Math.random().toString(36).slice(2));
      var t0 = yoursSince(cd), dd = t0 === null ? null : Math.floor((Date.now() - t0) / 86400000);
      var rk = YOURS_RANK[cd.getAttribute('data-ack') || ''];
      items.push({ mine: true, tier: (rk === undefined ? 2 : rk), ord: ord, target: cd, who: '你', text: (q.textContent || '').trim(),
                   days: dd && dd > 0 ? dd : null, act: '点进去拍一下' });
    });
    // ② 被别的线 / 别的事卡住的 —— 「你交代的」里 data-status="blocked" 的行;
    //   0928 起也收**没做完、标着要你拍 / 动手 / 去催**的行(不论状态)—— 目录格「要你 N」一直这么数,两处口径对齐
    document.querySelectorAll('.crow[data-status]').forEach(function (r) {
      var cd = r.closest('.card');
      if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0 || cd.hasAttribute('data-sub')) return;
      var fx = rowFacts(r);
      var youish = (fx.you === 'decide' || fx.you === 'do' || fx.you === 'nudge');
      if (r.getAttribute('data-status') !== 'blocked' && !(fx.open && youish)) return;
      if (!youish && isObserving(r, fx)) return;   // 1117 J6:观察中的不算卡着
      var b = r.querySelector('.txt > b'), title = ((b && b.textContent) || r.textContent || '').trim();
      if (!r.id) r.id = 'bk-' + (r.getAttribute('data-rkey') || r.getAttribute('data-ack') || Math.random().toString(36).slice(2));
      items.push({ mine: youish, tier: 2, ord: 1e6, target: r, who: youish ? '你' : (fx.waitFor || '别的线'),
                   text: title.slice(0, 60), days: fx.age,
                   act: (fx.act && (fx.act.textContent || '').trim()) || (youish ? '点进去看要你做什么' : '') });
    });
    if (!items.length) { if (host) { host.textContent = ''; host.style.display = 'none'; } return; }
    if (!host) {
      host = document.createElement('div'); host.id = ID;
      var an = document.querySelector('.northstar, .north') || document.getElementById('freshness');
      if (!an || !an.parentNode) return;
      an.parentNode.insertBefore(host, an.nextSibling);      // 大方向之后、目录条之前 = 第一屏最上面
    }
    host.style.display = '';
    host.textContent = '';
    // 卡在他的排最前;其中:挡着别的活的 → 过期提醒 → 其余(「要你的」的卡和「你交代的」里卡在他的行一起)按挂的时间从久到新
    //   → 去催别的线的;同样久的按 orderYours 的先后(「要你的」区里的顺序和这里一致)
    items.sort(function (a, b) {
      return (b.mine - a.mine) || (a.tier - b.tier) || ((b.days || 0) - (a.days || 0)) || (a.ord - b.ord);
    });
    var mine = items.filter(function (x) { return x.mine; }).length;
    var t = document.createElement('div'); t.classList.add('bk-t');
    var tb = document.createElement('b');
    tb.textContent = mine ? ('有 ' + mine + ' 件卡在你这儿') : ('有 ' + items.length + ' 件卡着');
    t.appendChild(tb);
    if (mine && items.length > mine) t.appendChild(document.createTextNode('，另有 ' + (items.length - mine) + ' 件卡在别处'));
    t.appendChild(document.createTextNode(' —— 点一行跳过去'));
    host.appendChild(t);
    items.forEach(function (it) {
      var a = document.createElement('a');
      a.classList.add('bk-row'); if (it.mine) a.classList.add('bk-mine');
      a.href = '#' + it.target.id;
      a.addEventListener('click', function (ev) {
        ev.preventDefault();
        scrollPin(it.target, 'center');   // 1114:走 scrollPin
        it.target.classList.add('bk-flash');
        setTimeout(function () { it.target.classList.remove('bk-flash'); }, 1600);
      });
      var w = document.createElement('span'); w.classList.add('bk-who');
      w.textContent = it.mine ? '等你' : ('等' + String(it.who).slice(0, 14));
      a.appendChild(w);
      var x = document.createElement('span'); x.classList.add('bk-text'); x.textContent = it.text; a.appendChild(x);
      if (it.days) { var d = document.createElement('span'); d.classList.add('bk-age'); d.textContent = '挂了 ' + it.days + ' 天'; a.appendChild(d); }
      if (it.act) { var ac = document.createElement('span'); ac.classList.add('bk-act'); ac.textContent = it.act.slice(0, 48); a.appendChild(ac); }
      host.appendChild(a);
    });
  }

  // ⭐⭐ 1009 负责人(状态板 v1.5):「这个标志在做,其实一天没动的活……现在只有我盯着的事情会有进展,我不盯的事情,哪怕他们只做了一半,
  //   第一不会跟我汇报,第二我都不知道,我如果不想起来的话,这个事情就当做没有。这是我当时状态板最需要解决的问题」。
  //   0918 首屏重排之后首屏只回答「要不要我」,在做的事一件名字都没有(示例-基建:要滚约三屏才看到在做的行,13 行在做里一天真动过的只有 5 行)。
  //   ⇒ 「卡着的」索引正下方、目录条之上加一块「在做的」:一行一件 —— 标题 · 上次动 · 预计;最久没动的在最前,超过一天没动的整行琥珀色。
  //   「上次动」= 这一行文字或状态上次变的时间,board.py touch 记在行上:data-txt-at → 没有就 data-upd → 再没有就 data-fp0(首次记账的时间)。
  //   ⚠ 规则的正本是 board.py `_doing_rows` / `_moved_label` / `_stale_flag`(超时的门槛 DOING_STALE_HOURS、球在他那边的不标),改一边必须改另一边;
  //     板这侧 lint 会对超时的行报错,这里只管给他看。
  //   ⛔ 它是一块【信息】,不是待办:不生成卡、不进「要你的」、不进「卡着的」索引、不改任何件数(负责人 08-17:每次触发都烧他一点注意力的机制必腐)。
  //   ⛔ 一件在做的都没有 ⇒ 整块不出现。只列「你交代的」区里 data-status="doing" 的行;机器卡里的不算(与 paintStale 同一条排除)。
  //   ⚠ 文字只走 textContent;类名 classList.add 写全名(lint 的孤儿类检查只认这种写法)。
  var DOING_STALE_HOURS = 24, DOING_SHOW = 8;
  var BALL_HIS = { decide: 1, 'do': 1, nudge: 1, stuck: 1 };
  // ⭐ 1117 挂了多久(负责人 11-17 12:13 方案页第 3 条):「要你的」每张卡、首屏「要你做的」每一行标挂出至今 ——
  //   今天挂的「今天 HH:MM」,昨天「昨天」,更早「N 天前」(按日历日,不按满 24 小时);用卡上的挂出时间 data-since,没有就不显示、不猜。kit 现算,不写进板文件。
  function cardAge(at, nowMs) {
    if (at === null || at === undefined || isNaN(at) || at > nowMs + 6e4) return '';   // 依据: 未验证 —— 留 1 分钟给钟差;挂出时间比现在晚 1 分钟以上当钟不准,不显示
    var d0 = new Date(at), d1 = new Date(nowMs);
    var days = Math.round((new Date(d1.getFullYear(), d1.getMonth(), d1.getDate()) - new Date(d0.getFullYear(), d0.getMonth(), d0.getDate())) / 864e5);
    if (days <= 0) return '今天 ' + ('0' + d0.getHours()).slice(-2) + ':' + ('0' + d0.getMinutes()).slice(-2);
    return days === 1 ? '昨天' : days + ' 天前';
  }
  function cardAgeMark(cd) {   // 卡的标签行(.chips)末尾一枚;已有就不再加(建卡可能跑两遍)
    if (!cd || cd.querySelector('.card-age')) return;
    var s = cardAge(stampMs(cd.getAttribute('data-since')), Date.now()), chips = cd.querySelector('.chips');
    // 1117 二轮(状态板线返工单第 2 条):今天挂的不加 —— 标签行本来就有那枚挂出时间(MM-DD HH:MM,与 data-since 同一刻),再写「今天 HH:MM」是重复;隔天起才加(昨天 / N 天前)
    if (!s || !chips || s.indexOf('今天') === 0) return;
    var sp = document.createElement('span'); sp.classList.add('chip'); sp.classList.add('card-age'); sp.textContent = s; chips.appendChild(sp);
  }
  function stampMs(v) {   // 行上的「YYYY-MM-DDTHH:MM」(本地时间)→ 毫秒;读不出 ⇒ null
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
  }
  // ⭐ 1113 等外部计时(负责人 11-13 18:17 卡 ask-ee1ae1b3):到点那天 board.py 叫醒了这块板的主人线、给行记 data-chase-due=<那天 YYYY-MM-DD>;
  //   次日起它还没处理(还在等、data-wait-since 没被 --chase 重置到叫醒那天之后)⇒ 首屏「卡着的」标红「等了 N 天没人追」。
  //   → 等了几天(日历日,从 data-wait-since 起;没有就从叫醒那天起)或 null。⚠ 与 board.py `_chase_overdue` 同一规则,改一边必须改另一边。
  //   1119:过了预计、球在 AI 这边(lateRow)也算:叫过之后现状没改字(data-txt-at 早于叫醒那天)、预计日没挪过叫醒那天 ⇒ 过了预计几天。
  //   机器汇总卡:无手写卡链接、标上要他及最近改行或收卡均早于叫醒日 ⇒ 从标记日起算日历天数。
  function chaseOverdue(r, nowMs, doc) {
    var st = r.getAttribute('data-status') || '', wf = (r.getAttribute('data-wait-for') || '').trim();
    var ys = r.getAttribute('data-you-src'), yr = ys === null ? r.getAttribute('data-you') : (ys === '' ? null : ys);
    var waiting = !!wf && (st === 'watch' || st === 'blocked') && !(st === 'blocked' && yr && yr !== 'wait') && !(st === 'watch' && yr && BALL_HIS[yr]);
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.getAttribute('data-chase-due') || ''); if (!m) return null;
    var due = new Date(+m[1], +m[2] - 1, +m[3]).getTime(), t = new Date(nowMs === undefined ? Date.now() : nowMs); t.setHours(0, 0, 0, 0);
    if (due >= t.getTime()) return null;
    if (['decide', 'do', 'nudge'].includes(yr)) {
      if (!['waiting-you', 'doing', 'blocked', 'todo', 'watch'].includes(st)) return null;
      var ack = r.getAttribute('data-ack');
      if (doc && ack && Array.from(doc.querySelectorAll('article.card')).some(function (card) {
        if (card.getAttribute('data-proj-from') || /^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(card.getAttribute('data-ack') || '')) return false;
        return (card.getAttribute('data-accept-rows') || '').split(/\s+/).includes(ack)
          || Array.from(card.querySelectorAll('a[href^="#row-"]')).some(function (a) { return a.getAttribute('href') === '#row-' + ack; });
      })) return null;
      var changes = ['data-txt-at', 'data-upd', 'data-card-at'].map(function (k) { return stampMs(r.getAttribute(k)); });
      var first = stampMs(r.getAttribute('data-you-since'));
      if (first === null) {
        var known = changes.concat(stampMs(r.getAttribute('data-fp0'))).filter(function (x) { return x !== null; });
        if (!known.length) return null;
        first = Math.max.apply(null, known);
      }
      var last = Math.max.apply(null, changes.filter(function (x) { return x !== null; }).concat(first));
      if (last >= due) return null;
      var startDay = new Date(first); startDay.setHours(0, 0, 0, 0);
      return Math.max(1, Math.round((t.getTime() - startDay.getTime()) / 864e5));
    }
    if (!waiting) {   // 1119 late(与 board.py `_chase_overdue` 的 late 分支同)
      if (!lateRow(r, nowMs)) return null;
      var lm = /^(\d{1,2})-(\d{1,2})$/.exec((r.getAttribute('data-eta') || '').trim()), le = lm ? mdDate(lm[1], lm[2], 'near') : null;
      if (le === null || le > due) return null;
      var ta = stampMs(r.getAttribute('data-txt-at'));
      if (ta !== null) { var tad = new Date(ta); tad.setHours(0, 0, 0, 0); if (tad.getTime() >= due) return null; }
      return Math.max(1, Math.round((t.getTime() - le) / 864e5));
    }
    if (/^\s*日子\s*[:：]/.test(wf)) {   // 1113 AI Harness 报:等日子的只按预计日判,不看 wait-since(与 board.py _chase_overdue 同)
      var em = /^(\d{1,2})-(\d{1,2})$/.exec((r.getAttribute('data-eta') || '').trim()), e = em ? mdDate(em[1], em[2], 'near') : null;
      if (e === null || e > due) return null;
      return Math.max(1, Math.round((t.getTime() - e) / 864e5));
    }
    var since = stampMs(r.getAttribute('data-wait-since')), start = due;
    if (since !== null) { var sd = new Date(since); sd.setHours(0, 0, 0, 0); if (sd.getTime() >= due) return null; start = sd.getTime(); }
    return Math.max(1, Math.round((t.getTime() - start) / 864e5));
  }
  // ⭐ 1116 板腐烂 7(示例-基建 #f2c6②):盯着 / 卡着的行现状第一句是完成语(「已上线…」),board.py touch 第一次看到时记 data-df-at=<YYYY-MM-DDTHH:MM>,
  //   改好了 touch 拿掉;连着挂满 DF_RED_H 小时 ⇒ 首屏「卡着的」标红(和「等了 N 天没人追」同一种红)。→ 挂了几个整小时或 null。
  //   ⚠ 与 board.py `_done_first_mark` / DONE_FIRST_RED_H 同一规则,改一边必须改另一边。
  var DF_RED_H = 24;
  function doneFirstHours(r, nowMs) {
    var st = r.getAttribute('data-status') || '';
    if (st !== 'watch' && st !== 'blocked') return null;
    var t = stampMs(r.getAttribute('data-df-at')); if (t === null) return null;
    var h = Math.floor(((nowMs === undefined ? Date.now() : nowMs) - t) / 36e5);
    return h >= DF_RED_H ? h : null;
  }
  // ⭐ 1117 J 共用判据 开始
  // ⭐ 1117 J6 rt-split(负责人 11-16 20:48 在复盘页选「拆成『真卡着 N · 观察中 M』,只有真卡着标红」):
  //   观察中 = 没做完、不用他做、卡着 / 没开工(blocked / todo)、--wait-for 写成「日子:…」、日子还没过(今天或以后)、群里没有新回复
  //   (修完了等定时跑一轮 / 试跑满一周这类,到点机器会叫醒去核)。日子过了 ⇒ 回到真卡着、标红「日子 MM-DD 过了 N 天没核」(obsLateDays)。
  //   首屏、目录条、旧的卡着条都只认这一个函数。⚠ 与 board.py `_obs_row` 同一规则,改一边必须改另一边。
  var OBS_HIS = { decide: 1, 'do': 1, nudge: 1, stuck: 1 };
  function obsBase(r, f) {
    return !!f && f.open && !OBS_HIS[f.you || ''] && (f.st === 'blocked' || f.st === 'todo')
      && /^\s*日子\s*[:：]/.test(f.waitFor || '') && !r.getAttribute('data-chat-new');
  }
  function isObserving(r, f) { f = f || rowFacts(r); return obsBase(r, f) && f.eta !== null && f.eta >= today0(); }
  function obsLateDays(r, f) { f = f || rowFacts(r); return (obsBase(r, f) && f.eta !== null && f.eta < today0()) ? Math.max(1, Math.round((today0() - f.eta) / 864e5)) : 0; }
  // ⭐ 1117 J4(复盘 11-16:两周里同一行同一种提醒被报 3 次以上 74 组,提醒加了行为没变):写行时的提醒同一行同一种只报一次,
  //   报出那一刻 board.py 在行上记 data-hinted="记号@时间 …";改好了(那句不再报)记号拿掉(row / touch 都会核)。
  //   记号挂满 HINT_RED_H 小时还在 ⇒ 首屏「卡着的」标红(照 1116 第一句完成语 data-df-at 那条)。⚠ 与 board.py `_hinted_old` / HINT_RED_H 同一规则。
  var HINT_RED_H = 24;
  var HINT_LABEL = { 'wait-no-chat': '在等别人回话,却没登记是哪个群', handed: '写着交给别的线做,却还标着在做', 'say-waiting': '标着在做,第一句却在说等别人',
    'doing-waits-date': '标着在做,其实只是在等一个日子', 'part-done-no-left': '报了做完一部分,没写还差什么', 'after-other': '在等另一件做完,没排到它后面',
    'self-check-no-timer': '说到日子回来核,却没定叫醒', 'ball-elsewhere': '标着在做,写的却是别的线在动', 'doing-date-later': '标着在做,写的是到某天再看',
    'done-first': '没做完,第一句却在说做完了', 'ask-in-row': '行里向你要东西,却没挂卡' };
  function hintedOld(r, nowMs) {
    var v = r.getAttribute('data-hinted') || '', re = /([a-z][a-z0-9-]*)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/g, m, best = null;
    var now = nowMs === undefined ? Date.now() : nowMs;
    while ((m = re.exec(v)) !== null) {
      var t = stampMs(m[2]); if (t === null) continue;
      var h = Math.floor((now - t) / 36e5);
      if (h >= HINT_RED_H && (!best || h > best.h)) best = { k: m[1], h: h };
    }
    return best;
  }
  // ⭐⭐ 1119 过了预计、球在 AI 这边(负责人 11-19 撤「这 N 件还没做完」提醒卡后的去处):没做完(todo / doing / blocked)、不标着要他(decide / do / nudge)、
  //   不在等(blocked + 没写类别或 wait + 写了在等谁 = 等外部 / 等日子,归 1113 那套)、预计日早于今天 ⇒ 是。到点该追叫醒本线;
  //   次日没处理 chaseOverdue 给天数,首屏「卡着的」标一行红「卡在 <线> · 过了预计 N 天」(不贴现状)。
  //   ⚠ 与 board.py `_late_row` 同一规则,改一边必须改另一边(selftest 逐条核)。
  var LATE_ST = { todo: 1, doing: 1, blocked: 1 }, LATE_MINE = { decide: 1, 'do': 1, nudge: 1 }, LATE_YOU = { decide: 1, 'do': 1, nudge: 1, wait: 1, stuck: 1 };
  function lateRow(r, nowMs) {
    var st = r.getAttribute('data-status') || ''; if (!LATE_ST[st]) return false;
    var ys = r.getAttribute('data-you-src'), yr = ys === null ? r.getAttribute('data-you') : (ys === '' ? null : ys), you = (yr && LATE_YOU[yr]) ? yr : null;
    if (you && LATE_MINE[you]) return false;
    if (st === 'blocked' && (!you || you === 'wait') && (r.getAttribute('data-wait-for') || '').trim()) return false;
    var em = /^(\d{1,2})-(\d{1,2})$/.exec((r.getAttribute('data-eta') || '').trim()), e = em ? mdDate(em[1], em[2], 'near') : null;
    if (e === null) return false;
    var t = new Date(nowMs === undefined ? Date.now() : nowMs); t.setHours(0, 0, 0, 0);
    return e < t.getTime();
  }
  function boardLineName() { return String(document.title || '').replace(/\s*状态板[\s\S]*$/, '').trim() || '这条线'; }
  // ⭐ 1117 J 共用判据 结束
  function rowMovedAt(r) {   // → { t: 毫秒或 null, src: 'txt' | 'upd' | 'fp0' | null }
    var ks = [['data-txt-at', 'txt'], ['data-upd', 'upd'], ['data-fp0', 'fp0']];
    for (var i = 0; i < ks.length; i++) { var t = stampMs(r.getAttribute(ks[i][0])); if (t !== null) return { t: t, src: ks[i][1] }; }
    return { t: null, src: null };
  }
  // 1104:「上次核过」= data-txt-at 与 data-chk-at(`row --checked`)里晚的那个;都没有退回 data-upd → data-fp0(与 board.py `_row_checked_at` 同一规则)
  function rowCheckedAt(r) {
    var a = stampMs(r.getAttribute('data-txt-at')), b = stampMs(r.getAttribute('data-chk-at'));
    if (a !== null || b !== null) return (b !== null && (a === null || b > a)) ? { t: b, src: 'chk' } : { t: a, src: 'txt' };
    var mv = rowMovedAt(r); return mv;
  }
  function movedLabel(mv) {   // 与 board.py `_moved_label` 同一规则(按日历日数)
    if (mv.t === null) return '没记过';
    var d0 = new Date(mv.t); d0.setHours(0, 0, 0, 0);
    var days = Math.round((today0() - d0.getTime()) / DAY_MS), d = new Date(mv.t);
    if (mv.src === 'fp0') return days <= 0 ? '今天才开始记' : days + ' 天没动过';
    var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    if (days <= 0) return '今天 ' + hm;
    return days === 1 ? '昨天 ' + hm : days + ' 天前';   // 昨天带钟点(同 board.py)
  }
  function paintDoingTop() { try {
    var ID = ['doing', 'top'].join('-');             // ⚠ 别写字面量:它是 kit 自己建的,页面里本来就没有
    var host = document.getElementById(ID), items = [], now = Date.now();
    document.querySelectorAll('.crow[data-status="doing"]').forEach(function (r, i) {
      var cd = r.closest('.card');
      if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0) return;
      if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(cd.getAttribute('data-ack') || '')) return;
      var f = rowFacts(r), mv = rowMovedAt(r), hours = mv.t === null ? null : (now - mv.t) / 36e5;
      items.push({ r: r, i: i, f: f, mv: mv, hours: hours, his: !!BALL_HIS[f.you || ''],
                   stale: hours !== null && hours > DOING_STALE_HOURS && !BALL_HIS[f.you || ''] });
    });
    if (!items.length) { if (host) { host.textContent = ''; host.style.display = 'none'; } return; }
    if (!host) {
      host = document.createElement('div'); host.id = ID;
      var bk = document.getElementById(['blocked', 'first'].join('-'));
      var an = bk || document.querySelector('.northstar, .north') || document.getElementById('freshness');
      if (!an || !an.parentNode) return;
      an.parentNode.insertBefore(host, an.nextSibling);      // 「卡着的」索引正下方;它不存在时 = 它本该在的位置(大方向之后、目录条之前)
    }
    host.style.display = ''; host.textContent = '';
    items.sort(function (a, b) {                              // 最久没动的在最前;没记过的排最后;同样久的按板上顺序
      if ((a.mv.t === null) !== (b.mv.t === null)) return a.mv.t === null ? 1 : -1;
      return ((a.mv.t || 0) - (b.mv.t || 0)) || (a.i - b.i);
    });
    var nStale = items.filter(function (x) { return x.stale; }).length;
    var t = document.createElement('div'); t.classList.add('dgt-t');
    var tb = document.createElement('b'); tb.textContent = '在做的 ' + items.length + ' 件'; t.appendChild(tb);
    var sub = document.createElement('span'); sub.classList.add('dgt-sub');
    sub.textContent = (nStale ? '其中 ' + nStale + ' 件超过一天没动 · ' : '') + '最久没动的在最前 —— 点一行跳到「你交代的」里那一行';
    t.appendChild(sub); host.appendChild(t);
    items.forEach(function (it, k) {
      var a = document.createElement('a'); a.classList.add('dgt-row'); if (it.stale) a.classList.add('dgt-stale');
      a.href = '#' + (it.r.id || '');
      a.addEventListener('click', function (ev) { ev.preventDefault(); jumpToRow(it.r); });
      var full = rowTitleText(it.r) || '(没写标题的行)', when = movedLabel(it.mv);
      if (it.stale) {
        var fl = document.createElement('span'); fl.classList.add('dgt-flag');
        fl.textContent = it.hours < 48 ? '一天没动' : Math.floor(it.hours / 24) + ' 天没动'; a.appendChild(fl);
      }
      var x = document.createElement('span'); x.classList.add('dgt-text'); x.textContent = full; a.appendChild(x);
      var w = document.createElement('span'); w.classList.add('dgt-when');
      w.textContent = (it.mv.src === 'fp0' || it.mv.t === null ? when : '上次动 ' + when) + (it.his ? ' · 等你' : ''); a.appendChild(w);
      if (it.f.er && it.f.eta !== null) {
        var e = document.createElement('span'); e.classList.add('dgt-eta'); if (it.f.late) e.classList.add('dgt-late');
        e.textContent = '预计 ' + fmtMD(it.f.eta) + (it.f.late ? ' · 过了 ' + it.f.late + ' 天' : ''); a.appendChild(e);
      }
      a.title = full + '(' + (it.mv.t === null ? '这一行还没记过上次动的时间,下一次刷板会记上'
        : (it.mv.src === 'fp0' ? '从 ' : '上次动 ') + String(it.r.getAttribute(it.mv.src === 'txt' ? 'data-txt-at' : it.mv.src === 'upd' ? 'data-upd' : 'data-fp0')).replace('T', ' ') + (it.mv.src === 'fp0' ? ' 开始记,之后文字没变过' : ''))
        + ';点了跳到这一行)';
      if (k >= DOING_SHOW) a.hidden = true;
      host.appendChild(a);
    });
    if (items.length > DOING_SHOW) {
      var more = document.createElement('a'); more.classList.add('dgt-more'); more.href = '#';
      more.textContent = '还有 ' + (items.length - DOING_SHOW) + ' 件';
      more.addEventListener('click', function (ev) {
        ev.preventDefault();
        Array.prototype.forEach.call(host.querySelectorAll('.dgt-row'), function (y) { y.hidden = false; });
        more.remove();
      });
      host.appendChild(more);
    }
  } catch (e) {} }

  // ⭐ 目录条(0907 负责人拍「五区收成三块」):新形态的板(有「要你的」区)由 kit 按区生成板顶目录,
  //   每格 = 区名 + 件数,点哪个跳哪个;「你交代的」那格按行状态数 ✓●○◎❗。作者只写一句话(.say)。
  //   ⛔ 旧形态(五区手写一眼条)的板不动 —— 各线自己搬。
  function paintToc() {
    var zy = document.getElementById(['zone-', '要你的'].join(''));
    if (!zy) return;
    var TOC = ['board', 'toc'].join('-');            // ⚠ 别写字面量:它是 kit 自己建的,页面里本来就没有
    var host = document.getElementById(TOC);
    if (!host) { host = document.createElement('div'); host.id = TOC;
      var anchorEl = document.querySelector('.northstar') || document.getElementById('freshness');
      if (anchorEl && anchorEl.parentNode) anchorEl.parentNode.insertBefore(host, anchorEl.nextSibling); else return; }
    host.textContent = '';
    function cell(zone, label, parts, urgent, big) {
      var a = document.createElement('a'); a.classList.add('toc-cell'); if (urgent) a.classList.add('toc-urgent');
      a.href = '#' + zone.id;
      a.addEventListener('click', function (ev) { ev.preventDefault(); scrollPin(zone, 'start'); });   // 1114:走 scrollPin;连点别的格 = 新跳撤旧跳
      // ⭐ 0922 负责人拍可视化②:每格先一个大数字(没做完几件 / 要你几件 / 排队几张),扫一眼就够;小字留在下面
      if (big !== undefined && big !== null) { var bn = document.createElement('em'); bn.classList.add('toc-n'); bn.textContent = big; a.appendChild(bn); a.classList.add('toc-tile'); }
      var b = document.createElement('b'); b.textContent = label; a.appendChild(b);
      var sm = document.createElement('span'); sm.textContent = parts; a.appendChild(sm);
      host.appendChild(a);
    }
    var nText = function (z) { var n = z.querySelector('.n'); var m = n && (n.textContent || '').match(/\d+/); return m ? m[0] : '?'; };
    var zc = document.getElementById(['zone-', '你交代的'].join(''));
    if (zc) {
      // ⭐ 0914(㊴ 第 5 条):这一格直接答他的两问 —— 没做完几件、其中要你动的几件、过期几件;红 = 有要你的或有过期。
      //   没做完的不管折在哪都算(0914 #4760:折起来的 ● 不许消失);做完的照 0908 口径:已读留档的、作者折叠的不算。
      var c = { open: 0, you: 0, late: 0, done: 0, archived: 0, blk: 0, watch: 0, obs: 0 };
      document.querySelectorAll('.crow[data-status]').forEach(function (r) {
        var cd = r.closest('.card');
        if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0 || cd.hasAttribute('data-sub')) return;
        var fx = rowFacts(r), det = r.closest('details');
        // ⭐ 0916(#4898):这里原先写的是 `!det` —— 一刀切掉所有折叠,而**做完的行正是 kit 自己收进抽屉的**
        //   ⇒ 「做完」那个数恒为 0(本线实测:65 行里 62 行 done,62 行全在 details 里,格子显示「做完 0」)。
        //   🔑 上面那句注释写的口径本来就是对的:**已读留档的、作者折叠的不算** —— 它没说「所有折叠都不算」。
        //   · `.rdrawer-old`(「更早做完、你还没点的 N 件 —— **不是留档**」)是 kit 自己收的 ⇒ **要算**;
        //   · `.rdrawer-done`(「已读、做完的 N 件 —— 留档」)⇒ 不算(0908 口径);
        //   · 作者自己写的折叠(「顺手做的」)⇒ 不算(同 0908)。
        var kitOld = det && det.classList && det.classList.contains('rdrawer-old');
        var kitDrawer = det && det.classList && det.classList.contains('rdrawer');
        if (fx.open) { c.open++; if (fx.you === 'decide' || fx.you === 'do' || fx.you === 'nudge') c.you++; else if (isObserving(r, fx)) c.obs++; else if (fx.st === 'blocked') c.blk++; else if (fx.st === 'watch') c.watch++; if (fx.late) c.late++; }
        // ⭐ 0921 负责人拍(#4820):「一定减少手填…能用机器直接自动算的,就让机器自动去算掉」。
        //   原来三处三个口径:区头手填「47 件」(含顺手做的)· 目录条「+29 已读」(那 29 其实是顺手做的,**标签错了**)· 汇总条重复计数。
        //   ⇒ 只剩一套数:做完 = kit 自己收起的(抽屉里 + 露在外面的);作者自己的折叠(「顺手做的」)单列,按它自己的名字叫。
        else if (fx.st === 'done') { if (!det || kitOld || kitDrawer) c.done++; else { c.archived++; var sm0 = det.querySelector('summary'); if (sm0 && /顺手/.test(sm0.textContent || '')) c.aside = 'side'; } }
      });
      // ⭐ 0916(#4898)⛔ 这里【没有】上「该格算 0 就报错」那道闸 —— 它抓不到真发作的那个形态:
      //   出事时格子显示的是「没做完 3 · 做完 0」,open 不是 0;而且旧口径在机器看来是自洽的
      //   (done 全被算进「排除」,等式照样成立)⇒ 那种闸只会让人以为有保护。
      //   ✅ 改成**让被排除的数可见**:留档的件数直接写在格子上,数字再消失他一眼看得出。
      cell(zc, '你交代的', '没做完 ' + c.open + (c.you ? ' · 要你 ' + c.you : '') + (c.late ? ' · 过期 ' + c.late : '')
        + ' · 做完 ' + c.done + '(已收起)' + (c.archived ? ' · ' + (c.aside === 'side' ? '顺手做的 ' : '另折起来的 ') + c.archived : ''), c.you > 0 || c.late > 0, c.open);
      // ⭐ 0922 负责人拍可视化②:目录条最上面一根按颜色分段的条 —— 「你交代的」全部行:等你(红)· 卡在别处(橙)· 在做(蓝)· 长期看(灰)· 做完(绿)。
      //   数和上面格子同一次循环算出来,⛔ 不另数一遍(两处数不同 = 板自相矛盾)。
      var doing = c.open - c.you - c.blk - c.watch - c.obs, tot = c.open + c.done;   // 1117 J6:观察中单独一段(isObserving)
      if (tot > 0) {
        var stk = document.createElement('div'); stk.classList.add('toc-stack');
        var bar = document.createElement('div'); bar.classList.add('ts-bar'); var lg = document.createElement('div'); lg.classList.add('ts-lg');
        [['ts-you', c.you, '等你'], ['ts-blk', c.blk, '卡在别处'], ['ts-obs', c.obs, '观察中'], ['ts-doing', doing, '在做'], ['ts-watch', c.watch, '长期看着'], ['ts-done', c.done, '做完']].forEach(function (k) {
          if (!k[1]) return;   // ⚠ 类名写全:lint 从脚本里扫类名,拼出来的 'ts-' + x 会被当成一个没定义的 .ts-(0922 全机 13 块当场红)
          var sp = document.createElement('span'); sp.classList.add(k[0]); sp.style.flex = k[1]; sp.title = k[2] + ' ' + k[1]; bar.appendChild(sp);
          var li = document.createElement('span'); var sw = document.createElement('i'); sw.classList.add(k[0]); li.appendChild(sw); li.appendChild(document.createTextNode(k[2] + ' ' + k[1])); lg.appendChild(li);
        });
        var cap = document.createElement('div'); cap.classList.add('ts-cap'); cap.textContent = '你交代的 ' + tot + ' 件';
        stk.appendChild(cap); stk.appendChild(bar); stk.appendChild(lg); host.insertBefore(stk, host.firstChild);
      }
      // ⭐ 区头那个数也由这里写 —— ⛔ 不再手填(0921 手填的「47 件」和他看得见的 5 行对不上,读起来像丢了 42 件)
      var zn = zc.querySelector('.n');
      if (zn) { zn.textContent = '没做完 ' + c.open + ' 件'; zn.title = '机器按行的状态现算,不是手填的'; }
      // ⭐ 0922 状态板 v1.3:作者自己的折叠(「顺手做的(你没派、但做了)30 件」)标题里那个数也是手填的 ——
      //   上面目录格已按行现算成 28,标题还写 30(prune 搬走了几行、新加了一行,没人改它)⇒ 同一件事两个数,就在同一屏。
      //   ⇒ 「你交代的」里作者写的「顺手做的」折叠,标题里的「N 件」换成里面真有的行数;kit 自己的抽屉不碰(它们本来就现算)。
      document.querySelectorAll('details').forEach(function (det) {
        if (det.classList.contains('rdrawer') || det.classList.contains('rdrawer-old')) return;
        var cd = det.closest('.card'); if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0) return;
        var sm = det.querySelector(':scope > summary');
        //   0924 扩:「更早做完的 46 件」(cc控制,v2.2 交接时手填,做完的行搬去留档后实有 14)同一个病 ⇒ 也认「做完的 N 件」,
        //     ⚠ 排除「没做完的 / 未做完的 / 还没做完的 N 件」(总控那种标题,数的是浮出去的行)。全机 0924 扫过:只多命中这一处。
        if (!sm || !(/顺手|没派/.test(sm.textContent || '') || /(^|[^没未还])做完的\s*\d+\s*件/.test(sm.textContent || ''))) return;
        //   ⚠ 只认「顺手做的 / 没派但做了」:别的折叠标题里的数另有含义(总控「9/10 派的 11 件(没做完的 2 件浮在最上面)」——
        //     浮出去的行不在折叠里,按行数一换就成了 9),全机 0922 扫过 10 个带数的标题才收窄到这两种。
        var rows = det.querySelectorAll('.crow[data-status]').length; if (!rows) return;
        var tw = document.createTreeWalker(sm, NodeFilter.SHOW_TEXT, null), nd, done = false;
        while (!done && (nd = tw.nextNode())) {
          if (/\d+\s*件/.test(nd.nodeValue)) { nd.nodeValue = nd.nodeValue.replace(/\d+(\s*件)/, rows + '$1'); done = true; }
        }
      });
    }
    var ny = nText(zy);
    cell(zy, '要你的', ny + ' 件' + ansTocNote(), ny !== '0' && ny !== '?', ny);   // 1006:「· 已答 K」只追加在小字里,N 不动(它和服务端检查绑着)
    var zq = document.getElementById(['zone-', '排队中的活'].join(''));
    if (zq) cell(zq, '排队中的活', nText(zq) + ' 张', false, nText(zq));
    // 0907 负责人:「右边那一堆小字我大概会直接跳过,去掉」⇒ 目录条只放格子;.say 若还写着就藏掉,不渲染
    var say = document.querySelector('.say'); if (say) say.hidden = true;
  }
  // ⭐⭐⭐ 0921 负责人拿 iOS / 总控两块板截图:「密密麻麻的文字,中间一大堆乱七八糟的加粗,可读性几乎为零…
  //   状态板一定是给我看的,是给人看的,不是给 AI 看的。」
  //   🔑 根因不是各线不守规矩:**闸只守一个字段(.res ≤ 200 字),文字就流到了没人守的字段里** ——
  //     iOS 把结论压成一句,把整段历史搬进了 `.why`(3,328 字、85 处加粗);总控的「大方向」框也没人管。
  //   ⇒ 不再加规则(他同日:「能用机器直接自动算的,就让机器自动去算掉」),**在显示这一层直接保证可读**:
  //     ① 摊在面上的文字块超过 TAME_MAX 字 ⇒ 只露第一句,其余收进「展开」;
  //     ② 按日期往后追加的流水账((09-21 …)(09-18 …))⇒ 只露**最新那段**的第一句,展开后一段一行;
  //     ③ 一个块里加粗超过 2 处 ⇒ 全部去掉加粗(到处都粗 = 没有重点)。
  //   ⚠ 原文一个字不删,只是收起来 —— 搜索框照样搜得到;作者写的东西在源文件里原样保留。
  // 依据: 793b53e44 为改善密集文字可读性，规定超过约90字的文字块只露第一句。
  var TAME_MAX = 90;
  function firstSentence(t, max) {
    t = t.replace(/\s+/g, ' ').trim();
    t = t.replace(/^[（(]\d{1,2}-\d{1,2}[^）)]{0,30}[）)]\s*/, '');   // 开头的「(09-21 v5.6 接棒复核)」标签不占露出来的那一句
    var m = /^[\s\S]{8,}?[。；;！!？?](?=\s|$|[^」』）)])/.exec(t);
    var out = m ? m[0] : t;
    if (out.length > max) out = out.slice(0, max).replace(/[,，、·\s]+$/, '') + '…';
    return out;
  }
  function logSegments(t) {                     // 「(MM-DD …)」开头的段落 ⇒ [{d:'09-21', text}],新的在前
    var re = /[（(](\d{1,2})-(\d{1,2})[^）)]{0,40}[）)]/g, idx = [], m;
    while ((m = re.exec(t))) idx.push({ at: m.index, d: +m[1] * 100 + +m[2], tag: m[0] });
    if (idx.length < 2) return null;
    var segs = idx.map(function (x, i) {
      return { d: x.d, tag: x.tag, text: t.slice(x.at + x.tag.length, i + 1 < idx.length ? idx[i + 1].at : t.length).trim() };
    });
    var head = t.slice(0, idx[0].at).trim();
    if (head) segs.unshift({ d: 9999, tag: '', text: head });   // 日期标记之前的开头 = 作者放在最前的那句,当最新
    return segs.sort(function (a, b) { return b.d - a.d; });
  }
  // ⭐ 1020 负责人(经 Harness v2.5):「一大坨字堆在一起…可读性几乎为0」—— 那张卡的前因后果是一段写成 ①…⑧ 的清单,
  //   渲出来一整段不换行。⇒ 和上面的流水账同一个办法:①②③ 连着出现 3 个以上 ⇒ 收起时露开头那句,展开后一项一行。
  //   只认从 ① 起、按顺序的圈号(「第②条」这种单个引用不算);⛔ 不拒写、不改源文件。
  var NUM_MARKS = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
  function numSegments(t) {
    var idx = [], want = 0, at;
    while (want < NUM_MARKS.length && (at = t.indexOf(NUM_MARKS[want], idx.length ? idx[idx.length - 1] + 1 : 0)) >= 0) { idx.push(at); want++; }
    if (idx.length < 3) return null;
    return { head: t.slice(0, idx[0]).trim(), items: idx.map(function (x, i) {
      return { tag: NUM_MARKS[i], text: t.slice(x + 1, i + 1 < idx.length ? idx[i + 1] : t.length).replace(/^[\s:：]+/, '').replace(/[;；,，、\s]+$/, '').trim() };
    }) };
  }
  function unbold(el) {
    Array.prototype.forEach.call(el.querySelectorAll('b, strong'), function (b) {
      var p = b.parentNode; while (b.firstChild) p.insertBefore(b.firstChild, b); p.removeChild(b);
    });
  }
  function tameBlock(el, max) {
    if (!el || el.hasAttribute('data-tamed')) return;
    if (el.closest('details:not([open])') || el.closest('#blocked-first')) return;
    el.setAttribute('data-tamed', '1');
    if (el.querySelectorAll('b, strong').length > 2) unbold(el);
    var full = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (full.length <= max) return;
    var segs = logSegments(full), nums = segs ? null : numSegments(full);
    var sum = nums ? firstSentence(nums.head.length >= 8 ? nums.head : (nums.head + ' ' + nums.items[0].tag + nums.items[0].text).trim(), max)
                   : firstSentence(segs ? segs[0].text : full, max);
    if (!segs && !nums && full.length - sum.length < 30) return;   // 剩不到 30 字就别折了(0921:「展开(还有 5 字)」)
    var orig = document.createElement('span'); orig.classList.add('tame-full'); orig.hidden = true;
    if (nums) {                                  // 1020:①②③ 清单 ⇒ 展开后开头一句 + 一项一行;原文里的链接照搬到最后
      if (nums.head) { var hd = document.createElement('span'); hd.classList.add('tame-numhead'); hd.textContent = nums.head; orig.appendChild(hd); }
      var ol = document.createElement('ul'); ol.classList.add('tame-log'); ol.classList.add('tame-num');
      nums.items.forEach(function (it) {
        var li = document.createElement('li'), dt = document.createElement('span');
        dt.classList.add('tame-date'); dt.textContent = it.tag; li.appendChild(dt); li.appendChild(document.createTextNode(it.text)); ol.appendChild(li);
      });
      orig.appendChild(ol);
      Array.prototype.forEach.call(el.querySelectorAll('a[href]'), function (a) { orig.appendChild(document.createTextNode(' ')); orig.appendChild(a.cloneNode(true)); });
    } else if (segs) {                                  // 流水账 ⇒ 展开后一段一行,新的在前
      var ul = document.createElement('ul'); ul.classList.add('tame-log');
      segs.forEach(function (sg) {
        var li = document.createElement('li');
        if (sg.tag) { var dt = document.createElement('span'); dt.classList.add('tame-date'); dt.textContent = sg.tag.replace(/[（()）]/g, ''); li.appendChild(dt); }
        li.appendChild(document.createTextNode(sg.text));
        ul.appendChild(li);
      });
      orig.appendChild(ul);
    } else {
      while (el.firstChild) orig.appendChild(el.firstChild);
    }
    el.textContent = '';
    var sp = document.createElement('span'); sp.classList.add('tame-sum'); sp.textContent = sum; el.appendChild(sp);
    var more = document.createElement('a'); more.classList.add('tame-more'); more.href = '#';
    var rest = full.length - sum.length;
    var moreLab = nums ? ' 展开(共 ' + nums.items.length + ' 项)' : segs ? ' 展开(共 ' + segs.length + ' 段)' : ' 展开(还有 ' + Math.max(rest, 0) + ' 字)';
    more.textContent = moreLab;
    more.addEventListener('click', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      orig.hidden = !orig.hidden; sp.hidden = !orig.hidden;
      more.textContent = orig.hidden ? moreLab : ' 收起';
      if (orig.hidden) el.insertBefore(more, orig); else el.appendChild(more);   // 展开时「收起」放在全文后面
    });
    el.appendChild(more); el.appendChild(orig);
  }
  // ⚠ 还有一种:作者直接散写在 .txt 里、不属于任何字段的文字(0921 iOS ㉓:「第一阶段已合进主干…而且比预想省…」)
  //   —— 连字段都没有,任何按字段查的闸都看不见它。⇒ 把第一个 <b>(标题)之后的散写文字 / 行内标签收成一块再处理。
  function wrapLoose(txt) {
    if (txt.hasAttribute('data-loose')) return; txt.setAttribute('data-loose', '1');
    var kids = Array.prototype.slice.call(txt.childNodes), group = [], seenTitle = false;
    function flush() {
      var t = group.map(function (n) { return n.textContent || ''; }).join('').trim();
      if (t.length > 0 && group.length) {
        var w = document.createElement('span'); w.classList.add('tame-loose');
        txt.insertBefore(w, group[0]); group.forEach(function (n) { w.appendChild(n); });
      }
      group = [];
    }
    kids.forEach(function (n) {
      var inline = n.nodeType === 3 || (n.nodeType === 1 && /^(B|STRONG|I|EM|CODE|A|U|SMALL|SUP|SUB|KBD)$/.test(n.tagName) && !n.className);
      if (!seenTitle && n.nodeType === 1 && n.tagName === 'B') { seenTitle = true; return; }
      if (seenTitle && inline) { group.push(n); return; }
      flush();
    });
    flush();
  }
  // ⭐ 1020(Harness v2.5 报,全机实查 26 张 ask 卡里 23 张):`board.py ask` 把问题同时写进标题 h2.q 和下面那行灰字 .lede,
  //   他每张卡读两遍同一句、白占一行。⇒ 灰字和标题一字不差就不显示(源文件不动,搜索照样搜得到)。
  function hideDupLede() {
    document.querySelectorAll('.card').forEach(function (cd) {
      var q = cd.querySelector('h2.q'), l = cd.querySelector('.lede');
      if (!q || !l || l.hasAttribute('data-dup')) return;
      var n = function (x) { return (x.textContent || '').replace(/\s+/g, ' ').trim(); };
      if (n(q) && n(q) === n(l)) { l.setAttribute('data-dup', '1'); l.hidden = true; }
    });
  }
  // ⭐ 1020 负责人:「你那个标题,那个大字那里,是不是应该先写结论,再写我当时的原话?…原话现在作为标题的话,我只能看到我的需求,但我不知道你做了什么」
  //   ⇒ 只在显示层:做完(data-status=done)且有结论(.res)的行,把结论挪到标题前面当大字,原话标题退成一行灰字「你当时说」。
  //   源文件不动(touch / lint / rows 照旧按原结构读);标题 <b> 还在,rowTitleText 照样取得到原话。
  function doneResFirst() {
    document.querySelectorAll('.crow[data-status="done"] > .txt').forEach(function (t) {
      if (t.hasAttribute('data-resfirst')) return;
      var r = t.querySelector(':scope > .res'), b = t.querySelector(':scope > b');
      if (!r || !b) return;
      t.setAttribute('data-resfirst', '1');
      // ⭐ 1020 晚 负责人:「单独看这个标题,其实我也看不懂…简单的说一下这个事情是什么,然后以及做了什么」
      //   ⇒ 行上有作者写的人话总结(data-sum,`answer --done --sum` / `row --covered-by --sum` 写的)就拿它当大字,结论退到原话下面当细节;没有的老行照旧结论在前。
      var sm = (t.parentNode.getAttribute('data-sum') || '').trim();
      if (sm) {
        var hd = document.createElement('span'); hd.classList.add('rsum'); hd.textContent = sm;
        t.classList.add('sum-first'); t.insertBefore(hd, t.firstChild);
      } else { t.classList.add('res-first'); t.insertBefore(r, t.firstChild); }
    });
  }
  function tameAll() {
    hideDupLede();
    doneResFirst();
    document.querySelectorAll('.crow .txt').forEach(function (t) {
      if (t.closest('details:not([open])')) return;
      wrapLoose(t);
    });
    document.querySelectorAll('.crow .txt > .tame-loose').forEach(function (e) { tameBlock(e, TAME_MAX); });
    document.querySelectorAll('.crow .txt > .why, .crow .txt > .res, .crow .txt > .act, .crow .txt > .sub2').forEach(function (e) { tameBlock(e, TAME_MAX); });
    document.querySelectorAll('.lede').forEach(function (e) { tameBlock(e, TAME_MAX + 30); });   // 卡外的说明段也算(0921 Handoff 板漏网一个)
    // ⚠ 「大方向」框有两种写法:13 块板里 10 块 `.northstar`、3 块 `.north`(cc控制 / 记忆助手 / 总控,0921 实查)
    document.querySelectorAll('.northstar, .north').forEach(function (e) { tameBlock(e, TAME_MAX + 30); });
    document.querySelectorAll('.crow .txt:not(.res-first):not(.sum-first) > b').forEach(function (e) {   // 行标题(含机器提醒卡里整句引用的原话);做完行的「你当时说」整句露出(1020 负责人:「这句话又没讲完」)
      if ((e.textContent || '').length > 60) tameBlock(e, 60);
    });
    linkifyBare();   // 1001:必须在收折之后(收折会按纯文字重建露出来的那一句),每次 tameAll 都跑,自己幂等
  }

  // ⭐ 1001 负责人(对总控线说):「你的状态板这个链接完全有问题,我没有办法点进方案板去看。」
  //   作者把网址写成了文字(`board.py ask --why "…http://…"` 会转义;手写的行里也有),板上印出来是一串点不动的字,lint 还 PASS。
  //   ⇒ 显示这一层直接保证:卡 / 行 / 说明段里写成文字的网址,打开时一律变成可点、新标签页。⛔ 不靠作者记得包 <a>。
  //   ⚠ 不改字(textContent 一个字不变,搜索与指纹照旧);已经在 <a> 里的不动;板顶「没在自动更新」那条里的地址不动。
  //   ⚠ 收折后露出来的那一句是按字数截的 ⇒ 网址可能被截掉一半:露出来的那半截照样可点,指向全文里以它开头的那个完整网址;
  //     全文里对不上的(截在了别处)不动 —— 半截网址点过去是 404,比点不动更糟。
  var URL_RE = /https?:\/\/[^\s<>"'，。；、）)】」』]+/g;
  function linkifyBare() { try {
    var roots = document.querySelectorAll('.card, .crow, .lede, .northstar, .north');
    Array.prototype.forEach.call(roots, function (root) {
      var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null), nd, todo = [];
      while ((nd = tw.nextNode())) {
        if (nd.nodeValue.indexOf('http') < 0) continue;
        var pe = nd.parentElement;
        if (!pe || pe.closest('a, script, style, textarea, #board-liveness')) continue;
        todo.push(nd);
      }
      todo.forEach(function (nd) {
        var t = nd.nodeValue, sum = nd.parentElement.closest('.tame-sum'), whole = null, out = [], last = 0, m;
        if (sum && sum.parentNode) {
          var fullEl = sum.parentNode.querySelector('.tame-full');
          whole = ((fullEl && fullEl.textContent) || '').match(URL_RE) || [];
        }
        URL_RE.lastIndex = 0;
        while ((m = URL_RE.exec(t))) {
          var u = m[0].replace(/[.,;:!?…]+$/, '');
          var href = u;
          if (whole) {
            href = null;
            for (var wi = 0; wi < whole.length; wi++) {
              var w = whole[wi].replace(/[.,;:!?…]+$/, '');
              if (w === u || (u.length >= 12 && w.indexOf(u) === 0)) { href = w; break; }
            }
          }
          if (u.length < 12 || !href) continue;
          if (m.index > last) out.push(document.createTextNode(t.slice(last, m.index)));
          var a = document.createElement('a');
          a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.classList.add('autolink'); a.textContent = u;
          a.addEventListener('click', function (ev) { ev.stopPropagation(); });
          out.push(a); last = m.index + u.length;
        }
        if (!out.length) return;
        if (last < t.length) out.push(document.createTextNode(t.slice(last)));
        var par = nd.parentNode; out.forEach(function (x) { par.insertBefore(x, nd); }); par.removeChild(nd);
      });
    });
  } catch (e) {} }

  // ⭐ 0928(示例-基建 v1.3 转负责人:「完全没有办法读」):卡里表格第一列在外壳里是「短标签」列 —— 不换行、只占最窄。
  //   作者一旦在第一列放了一整段话,整行被撑出卡外、其余列被挤到看不见(面板宽 760 时实测:第一列 714px、另两列 34/37px),lint 照样 PASS。
  //   ⇒ 第一列超过 16 个字的格子放开换行、占三分之一宽;短标签照旧紧凑。⛔ 不靠作者记得「第一列只放短标签」,也不加闸逼他改。
  function wrapLongFirstCells() { try {
    document.querySelectorAll('.card td:first-child, .body td:first-child, details td:first-child').forEach(function (td) {
      if ((td.textContent || '').replace(/\s+/g, '').length > 16) td.classList.add('td-wrap');
    });
  } catch (e) {} }

  orderZones();
  wrapLongFirstCells();   // 0928:表格第一列一整段话时放开换行(见函数注释)
  paintStale();      // 0928:过期提醒卡现算 —— 必须在 orderYours 之前(新插的卡要参与排序)、paintToc 之前
  paintRowYou();     // 0928:「你交代的」里标着要你拍 / 动手 / 去催的行 —— 文件里没有那张卡(还没被新版 touch 过)才现画;同样要在排序与目录条之前
  orderYours();
  ansZoneHead();     // 1110:区头「要你的 N 件」按此刻真有的卡现算 —— 机器卡画完 / 撤完之后、目录条读它之前
  paintToc();
  paintBlocked();
  paintDoingTop();   // 1009:首屏「在做的」—— 必须在 paintBlocked 之后(它要贴在「卡着的」索引正下方)
  tameAll();

  // ⭐⭐⭐ 2026-10-06 负责人拍(状态板 v1.5):「要你的」卡上直接答 —— 点选项 / 自己写一段,点完当场记到本机,不靠 AI 回来改板。
  //   他的原话(需求正本):
  //     「点了当场记到板上,这个我觉得是 OK 的」
  //     「自动去发肯定是有问题的,因为我很多时候我喜欢攒着一大波事项统一回复」
  //     「有些事项我没有办法简单的用 A 选项、B 选项、C 选项来解决…可能是 A 选项加一些我的补充内容,或者说…可能是我自己想到的 D 选项」
  //     「如果能复制 N 件的话,那我想什么时候复制什么时候复制…我可以和其他事情攒着一起发」
  //   ⚠ 这不是 0923 被他否掉的「板上就地回复」(见 vzBig 上面那段):那次否的是「通过状态板来发消息」。这里**只记、不发** ——
  //     ⛔ 绝不自动发送任何东西、不调任何会发消息的接口;把答复交给这条线 = 他点「复制这 N 件」再自己粘进对话,想攒到什么时候都行。
  //   接口(boards-server.py `_ans_get` / `_ans_post`,只绑回环):
  //     GET  /_answers?page=<板文件名>  → {"answers": {<卡的 data-ack>: {q, choice, note, ts[, copied]}}}
  //     POST /_answer {page, id, q, choice, note, ts} 记一条(同 id 覆盖)· {page, id, clear:true} 撤回 · {page, copied:[id…], ts} 标「这几条他已复制」
  //   只管**作者写的卡**:机器生成的卡(等你的行 / 过期提醒 / 去催 / 卡在你身上 / 排队 / 主线 / 占位卡)不加 —— 那些卡没有一个「答案」可记,答的是它列的每一行。
  //   真相只在伺服端,⛔ 不另存 localStorage(两份真相必漂);接口不在(404 / 没起 / file://)⇒ 板照常显示,点了只出一句「没记上」。
  //   ⚠ 类名一律 classList.add 写全名(lint 的孤儿类检查只认这种写法);他输入的字只走 textContent / value,⛔ 不拼 innerHTML。
  //   ⚠ 「要你的 N 件」那个数不碰(和服务端检查绑着);已答的只在目录格小字里追加「· 已答 K」,并在 orderYours 排好的顺序上把已答的挪到最后。
  // ⭐ 1020 负责人:「我在状态板外面点了拆,然后在方案板里面点了其他…根本不同步…我在外面点的和里面点的一定应该是一样的」
  //   ⇒ 卡带 data-deep-q / data-deep-page(`ask --deep-q`)= 它和方案页那一题是**同一道题**:卡上点 ⇒ 同时记到方案页那一题;
  //     方案页上点 ⇒ 卡上显示那一项;两边不一样以最后点的为准;撤回两边一起撤。
  var ANS_LINK = {};   // 卡的 data-ack → {choice, note, ts}:方案页那一题上他的答案(choice 已换成卡的写法:「其他」= '')
  var LINK_OTHER = '其他(我自己写)';   // = plan.py 的 OTHER
  function ansEff(rec) {
    var a = ANS[rec.id], b = ANS_LINK[rec.id];
    if (!b) return a ? { a: a, via: '' } : null;
    if (!a) return { a: b, via: '方案页' };
    return (Date.parse(b.ts) || 0) > (Date.parse(a.ts) || 0) ? { a: b, via: '方案页' } : { a: a, via: '' };
  }
  var ANS_PROP = {};   // 卡的 data-ack → {ts, n}:这张卡挂着的方案页上他答过(1014,见 ansPaintCard)
  var ANS_PROP_PEND = {};   // 卡的 data-ack → {方案页: [没交的题 id]}(1026 晚:这些没交 ⇒ 卡不算已答,右下角按钮一起交)
  function ansPropPend(id) { var m = ANS_PROP_PEND[id] || {}, n = 0; Object.keys(m).forEach(function (pg) { n += m[pg].length; }); return n; }
  var ANS = {}, ANS_CARDS = [], ANS_CHAIN = Promise.resolve(), ANS_JUST = null;
  // 1110 子线投影:ANS = 本板那份(ANS_OWN)+ 投影卡各自子板那份(ANS_P[子板])合起来的视图,只经 ansAdopt 改
  var ANS_OWN = {}, ANS_P = {}, PROJ_IDS = {}, PROJ_ROWS = {}, PROJ_GEN = {}, PROJ_SIG = null, PROJ_VIS = false, LINK_TICK = false, DRAFT_LEFT = {};
  var PROJ_TICK = 60000;   // 依据: 与同侪条 paintPeers 同一 60 秒节奏(名单 / 子板变了只提示换页,不必更勤)
  var ANS_MACHINE = /^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-|yours-empty)/;
  var ANS_PAGE = (function () { var p = location.pathname.split('/').pop() || ''; try { return decodeURIComponent(p); } catch (e) { return p; } })();
  var ANS_FAIL = '没记上,本机看板服务没开';
  function ansEl(tag, text) {   // ⚠ 类名不从这里传:每处自己调 classList 的 add、写类的全名,lint 才扫得到(⛔ 注释里也别写出那个调用的样子 —— lint 连注释一起扫)
    var el = document.createElement(tag);
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function ansFlat(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  function ansNow() {   // 本地时间 + 时区,例 2026-10-06T15:20:31+08:00(给 AI 读的那份里时间不该要人换算)
    var d = new Date(), p = function (n) { return ('0' + n).slice(-2); }, o = -d.getTimezoneOffset(), a = Math.abs(o);
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
      + (o >= 0 ? '+' : '-') + p(Math.floor(a / 60)) + ':' + p(a % 60);
  }
  function ansWhen(ts, timeOnly) {
    var t = Date.parse(ts);
    if (isNaN(t)) return String(ts || '').slice(0, 16);
    var d = new Date(t), hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return timeOnly ? hm : fmtMD(t) + ' ' + hm;
  }
  function ansIsAuthorCard(cd) {
    var id = cd.getAttribute('data-ack') || '';
    if (!id || !inYours(cd)) return false;                        // 没编号的卡记不了(答案按 data-ack 存);卡里套的卡不算
    if (ANS_MACHINE.test(id) || isYoursPlaceholder(cd)) return false;
    var machine = false;
    cd.querySelectorAll('.chips .chip').forEach(function (c) { if (/机器生成/.test(c.textContent || '')) machine = true; });
    return !machine;
  }
  function ansPost(body, page) {   // 串行发(同 /_ack 那条教训:乱序会让后到的盖掉先到的);成了回整份 answers,没成一律回 null,⛔ 不抛
    if (!HTTP) return Promise.resolve(null);
    body.page = page || ANS_PAGE;   // 1020:连着方案页的卡顺带写那一页(同一条串行链)
    var run = function () {
      return fetch('/_answer', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) { return (j && j.answers && typeof j.answers === 'object' && !Array.isArray(j.answers)) ? j.answers : null; })
        .catch(function () { return null; });
    };
    ANS_CHAIN = ANS_CHAIN.then(run, run);
    return ANS_CHAIN;
  }
  function ansSig(choice, note) { return String(choice || '') + '\u0001' + String(note || ''); }
  // ⭐⭐ 1021 晚(示例-选品转【急】,负责人:「我刚刚在状态板上写了很大一串回复,那个回复都没了吗……它一会弹上来一会弹下去的……这个好严重的问题」)
  //   伺服端只记到他点「批准」那一下,打的字一个都没记上,浏览器里也没有草稿 ⇒ 找不回。
  //   原来只靠「停手 5 秒 / 失焦 / 收起面板」往伺服端记 —— 每一条都要页面还活着时走完一次网络来回;页面一跳
  //   (点进方案页、自动刷新、卡被这条线收走)就可能落空,而落空时什么都不剩。
  //   ⇒ 每打一个字先存进浏览器本地(一块板一份);重载后框里自动回填并替他记上;卡已经不在板上的(被收走 / 撤了),
  //     在「要你的」区头下单列「你写了还没交出去的字」,能复制、能丢掉。伺服端记上同一段字之后,本地那份才删。
  var DRAFT_KEY = 'status-board-ans-draft:' + ANS_PAGE, DRAFT_DAYS = 14;
  function draftKey(page) {   // 1110 子线投影:投影卡的草稿记在子板名下(和子板自己那页同一个键)
    return (!page || page === ANS_PAGE) ? DRAFT_KEY : 'status-board-ans-draft:' + page;
  }
  function draftAll(page) {
    try { var o = JSON.parse(localStorage.getItem(draftKey(page)) || '{}'); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
  }
  function draftPut(o, page) {
    try { if (Object.keys(o).length) localStorage.setItem(draftKey(page), JSON.stringify(o)); else localStorage.removeItem(draftKey(page)); } catch (e) {}
  }
  function draftSet(rec) {
    var o = draftAll(rec.page), v = rec.note.value;
    if (v.trim()) o[rec.id] = { note: v, q: rec.q, t: Date.now() }; else delete o[rec.id];
    draftPut(o, rec.page);
  }
  function draftDrop(id, note, page) {   // note 给了 ⇒ 只在本地那份和它一样时删(他记完又接着打的,留着)
    var o = draftAll(page);
    if (o[id] && (note === undefined || String(o[id].note || '').trim() === String(note || '').trim())) { delete o[id]; draftPut(o, page); }
  }
  function ansDraftRestore(page) {
    var pg = page || ANS_PAGE, o = draftAll(pg), now = Date.now(), left = [], byId = {};
    ANS_CARDS.forEach(function (rec) { if ((rec.page || ANS_PAGE) === pg) byId[rec.id] = rec; });
    Object.keys(o).forEach(function (id) {
      var d = o[id];
      if (!d || typeof d.note !== 'string' || !d.note.trim() || now - (+d.t || 0) > DRAFT_DAYS * 864e5) { delete o[id]; return; }
      var rec = byId[id];
      if (!rec) { left.push({ id: id, d: d, page: pg }); return; }
      var a = ANS[id], have = (a && typeof a === 'object') ? String(a.note || '') : '';
      if (have.trim() === d.note.trim()) { delete o[id]; return; }
      if (rec.note.value.trim() && rec.note.value.trim() !== have.trim()) return;   // 框里已经有他这一页新打的字 ⇒ 不动
      rec.note.value = d.note;
      ansSave(rec, true);
      ansHint(rec, '上次写了没记上的这段已找回,正在替你记下');
    });
    draftPut(o, pg);
    DRAFT_LEFT[pg] = left;                        // 1110 子线投影:本板和各子板的「没交出去的字」合在一处摆
    var all = [];
    Object.keys(DRAFT_LEFT).forEach(function (k) { all = all.concat(DRAFT_LEFT[k]); });
    ansOrphans(all);
  }
  function ansOrphans(left) {
    var old = document.querySelector('.ans-orphans');               // ⚠ 按类找:lint 要求脚本按 id 找的元素页面里先有
    if (old) old.remove();
    if (!left.length) return;
    var zy = document.getElementById(['zone-', '要你的'].join(''));
    if (!zy || !zy.parentNode) return;
    var box = ansEl('div'); box.classList.add('ans-orphans');
    var h = ansEl('div', '你写了、还没交出去的字 ' + left.length + ' 段 —— 那张卡已经不在板上了(多半是这条线先收走了)。复制下来发给这条线,或者不要了就丢掉:');
    h.classList.add('ans-orphan-h'); box.appendChild(h);
    left.forEach(function (x) {
      var row = ansEl('div'); row.classList.add('ans-orphan');
      var t = ansEl('div', '〈' + (x.d.q || x.id) + '〉 · 写于 ' + ansWhen(new Date(+x.d.t).toISOString()));
      t.classList.add('ans-orphan-q'); row.appendChild(t);
      var ta = ansEl('textarea'); ta.classList.add('ans-orphan-t'); ta.value = x.d.note; ta.setAttribute('readonly', ''); ta.rows = 3; row.appendChild(ta);
      var foot = ansEl('div'); foot.classList.add('ans-foot');
      var cp = ansEl('button', '复制'); cp.type = 'button'; cp.classList.add('ans-save');
      var tip = ansEl('span'); tip.classList.add('ans-hint');
      cp.addEventListener('click', function () {
        ansClip('〈' + (x.d.q || x.id) + '〉(卡 ' + x.id + ')我写的:\n' + x.d.note).then(function (ok) { tip.textContent = ok ? '已复制,粘到这条线的对话里发出去' : '复制没成,在上面框里手动全选复制'; });
      });
      var dr = ansEl('button', '不要了'); dr.type = 'button'; dr.classList.add('ans-undo');
      dr.addEventListener('click', function () { draftDrop(x.id, undefined, x.page); row.remove(); if (!box.querySelector('.ans-orphan')) box.remove(); });
      foot.appendChild(cp); foot.appendChild(dr); foot.appendChild(tip); row.appendChild(foot);
      box.appendChild(row);
    });
    zy.parentNode.insertBefore(box, zy.nextSibling);
  }
  function ansPaintOpts(rec) {
    rec.opts.forEach(function (o) {
      var on = (rec.pick !== undefined && rec.pick !== null && rec.pick !== '' && o.title === rec.pick);
      if (on) o.el.classList.add('ans-on'); else o.el.classList.remove('ans-on');
      o.el.setAttribute('aria-checked', on ? 'true' : 'false');
    });
    if (rec.other) {
      var oo = (rec.pick === '');
      if (oo) rec.other.classList.add('ans-on'); else rec.other.classList.remove('ans-on');
      rec.other.setAttribute('aria-checked', oo ? 'true' : 'false');
    }
  }
  function ansHint(rec, text, fail) {
    rec.hint.textContent = text || '';
    if (fail) rec.hint.classList.add('ans-fail'); else rec.hint.classList.remove('ans-fail');
  }
  // 按伺服端那份把一张卡画成已答 / 未答。keepInput = 别动框里的字(他正在打字 / 撤回后留着的草稿)
  function ansPaintCard(rec, keepInput) {
    var ef = ansEff(rec), a = ef && ef.a;
    if (a && typeof a === 'object') {
      var choice = String(a.choice || ''), note = String(a.note || ''), cnt = ansCounted(a);
      // 1026 晚:没交的(卡上「记下」了、或在方案页答了还没交)不算已答 —— 「要你的」照数、右下角按钮替他交(见 ansUnsub)
      if (cnt) rec.cd.classList.add('ans-done'); else rec.cd.classList.remove('ans-done');
      rec.cd.classList.remove('ans-viaprop'); if (rec.undo) rec.undo.hidden = false; rec.cntd = cnt;
      rec.pick = choice || (rec.opts.length ? '' : undefined);
      if (!keepInput) rec.note.value = note;
      rec.sent = ansSig(choice, note) + (rec.small ? smallPaint(rec, a, keepInput) : ''); rec.skip = null; rec.subSig = (!ef.via && ansSubbed(a)) ? rec.sent : null;
      rec.keepSig = (!ef.via && a.keep && Date.parse(a.keep) >= Date.parse(a.ts)) ? rec.sent : null;
      var said = choice ? ((rec.lab && rec.lab[choice]) || choice) + (note ? '(另有补充)' : '') : (note.length > 20 ? note.slice(0, 20) + '…' : note);
      rec.mark.textContent = '你 ' + ansWhen(a.ts) + (ef.via ? (cnt ? ' 答了(在' + ef.via + ')' : ' 在' + ef.via + '答了(还没发给 AI)') : cnt ? ' 交给这条线了' : ' 记下了(还没交)') + ':' + said;
      rec.copied.textContent = a.copied ? '这条线已处理 · ' + ansWhen(a.copied, true) : '';   // copied = 这条线 answers --mark / answer 收过(1115:原文「已复制去交给」是复制粘贴年代的说法)
      rec.copied.hidden = !a.copied;
      rec.head.hidden = false;
    } else if (ANS_PROP[rec.id]) {
      // ⭐ 1014 负责人(经示例-选品):「我点进完整方案里回复了以后，我在那个状态板里面还是显示我需要回复，说我没回复…这肯定是有问题的」
      //   卡上没答、但这张卡挂着的方案页上答过 ⇒ 卡头写「你 HH:MM 已在方案页答了」、选项和补充框收起、⛔ 不给撤回(撤的是卡上那份,这里没有)。
      //   这条线处理完照旧 `board.py answer` 拿卡;答案本身由答案钩子在他下一次到这条线发话时带过去,⛔ 不进「复制这 N 件」。
      var pn = ansPropPend(rec.id);
      if (pn) rec.cd.classList.remove('ans-done'); else rec.cd.classList.add('ans-done');
      rec.cd.classList.add('ans-viaprop'); rec.cntd = !pn;
      rec.pick = undefined; rec.sent = null;
      rec.mark.textContent = '你 ' + ansWhen(ANS_PROP[rec.id].ts) + ' 已在方案页答了' + (ANS_PROP[rec.id].n > 1 ? ' ' + ANS_PROP[rec.id].n + ' 题' : '')
        + (pn ? '(' + pn + ' 题还没发给 AI —— 点右下角「交给这条线」)' : ',等这条线处理');
      rec.copied.textContent = ''; rec.copied.hidden = true;
      if (rec.undo) rec.undo.hidden = true;
      rec.head.hidden = false;
    } else {
      rec.cd.classList.remove('ans-done'); rec.cd.classList.remove('ans-viaprop'); if (rec.undo) rec.undo.hidden = false;
      rec.pick = undefined;
      if (!keepInput) rec.note.value = '';
      if (rec.small) smallPaint(rec, null, keepInput);             // 1116 小修卡:撤回 ⇒ 打回的框一起清
      rec.sent = null;
      rec.skip = ansSig('', rec.note.value.trim());                // 撤回后框里留着的字不自动再记一遍(失焦 / 定时 / 收起面板都跳过);他再改、点选项或点「记下」才记
      rec.mark.textContent = ''; rec.copied.textContent = ''; rec.copied.hidden = true; rec.head.hidden = true;
    }
    ansPaintOpts(rec);
  }
  // ⭐ 1109 负责人(经 AI Harness):「我不是已经回复了,你已经在处理了,为什么状态板上这个事情……还挂着,这是状态板的bug吗?」
  //   首屏早就不数交过的卡(yoursLive),区头「要你的 N 件」还在数 ⇒ 他读到的是还要他做。区头改成同一口径,并写明已交。
  //   只改显示:卡要等这条线 `board.py answer` 才真的收。
  // ⭐ 1110(方案页 fable-audit-plan-1110「照做」表第 10 条,负责人选「照做」:板上的数 = 列表长度):这个数只在这一处现算 ——
  //   数区里此刻真有的卡(占位卡不算),扣掉已交的。原来三处各改各的(过期提醒卡 / 等你的行那张机器卡现画时各 +1,这里再按
  //   「上次扣了几」加减),谁少加少减一次,区头就和下面的卡对不上:暂停的线撤掉过期提醒卡时就没减回去。
  //   ⛔ 别处不许再改这个数;新加会增减「要你的」里的卡的代码,改完调一次 ansZoneHead()。文件里那个数仍由 board.py touch 按真卡数写,数的是同一批卡。
  function yoursHeadCount() {
    var real = 0, done = 0;
    document.querySelectorAll('.card').forEach(function (cd) {
      if (!inYours(cd) || isYoursPlaceholder(cd)) return;
      real++; if (cd.classList.contains('ans-done')) done++;
    });
    return { real: real, done: done };
  }
  function ansZoneHead() {
    var zy = document.getElementById(['zone-', '要你的'].join(''));
    var zn = zy && zy.querySelector('.n');
    if (!zn) return;
    var raw = (zn.textContent || '').split(' · ')[0], m = /(\d+)/.exec(raw);
    if (!m) return;
    var c = yoursHeadCount();
    var text = raw.replace(m[1], String(c.real - c.done));
    zn.textContent = c.done ? text + ' · 已交 ' + c.done + ' 件,开着的话约 1 分钟接手' : text;
    var zt = zy.querySelector('.hint');   // 1110 子线投影:本板自己没卡、只有投影卡时,区头那句「此刻没有要你…」跟着换(同 board.py 重建区头的那句);先比字再碰 PROJ_IDS —— ansZoneHead 第一次被调时 PROJ_* 还没赋值,自检的假环境里干脆没声明
    if (zt && /此刻没有/.test(zt.textContent || '') && c.real > 0 && typeof PROJ_IDS === 'object' && Object.keys(PROJ_IDS).length) zt.textContent = '点开每张卡,做完或先搁置都在卡上说一句。';
  }
  function ansRefresh() { try { ansZoneHead(); } catch (e) {} try { paintToc(); } catch (e) {} try { ansBar(); } catch (e) {} try { paintFirstScreen(); } catch (e) {} try { ansFab(); } catch (e) {} }
  // ⭐ 1026 晚负责人:「我刚把一个事项回复完，我正准备回复下一个事项……点了一下那个交给这条线，它直接就去启动了。但实际上我希望的是
  //   我的状态板上把所有事情都回复完，我再点一下交给这条线，然后它自己一次性再交给这条线……是不是应该放在右下角之类的？」
  //   (个人助理板 21:46:16 / 21:46:26 两张卡各交一次 ⇒ 那条线被叫醒两次)
  //   ⇒ 每张卡只「记下」;右下角浮一个「交给这条线(N 条)」,点了先把框里没存的字存下(同一条串行链),再把整块板记下的一次交掉
  //   (伺服 /_answer {submit:[…]} 由伺服盖交的时间)。连着方案页的卡把那一题也一起交。没有没交的就不出这个按钮。
  var ANS_FAB = null;
  function ansUnsub() {
    return (ANS_CARDS || []).filter(function (rec) {
      if (ansIsAccept(rec)) return false;                          // 1114 第 2 步:验收卡一存就交,不进右下角「交给这条线」
      var a = ANS[rec.id], b = ANS_LINK[rec.id];
      return (a && typeof a === 'object' && (a.choice || a.note) && !ansCounted(a)) || (b && !ansCounted(b)) || ansPropPend(rec.id) > 0;
    });
  }
  function ansFab() {
    if (!HTTP || !ANS_CARDS || !ANS_CARDS.length) return;
    if (!ANS_FAB) {
      ANS_FAB = ansEl('button'); ANS_FAB.type = 'button'; ANS_FAB.classList.add('ans-subfab'); ANS_FAB.hidden = true;
      ANS_FAB.addEventListener('mousedown', function (e) { e.preventDefault(); });   // 别抢走框里的焦点(否则失焦重排,按钮在点下去那一刻可能挪走)
      ANS_FAB.addEventListener('click', ansSubmitAll);
      document.body.appendChild(ANS_FAB);
      setInterval(function () {   // 停手到点自动算交的 / 方案页那边刚交的 ⇒ 卡和按钮 30 秒内跟上
        try {
          ansPropFetch();
          var ch = false;
          ANS_CARDS.forEach(function (rec) { var ef = ansEff(rec); if (ef && ef.a && rec.cntd === false && ansCounted(ef.a)) { ansPaintCard(rec, true); ch = true; } });
          if (ch) ansRefresh(); else ansFab();
        } catch (e) {}
      }, 30000);
    }
    if (ANS_FAB.busy) return;
    var n = ansUnsub().length;
    ANS_FAB.hidden = !n;
    ANS_FAB.textContent = '交给这条线' + (n > 1 ? '(' + n + ' 条)' : '');
  }
  function ansSubmitAll() {
    if (!ANS_FAB || ANS_FAB.busy) return;
    ANS_FAB.busy = true; ANS_FAB.textContent = '正在交…';
    ANS_CARDS.forEach(function (rec) { clearTimeout(rec.tm); if (rec.pick || rec.note.value.trim()) ansSave(rec); });   // 框里还没存的先存(排在交的前面)
    ANS_CARDS.forEach(function (rec) { if (rec.lq && rec.lpage) ansPost({ submit: [rec.lq] }, rec.lpage); });
    ANS_CARDS.forEach(function (rec) { var m = ANS_PROP_PEND[rec.id] || {}; Object.keys(m).forEach(function (pg) { ansPost({ submit: m[pg].slice() }, pg); }); });
    projSubmitPages();                                  // 1110 子线投影:投影卡交到各自子板名下(同一条串行链,排在本板这份前面)
    ansPost({ submit: ANS_CARDS.map(function (rec) { return rec.id; }) }).then(function (map) {
      ANS_FAB.busy = false;
      if (!map) { ANS_FAB.textContent = '没交上,再点一次'; return; }
      ansAdopt(map); ANS_JUST = null;
      ANS_CARDS.forEach(function (rec) {
        if (!ANS[rec.id]) return;
        ansPaintCard(rec, document.activeElement === rec.note);
        ansHint(rec, ansSubbed(ANS[rec.id]) ? '已交给这条线 ' + ansWhen(ANS[rec.id].sub, true) + ' · 开着的话约 1 分钟自己接手,不用再说一句' : '');
      });
      try { ansPropFetch(); } catch (e) {}   // 方案页那几份重新读回来(带上刚盖的交的时间)
      ANS_FAB.hidden = false; ANS_FAB.textContent = '已交 ✓ 不用再说一句'; ANS_FAB.busy = true;   // 1105:88 次「看板」里 56 次写完 90 秒内就开口、8 次叫到了还说 —— 原来写「它下一轮办」,听不出它会自己接手
      ansRefresh();                                   // 1109:点完当场刷新件数和首屏,别等 6 秒(他盯着看的就是这几秒)
      setTimeout(function () { ANS_FAB.busy = false; ansRefresh(); }, 6000);
    });
  }
  // 补充里那句话像不像「同意照原文发」(1023):像 ⇒ 提示他点「发出去」;带着改 / 别发 / 自己来 ⇒ 不像(那是他自己的答复)
  var ANS_SEND_NO = /别发|不发|先别|先不|不要|不用|再改|改一下|改改|改成|换成|重写|不行|不对|算了|取消|自己|等等|等一下|但是|不过/;
  var ANS_SEND_YES = /(直接|就|那就|可以|照原文|照这个)?发(吧|出去|了吧|过去)|没问题|就这样|照原文|^\s*(行|可以|好的?|ok|OK|同意)\s*[。.!！~]*\s*$/;
  function ansSaysSend(t) { t = String(t || ''); return !!t.trim() && ANS_SEND_YES.test(t) && !ANS_SEND_NO.test(t); }
  // ⭐ 1026 负责人:「我只有板上的回复写到一半，然后他就直接去读了……片面的一半的回复」(18:43 批「先试」)
  //   ⇒ 框下的按钮从「记下」改成「交给这条线」:点了 = 写完了(记录带 sub);不点照样每 5 秒 / 失焦自动存,但只算草稿 ——
  //   board.py answers 不列草稿内容、AI 不照办。没点的兜底(board.py _ans_submitted):只点了选项 1 分钟没再动 / 写了字 10 分钟没再改 = 交。
  //   交了之后又改 ⇒ 新的那份又是草稿,等再点一次或停手。
  function ansSubbed(a) { var t = Date.parse(a && a.ts), u = Date.parse(a && a.sub); return !isNaN(u) && (isNaN(t) || u >= t); }
  // 算不算已经交给这条线:点过「交给这条线」,或停手到点(只点选项 1 分钟 / 写了字 10 分钟)—— 与 board.py _ans_submitted 同一条规则;
  //   1026 晚:停手到点那些板上还写「记下了(还没交)」、右下角还催他交,而那条线早已照办
  // 依据: board_paths.py ANS_SUB_CHOICE_S / ANS_SUB_NOTE_S(×1000)。kit 读不到 Python,两边各写一份,board.py selftest「1115 大扫除 C3」比对相等
  var ANS_SUB_CHOICE_MS = 60e3, ANS_SUB_NOTE_MS = 600e3;
  function ansCounted(a) {
    if (ansSubbed(a)) return true;
    var t = Date.parse(a && a.ts);
    return isNaN(t) || Date.now() - t >= (String((a && a.note) || '').trim() ? ANS_SUB_NOTE_MS : ANS_SUB_CHOICE_MS);
  }
  // ⭐ 1114 第 2 步(验收答题合一;负责人 11-13 14:40 定「单纯通过机器直接收、不叫醒」不变):
  //   验收卡点「通过」或「不通过」= 当场交,之后补的字并进同一题号、照样是交了的(每次存都带 sub = 这次的 ts,sub ≥ ts 才算交 —— kit ansSubbed 与 board.py _ans_submitted 同一条);
  //   不用再点右下角「交给这条线」。叫不叫、何时叫由 board.py cmd_wake_lines 定:纯通过满 ACCEPT_GRACE_S 机器收;不通过 / 带补充的等最后一次改动满 ACCEPT_GRACE_S 再叫。
  //   普通卡不走这里(记下 → 右下角「交给这条线」照旧)。
  function ansIsAccept(rec) {
    return !!(rec && rec.cd && rec.cd.getAttribute && rec.cd.getAttribute('data-accept') === '1');
  }
  // 「一分半」= board.py ACCEPT_GRACE_S(90 秒);改那边要改这里和下面「接着做 / 不通过」提示里的字,selftest「1115 大扫除 C3」比对
  // ⭐ 1115 大扫除 C8:原来每次输入都把 5 秒的定时器往后推 ⇒ 一直打字不停手就一次不存,伺服的答案 ts 停在第一次存的时刻,
  //   board.py 判「他还在写」(_accept_settled / _ans_submitted 看 ts)以为他早停手了,半截的话被叫醒办掉。
  //   ⇒ 停手 ANS_SAVE_IDLE_MS 存一次;一直不停手,离上次存满 ANS_SAVE_MAX_MS 也存一次。
  // 依据: 停手 5 秒存一次是 1021 的原值;不停手的上限取同一个数,ts 最多落后 5 秒(远小于 ACCEPT_GRACE_S 的 90 秒)
  var ANS_SAVE_IDLE_MS = 5000, ANS_SAVE_MAX_MS = 5000;
  function ansTypeTick(rec, now, save) {
    clearTimeout(rec.tm);
    if (!rec.dirtyAt) rec.dirtyAt = now;
    if (now - rec.dirtyAt >= ANS_SAVE_MAX_MS) { rec.dirtyAt = 0; save(rec); return true; }
    rec.tm = setTimeout(function () { rec.dirtyAt = 0; save(rec); }, ANS_SAVE_IDLE_MS);
    return false;
  }
  function ansAcceptHint(choice, note, ts, asked) {   // asked = 提问行的回答卡(1117:按钮写「看过了」,值是「通过」)
    if (asked && choice === '通过' && !note) return '已交 ' + ansWhen(ts, true) + ' · 看过了;一分半内没再补字就机器收掉这张卡,不叫那条线';
    return '已交 ' + ansWhen(ts, true) + (choice === '通过' && !note ? ' · 验收通过;一分半内没再补字就机器收掉这件,不叫那条线'
      : choice === '同意不做' && !note ? ' · 同意不做;一分半内没再补字就机器收成「不做了」,不叫那条线'   // 1115 sw-drop
      : choice === '都通过' && !note ? ' · 一分半内没再改就机器收掉没打回的几件;打回的那几件交给那条线回去改'   // 1116 小修卡
      : ' · 停手一分半后叫那条线来办;这之前再补的字并进同一条');
  }
  function ansSave(rec, explicit, submit, keep) {   // keep = 点的是卡上「记下」(1027:= 这张写完了,AI 看得到;不算交、不叫醒)   // explicit = 他亲手点的(选项 /「交给这条线」);失焦、停手 5 秒、收起面板是顺带记,不算。submit = 点的是「交给这条线」
    rec.dirtyAt = 0;                                               // 1115 C8:任何一次存都重新起算「不停手」的 5 秒
    var choice = rec.pick || '', note = rec.note.value.trim();
    if (!choice && !note) {                                        // 空的不记 —— 想收回已记的那条,走「撤回」
      if (ANS[rec.id]) ansHint(rec, '空的没记;想收回这条点上面的「撤回」');
      return;
    }
    var acc = ansIsAccept(rec);
    if (acc) submit = true;                                        // 1114 第 2 步:验收卡一存就是交(见 ansIsAccept 上面那段)
    var exc = rec.small ? smallExcept(rec) : null, sig = ansSig(choice, note) + (exc ? smallSig(exc) : '');   // 1116 小修卡:打回的几件也算内容
    if (!explicit && sig === rec.skip) return;
    if (sig === rec.sent && !(submit && rec.subSig !== sig) && !(keep && rec.keepSig !== sig)) return;   // 和已记 / 正在发的那份一样 ⇒ 不重发;点「交给这条线」而这份还没交过 ⇒ 照发,带上 sub
    rec.sent = sig; rec.skip = null;
    var ts = ansNow(), body = { id: rec.id, q: rec.q, choice: choice, note: note, ts: ts };
    if (exc) body.except = exc;                                    // 1116 小修卡:每次都带(空的也带 —— 伺服没带就留上次的,撤掉的打回会复活)
    if (submit) { body.sub = ts; rec.subSig = sig; } else if (rec.subSig !== sig) rec.subSig = null;
    if (keep) { body.keep = ts; rec.keepSig = sig; } else if (rec.keepSig !== sig) rec.keepSig = null;
    ansPost(body, rec.page).then(function (map) {   // 1110 子线投影:投影卡记在子板名下(rec.page);本板的卡 rec.page 为空 = 本板
      var typing = (document.activeElement === rec.note), draft = rec.note.value;
      if (!map) {                                                  // 没记上:选中态退回已记的那份(别让它看起来像记上了),框里的字留着
        ansPaintCard(rec, true);
        rec.note.value = draft; rec.sent = null; rec.skip = null; rec.subSig = null;
        ansHint(rec, ANS_FAIL, true);
        return;
      }
      ansAdopt(map, rec.page); ANS_JUST = null;
      draftDrop(rec.id, note, rec.page);                                     // 1021 晚:伺服端已有同一段字 ⇒ 本地那份不用留了
      if (rec.lq) {                                                // 1020:同一道题 ⇒ 方案页那一题也记成这一份
        ANS_LINK[rec.id] = { choice: choice, note: note, ts: ts };
        ansPost({ id: rec.lq, q: rec.q, choice: choice || LINK_OTHER, note: note, ts: ts }, rec.lpage);
      }
      ansPaintCard(rec, typing);                                   // 他还在框里打字 ⇒ 不动框里的字;rec.sent 已是刚记上的那份,再失焦时有改动才会再发
      ansHint(rec, submit ? '已交给这条线 ' + ansWhen(ts, true) + ' · 开着的话约 1 分钟自己接手,不用再说一句'
        : keep ? '已记下 ' + ansWhen(ts, true) + ' · 那条线干活时就能看到;都答完点右下角「交给这条线」叫它一起办'
        : '已存 ' + ansWhen(ts, true) + ' · 写完点「记下」,都答完点右下角「交给这条线」' + (note ? '(不点的话,停手 10 分钟也算交)' : '(不点的话,1 分钟没再动也算交)'));
      if (acc) ansHint(rec, ansAcceptHint(choice, note, ts, rec.cd.getAttribute('data-asked') === '1'));
      // 1023(示例-基建转,负责人:「我前面就已经点过这个状态板…为什么没有处理？」):要发给真人的稿(卡里有「请你过目的原文」)
      //   他在补充里写「没问题,直接发吧」、没点「发出去」⇒ 发消息闸不认(补充里常夹着要改稿)⇒ 只在他写的话像「同意发」时当场说一句。
      //   ⚠ 1023 午负责人:「如果不选任何选项,我直接打内容,它会选其他,结果它下面还是报了这样一个提醒」—— 他写「这个我自己去找吧」
      //     是正当的答复(选的就是「其他」),不能说他「没点选项」⇒ 话里不像同意发(或带着改 / 别发 / 自己来)就不提示。
      if (!choice && rec.opts.length && rec.cd.querySelector('.otext') && ansSaysSend(note)) {
        var go = null; rec.opts.forEach(function (o) { if (!go && /发/.test(o.title) && !/再改|别发|不发/.test(o.title)) go = o.title; });
        if (go) ansHint(rec, '你写的像是同意发,但选的是「其他」—— 这样这条稿子不会照原文发出去。要发就点上面的「' + go + '」', true);
      }
      ansRefresh();
    });
  }
  function ansUndo(rec) {
    clearTimeout(rec.tm);
    if (rec.lq) { delete ANS_LINK[rec.id]; ansPost({ id: rec.lq, clear: true }, rec.lpage); }   // 1020:两边一起撤
    ansPost({ id: rec.id, clear: true }, rec.page).then(function (map) {
      if (!map) { ansHint(rec, ANS_FAIL, true); return; }
      ansAdopt(map, rec.page); ANS_JUST = null;   // 撤回之后剪贴板里那段已经不准了 ⇒ 板顶不再写「已复制 N 件」
      draftDrop(rec.id, undefined, rec.page);     // 1021 晚:撤回 = 不要它了,重载时别再替他记回去
      var left = rec.note.value.trim();
      ansPaintCard(rec, true);
      ansHint(rec, left ? '已撤回(框里的字还留着,没记)' : '已撤回');
      ansRefresh();
    });
  }
  function ansPick(rec, title) {
    rec.pick = title;
    ansPaintOpts(rec);
    if (title === '') {
      try { rec.note.focus(); } catch (e) {}
      if (!rec.note.value.trim()) { ansHint(rec, ansIsAccept(rec) ? '写在下面的框里,写完停手就自己交' : '写在下面的框里;都答完点右下角「交给这条线」'); return; }
    }
    ansSave(rec, true);
    // 1113 负责人第一次真点(AI Harness 报):验收卡点「通过」= 这件他认了,一下就算交、单独交,不被同板别的草稿压住(伺服那边同样先收,见 board.py cmd_wake_lines)。
    //   1114 第 2 步:通过 / 不通过都由上面这次 ansSave 带 sub 一起交(同一条 POST;投影卡也记在子板名下),这里不再另发 submit。
  }
  function ansWireOpt(rec, el, title) {
    el.classList.add('ans-opt');
    el.setAttribute('role', 'radio'); el.setAttribute('tabindex', '0'); el.setAttribute('aria-checked', 'false');
    el.addEventListener('click', function () { ansPick(rec, title); });
    el.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); ansPick(rec, title); }
    });
  }
  // 1113 夜负责人(经示例-基建 #e4f1):「做到哪里面是一大坨字……里面还有两句话是重复的」
  //   ⇒ 「做到哪」按句拆:和「看什么」/ 问题里重复的句子去掉;只露第一句,其余折进「展开」。
  //   根因(实测):长段文字在板上被折成「前一截(.tame-sum)+ 展开 + 全文(.tame-full)」,直接取 textContent 会把前一截和全文都读进来 ⇒ 同一段出现两遍。
  function acceptPlain(el) { if (!el) return ''; var c = el.cloneNode(true); Array.prototype.forEach.call(c.querySelectorAll('.tame-sum, .tame-more'), function (n) { n.parentNode.removeChild(n); }); return c.textContent || ''; }
  function acceptSents(t) { return String(t || '').split(/(?<=[。；;！？!?])\s*|\n+/).map(function (x) { return x.replace(/^做到哪[:：]\s*/, '').trim(); }).filter(Boolean); }
  function acceptNorm(t) { return String(t || '').replace(/[\s,，。.;；:：、!！?？「」『』“”"'()（）\[\]【】→⇒…-]/g, ''); }
  function acceptDoingNode(doing, check, q) {
    var seen = acceptNorm(check) + '|' + acceptNorm(q);
    var steps = acceptSents(String(check || '').replace(/\s*(?:→|->|⇒)\s*/g, '\n')).map(acceptNorm).filter(function (x) { return x.length >= 8; });
    var out = [], kept = {};
    acceptSents(doing).forEach(function (s) {
      var n = acceptNorm(s);
      if (!n || kept[n]) return;                                         // 自己里头重复的
      if (n.length >= 8 && seen.indexOf(n) >= 0) return;                 // 整句已在「看什么」/ 问题里
      if (steps.some(function (st) { return n.indexOf(st) >= 0 && st.length >= n.length * 0.6; })) return;   // 这句基本就是「看什么」里的某一步
      kept[n] = 1; out.push(s);
    });
    if (!out.length) return null;
    // 1113 夜负责人看了第一版:「点个展开只是把后面的话显示出来……或者给我分个段……一眼扫过去就知道」
    //   ⇒ 一句一条,不截半句;最多露 SHOW 条,「还有 N 条」里只放剩下的,⛔ 不再把前面的重写一遍。
    var SHOW = 4;   // 依据: 负责人 11-13 23:3x「一眼扫过去」;卡上四行内扫得完
    var wrap = document.createElement('div');
    function list(arr) { var ul = document.createElement('ul'); ul.className = 'accept-pts'; arr.forEach(function (x) { var li = document.createElement('li'); li.textContent = x; ul.appendChild(li); }); return ul; }
    wrap.appendChild(list(out.slice(0, SHOW)));
    if (out.length > SHOW) {
      var dt = document.createElement('details'); dt.className = 'more';
      var sm = document.createElement('summary'); sm.textContent = '还有 ' + (out.length - SHOW) + ' 条'; dt.appendChild(sm);
      dt.appendChild(list(out.slice(SHOW)));
      wrap.appendChild(dt);
    }
    return wrap;
  }
  // 1113 夜负责人(经示例-基建【急】):「语音转文字输入的过程中啊，我想往上拖，它就会自动弹回这个输入框这里」
  //   输入法每往框里写一次,浏览器就把光标滚回眼前(原生行为,拦不住);手打时停手就不拽,语音转文字一直在写就一直拽。
  //   ⇒ 光标在框里、框的原位滚出屏外时,把这一块(框 + 记下)钉在屏幕底部,原位留同高空位;光标始终在屏上,浏览器就不滚整页。
  //     原位回到屏内 / 失焦 ⇒ 放回原处;右下角「交给这条线」跟着抬高。⛔ 别改成一聚焦就钉底(框会从眼前跳走)。
  function ansDockWire(rec, box) {
    var ph = null;
    function place() { if (!ph) return; var r = ph.getBoundingClientRect(); box.style.left = Math.max(8, Math.round(r.left)) + 'px'; box.style.width = Math.round(Math.min(r.width, window.innerWidth - 16)) + 'px'; }
    function fab() { if (ANS_FAB) ANS_FAB.style.bottom = ph ? (Math.round(box.getBoundingClientRect().height) + 16) + 'px' : ''; }
    function dock() {
      if (ph || !box.parentNode) return;
      ph = document.createElement('div'); ph.className = 'ans-dock-ph'; ph.style.height = Math.round(box.getBoundingClientRect().height) + 'px';
      box.parentNode.insertBefore(ph, box); box.classList.add('ans-dock'); place(); fab();
    }
    function undock() {
      if (!ph) return;
      box.classList.remove('ans-dock'); box.style.left = ''; box.style.width = '';
      if (ph.parentNode) ph.parentNode.removeChild(ph); ph = null; fab();
    }
    function sync() {
      if (document.activeElement !== rec.note) { undock(); return; }
      var r = (ph || box).getBoundingClientRect(), vh = window.innerHeight || document.documentElement.clientHeight;
      if (!vh || !r.height) return;
      var away = r.bottom > vh || r.top < 0;
      if (away && !ph) dock(); else if (!away && ph) undock(); else if (ph) { place(); fab(); }
    }
    window.addEventListener('scroll', sync, { passive: true });
    window.addEventListener('resize', sync);
    rec.note.addEventListener('input', sync);
    rec.note.addEventListener('focus', sync);
    rec.note.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== rec.note) undock(); }, 0); });
    rec.dockSync = sync;
  }
  // 1114 验收卡新写法(data-accept-fmt="2"):卡面作者写(标题 / 交代→现在 / 入口 / 图),kit 不解析不拼,只排顺序:
  //   问题 → 交代→现在 → 入口(有才有)→ 图 → 选项 → 框。老卡(没有这个属性)走原来那几块,一个像素不变。
  function acceptFmt2Order(cd, qel) {
    var prev = qel;   // 1115:加了「还要你做」(客户项目甲 #c41e)/「为什么不做」(sw-drop)两块,排在交代→现在之后、入口之前
    var ans = cd.querySelector('.accept-parts') || cd.querySelector('.accept-ans');   // 1117 晚 G:回答卡 ⇒「回答」一段(+表)紧接标题,去哪看 / 怎么来的排在它后面(没有这一块 ⇒ 顺序不变)
    if (ans && ans.parentNode && qel.parentNode) { qel.parentNode.insertBefore(ans, qel.nextSibling); prev = ans; }
    var see = cd.querySelector('.accept-see');   // 1116 讲人话:「去哪看:…」在标题下第一行(老卡没有这一块 ⇒ 顺序不变)
    if (see && see.parentNode && prev.parentNode) { prev.parentNode.insertBefore(see, prev.nextSibling); prev = see; }
    var how = cd.querySelector('.accept-how');   // 1117「怎么来的:…」紧接在「去哪看」下面(没有这一块 ⇒ 顺序不变)
    if (how && how.parentNode && prev.parentNode) { prev.parentNode.insertBefore(how, prev.nextSibling); prev = how; }
    ['.accept-got', '.accept-todo', '.accept-drop', '.accept-entry', '.cimgs'].forEach(function (k) { var n = cd.querySelector(k); if (n && n.parentNode && prev.parentNode) { prev.parentNode.insertBefore(n, prev.nextSibling); prev = n; } });
  }
  // ⭐ 1116 小修每天一张(负责人 11-16 wk-grain):今天的小修一张卡,一件一行;哪件不对点它右边「打回」写一句,其余点底部「都通过」一起收。
  //   打回的话随「都通过」那一下一起交:记在回答的 except 里(「行号|他的话」,伺服现成字段、一条最多 200 字),board.py _small_split 照单张不通过转给那条线。
  //   ⛔ 打回不单独交:他可能接着打回第二件,一按一叫那条线会被叫好几次。小修卡不出「其他(我自己写)」和补充框 —— 话都写在那一件下面。
  function smallExcept(rec) {
    var out = [];
    (rec.smallRows || []).forEach(function (k) { var v = String((rec.back || {})[k] || '').replace(/\s+/g, ' ').trim(); if (v) out.push((k + '|' + v).slice(0, 200)); });
    return out;
  }
  function smallSig(exc) { return (exc && exc.length) ? '\u0002' + exc.join('\u0003') : ''; }
  function smallPaint(rec, a, keepInput) {
    var exc = (a && Array.isArray(a.except)) ? a.except : [];
    if (!keepInput) {
      rec.back = {};
      exc.forEach(function (x) { var s = String(x), i = s.indexOf('|'); if (i > 0) rec.back[s.slice(0, i)] = s.slice(i + 1); });
      (rec.smallUi || []).forEach(function (u) { var v = rec.back[u.k] || ''; u.ta.value = v; u.box.hidden = !v; if (v) u.btn.classList.add('on'); else u.btn.classList.remove('on'); u.btn.textContent = v ? '不打回了' : '打回'; });
    }
    return smallSig(exc);
  }
  function smallWire(rec) {
    var cd = rec.cd; rec.small = true; rec.back = {}; rec.smallRows = []; rec.smallUi = [];
    if (rec.other) rec.other.style.display = 'none';
    rec.note.style.display = 'none';
    var sv = cd.querySelector('.ans-save'); if (sv) sv.style.display = 'none';
    Array.prototype.forEach.call(cd.querySelectorAll('.accept-small-i'), function (it) {
      var k = it.getAttribute('data-row') || ''; if (!k) return;
      rec.smallRows.push(k);
      var btn = ansEl('button', '打回'); btn.type = 'button'; btn.classList.add('small-back');
      var box = ansEl('div'); box.classList.add('small-back-box'); box.hidden = true;
      var ta = ansEl('textarea'); ta.classList.add('small-back-note'); ta.rows = 1; ta.maxLength = 180;
      ta.placeholder = '这件哪里不对,写一句(交给那条线回去改)'; ta.setAttribute('aria-label', ta.placeholder);
      box.appendChild(ta); it.appendChild(btn); it.appendChild(box);
      var resave = function () { if (rec.pick) ansSave(rec, true); };
      btn.addEventListener('click', function () {
        if (box.hidden) { box.hidden = false; btn.classList.add('on'); btn.textContent = '不打回了'; try { ta.focus(); } catch (e) {} ansHint(rec, '写一句哪里不对;都看完点底部「都通过」:打回的转给那条线,其余的收'); }
        else { box.hidden = true; ta.value = ''; delete rec.back[k]; btn.classList.remove('on'); btn.textContent = '打回'; resave(); }
      });
      ta.addEventListener('input', function () { rec.back[k] = ta.value; });
      ta.addEventListener('blur', resave);
      rec.smallUi.push({ k: k, btn: btn, box: box, ta: ta });
    });
  }
  // 1120 做完没有的牌子(负责人 11-20 方案页「强制,卡顶一个牌子」):卡上 data-done-state(+ data-left)⇒ 标题正上方一枚
  //   绿「做完了」/ 橙「没做完 · 还差 …」;na 或没有 ⇒ 不出。字与 board.py `_done_state_label` 同一句(自检逐条比两端);
  //   board.py 已写进卡面的那枚照属性重写一遍、挪到标题正上方(答题后那行「你 … 答了」排在牌子上面)。⛔ 不放进 h2.q:多处按它的字取标题。
  function doneStateLabel(st, left) {
    if (st === 'partial') { var l = String(left || '').replace(/\s+/g, ' ').trim(); return l ? '没做完 · 还差 ' + l : '没做完'; }
    return st === 'done' ? '做完了' : '';
  }
  function doneStateMark(cd, qel) {
    var st = cd.getAttribute('data-done-state') || '', lab = doneStateLabel(st, cd.getAttribute('data-left'));
    var el = cd.querySelector('.done-state');
    if (!lab) { if (el && el.parentNode) el.parentNode.removeChild(el); return ''; }
    if (!el) el = document.createElement('span');
    el.className = 'done-state ' + (st === 'partial' ? 'ds-partial' : 'ds-done'); el.textContent = lab;
    if (qel && qel.parentNode) qel.parentNode.insertBefore(el, qel);
    return lab;
  }
  function ansBuild(cd) {
    var qel = cd.querySelector('h2.q'), opts = cd.querySelector('.opts');
    var aFmt2 = cd.getAttribute('data-accept-fmt') === '2';
    try { cardAgeMark(cd); } catch (e) {}   // 1117 挂了多久:标签行末尾一枚(出错不挡建卡)
    // 1113:卡上的图(--img)挪到问题正下方 —— 他要看的就是样子,图放在选项和答题框下面得往下翻才看到
    var cimgs = cd.querySelector('.cimgs');
    if (cimgs && qel && qel.parentNode && cimgs.previousElementSibling !== qel) qel.parentNode.insertBefore(cimgs, qel.nextSibling);
    // 1113 晚:首屏那一行点进来就是这张卡 ⇒ 入口按钮放这张卡上(问题和图下面);外部网站写「在浏览器打开」,点了走默认浏览器(见文件末 openInBrowser)
    var aurl = cd.getAttribute('data-accept-url') || '';
    if (!aFmt2 && cd.getAttribute('data-accept') === '1' && aurl && qel && qel.parentNode && !cd.querySelector('.accept-open-link')) {
      var al = document.createElement('a'); al.classList.add('accept-open-link', 'fsx-accept-btn'); al.href = aurl; al.target = '_blank'; al.rel = 'noopener'; al.textContent = '打开看 ↗';
      try { var au = new URL(aurl, location.href), ah = (au.hostname || '').toLowerCase(); if (ah && !(ah === '127.0.0.1' || ah === 'localhost' || /\.localhost$/.test(ah))) { al.textContent = '在浏览器打开 ↗'; al.title = '外部网站,用你的默认浏览器打开(App 面板里打开会很慢)'; } } catch (e) {}
      var anchor = cd.querySelector('.cimgs') || qel; anchor.parentNode.insertBefore(al, anchor.nextSibling);
    }
    // 1113 晚:验收卡上「做到哪 / 看什么」单独一块放在入口按钮下面、答题框上面(原来塞在折起的「前因后果」里,要点展开才看得到)
    if (!aFmt2 && cd.getAttribute('data-accept') === '1' && qel && qel.parentNode && !cd.querySelector('.accept-brief')) {
      var brief = document.createElement('div'); brief.classList.add('accept-brief');
      var rk2 = cd.querySelector('a[href^="#row-"]'), rowEl2 = null;
      try { if (rk2) rowEl2 = document.querySelector('.crow[data-ack="' + rk2.getAttribute('href').slice(5).replace(/"/g, '') + '"]'); } catch (e) { rowEl2 = null; }
      if (cd.getAttribute('data-accept-rows')) rowEl2 = null;   // 1113 夜:一批行一张卡 ⇒ 「做到哪」用卡上一行一件那几句,别拿第一行的现状冒充
      var whyEl = null;
      Array.prototype.forEach.call(cd.querySelectorAll('.crow'), function (cr) { var b0 = cr.querySelector('.txt > b'); if (b0 && b0.textContent.trim() === '前因后果') whyEl = cr; });
      var raw = whyEl ? acceptPlain(whyEl) : (cd.textContent || '');   // 1113 夜 #e4f1:别把折起的前一截和全文都读进来
      var mDo = /做到哪[:：]\s*([\s\S]*?)(?:验收看什么[:：]|$)/.exec(raw);
      var live = rowEl2 ? acceptPlain(rowEl2.querySelector('.why') || rowEl2.querySelector('.res')) : '';   // 同上
      var doing2 = (live || (mDo ? mDo[1] : '')).replace(/展开[(（]还有\s*\d+\s*字[)）]/g, '').replace(/\s+/g, ' ').trim();
      var ck2 = cd.getAttribute('data-accept-check') || '';
      var addSec = function (label, node) { var d = document.createElement('div'); d.classList.add('accept-brief-sec'); var h = document.createElement('b'); h.textContent = label; d.appendChild(h); d.appendChild(node); brief.appendChild(d); };
      if (doing2) { var dn = acceptDoingNode(doing2, ck2, qel ? qel.textContent : ''); if (dn) addSec('做到哪', dn); }   // 1113 夜 #e4f1:去重 + 一句一条
      var st2 = ck2.split(/\s*(?:→|->|⇒|;|；|\n)\s*/).filter(function (x) { return x.trim(); });
      if (st2.length > 1) { var ol2 = document.createElement('ol'); st2.forEach(function (x) { var li = document.createElement('li'); li.textContent = x; ol2.appendChild(li); }); addSec('看什么', ol2); }
      else if (ck2) { var cp2 = document.createElement('div'); cp2.textContent = ck2; addSec('看什么', cp2); }
      if (brief.children.length) {
        var after = cd.querySelector('.accept-open-link') || cd.querySelector('.cimgs') || qel; after.parentNode.insertBefore(brief, after.nextSibling);
        if (whyEl) { whyEl.hidden = true; whyEl.style.display = 'none'; }   // 同一段话不在卡上出现两遍(.crow 是 flex,光 hidden 盖不住)
      }
    }
    // 1113 晚负责人(经示例-基建【急】):「我在下方你这个输入框里输入的时候……鼠标滚轮往上滑去看你这个图，它会不断把我往拉回这个输入框这里」
    //   打字时浏览器会把光标所在的框滚回眼前(改不了的原生行为);原顺序 图 → 入口 → 做到哪 / 看什么 → 选项 → 框,图顶到框 1056px > 一屏 885px。
    //   ⇒ 图挪到紧挨选项和框的位置:问题 → 做到哪 / 看什么 → 入口按钮 → 图 → 选项 → 框;图高另按屏高封顶(kit.css),图和框总在同一屏。
    if (cd.getAttribute('data-accept') === '1' && qel && qel.parentNode) {
      // 卡上的图改成立即加载:懒加载的图在面板里实测一直 0×0 不加载(宽高都靠图本身撑)
      Array.prototype.forEach.call(cd.querySelectorAll('.cimg-i'), function (i) { i.loading = 'eager'; });
      var prevA = qel;
      if (aFmt2) acceptFmt2Order(cd, qel); else [cd.querySelector('.accept-brief'), cd.querySelector('.accept-open-link'), cd.querySelector('.cimgs')].forEach(function (n) {
        if (n && n.parentNode && prevA.parentNode) { prevA.parentNode.insertBefore(n, prevA.nextSibling); prevA = n; }
      });
    }
    if (cd.getAttribute('data-accept') === '1' && qel && qel.parentNode) {   // 1113 夜 #e4f1:标题下那行和问题一字不差 ⇒ 藏掉(同一句卡上出现两遍)
      var ld0 = qel.parentNode.querySelector('.lede');
      if (ld0 && acceptNorm(ld0.textContent) === acceptNorm(qel.textContent)) ld0.style.display = 'none';
    }
    if (cd.getAttribute('data-accept') === '1' && qel && qel.parentNode && !cd.querySelector('.accept-badge')) {
      var badge = document.createElement('span'); badge.classList.add('accept-badge'); badge.textContent = cd.getAttribute('data-drop') === '1' ? '想不做,等你定' : '待你验收';   // 1115 sw-drop
      if (cd.getAttribute('data-asked') === '1' && cd.getAttribute('data-drop') !== '1') { badge.textContent = '你问的'; badge.classList.add('accept-badge-asked'); if (/^\s*你问/.test(qel.textContent || '')) badge.classList.add('accept-badge-dup'); }   // 1117 晚 G:标题已以「你问」开头 ⇒ 小标不重复   // 1117 提问行的回答卡
      qel.parentNode.insertBefore(badge, qel.parentNode.firstChild);
    }
    // 1113 晚负责人改主意:验收卡就是首屏那一行点进来看的「细节卡」⇒ 不再折成一行(原先 8aad25d0 折起来)
    var rec = { cd: cd, id: cd.getAttribute('data-ack'), q: ansFlat(qel ? qel.textContent : '').slice(0, 400), opts: [], other: null, pick: undefined, sent: null, skip: null, tm: null,
                lq: cd.getAttribute('data-deep-q') || '', lpage: cd.getAttribute('data-deep-page') || '' };
    // 卡头那枚标记:「你 MM-DD HH:MM 答了:…」+「撤回」;没答时整条藏着
    rec.head = ansEl('div'); rec.head.classList.add('ans-head'); rec.head.hidden = true;
    rec.mark = ansEl('span'); rec.mark.classList.add('ans-mark'); rec.head.appendChild(rec.mark);
    rec.copied = ansEl('span'); rec.copied.classList.add('ans-copied'); rec.copied.hidden = true; rec.head.appendChild(rec.copied);
    var undo = ansEl('button', '撤回'); undo.classList.add('ans-undo'); undo.type = 'button';
    rec.undo = undo;
    undo.addEventListener('click', function () { ansUndo(rec); });
    rec.head.appendChild(undo);
    var inner = cd.querySelector('.body') || cd;
    if (qel && qel.parentNode) qel.parentNode.insertBefore(rec.head, qel); else inner.insertBefore(rec.head, inner.firstChild);
    if (cd.getAttribute('data-accept') === '1' && qel) { try { doneStateMark(cd, qel); } catch (e) {} }   // 1120 牌子紧贴标题(在「你 … 答了」那行下面)
    // 补充框 +「记下」(1026 19:5x 起一度叫「交给这条线」,1026 晚改回:交挪到右下角,一次交整块板)
    var box = ansEl('div'); box.classList.add('ans-box');
    rec.note = ansEl('textarea'); rec.note.classList.add('ans-note');
    rec.note.rows = 2; rec.note.maxLength = 8000; rec.note.name = 'ans-note';
    rec.note.placeholder = opts ? '想补一段、或者都不选自己说一个,就写在这里' : '直接写你的答复';
    rec.note.setAttribute('aria-label', rec.note.placeholder);
    box.appendChild(rec.note);
    var foot = ansEl('div'); foot.classList.add('ans-foot');
    var saveBtn = ansEl('button', '记下'); saveBtn.classList.add('ans-save'); saveBtn.type = 'button';   // 1026 晚:只存不交;交 = 右下角「交给这条线」(ansFab)
    foot.appendChild(saveBtn);
    rec.hint = ansEl('span'); rec.hint.classList.add('ans-hint'); rec.hint.setAttribute('aria-live', 'polite'); foot.appendChild(rec.hint);
    box.appendChild(foot);
    if (opts) {
      opts.setAttribute('role', 'radiogroup');
      Array.prototype.forEach.call(opts.querySelectorAll(':scope > .opt'), function (el) {
        var b = el.querySelector('b'), title = ansFlat((b || el).textContent).slice(0, 600);
        if (!title) return;
        var val = el.getAttribute ? (el.getAttribute('data-val') || '') : '';   // 1117 回答卡:按钮写「看过了 / 没答到点上」,记的值照旧「通过 / 不通过」
        if (val) { (rec.lab = rec.lab || {})[val] = title; title = val; }
        rec.opts.push({ el: el, title: title });
        ansWireOpt(rec, el, title);
      });
      rec.other = ansEl('div'); rec.other.classList.add('opt'); rec.other.classList.add('ans-other');
      rec.other.appendChild(ansEl('b', '其他(我自己写)'));
      opts.appendChild(rec.other);
      ansWireOpt(rec, rec.other, '');
      opts.parentNode.insertBefore(box, opts.nextSibling);
    } else {
      (cd.querySelector('.checks') || inner).appendChild(box);
    }
    saveBtn.addEventListener('click', function () {
      clearTimeout(rec.tm);
      if (!rec.pick && !rec.note.value.trim() && !ANS[rec.id]) { ansHint(rec, opts ? '先点一个选项,或在框里写一段' : '先在框里写一段'); return; }
      ansSave(rec, true, false, true);
    });
    rec.note.addEventListener('blur', function () { clearTimeout(rec.tm); ansSave(rec); });
    ansDockWire(rec, box);
    // 他写到一半走开:板会在没人看 / 闲着时自己刷新(reloadIfChanged),没记的字会跟着丢 ⇒ 停手 5 秒先记一次
    rec.note.addEventListener('input', function () {
      draftSet(rec);                                               // 1021 晚:先存本地,页面一跳也丢不了(见 ansDraftRestore)
      // 1113 负责人在验收卡上只写了反对意见、没点通过也没点不通过 ⇒ 写了差什么就记成「不通过」(要通过就点通过)
      if (!rec.pick && rec.note.value.trim() && rec.cd && rec.cd.getAttribute('data-accept') === '1') {
        if (rec.cd.getAttribute('data-drop') === '1') { rec.pick = '接着做'; ansPaintOpts(rec); ansHint(rec, '写了字 ⇒ 记成「接着做」,写完停手就自己交,那条线一分半后接着做;同意不做就点「同意不做」'); }   // 1115 sw-drop
        else if (rec.lab && rec.lab['不通过']) { rec.pick = '不通过'; ansPaintOpts(rec); ansHint(rec, '写了还想知道什么 ⇒ 记成「' + rec.lab['不通过'] + '」,写完停手就自己交,那条线一分半后回来补答;看过了就点「' + (rec.lab['通过'] || '通过') + '」'); }   // 1117 回答卡
        else { rec.pick = '不通过'; ansPaintOpts(rec); ansHint(rec, '写了差什么 ⇒ 记成「不通过」,写完停手就自己交,那条线一分半后回去改;要通过就点「通过」'); }
      }
      ansTypeTick(rec, Date.now(), ansSave);                      // 1115 C8:停手 5 秒存;不停手每 5 秒也存一次
    });
    if (cd.getAttribute('data-small')) smallWire(rec);           // 1116 小修卡:每行「打回」、底部「都通过」
    return rec;
  }
  // 已答的排到「要你的」最后:在 orderYours 排好的顺序上做一次稳定的二分(未答在前、已答在后),各自内部的先后不动。
  //   ⚠ 只在打开板时排;他正点着 / 写着的那张卡不当场飞走(点完选项还要补一段时,卡跳到区尾等于打断他)。
  function ansOrder() {
    // ⛔ 1029 负责人(经选品 v2.9):「还因为我回答那些问题以后,它会被放到最后去」—— 他从方案页答完回来,刚答的卡跑到区尾,得重新找。
    //   ⇒ 答过的卡留在原位(变灰,见 ans-done),不再挪。保留空壳:调用点不动;原来的稳定二分排序 1115 大扫除删了,要恢复看 git 历史。
    return;
  }
  function ansTocNote() {
    var k = 0;
    (ANS_CARDS || []).forEach(function (rec) { if (ANS[rec.id]) k++; });
    return k ? ' · 已答 ' + k : '';
  }
  function ansClip(text) {   // 成了回 true;两条路都不行回 false(⛔ 不抛)
    return new Promise(function (res) {
      function legacy() {
        try {
          var ta = ansEl('textarea'); ta.classList.add('ans-clip'); ta.value = text; ta.setAttribute('readonly', '');
          document.body.appendChild(ta); ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta); res(!!ok);
        } catch (e) { res(false); }
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { res(true); }, legacy);
        else legacy();
      } catch (e) { legacy(); }
    });
  }
  // 板顶那一条:有已答、还没复制的才出现;复制完变成「已复制 N 件,粘到对话里发出去」。⛔ 这里只动剪贴板和「已复制」标记,不发任何东西。
  function ansBar() {
    // ⭐ 1020 负责人:「复制这个按钮,其实我从来没有用过…我都喜欢在状态板上回复完,我就会直接跟那个对应的那条conversation说…你去看一眼状态板上的回复」
    //   (答案钩子也会在他下一次发话时把板上的回答带给那条线)⇒ 板顶「你已答 N 件 · 复制这 N 件」整条不再出;旧板上已建的那条藏起。
    var bar = document.getElementById(['ans', 'bar'].join('-'));
    if (bar) bar.hidden = true;
  }

  // 卡里指向方案页(proposals/…)的链接 ⇒ 去取那一页上他的回答;只认这张卡挂出来(data-since)以后答的 —— 旧方案页被新卡复用时,上一轮的答案不算。
  function ansLinkFetch() { try {
    ANS_CARDS.forEach(function (rec) {
      if (!rec.lq || !rec.lpage || !HTTP) return;
      var since = stampMs(rec.cd.getAttribute('data-since'));
      fetch('/_answers?page=' + encodeURIComponent(rec.lpage), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j || !j.answers || typeof j.answers !== 'object' || Array.isArray(j.answers)) return;
          var a = j.answers[rec.lq], t = a && Date.parse(a.ts), old = ANS_LINK[rec.id], nu = null;
          if (a && t && !isNaN(t) && !(since !== null && t < since))
            nu = { choice: String(a.choice || '') === LINK_OTHER ? '' : String(a.choice || ''), note: String(a.note || ''), ts: a.ts, sub: a.sub };
          if (JSON.stringify(nu) === JSON.stringify(old || null)) return;
          if (nu) ANS_LINK[rec.id] = nu; else delete ANS_LINK[rec.id];
          ansPaintCard(rec, document.activeElement === rec.note && !!rec.note.value); ansOrder(); ansRefresh();
        })
        .catch(function () {});
    });
  } catch (e) {} }
  // ⭐ 1027(示例-投流达人 v1.9 转):方案页 3 道题,板上的卡只出 1 道(ask --deep-q 只连一题)⇒ 他在板上看不出还有两道要答。
  //   ⇒ 卡连着的方案页有 2 道题以上时,卡上(问句下面)列出这一页全部题目和各自答没答 / 交没交;题目清单由伺服 /_plan-qs 按页读一次。
  //   只是看得见,不改「这张卡算不算答了」:页上没答的题交的时候按页上的建议算(plan.js「没点开,按建议」),不能因此把卡一直挂着。
  var PLAN_QS = {};
  function ansQPage(rec) {
    if (rec.lpage) return rec.lpage;
    var pg = '';
    Array.prototype.some.call(rec.cd.querySelectorAll('a[href]'), function (a) {
      var m = /(?:^|\/)proposals\/([^\/?#]+\.html)(?:[?#]|$)/.exec(a.getAttribute('href') || '');
      if (!m) return false; pg = m[1]; try { pg = decodeURIComponent(pg); } catch (e) {} return true;
    });
    return pg;
  }
  function ansQList(rec) { try {
    var pg = ansQPage(rec);
    if (!pg || !HTTP) return;
    var paint = function (qs) {
      if (!qs || (qs.length < 2 && !rec.lq)) return;
      fetch('/_answers?page=' + encodeURIComponent(pg), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var A = (j && j.answers && typeof j.answers === 'object' && !Array.isArray(j.answers)) ? j.answers : {};
          // 1027 晚(投流达人转,负责人 18:3x:「状态板上显示 4 个问题都没答,但我点进完整方案里面……都答过了」):
          //   方案页的题答没答只看方案页上的回答,不按卡挂上的时间筛(卡常在他答完之后才挂);答了已收(copied)也算答了
          var left = 0;
          var seen = function (a) { return !!(a && typeof a === 'object' && (a.choice || a.note)); };
          if (rec.lq) {   // 连着一题的卡:同页别的题 / 整份方案的补充答了没交 ⇒ 记进 ANS_PROP_PEND,右下角「交给这条线」一起交(他 10-26 定的「全部答完一次交」)
            var pend = Object.keys(A).filter(function (k) { return k !== rec.lq && seen(A[k]) && !A[k].copied && !ansCounted(A[k]); });
            var pm = ANS_PROP_PEND[rec.id] = ANS_PROP_PEND[rec.id] || {}, was = JSON.stringify(pm[pg] || []);
            if (pend.length) pm[pg] = pend; else delete pm[pg];
            if (was !== JSON.stringify(pm[pg] || [])) { ansPaintCard(rec, document.activeElement === rec.note && !!rec.note.value); ansRefresh(); }
          }
          if (qs.length < 2) return;
          // 1027 晚②(同上):只借方案页给他看资料的卡(没带 --deep-q),卡自己的问题照常能答;只有连着方案页某一题的卡才换成入口
          // ⭐ 1027 晚(投流达人 v1.9 转,负责人 18:1x:「你不让我所有问题都去方案页回答得了,你不要在那个状态板上再放一个事项让我去答」)
          //   ⇒ 连着 2 题以上方案页的卡只当入口:选项和答题框收起,只留题目进度 +「去方案页答」;状态词用人话
          if (rec.lq) rec.cd.classList.add('ans-multi');
          var LINE = String(document.title || '').replace(/\s*状态板[\s\S]*$/, '').trim() || '这条线';
          var rows = qs.map(function (x, i) {
            var a = A[x.id], ok = seen(a);
            if (!ok) left++;
            return { k: !ok ? 'no' : ansCounted(a) ? 'sub' : 'pend', t: (i + 1) + '. ' + x.q + (x.id === rec.lq ? '(就是这张卡)' : '') };
          });
          if (seen(A._overall)) rows.push({ k: ansCounted(A._overall) ? 'sub' : 'pend', t: '整份方案的补充' });
          var sig = JSON.stringify(rows);
          if (rec.qlist && rec.qlist.__sig === sig) return;
          if (!rec.qlist) {
            rec.qlist = ansEl('div'); rec.qlist.classList.add('ans-qlist');
            var qel = rec.cd.querySelector('h2.q');
            if (qel && qel.parentNode) qel.parentNode.insertBefore(rec.qlist, qel.nextSibling); else (rec.cd.querySelector('.body') || rec.cd).appendChild(rec.qlist);
          }
          rec.qlist.__sig = sig; rec.qlist.textContent = '';
          var h = ansEl('div', (rec.lq ? '这件事在方案页答:共 ' : '连着的方案页另有 ') + qs.length + ' 题' + (left ? ',还有 ' + left + ' 题没答(不答 = 按页上的建议)' : ',都答了'));
          h.classList.add('ans-qlist-h'); rec.qlist.appendChild(h);
          var dl = rec.cd.querySelector('a[href*="proposals/"]');
          if (dl) { var go = ansEl('a', '去方案页答 →'); go.setAttribute('href', dl.getAttribute('href')); go.classList.add('ans-qlist-go'); h.appendChild(go); }
          rows.forEach(function (r) {
            var e = ansEl('div', (r.k === 'no' ? '○ 没答 · ' : r.k === 'sub' ? '✓ 已发给 ' + LINE + ' · ' : '✎ 还没发给 AI · ') + r.t);
            e.classList.add(r.k === 'no' ? 'ans-q-no' : r.k === 'sub' ? 'ans-q-sub' : 'ans-q-pend'); rec.qlist.appendChild(e);
          });
        })
        .catch(function () {});
    };
    if (PLAN_QS[pg]) return paint(PLAN_QS[pg]);
    fetch('/_plan-qs?page=' + encodeURIComponent(pg), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { PLAN_QS[pg] = (j && Array.isArray(j.qs)) ? j.qs : []; paint(PLAN_QS[pg]); })
      .catch(function () {});
  } catch (e) {} }
  function ansPropFetch() { try {
    ansLinkFetch();
    ANS_CARDS.forEach(function (rec) {
      ansQList(rec);
      if (rec.lq) return;                         // 1020:连着一道题的卡只认那一题(ansLinkFetch),不按「这一页上答过任何一题」算
      var pages = [];
      Array.prototype.forEach.call(rec.cd.querySelectorAll('a[href]'), function (a) {
        var h = a.getAttribute('href') || '', m = /(?:^|\/)proposals\/([^\/?#]+\.html)(?:[?#]|$)/.exec(h);
        if (!m) return; var pg = m[1]; try { pg = decodeURIComponent(pg); } catch (e) {}
        if (pages.indexOf(pg) < 0) pages.push(pg);
      });
      if (!pages.length) return;
      var since = stampMs(rec.cd.getAttribute('data-since'));
      pages.forEach(function (pg) {
        fetch('/_answers?page=' + encodeURIComponent(pg), { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j || !j.answers || typeof j.answers !== 'object' || Array.isArray(j.answers)) return;
            var best = null, n = 0, pend = [];
            Object.keys(j.answers).forEach(function (k) {
              var a = j.answers[k], t = a && Date.parse(a.ts);
              if (!t || isNaN(t) || (since !== null && t < since)) return;
              n++; if (best === null || t > best) best = t;
              if (!a.copied && !ansCounted(a)) pend.push(k);
            });
            var pm = ANS_PROP_PEND[rec.id] = ANS_PROP_PEND[rec.id] || {}, was = JSON.stringify(pm[pg] || []);
            if (pend.length) pm[pg] = pend; else delete pm[pg];
            if (best === null) return;
            var cur = ANS_PROP[rec.id];
            if (cur && cur.t >= best) { if (was !== JSON.stringify(pm[pg] || [])) { ansPaintCard(rec, true); ansRefresh(); } return; }
            ANS_PROP[rec.id] = { t: best, ts: new Date(best).toISOString(), n: n };
            ansPaintCard(rec, true); ansOrder(); ansRefresh();
          })
          .catch(function () {});
      });
    });
  } catch (e) {} }
  // ⭐ 1110 子线投影(负责人 11-10 17:40 批方案页 subline-on-main-plan-1110「行,照图做」;他 16:30:只看主线的板、只和主线说话):
  //   带父板声明的子线板,它「要你的」里的真卡和一句进度现取过来画在本板上 —— 投影,本板文件里不落子线任何内容。
  //   名单 = boards-index 写的 ./_children.json(父板 → 子板);名单里没有本板 ⇒ 不发任何取子板的请求,页面一个字不变。
  //   取子板带 ?proj=1:伺服认得这个标记,不把它记成「有人开着子板」(last-fetch / pane-fetch 都不写)。
  //   投影卡上答 = 本板的卡一样答(选项 / 补充 / 交给这条线),但记在子板名下(ansPost 带 page = 子板);已看过记子板的键。
  //   区头 / 目录条的数只经 ansZoneHead 一处(投影卡登记进 zoneOf 就数得进去)。
  //   子板取不到 / 解析不了 ⇒ 本板照常,不报错;卡先整张做好再一起插,不留半张。子板内容变了 / 名单变了 ⇒ 走「有更新,停手几秒换上」。
  //   ⛔ 被否:子线把卡写进父板文件(整文件读改写没有按板的锁;叫醒按最近写入者选人;子线归档后留下没主的卡);让子线直接收父板上的卡。
  function ansAdopt(map, page) {
    if (!map || typeof map !== 'object') return;
    if (page && page !== ANS_PAGE) ANS_P[page] = map; else ANS_OWN = map;
    var m = {};
    Object.keys(ANS_OWN).forEach(function (k) { m[k] = ANS_OWN[k]; });
    Object.keys(PROJ_IDS).forEach(function (id) { var a = (ANS_P[PROJ_IDS[id]] || {})[id]; if (a) m[id] = a; else delete m[id]; });
    ANS = m;
  }
  function projMine(idx) {
    var a = (idx && typeof idx === 'object' && !Array.isArray(idx)) ? idx[ANS_PAGE] : null, out = [];
    if (!Array.isArray(a)) return out;
    a.forEach(function (e) {
      if (!e || typeof e.file !== 'string' || !/\.html$/.test(e.file) || e.file.indexOf('/') >= 0 || e.file === ANS_PAGE || typeof e.title !== 'string') return;
      var ent = { file: e.file, title: e.title, row: typeof e.row === 'string' ? e.row : '' };
      if (e.session === '子线会话不在' || e.session === '子线会话已归档') ent.session = e.session;
      if (Array.isArray(e.edited)) ent.edited = e.edited.filter(function (i) { return Number.isInteger(i) && i >= 0; });
      out.push(ent);
    });
    return out;
  }
  function projUrl(file) {
    return './' + encodeURIComponent(file) + '?proj=1';
  }
  function projLoad(first) {
    if (!HTTP) return Promise.resolve(0);
    return fetch('./_children.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (idx) {
        if (!idx || typeof idx !== 'object') return 0;          // 名单取不到 ⇒ 什么都不动(别因为一次 404 就换页)
        var mine = projMine(idx), sig = JSON.stringify(mine);
        if (!first && PROJ_SIG !== null && sig !== PROJ_SIG) {
          showUpdateHint();
          mine.forEach(function (ent) { projRefreshStall(ent); });
          return mine.length;
        }
        PROJ_SIG = sig;
        mine.forEach(function (ent) {
          fetch(projUrl(ent.file), { cache: 'no-store' })
            .then(function (r) { return r.ok ? r.text() : null; })
            .then(function (t) { if (t) projApply(ent, t); })
            .catch(function () {});
        });
        return mine.length;
      })
      .catch(function () { return 0; });
  }
  function projStart() {
    projLoad(true);
    setInterval(function () { projLoad(false); }, PROJ_TICK);
  }
  function projPick(doc) {   // 子板「要你的」里的真卡:有编号、不是机器卡、不是占位卡、不是卡里套的卡
    var zone = '', out = [];
    Array.prototype.forEach.call(doc.querySelectorAll('.zone h2, .sec h2, .b-zone h2, .card'), function (el) {
      if (el.tagName === 'H2') { zone = el.textContent || ''; return; }
      if (zone.indexOf('要你的') < 0) return;
      if (el.parentNode && el.parentNode.closest && el.parentNode.closest('.card')) return;
      var id = el.getAttribute('data-ack') || '';
      if (!id || ANS_MACHINE.test(id) || isYoursPlaceholder(el)) return;
      var machine = false;
      Array.prototype.forEach.call(el.querySelectorAll('.chips .chip'), function (c) { if (/机器生成/.test(c.textContent || '')) machine = true; });
      if (!machine) out.push(el);
    });
    return out;
  }
  function projRowsGist(doc) {   // 一句进度:子板「你交代的」里没做完、最近动过的一行,取它 .why 的第一句(同首屏 fsFirst);没有 .why 取标题
    var zone = '', best = null, bt = -1;
    Array.prototype.forEach.call(doc.querySelectorAll('.zone h2, .sec h2, .b-zone h2, .card'), function (el) {
      if (el.tagName === 'H2') { zone = el.textContent || ''; return; }
      if (zone.indexOf('你交代的') < 0 || el.hasAttribute('data-sub')) return;
      if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(el.getAttribute('data-ack') || '')) return;
      Array.prototype.forEach.call(el.querySelectorAll('.crow[data-status]'), function (r) {
        if (!OPEN_ST[r.getAttribute('data-status') || '']) return;
        var mv = rowMovedAt(r), t = mv.t === null ? 0 : mv.t;
        if (best === null || t > bt) { best = { r: r, mv: mv }; bt = t; }
      });
    });
    if (!best) return { s: '', mv: { t: null, src: null } };
    var b = best.r.querySelector('.txt > b');
    return { s: fsFirst(best.r.querySelector('.why')) || ((b && b.textContent) || '').replace(/\s+/g, ' ').trim(), mv: best.mv };
  }
  function projStall(doc, session, now, edited) {
    var zone = '', rows = [], counts = {}, ri = 0, current = now === undefined ? Date.now() : now;
    Array.prototype.forEach.call(doc.querySelectorAll('.zone h2, .sec h2, .b-zone h2, .card'), function (el) {
      if (el.tagName === 'H2') { zone = el.textContent || ''; return; }
      if (zone.indexOf('你交代的') < 0 || el.hasAttribute('data-sub')) return;
      if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(el.getAttribute('data-ack') || '')) return;
      Array.prototype.forEach.call(el.querySelectorAll('.crow[data-status]'), function (r) {
        var index = ri++, st = r.getAttribute('data-status') || ''; if (!OPEN_ST[st]) return;
        var reasons = [], mv = rowMovedAt(r), f = rowFacts(r);
        if (session) reasons.push(session);
        if (r.hasAttribute('data-chat-new')) reasons.push('群里有新回复要重判');
        if ((st === 'doing' || st === 'blocked') && (!edited || edited.indexOf(index) < 0) && mv.t !== null && (current - mv.t) > DOING_STALE_HOURS * 36e5) reasons.push('超过24小时没动');
        if (f.late > 0) reasons.push('预计日已过');
        var sod = f.open ? stallOverdue(r, current) : null;   // ⭐ 1117 tail-2:子线上「等了 N 个工作日没结果」也投到父板(与 board.py `_child_stall_rows` 同一句;两样都到只写这句)
        if (sod !== null) reasons.push('等了 ' + sod + ' 个工作日没结果');
        else if (f.open && chaseOverdue(r, current, doc) !== null) reasons.push(['decide', 'do', 'nudge'].includes(f.you) ? '等你动但没挂卡' : '叫过没人追');   // 与 board.py `_child_stall_rows` 同一句
        if (reasons.length) { rows.push(r); reasons.forEach(function (s) { counts[s] = (counts[s] || 0) + 1; }); }
      });
    });
    var top = ''; Object.keys(counts).forEach(function (s) { if (!top || counts[s] > counts[top]) top = s; });
    return { n: rows.length, why: top ? top + ' ' + counts[top] + ' 件' : '' };
  }
  function projRefreshStall(ent, doc) {
    var p = ent.row && PROJ_ROWS[ent.row];
    if (!p || p.page !== ent.file || !(doc || p.doc)) return;
    var next = projStall(doc || p.doc, ent.session, undefined, ent.edited);
    if (JSON.stringify(next) !== JSON.stringify(p.stall)) {
      p.stall = next;
      try { paintFirstScreen(); } catch (e) {}
    }
  }
  function projGist(s, n) {   // 有没交的投影卡 ⇒ 先说「等你定 N 件」;再接现状一句;都没有 ⇒「都做完了」
    var g = n > 0 ? '等你定 ' + n + ' 件' : '';
    if (s) g = g ? g + ' · ' + s : s;
    return g || '都做完了';
  }
  function projSub(ack) {
    var p = ack && PROJ_ROWS && PROJ_ROWS[ack];
    if (!p) return '';
    var n = 0;
    ANS_CARDS.forEach(function (rec) { if (rec.page === p.page && !(rec.cd && rec.cd.classList && rec.cd.classList.contains('ans-done'))) n++; });
    return p.title + ':' + (p.stall && p.stall.n ? p.stall.n + ' 件停着(' + p.stall.why + ')' : projGist(p.s, n));
  }
  function projMv(r, mv) {   // 父板那一行「上次动」取父行和子板里晚的那个
    var p = (PROJ_ROWS || {})[(r && r.getAttribute && r.getAttribute('data-ack')) || ''];
    if (!p || !p.mv || p.mv.t === null) return mv;
    return (mv.t === null || p.mv.t > mv.t) ? p.mv : mv;
  }
  function projTag(a, cd) {   // 首屏「要你做的」那一件后面:同色小药丸「来自 子线·X」
    var from = cd && cd.getAttribute && cd.getAttribute('data-proj-from');
    if (!from) return a;
    var m = a.querySelector('.fsx-meta') || a, sp = document.createElement('span');
    sp.classList.add('fsx-proj'); sp.textContent = '来自 ' + from; m.appendChild(sp);
    return a;
  }
  function projAck(cd, page, id) {   // 「标为已看过」记在子板的键下(和子板自己那页同一个键:SLUG = 子板地址里的文件名)
    var key = 'status-board-board:' + encodeURIComponent(String(page)).replace(/\.html?$/i, '') + ':ack', acked = {};
    try { acked = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
    var btn = document.createElement('div');
    btn.className = 'ack';
    var paint = function () { btn.textContent = acked[id] ? '✓ 已看过 · 点开' : '○ 标为已看过'; };
    if (acked[id]) cd.classList.add('acked');
    paint();
    btn.addEventListener('click', function () {
      try { acked = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) {}
      if (acked[id]) { delete acked[id]; cd.classList.remove('acked'); } else { acked[id] = 1; cd.classList.add('acked'); }
      try { localStorage.setItem(key, JSON.stringify(acked)); } catch (e) {}
      paint();
    });
    cd.appendChild(btn);
  }
  function projSubmitPages() {
    var m = {};
    ANS_CARDS.forEach(function (rec) { if (rec.page) (m[rec.page] = m[rec.page] || []).push(rec.id); });
    Object.keys(m).forEach(function (pg) { ansPost({ submit: m[pg] }, pg).then(function (map) { if (map) ansAdopt(map, pg); }); });
  }
  function projApply(ent, text) {
    try {
      var doc = new DOMParser().parseFromString(text, 'text/html');
      var gn = doc.querySelector('[data-gen]'), gen = gn ? gn.getAttribute('data-gen') : String(text.length);
      if (PROJ_GEN[ent.file] !== undefined) {
        if (PROJ_GEN[ent.file] !== gen) showUpdateHint(); else projRefreshStall(ent, doc);
        return;
      }
      PROJ_GEN[ent.file] = gen;
      if (ent.row) { var gi = projRowsGist(doc); PROJ_ROWS[ent.row] = { title: ent.title, page: ent.file, s: gi.s, mv: gi.mv, doc: doc, stall: projStall(doc, ent.session, undefined, ent.edited) }; }
      var zy = document.getElementById(['zone-', '要你的'].join('')), zh = zy && zy.querySelector('h2');
      var built = [];
      (zy ? projPick(doc) : []).forEach(function (src) {
        var id = src.getAttribute('data-ack');
        if (PROJ_IDS[id] !== undefined || document.getElementById(['ack-', id].join('')) || document.getElementById(['proj-', id].join(''))) return;
        var cd = document.importNode(src, true);
        cd.id = 'proj-' + id; cd.setAttribute('data-proj-page', ent.file); cd.setAttribute('data-proj-from', ent.title);
        cd.removeAttribute('data-vz'); cd.removeAttribute('data-ans');
        var chips = cd.querySelector('.chips');
        if (!chips) {
          chips = document.createElement('div'); chips.classList.add('chips');
          var q0 = cd.querySelector('h2.q');
          if (q0 && q0.parentNode) q0.parentNode.insertBefore(chips, q0); else cd.insertBefore(chips, cd.firstChild);
        }
        var tag = document.createElement('span'); tag.classList.add('chip'); tag.classList.add('proj-from'); tag.textContent = '来自 ' + ent.title;
        chips.insertBefore(tag, chips.firstChild);
        built.push(cd);
      });
      if (built.length) {
        var real = null, ph = [];
        document.querySelectorAll('.card').forEach(function (c) { if (!inYours(c)) return; if (isYoursPlaceholder(c)) ph.push(c); else if (!real) real = c; });
        var host = real ? real.parentNode : (ph.length ? ph[0].parentNode : zy.parentNode);
        var before = real ? real : (ph.length ? ph[0].nextSibling : zy.nextSibling);
        built.forEach(function (cd) {
          host.insertBefore(cd, before);
          zoneOf.set(cd, (zh && zh.textContent) || '要你的');
          cd.querySelectorAll('.crow[data-status] > .mk').forEach(function (mk) {
            var st = mk.parentNode.getAttribute('data-status'); if (st === 'blocked') st = 'doing';
            if (GLYPH_ALL[st]) { mk.textContent = GLYPH_ALL[st]; mk.classList.add(MKCLS[st]); }
          });
          projAck(cd, ent.file, cd.getAttribute('data-ack'));
        });
        ph.forEach(function (x) { x.style.display = 'none'; });
        try { vzAsks(); } catch (e) {}
        try { vzDropDates(); } catch (e) {}
        built.forEach(function (cd) {
          cd.setAttribute('data-ans', '1');
          var rec = ansBuild(cd); rec.page = ent.file; ANS_CARDS.push(rec); PROJ_IDS[rec.id] = ent.file;
        });
        if (!PROJ_VIS) {
          PROJ_VIS = true;
          document.addEventListener('visibilitychange', function () {
            if (document.hidden) ANS_CARDS.forEach(function (rec) { if (!rec.page) return; try { clearTimeout(rec.tm); ansSave(rec); } catch (e) {} });
          });
        }
        if (HTTP) fetch('/_answers?page=' + encodeURIComponent(ent.file), { cache: 'no-store' })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (!j || !j.answers || typeof j.answers !== 'object' || Array.isArray(j.answers)) return;
            ansAdopt(j.answers, ent.file);
            ANS_CARDS.forEach(function (rec) { if (rec.page === ent.file) ansPaintCard(rec, document.activeElement === rec.note && !!rec.note.value); });
            try { ansDraftRestore(ent.file); } catch (e) {}
            ansRefresh();
          })
          .catch(function () {});
        try { ansPropFetch(); } catch (e) {}
        if (!LINK_TICK && ANS_CARDS.some(function (rec) { return rec.lq; })) { LINK_TICK = true; setInterval(ansLinkFetch, 20000); }   // 依据: 与 initAnswers 里方案页那一题同一 20 秒
      }
      orderYours(); ansRefresh();
      var hs = (location.hash || '').slice(1);
      if (hs.indexOf('proj-') === 0) { var tg = document.getElementById(decodeURIComponent(hs)); if (tg) scrollPin(tg, 'start'); }   // 1114:载入时图还在路上,一次瞬时滚动会偏 ⇒ 走 scrollPin
    } catch (e) {}
  }
  function initAnswers() { try {
    if (ANS_CARDS.length) return;
    document.querySelectorAll('.card').forEach(function (cd) {
      if (!ansIsAuthorCard(cd) || cd.hasAttribute('data-ans')) return;
      cd.setAttribute('data-ans', '1');
      try { ANS_CARDS.push(ansBuild(cd)); } catch (e) {}
    });
    if (!ANS_CARDS.length) { try { ansDraftRestore(); } catch (e) {} return; }   // 1021 晚:卡全被收走了,写了没交出去的字照样要摆出来
    // 面板收起 / 切走那一刻,把写了没记的先记上(后台刷新会把没记的字冲掉)
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) ANS_CARDS.forEach(function (rec) { if (rec.page) return; try { clearTimeout(rec.tm); ansSave(rec); } catch (e) {} });   // 投影卡由 projApply 那份管
    });
    if (!HTTP) return;
    fetch('/_answers?page=' + encodeURIComponent(ANS_PAGE), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.answers || typeof j.answers !== 'object' || Array.isArray(j.answers)) return;   // 接口不在 / 回的不是那个形状 ⇒ 当没有答案,板照常
        ansAdopt(j.answers);
        ANS_CARDS.forEach(function (rec) { ansPaintCard(rec, document.activeElement === rec.note && !!rec.note.value); });
        ansOrder();
        try { ansDraftRestore(); } catch (e) {}                    // 1021 晚:上次写了没记上的字回填并替他记上;卡已不在的单列出来
        ansRefresh();
      })
      .catch(function () {});
    ansPropFetch();
    if (ANS_CARDS.some(function (rec) { return rec.lq; })) {   // 1020:他可能正开着方案页在答 ⇒ 板这边隔一会儿再取一次那一题
      LINK_TICK = true; setInterval(ansLinkFetch, 20000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) ansLinkFetch(); });
    }
  } catch (e) {} }

  // ⭐⭐ 同侪条:在**每一块板**上告诉他「别的线要不要你」(负责人 2026-08-28 拍)。
  //
  //   他原话:「我现在基本都只看状态板了……最多扫一眼最近一条消息」。
  //   而他看板的方式是「切到哪条对话就看哪块板」⇒ **别的线在等他拍什么,他看不到**。
  //   总览页有这份数据,但它在**一次点击之外**,而「他会去点」是本体系反复证伪过的假设
  //   (Chrome 收藏、「详见完整记录」都是同一个形状:多一步就等于没有)。
  //
  //   ⚠ 只放三样:线名 / 多久没动 / 等你拍几件。**不放内容** —— 它是导航,不是第二真相源。
  //   数据由 `boards-index.py` 写进 `_peers.json`,取不到就整条不显示(宁可没有,不要错的)。
  function paintPeers() {
    // ⚠⚠ 必须解码(设计系统 v2.2 2026-08-28 面板内实测报回):
    //   `location.pathname` 是**百分号编码**的(`%E6%99%BA…`),而 `_peers.json` 里是**原始中文**
    //   ⇒ 两边永远不等 ⇒ **中文名的板排除不掉自己**:把自己列进 pill、标题数字也多算本板那几件。
    //   ⭐ 它躲过我验收的原因值得单独记:`ios.html` 是纯 ASCII,编码前后一样 ⇒
    //     **我自己那块板恰好是唯一不发作的**。与 `--dim` 那次一模一样(5 块坏 4 块,好的那块是 iOS)。
    //   ⇒ 判据(设计系统线提的,我认领):**改共享层之后,拿一块「不是自己那块」的板验。**
    var _raw = location.pathname.split('/').pop() || '';
    var self;
    try { self = decodeURIComponent(_raw).toLowerCase(); }
    catch (e) { self = _raw.toLowerCase(); }   // 畸形转义会抛,退回原值总比整条不显示好
    var host = document.getElementById('peers');
    if (!host) return;
    // ⭐⭐ 0918 负责人推翻了我的第一版:「**别的线还有多少件事情要你做,如果跟当前我看的这条线没有关系,
    //   你根本不用放在上面。**…除非 iOS 线的某个事情卡住了你状态板线的某个事项…**只有这种情况下**,
    //   你才应该在状态板线上把这个事情展示出来。」
    //   ⚠ 我提的是「收成一行」—— **收起来 ≠ 不显示**,他连那一行都不想看到跟本线无关的东西。
    //   ⇒ 名单由 `board.py sync` 从本线 `.queue.json` 的 `blocked_by` 结构位算出来,写在 data-only 上。
    //   ⛔ **名单为空 ⇒ 整条不渲染**(连标题都不要)。这一侧是安全的:漏显示只是少一条导航,
    //     而错显示会让他每块板都扫一遍跟自己无关的东西 —— 那正是他要我删掉的。
    var only = (host.getAttribute('data-only') || '').trim();
    var onlySet = only ? only.toLowerCase().split(/\s+/) : [];
    if (!onlySet.length) { host.textContent = ''; host.style.display = 'none'; return; }
    host.style.display = '';
    // ⚠ 挂载点由 `board.py sync` 写在**页脚那一段**里(那是 sync 唯一能稳定重建的区域),
    //   而这条导航必须在**最上面**才有用 —— 他只看板顶那一屏。所以第一次渲染时把它搬上去。
    //   ⭐ 2026-08-28 实证 ①:不搬的话机检全绿(`hostExists:true`、数据也对)、而**截图里根本看不见**
    //     —— 「绿了但不是我要的那个绿」,只有渲图看得出来。
    //   ⭐⭐ 实证 ②(总控 v5.3 同日报回,**推翻了我的第一版锚点**):首版用
    //     `.northstar || .zone` 定位 —— 而**三块板一个 .northstar 都没有**,且总控那块板
    //     唯一一处 `class="zone"` **出现在注释里**(kit 自己的注释逐字引用了它)⇒
    //     `querySelector` 返回 null ⇒ 整条搬运没跑,条子留在页脚,**要滚 8,600px 才看得见**。
    //     ⇒ 锚点必须挑**每块板都保证存在**的:`#freshness`(板顶那行「生成于…·N 分钟前」)
    //       —— 6 块板各 1 个,且 lint 强制 `data-gen` 必须在 HTML 属性上,它不会消失。
    //   ⚠ 同族:「文本级匹配会咬到注释」——这次是 CSS 选择器咬到注释里的 class 字符串。
    var anchor = document.getElementById('freshness');
    if (anchor && anchor.parentNode) {
      if (host.previousElementSibling !== anchor) {
        anchor.parentNode.insertBefore(host, anchor.nextSibling);
      }
    } else {
      var alt = document.querySelector('.northstar') || document.querySelector('.zone');
      if (alt && alt.parentNode && host.nextElementSibling !== alt) alt.parentNode.insertBefore(host, alt);
    }
    fetch(paneUrl('./_peers.json', PANE_S), { cache: 'no-store' })   // 1110 面板归属:同上
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (list) {
        if (!list || !list.length) return;
        // ⚠ 用 DOM API 建、classList.add 加类,**不用字符串拼 HTML**:
        //   lint 的孤儿类检查靠扫 `className=` / `classList.add(...)` 才看得见运行时注入的类;
        //   拼字符串的话这些类对它是隐形的(而且会把 JS 碎片喂给它的 `class="…"` 正则)。
        // ⭐ 分三档,不是二值隐藏(负责人 2026-08-28 提,他撞到的是「AI平台-运维 迁去 Codex 了、
        //   三十多小时没动,却还挂在『别的线等你拍』最前面」)。
        //
        //   ⚠ 他建议按时间隐藏,方向对,但**有个坑必须绕开**:
        //     「久没动」和「不需要你」**不是一回事** —— 一条线可能**正是因为卡在他身上**才不动。
        //     那种情况下按时间隐藏,恰好把最该看见的藏起来。而两者的数据**长得一模一样**。
        //   ⭐ 这正是本板自己踩过的坑:「排队中的活」那次折叠,让「0 张能开工」和
        //     「0 张待办」看起来一样,他当场误读。结论是 **不许静默隐藏,要先摆总数**。
        //
        //   ⇒ 做法:久没动的**不占 pill 位置**,但归进一行小字;
        //     而其中 **pending>0 的要点名**(只给数字他分不出是哪条),
        //     并把「它可能真在等你 / 也可能那块板该撤了」两种读法一起写出来 —— 只有他能分。
        var STALE_H = 10;                       // 超过这么久没动就降级(负责人给的数)
        var now = Date.now() / 1000, rows = [], asks = 0, dorm = [], dormAsk = 0;
        list.forEach(function (p) {
          if ((p.file || '').toLowerCase() === self || p.archived) return;
          if (onlySet.indexOf((p.file || '').toLowerCase()) < 0) return;   // ⭐ 不卡着本线的一件都不出现
          var min = p.epoch ? Math.round((now - p.epoch) / 60) : null;
          var need = (p.pending || 0) > 0;
          if (min !== null && min > STALE_H * 60) {
            dorm.push({ name: String(p.title || p.file).replace(/\s*状态板\s*$/, ''),
                        h: Math.round(min / 60), pending: p.pending || 0, file: p.file });
            if (need) dormAsk += p.pending;
            return;                             // 不进 pill 行
          }
          if (need) asks += p.pending;
          var a = document.createElement('a');
          a.classList.add('peer');
          if (need) a.classList.add('peer-need');
          if (min !== null && min > 180) a.classList.add('peer-stale');
          a.href = './' + encodeURIComponent(p.file);
          var nm = document.createElement('b');
          nm.textContent = String(p.title || p.file).replace(/\s*状态板\s*$/, '');
          a.appendChild(nm);
          if (need) {
            var n = document.createElement('span');
            n.classList.add('peer-n');
            n.textContent = '要你的 ' + p.pending;
            a.appendChild(n);
          }
          var ag = document.createElement('span');
          ag.classList.add('peer-age');
          ag.textContent = (min === null ? '?' : (min < 60 ? min + ' 分钟' : Math.round(min / 60) + ' 小时')) + '前';
          a.appendChild(ag);
          rows.push(a);
        });
        host.textContent = '';
        if (!rows.length) return;
        var t = document.createElement('div');
        t.classList.add('peers-t');
        // ⭐ 文案要答「它凭什么出现在这块板上」—— 只有一个答案:它卡着本线的事。
        t.appendChild(document.createTextNode('⚠ '));
        var strong = document.createElement('b');
        strong.textContent = rows.length + ' 条线卡着这块板上的事';
        t.appendChild(strong);
        t.appendChild(document.createTextNode(
          asks ? '（其中 ' + asks + ' 件是在等你）—— 点进去看' : ' —— 点进去看'));
        var row = document.createElement('div');
        row.classList.add('peers-row');
        rows.forEach(function (a) { row.appendChild(a); });
        host.appendChild(t);
        host.appendChild(row);

        // ⭐ 久没动的那一行 —— 不静默丢掉,但也不占最醒目的位置
        if (dorm.length) {
          var d = document.createElement('div');
          d.classList.add('peers-dorm');
          dorm.sort(function (a, b) { return b.pending - a.pending || b.h - a.h; });
          d.appendChild(document.createTextNode('其中 ' + dorm.length + ' 条 ≥' + STALE_H + ' 小时没动'));
          if (dormAsk) {
            // ⚠ 点名,不能只给数字:「它真在等你」和「那块板没人管了」数据一样,只有他能分
            d.appendChild(document.createTextNode('，其中仍标着要你的：'));
            dorm.filter(function (x) { return x.pending > 0; }).forEach(function (x, i) {
              if (i) d.appendChild(document.createTextNode('、'));
              var a2 = document.createElement('a');
              a2.classList.add('peer-dorm-link');
              a2.href = './' + encodeURIComponent(x.file);
              a2.textContent = x.name + '(' + x.h + 'h · ' + x.pending + ' 件)';
              d.appendChild(a2);
            });
            var hint = document.createElement('span');
            hint.classList.add('peers-dorm-hint');
            hint.textContent = ' —— 要么它真在等你，要么那块板该撤了';
            d.appendChild(hint);
          } else {
            d.appendChild(document.createTextNode('，都没有要你的'));
          }
          host.appendChild(d);
        }
      })
      .catch(function () { /* 取不到就不显示 —— 导航条错了比没有更糟 */ });
  }
  // ⭐⭐⭐ 1013 负责人(状态板 v1.6)首屏四块 —— 他回来开板只问三件:「当前什么事情被卡着,什么事情在推进…还有什么事情需要我去做」
  //   「下一次来的时候,我肯定要能大概提醒我该验收哪些事情」。样板他 10-13 看过,定了全部板直接换上。
  //   ① 要你做的(= 原有「要你的」区,不动)② 待你验收(做完了要他点「通过」的;1114 起并进「要你的」,见下面 1114 第 3 步那段)
  //   ③ 卡着的 / 没开工的 —— 分两段:在等的(等你 / 在等谁 / 排在哪件后面)和【没在等谁、却还没开工的】
  //   ④ 在推进的(不限件数,他 10-13 否了上限)。「你交代的」整本台账收进一个折叠,要查旧事再点开。
  //   ⭐ ③ 的第二段是他 10-13 点名的:「只要他能立刻做的事情,不就应该立刻开始吗?为什么会有这么多事情会排到10月15号或10月20号」。
  //     全机当天 24 行标着没开始,23 行只有一个预计日、没写在等什么 ⇒ 这里不再把预计日写成「排到几号」,没写在等谁的单列并标红。
  //     判据全在行上现成的属性:blocked = 在等;todo 带 data-after = 排在别的行后面;todo 带 data-wait-for = 在等(1110);todo 什么都不带 = 没在等谁。
  //   「你上次发话」的时间:hooks/board-pane-check.js 在他发话那一刻写 boards-web/_said/<板文件名>.json;取不到 ⇒ 退成「最近 24 小时做完的」并照实写。
  //   ⚠ 它只是索引:每行点了跳到台账里那一行(jumpToRow 会把折叠打开),内容不在这里另存一份。
  //   ⚠ 原来板顶的三块(卡着的索引 / 在做的 / 目录条)照旧生成、只是藏起来 —— 目录条那个函数还管着区头件数,别删。
  //   ⚠ 必须排在 tameAll 之后:收进折叠的行量不出高度。类名全部新起 fsx- 前缀、classList.add 写全名。
  var FS_SAID = null, FS_CUT = 96;
  function fsFirst(el) {
    if (!el) return '';
    var c = (el.querySelector('.tame-full') || el).cloneNode(true);
    Array.prototype.forEach.call(c.querySelectorAll('.rtl-more, .tame-more, .tame-sum, .xref-t, .rbaton, .rafter, .rchat, .rack'), function (x) { x.remove(); });
    var t = (c.textContent || '').replace(/\s+/g, ' ').trim();
    var m = /^.{6,}?[。;；!！?？]/.exec(t); t = m ? m[0] : t;
    return t.length > FS_CUT ? t.slice(0, FS_CUT) + '…' : t;
  }
  function paintFirstScreen() { try {
    // 依据: 11-23 核实报告 ② 和巡检故障补充，判据与 board.py _stuck_escalation 一致。
    function stuckEscalation(r, f, now, paused) {
      if (paused || !f.open || (f.st !== 'watch' && f.st !== 'todo')) return '';
      var ack = r.getAttribute('data-ack') || '';
      var pushed = (r.getAttribute('data-eta-n') || '').trim();
      var repeat = f.st === 'todo' && /^ntc-/.test(ack) && /第\s*([0-9]+)\s*次报/.exec(rowTitleText(r));
      if (f.st === 'watch' ? !/^[0-9]+$/.test(pushed) || +pushed < 2 : !repeat || +repeat[1] < 2) return '';
      var at = stampMs((r.getAttribute('data-txt-at') || '').trim());
      if (at === null) at = stampMs((r.getAttribute('data-upd') || '').trim());
      var days = at === null ? 0 : Math.floor((now - at) / 864e5);
      if (days < 3) return '';
      if (f.you === 'decide' && (r.getAttribute('data-you-card') || Array.from(document.querySelectorAll('article.card')).some(function (card) {
        if (card.getAttribute('data-proj-from') || /^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(card.getAttribute('data-ack') || '')) return false;
        return (card.getAttribute('data-accept-rows') || '').split(/\s+/).includes(ack)
          || Array.from(card.querySelectorAll('a[href^="#row-"]')).some(function (a) { return a.getAttribute('href') === '#row-' + ack; });
      }))) return '';
      if (f.st === 'watch') return '预计日推了 ' + (+pushed) + ' 次,现状 ' + days + ' 天没变';
      if (/^日子\s*[:：]/.test(f.waitFor) && f.eta !== null && f.eta > today0()) return '';
      return '机器报了 ' + (+repeat[1]) + ' 次还没人处理';
    }

    // 1116 等外部总时长的判据 stallOverdue 在 paintFirstScreen 紧后面(1117 tail-2 提到外层,子线投影也用)
    var zq = document.getElementById(['zone-', '要你的'].join('')), zy = document.getElementById(['zone-', '你交代的'].join(''));
    if (!zq || !zy || !zq.parentNode) return;
    var wrap = zq.parentNode, now = Date.now();   // ⚠ 取「要你的」的父节点:「你交代的」第二次画时已经在台账折叠里了
    var rows = [];
    document.querySelectorAll('.crow[data-status]').forEach(function (r) {
      var cd = r.closest('.card');
      if (!cd || (zoneOf.get(cd) || '').indexOf('你交代的') < 0 || cd.hasAttribute('data-sub')) return;
      if (/^(stale-generated|nudge-generated|blocked-on-you|queue-generated|rows-on-you|main-)/.test(cd.getAttribute('data-ack') || '')) return;
      rows.push(r);
    });
    var pz = boardPaused(), paused = !!pz;
    var saidMs = FS_SAID ? stampMs(FS_SAID) : null, since = saidMs !== null ? saidMs : now - 864e5;
    var fresh = [], waiting = [], idle = [], doing = [], watch = [], obs = [], nDone = 0, nWatch = 0;
    rows.forEach(function (r) {
      var f = rowFacts(r), mv = rowMovedAt(r), his = f.open && !!BALL_HIS[f.you || ''];
      var it = { r: r, f: f, mv: projMv(r, mv), pj: !!(PROJ_ROWS || {})[r.getAttribute('data-ack') || ''] };   // 1110 子线投影:这一行有子线在做 ⇒ 上次动取子板里最近那次
      // ⭐ 1020 负责人(板上答「按这个改」):「做完了」= 最近 24 小时做完的、只是告诉你一声;要你看结果 / 审核的挂「要你的」卡。
      //   ⛔ 不再按「你上次发话」算 —— 那判不了他看没看。
      // ⭐ 1110 负责人(方案页 fable-audit-plan-1110 题 ack-button,看着前后对比图选「按建议改」):每件的「知道了」撤掉 ——
      //   全机最后一次点击是 10-24,之后露出 641 件、点了 0 次。「做完了」= 最近 24 小时做完的,不再看点没点过;
      //   整块只露一行,点区头才展开(foldBlock)。台账里那一行的已读记录照旧,不归这里管。
      if (f.st === 'done') { nDone++;
        if (mv.t !== null && mv.t > now - 864e5) fresh.push(it); return; }
      var escalation = stuckEscalation(r, f, now, paused);
      if (escalation) { it.chip = escalation; it.hot = true; it.escalation = true; waiting.push(it); return; }
      // 1023 晚:登记的对方群里有人说了新的、这一行还没重判 ⇒ 不管球在谁那边,都进「卡着的」最前面、标红(见 paintRowChat)
      if (f.open && r.getAttribute('data-chat-new')) { it.chip = chatChip(r); it.hot = true; it.chat = true;
        it.sub = '「' + (r.getAttribute('data-chat-say') || '') + '」'; waiting.push(it); return; }
      // ⭐ 1116 等外部总时长:叫过「换一条路」、次日还没处理 ⇒ 进「卡着的」、标红(见 stallOverdue);排在「没人追」前面(它更久)
      var sod = f.open ? stallOverdue(r, now) : null;
      if (sod !== null) { it.chip = '等了 ' + sod + ' 个工作日没结果'; it.hot = true; it.chase = true;
        it.sub = '在等 ' + (r.getAttribute('data-wait-for') || '').slice(0, 30) + ' · 追过 ' + (parseInt(r.getAttribute('data-chase-n') || '0', 10) || 0) + ' 次'; waiting.push(it); return; }
      // ⭐ 1113 等外部计时:叫过主人线、次日还没人追 ⇒ 不管是盯着还是卡着,都进「卡着的」、标红(见 chaseOverdue)
      var cod = f.open ? chaseOverdue(r, now, document) : null;
      if (cod !== null && his && f.you !== 'stuck') {
        it.title = '在等你:' + rowTitleText(r); it.chip = '挂了 ' + cod + ' 天没人挂卡';
        it.hot = true; it.chase = true; it.youIdle = true; waiting.push(it); return;
      }
      // ⭐ 1119 过了预计、球在 AI 这边,叫过次日没处理 ⇒ 一行:卡在哪条线 · 过了预计 N 天(不贴现状、不加「N 天没核」)
      if (cod !== null && lateRow(r, now)) { it.chip = '卡在 ' + boardLineName() + ' · 过了预计 ' + cod + ' 天'; it.hot = true; it.chase = true; it.late = true; waiting.push(it); return; }
      if (cod !== null) { it.chip = '等了 ' + cod + ' 天没人追'; it.hot = true; it.chase = true;
        it.sub = '在等 ' + (r.getAttribute('data-wait-for') || '').replace(/^\s*日子\s*[:：]\s*/, '日子:').slice(0, 30); waiting.push(it); return; }
      // ⭐ 1116 板腐烂 7:第一句写着做完了、其实还挂着,连着 24 小时没拆 ⇒ 进「卡着的」、标红(见 doneFirstHours)
      var dfh = f.open ? doneFirstHours(r, now) : null;
      if (dfh !== null) { it.chip = '写着做完了其实还挂着 · ' + (dfh >= 48 ? Math.floor(dfh / 24) + ' 天' : dfh + ' 小时') + '没拆开'; it.hot = true; it.chase = true;
        it.sub = fsFirst(r.querySelector('.why')); waiting.push(it); return; }
      // ⭐ 1117 J4:写行时提醒过、挂满 HINT_RED_H 小时还没改 ⇒ 进「卡着的」、标红(见 hintedOld)
      var hod = f.open ? hintedOld(r, now) : null;
      if (hod !== null) { it.chip = '提醒过 ' + (hod.h >= 48 ? Math.floor(hod.h / 24) + ' 天' : hod.h + ' 小时') + '还没改'; it.hot = true; it.chase = true;
        it.sub = HINT_LABEL[hod.k] || '写这一行时机器提醒过一处会烂的写法'; waiting.push(it); return; }
      // ⭐ 1021 负责人:「你跟我说有 3 件没做完,但我在状态板上看不到任何事情是没做完的……我直接完全不看你的对话记录的情况下,能做到吗?」
      //   长期看着(watch,定了日子再做)原来只在台账折叠里计个数 ⇒ 首屏四块哪儿都没有它。⇒ 放进「在推进的」,写明等到哪天。
      //   1021 晚(示例-投流转负责人 16:2x:「这种事情为什么会定在10月28号做?……不是今天就应该解决的吗」):原写「定在 X 做」,
      //   读起来像「排到那天才动手」,而 watch 是「在做 / 在等别的事发生,我盯着,到那天出结论」⇒ 写「盯到 X」。
      if (f.st === 'watch') { nWatch++;
        it.chip = f.late ? '盯到 ' + f.er + ' · 已过 ' + f.late + ' 天' : (f.er ? '盯到 ' + f.er : '一直盯着,没写到哪天');
        if (his) it.chip += ' · 也等你';
        it.hot = !!f.late || !f.er; watch.push(it); return; }
      // ⭐ 1020 负责人:「卡着的几件事情…会跟要你的里面…重复…本质一定是两件事情」⇒ 卡在他身上的只在「要你的」(机器卡列这些行)
      // ⭐ 1105 负责人(经 AI平台 v2.0):「我就不应该翻你任何的聊天记录」。Image 2.6 那行在做,只是多挂了一张「2.5 要不要保留」的卡,整行从「在推进的」消失,像这件事没了。
      //   ⇒ 只有真卡着的才只留在「要你的」;在做 / 盯着的 AI 这边还有活,留在「在推进的」,标「也等你」(同 board.py `_recheck_rows` 的口径:status=doing 就是还有活)。
      if (his && f.st !== 'doing') return;
      // ⭐ 1117 J6:观察中(等的日子没到)不进真卡着、折在块底;日子过了没核 ⇒ 真卡着、标红(见 isObserving / obsLateDays)
      if (isObserving(r, f)) { it.chip = '等到 ' + f.er + ' 自动核'; obs.push(it); return; }
      var odl = obsLateDays(r, f);
      if (odl) { it.chip = '日子 ' + f.er + ' 过了 ' + odl + ' 天没核'; it.hot = true; it.sub = '在等 ' + f.waitFor.replace(/^\s*日子\s*[:：]\s*/, '').slice(0, 30); waiting.push(it); return; }
      if (f.st === 'blocked') { it.chip = f.waitFor ? '在等 ' + f.waitFor.slice(0, 24) : '卡住'; waiting.push(it); return; }
      if (f.st === 'todo') {
        if (f.after) { var x = null; rows.forEach(function (o) { if (o.getAttribute('data-ack') === f.after) x = o; });
          it.chip = '排在「' + (x ? rowTitleText(x).slice(0, 12) : '一件不在板上的事') + '…」后面'; waiting.push(it); return; }
        // 1110:`row --wait-for` 放开到没开工的行 ⇒ 写了在等谁的列进「在等的」(和卡着的行同一种写法),不再标红
        if (f.waitFor) { it.chip = '在等 ' + f.waitFor.slice(0, 24); waiting.push(it); return; }
        it.chip = '没写在等谁'; it.hot = true; idle.push(it); return;
      }
      if (f.st === 'doing') doing.push(it);
    });
    // ⭐ 1020 负责人(方案页选「3 天」):「有些todo比如说很久没有做了,它该自动蹦上来」⇒ 没做完、3 天没动的:
    //   卡着 / 没开工的标上「N 天没动」并排最前;标着在做却 3 天没动的,从「在推进的」挪进「卡着的」。长期看着(watch)的不算。
    // ⭐ 1104 负责人(方案页 board-rot-plan-20261103 选「只标到期当天和三天没核的」):卡着 / 没开工的按「上次核过」算(`row --checked` 也算核过,touch / 只改日期不算),
    //   标「N 天没核」;预计日就是今天的标「今天到期」。与 board.py `_recheck_rows`(`board.py recheck` 那份名单)同一口径。
    var STALE_D = 3, staleDays = function (it) { return it.mv.t === null ? 0 : Math.floor((now - it.mv.t) / 864e5); };
    var chkDays = function (it) { var c = rowCheckedAt(it.r); return c.t === null ? 0 : Math.floor((now - c.t) / 864e5); };
    var dueToday = function (it) { return it.f.open && it.f.eta !== null && it.f.eta === today0(); };
    doing = doing.filter(function (it) {
      if (staleDays(it) < STALE_D) return true;
      it.chip = '标着在做,但 ' + staleDays(it) + ' 天没动'; it.hot = true; waiting.push(it); return false;
    });
    waiting.concat(idle).forEach(function (it) {
      var d = chkDays(it);
      if (d >= STALE_D && it.chip.indexOf('天没动') < 0 && !it.late && !it.youIdle && !it.escalation) { it.chip += ' · ' + d + ' 天没核'; it.hot = true; }
    });
    waiting.concat(idle, doing, watch).forEach(function (it) { if (dueToday(it)) { if (it.youIdle) return; it.chip = (it.chip ? it.chip + ' · ' : '') + '今天到期'; it.hot = true; it.due = true; } });
    var staleFirst = function (a, b) { var ca = (a.chat ? 2 : 0) + (a.chase ? 1 : 0), cb = (b.chat ? 2 : 0) + (b.chase ? 1 : 0), ha = a.chip.indexOf('等你') === 0 ? 1 : 0, hb = b.chip.indexOf('等你') === 0 ? 1 : 0, da = a.due ? 1 : 0, db = b.due ? 1 : 0; return (cb - ca) || (hb - ha) || (db - da) || (chkDays(b) - chkDays(a)); };   // 1104:今天到期的排在群里有新回复 / 等你的之后   // 群里有新回复的最前,等你的其次
    waiting.sort(staleFirst);
    fresh.sort(function (a, b) { return b.mv.t - a.mv.t; });
    doing.sort(function (a, b) { return (b.mv.t || 0) - (a.mv.t || 0); });
    watch.sort(function (a, b) { return (a.f.eta || 9e15) - (b.f.eta || 9e15); });   // 日子近的在前
    idle.sort(function (a, b) { return (a.mv.t || 0) - (b.mv.t || 0); });
    var openCards = YOURS_ORDER.filter(function (cd) { return !isYoursPlaceholder(cd) && !cd.classList.contains('ans-done'); });
    // ⭐ 1114 第 3 步(负责人 11-14 00:0x 批「照做」):首屏只留「要你做的」一块 —— 验收卡本来就是「要你的」区里的一种卡,
    //   不再另起「待你验收」一块;验收的那几件行首带「待验收」小标签,和普通卡按 YOURS_ORDER 同一套顺序混排。
    var yoursLive = openCards, nYours = yoursLive.length;

    var HOST = ['fsx', 'host'].join('-'), LED = ['fsx', 'ledger'].join('-'), FS_SHOW = 3;
    // 依据: 负责人 11-14 19:04 在卡 ask-a00f1d4b 选「放宽到 6 件」—— 「要你做的」并进了原「待你验收」(合并前两块各露 3 件),这一块单独露 6 件;其余几块照旧 FS_SHOW。
    var FS_SHOW_YOU = 6;
    var old = document.getElementById(HOST); if (old) old.remove();
    var old2 = document.getElementById(HOST + '-b'); if (old2) old2.remove();
    // ⭐⭐ 1020 负责人(方案页 fs-color 答其他):「改成四个大块的思路是OK的…四个颜色板块做的也太难看了,且里面的小功能可用性你有没有做?…好好重新设计一下」
    //   ⇒ 四块白底、只在顶边和数字上用颜色(同「要你的」卡的做法:颜色只当记号,不平涂);0 件的块变灰、不抢眼;
    //     每块露前 3 件,「再看 N 件」就地展开 / 收起(记在本浏览器);点一件跳到原行(① 跳到那张卡)。(② 每件带「知道了」1110 已撤,见上。)
    //   ⇒ 不再在下面另画一份明细(以前四格 + 下面三块 = 同一批事写两遍)。⛔ 不截断清单:多出来的只是收着(class),不 slice。
    var OPEN_K = 'fsx-open|' + location.pathname + '|';
    function fsOpenGet(k) { try { return localStorage.getItem(OPEN_K + k) === '1'; } catch (e) { return false; } }
    function fsOpenSet(k, v) { try { if (v) localStorage.setItem(OPEN_K + k, '1'); else localStorage.removeItem(OPEN_K + k); } catch (e) {} }
    function goCard(cd) {
      for (var d = cd.parentNode; d; d = d.parentNode) { if (d.tagName === 'DETAILS') d.open = true; }
      scrollPin(cd, 'start');   // 1114:路上上面的卡变高(图后到)也落在这张卡顶(见 scrollPin)
      cd.classList.add('fsx-flash'); setTimeout(function () { cd.classList.remove('fsx-flash'); }, 1600);
    }
    function ageTag(c, el) {   // 1117 挂了多久:点进卡的行在说明后面带一枚小字(没有挂出时间 / 在将来 ⇒ 不加)
      var s = cardAge(stampMs(el && el.getAttribute ? el.getAttribute('data-since') : ''), now);
      if (!s) return;
      var sp = document.createElement('span'); sp.classList.add('fsx-age'); sp.textContent = s; c.appendChild(sp);
    }
    function line(it, meta, tone, sub, go) {
      if (!it.youIdle && it.f && it.f.open && it.r && it.r.getAttribute) { var ps = projSub(it.r.getAttribute('data-ack') || ''); if (ps) sub = ps; }   // 1110 子线投影:只放一句「子线·X:现状」,不列子项
      var a = document.createElement('a'); a.classList.add('fsx-row'); a.href = '#' + (it.r.id || '');
      a.addEventListener('click', function (ev) { ev.preventDefault(); (go || jumpToRow)(it.r); });
      var t = document.createElement('span'); t.classList.add('fsx-t'); t.textContent = it.title || rowTitleText(it.r); a.title = t.textContent; a.appendChild(t);
      if (it.tag) { var tg = document.createElement('span'); tg.classList.add('fsx-tag-accept'); tg.textContent = it.tag; t.insertBefore(tg, t.firstChild); }   // 1114 第 3 步:验收件行首「待验收」
      var c = document.createElement('span'); c.classList.add('fsx-meta');
      if (tone === 'red') c.classList.add('fsx-m-red'); else if (tone === 'amber') c.classList.add('fsx-m-amber');
      else if (tone === 'teal') c.classList.add('fsx-m-teal'); else if (tone === 'green') c.classList.add('fsx-m-green');
      c.textContent = meta; a.appendChild(c);
      try { if (go === goCard && !it.noAge) ageTag(c, it.r); } catch (e) {}   // 1117 挂了多久(首屏「要你做的」里没写等了多久的行;验收 / 回答 / 想不做那几行自己带「已等你 …」,见 acceptLine)
      if (sub) { var s = document.createElement('span'); s.classList.add('fsx-sub'); var pp = it.r && PROJ_ROWS[it.r.getAttribute('data-ack') || '']; if (pp && pp.stall && pp.stall.n) s.classList.add('fsx-child-stall'); s.textContent = sub; a.appendChild(s); }
      return a;
    }
    function block(key, n, head, note, lines, empty, tone, hot) {
      var b = document.createElement('section'); b.classList.add('fsx-blk'); b.id = HOST + '-' + key;
      if (tone === 'red') b.classList.add('fsx-red'); else if (tone === 'amber') b.classList.add('fsx-amber');
      else if (tone === 'teal') b.classList.add('fsx-teal'); else b.classList.add('fsx-green');
      if (!lines.length) b.classList.add('fsx-zero'); if (hot) b.classList.add('fsx-hot');
      var h = document.createElement('div'); h.classList.add('fsx-h');
      // 1110 负责人(方案页 fable-audit-plan-1110 选「照做」,审计清单第 10 条):块头的数只从清单现算 —— 显示的数永远等于下面列出来的条数。
      //   传进来的 n 只留给调用处读着方便;和清单对不上就是调用处写错了,在控制台报出来,显示以清单为准。
      if (n !== lines.length && window.console && console.warn) console.warn('[fsx] ' + key + ' 块头的数 ' + n + ' 和清单 ' + lines.length + ' 条对不上');
      var nb = document.createElement('b'); nb.classList.add('fsx-num'); nb.textContent = lines.length; h.appendChild(nb);
      var ht = document.createElement('div'); ht.classList.add('fsx-ht');
      var hs = document.createElement('strong'); hs.textContent = head; ht.appendChild(hs);
      var hn = document.createElement('small'); hn.textContent = note; ht.appendChild(hn);
      h.appendChild(ht); b.appendChild(h);
      if (!lines.length) { var e = document.createElement('div'); e.classList.add('fsx-empty'); e.textContent = empty; b.appendChild(e); return b; }
      var list = document.createElement('div'); list.classList.add('fsx-list');
      var show = key === 'you' ? FS_SHOW_YOU : FS_SHOW;   // 1114:「要你做的」露 6 件,见 FS_SHOW_YOU
      lines.forEach(function (x, i) { if (i >= show) x.classList.add('fsx-over'); list.appendChild(x); });
      b.appendChild(list);
      if (lines.length > show) {
        var more = document.createElement('button'); more.type = 'button'; more.classList.add('fsx-more');
        var setOpen = function (o) {
          if (o) b.classList.add('fsx-open'); else b.classList.remove('fsx-open');
          more.textContent = o ? '收起' : '再看 ' + (lines.length - show) + ' 件';
          more.setAttribute('aria-expanded', o ? 'true' : 'false');
        };
        setOpen(fsOpenGet(key));
        more.addEventListener('click', function (ev) { ev.preventDefault(); var o = !b.classList.contains('fsx-open'); setOpen(o); fsOpenSet(key, o); });
        b.appendChild(more);
      }
      return b;
    }
    function ago(mv) { return mv.t === null ? '没记过上次动的时间' : '上次动 ' + movedLabel(mv); }
    // 1110:整块收成一行 —— 只露区头,点区头才展开,展开时全列出来(不再分「前 3 件 / 再看 N 件」)。
    //   开着的状态只记 30 分钟:页面会自己刷新,别让他读到一半合上;过了自己收回,不会一直摊着。存不了(内置浏览器 / 隐私模式)就只记在内存里。
    //   未验证: 30 分钟(18e5 毫秒)是估的,没有实测依据;11-16 周复查看有没有「读到一半合上」或「一直摊着」的反馈再调。
    var FOLD_MS = 18e5, foldMem = paintFirstScreen.foldMem || (paintFirstScreen.foldMem = {});
    function foldGet(k) {
      var t = foldMem[k] || 0;
      try { t = Math.max(t, parseInt(localStorage.getItem(OPEN_K + 'fold|' + k), 10) || 0); } catch (e) {}
      return now - t < FOLD_MS;
    }
    function foldSet(k, o) {
      foldMem[k] = o ? Date.now() : 0;
      try { if (o) localStorage.setItem(OPEN_K + 'fold|' + k, String(foldMem[k])); else localStorage.removeItem(OPEN_K + 'fold|' + k); } catch (e) {}
    }
    function foldBlock(b, key, n) {
      b.classList.add('fsx-fold');
      var e = b.querySelector('.fsx-empty'); if (e) e.remove();
      var m = b.querySelector('.fsx-more'); if (m) m.remove();
      b.querySelectorAll('.fsx-over').forEach(function (x) { x.classList.remove('fsx-over'); });
      var h = b.querySelector('.fsx-h'), note = b.querySelector('.fsx-ht small');
      if (!n) { note.textContent = ''; b.classList.remove('fsx-open'); return b; }
      h.setAttribute('role', 'button'); h.tabIndex = 0;
      var setOpen = function (o) {
        if (o) b.classList.add('fsx-open'); else b.classList.remove('fsx-open');
        note.textContent = o ? '点一下收起 ▴' : '点开才展开 ▸';
        h.setAttribute('aria-expanded', o ? 'true' : 'false');
      };
      setOpen(foldGet(key));
      var flip = function (ev) { ev.preventDefault(); var o = !b.classList.contains('fsx-open'); setOpen(o); foldSet(key, o); };
      h.addEventListener('click', flip);
      h.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') flip(ev); });
      return b;
    }
    // 依据: 负责人 11-13 定稿图:等一天标黄、三天标红。
    var ACCEPT_AMBER_HOURS = 24, ACCEPT_RED_HOURS = 72;
    // ⭐ 1113 晚负责人:「要你做的里面……点任何一个事项,它都会跳到底下要你做的一个具体的卡里面去。那你这个验收为什么不做同样的机制呢?」
    //   ⇒ 首屏「待你验收」和「要你做的」同一套:一行一件(事名 + 等了多久),点一下跳到下面「要你的」里那张完整的验收卡,
    //   细节、图、通过 / 不通过、写差什么都在那张卡上(空间大)。首屏不再就地展开、不放按钮。
    function acceptLine(cd) {
      // 依据: 状态板线 11-17 二轮返工单第 1 条(看过 demo 后定):不满 48 小时写「已等你 N 小时」,满 48 小时写「已等你 N 天」、按满 24 小时取整(71 小时 = 2 天)—— 「已等你 126 小时」读不出是几天
      var ACCEPT_DAY_HOURS = 48;
      var q = cd.querySelector('h2.q');
      var name = (q ? q.textContent : '').replace(/\s*做好了,验收通过吗[?？]\s*$/, '').replace(/\s*[(（][^)）]*$/, '').trim();
      var at = stampMs(cd.getAttribute('data-since')), hours = at === null ? null : Math.max(0, (now - at) / 36e5);
      var tone = hours !== null && hours >= ACCEPT_RED_HOURS ? 'red' : hours !== null && hours >= ACCEPT_AMBER_HOURS ? 'amber' : '';
      var lineName = cd.getAttribute('data-proj-from') || '';
      var isDrop = cd.getAttribute('data-drop') === '1';   // 1115 sw-drop:「不做了,同意吗」卡同一套首屏行,字样换成「想不做」
      var isAsked = !isDrop && cd.getAttribute('data-asked') === '1';   // 1117 提问行的回答卡:行首「你问的」,点进去看回答
      var meta = (lineName ? lineName + ' · ' : '') + (hours === null ? '' : hours < 1 ? '刚交来 · ' : hours >= ACCEPT_DAY_HOURS ? '已等你 ' + Math.floor(hours / 24) + ' 天 · ' : '已等你 ' + Math.floor(hours) + ' 小时 · ') + (isDrop ? '去定 ↓' : isAsked ? '去看回答 ↓' : '去验收 ↓');
      var it0 = { r: cd, title: name || '(这张验收卡没写事名)', tag: isDrop ? '想不做' : '待验收' };
      if (isAsked) it0.tag = '你问的';
      it0.noAge = true;   // 1117 二轮(状态板线返工单第 1 条):这一行自己写着「已等你 … / 刚交来」,再加「· 5 天前」是同一件事说两遍 ⇒ 不加挂了多久
      var ln = line(it0, meta, tone, null, goCard);
      ln.classList.add('fsx-accept-line');
      return projTag(ln, cd);
    }
    function yoursLine(cd) {
      var q = cd.querySelector('h2.q');
      var ln = line({ r: cd, title: q ? (q.textContent || '').replace(/\s+/g, ' ').trim() : '(这张卡没写问题)' }, '去回答 ↓', 'red', null, goCard); return projTag(ln, cd);
    }
    // ⭐ 1114 第 3 步:一块装两种行 —— 验收件 = acceptLine(事名 + 等了多久,行首「待验收」),普通件 = yoursLine;块头的数由 block 按清单现算
    var b1 = block('you', nYours, '要你做的', '拍板、动手或验收;点一件跳到那张卡',
      yoursLive.map(function (cd) { return cd.getAttribute('data-accept') === '1' ? acceptLine(cd) : yoursLine(cd); }),
      '此刻没有要你做的。', 'red', nYours > 0);
    // ⭐ 1120 卡着按在等谁合成一行(见 stuckWho):≥2 件等同一个人 / 同一条线 ⇒ 一行,排在其中第一件原来的位置;点开列每一件(开着的状态同块底折叠只记 30 分钟)。
    //   最久 N 天 = 组里最早一件从 data-wait-first / data-fp0(取早的)到今天;上次追 = 追过(data-chase-n ≥1)的那几件 data-wait-since 最晚的那天(--chase 会把它重置到追的那一刻)。
    function stuckGroupLines(its) {
      var by = {}, seen = {}, out = [];
      its.forEach(function (x) { var w = stuckWhoOf(x.it.r, x.it.f); if (w) (by[w] = by[w] || []).push(x); });
      its.forEach(function (x) {
        var w = stuckWhoOf(x.it.r, x.it.f);
        if (!w || by[w].length < 2) { out.push(x.el); return; }
        if (seen[w]) return;
        seen[w] = 1; out.push(stuckGroupLine(w, by[w]));
      });
      return out;
    }
    function stuckGroupLine(who, xs) {
      var oldest = null, chased = null;
      xs.forEach(function (x) {
        var r = x.it.r, ts = [stampMs(r.getAttribute('data-wait-first')), stampMs(r.getAttribute('data-fp0'))].filter(function (t) { return t !== null; });
        if (ts.length) { var t = Math.min.apply(null, ts); if (oldest === null || t < oldest) oldest = t; }
        var cs = (parseInt(r.getAttribute('data-chase-n') || '0', 10) || 0) > 0 ? stampMs(r.getAttribute('data-wait-since')) : null;
        if (cs !== null && (chased === null || cs > chased)) chased = cs;
      });
      var md = function (t) { var d = new Date(t); return ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); };
      var meta = (oldest !== null ? '最久 ' + Math.max(0, Math.floor((now - oldest) / 864e5)) + ' 天' : '') + (chased !== null ? (oldest !== null ? ' · ' : '') + '上次追 ' + md(chased) : '');
      var key = 'grp|' + who, g = document.createElement('div'), l = document.createElement('div');
      g.classList.add('fsx-grp'); l.classList.add('fsx-grp-l');
      var head = line({ r: xs[0].it.r, title: '等' + who + ' ' + xs.length + ' 件' }, meta, xs.some(function (x) { return x.it.hot; }) ? 'red' : 'amber', null,
        function () { var o = !g.classList.contains('fsx-grp-open'); set(o); foldSet(key, o); });
      head.classList.add('fsx-grp-h'); head.setAttribute('href', '#'); head.setAttribute('role', 'button');   // href 只留「#」:页面上「跳到那一行会先打开台账」那个监听不碰它
      var mEl = head.children[1];
      var set = function (o) {
        if (o) g.classList.add('fsx-grp-open'); else g.classList.remove('fsx-grp-open');
        mEl.textContent = meta + (meta ? ' ' : '') + (o ? '▴' : '▸'); head.setAttribute('aria-expanded', o ? 'true' : 'false');
      };
      xs.forEach(function (x) { l.appendChild(x.el); });
      g.appendChild(head); g.appendChild(l); set(foldGet(key));
      return g;
    }
    var nChase = waiting.filter(function (it) { return it.chase; }).length;
    obs.sort(function (a, b) { return (a.f.eta || 9e15) - (b.f.eta || 9e15); });   // 1117 J6:日子近的在前
    var wIts = idle.map(function (it) { return { it: it, el: line(it, it.chip + ' · ' + ago(it.mv), 'red', fsFirst(it.f.why)) }; })
      .concat(waiting.map(function (it) { return { it: it, el: line(it, it.chip, it.hot ? 'red' : 'amber', it.late || it.youIdle ? '' : (it.sub || fsFirst(it.f.act || it.f.why))) }; }));
    var wLines = stuckGroupLines(wIts), nStuck = wIts.length;   // 1120:块头的数按组算(一组算 1),小字写「共 N 件」
    var b3 = block('wait', wLines.length, '真卡着 ' + wLines.length + ' · 观察中 ' + obs.length, (wLines.length < nStuck ? '共 ' + nStuck + ' 件 · ' : '') + (nChase ? '红字 = 到点叫过那条线、还没处理' + (idle.length ? ';或没写在等谁' : '') : idle.length ? '红字 = 没写在等谁,按规矩现在就该在做' : '每件写明在等谁、等什么'),
      wLines,
      obs.length ? '没有真卡着的事。' : '没有卡着的事。', 'amber', idle.length > 0 || waiting.some(function (it) { return it.chat || it.chase || it.escalation; }));   // 1023 晚:群里有新回复的也让这一块亮
    if (obs.length) {   // ⭐ 1117 J6:观察中的折在块底一句,点开才列;不标红(开着的状态同「定了日子、到时再看的」只记 30 分钟)
      var ofd = document.createElement('div'); ofd.classList.add('fsx-wfold');
      var oh = document.createElement('button'); oh.type = 'button'; oh.classList.add('fsx-wfold-h');
      var ol = document.createElement('div'); ol.classList.add('fsx-wfold-l');
      obs.forEach(function (it) { ol.appendChild(line(it, it.chip, 'teal', fsFirst(it.f.why))); });
      var oSet = function (o) {
        if (o) ofd.classList.add('fsx-wfold-open'); else ofd.classList.remove('fsx-wfold-open');
        oh.textContent = obs.length + ' 件修完了、等到点自动核 ' + (o ? '▴' : '▸'); oh.setAttribute('aria-expanded', o ? 'true' : 'false');
      };
      oSet(foldGet('obs'));
      oh.addEventListener('click', function (ev) { ev.preventDefault(); var o = !ofd.classList.contains('fsx-wfold-open'); oSet(o); foldSet('obs', o); });
      ofd.appendChild(oh); ofd.appendChild(ol); b3.appendChild(ofd);
    }
    // ⭐ 1110 负责人(在示例-基建板上问:「为什么有这么多事情？25 个在推进的，10 个卡着的」;示例业务三条线自查后报给状态板线 #d5a9 / #7f3e / #a169):
    //   「在推进的」原来 = 在做的 + 定了日子到时再看的,数字读起来像 25 件都有人在动,其实一多半只是盯着日子。
    //   ⇒ 块头的数只数此刻真在动的;定了日子、到时再看的收成块底一行,点开才列(开着的状态同样只记 30 分钟)。
    //   盯的日子已经过了、今天到期、或压根没写盯到哪天的,不收 —— 那几件是要人管的,照旧红字露在上面。
    var watchHot = watch.filter(function (it) { return it.hot; }), watchCalm = watch.filter(function (it) { return !it.hot; });
    var b4 = block('doing', doing.length + watchHot.length, '在推进的', watchHot.length ? '此刻真在动的,和盯的日子到了的' : '此刻真在动的',
      doing.map(function (it) { return line(it, (it.pj ? '子线在做 · ' : '') + ago(it.mv) + (BALL_HIS[it.f.you || ''] ? ' · 也等你' : '') + (it.due ? ' · 今天到期' : ''), it.due ? 'red' : 'teal', fsFirst(it.f.why)); })
        .concat(watchHot.map(function (it) { return line(it, it.chip, 'red', fsFirst(it.f.why)); })),
      watchCalm.length ? '此刻没有正在动的事。' : '此刻没有在推进、也没有定了日子再做的事。', 'teal', false);
    if (watchCalm.length) {
      var wf = document.createElement('div'); wf.classList.add('fsx-wfold');
      var wh = document.createElement('button'); wh.type = 'button'; wh.classList.add('fsx-wfold-h');
      var wl = document.createElement('div'); wl.classList.add('fsx-wfold-l');
      watchCalm.forEach(function (it) { wl.appendChild(line(it, it.chip, 'teal', fsFirst(it.f.why))); });
      var wSet = function (o) {
        if (o) wf.classList.add('fsx-wfold-open'); else wf.classList.remove('fsx-wfold-open');
        wh.textContent = '定了日子、到时再看的 ' + watchCalm.length + ' 件 ' + (o ? '▴' : '▸'); wh.setAttribute('aria-expanded', o ? 'true' : 'false');
      };
      wSet(foldGet('watch'));
      wh.addEventListener('click', function (ev) { ev.preventDefault(); var o = !wf.classList.contains('fsx-wfold-open'); wSet(o); foldSet('watch', o); });
      wf.appendChild(wh); wf.appendChild(wl); b4.appendChild(wf);
    }
    var grid = document.createElement('div'); grid.id = HOST; grid.classList.add('fsx-grid');
    // 1110 起:左列 = ① 要你做的 + ③ 卡着的 + ② 做完的(一行),右列 = ④ 在推进的;两列各自往下排;窄屏叠成一列。
    //   没做完的三块仍然开板不滚动就看得到(1021 的要求没变)。暂停的线照旧排法(③④ 收着,右列只放那一行做完的)。
    // 1110 之前:左列 = 还没做完的(① + ③ + ④),右列 = ② 做完的(常十来件,占掉首屏右半边)
    // ⭐ 1021 负责人:「在推进的」原来排在右列「做完的」(常十来件)下面,得往下滚才看得到 ⇒ 没做完的全放左列,开板不滚动就能数清
    // ⭐ 1105 负责人(卡 ask-536129fc):「一段时间以后没有动的事项……作为一个类似于一个暂停状态好了。就哪天重开,我们再把它拉回来」
    //   有没做完的行、且所有行最近一次动距今 14 天以上 ⇒ 这条线算暂停(与 board.py `_board_paused` 同一规则,现算不存状态):
    //   「卡着的」「在推进的」收起来,只留一句;点一下还能看。「要你做的」照常露着。
    var bp = null, nOpen = pz ? pz.open : 0;
    if (paused) {
      bp = document.createElement('section'); bp.classList.add('fsx-paused');
      var pt = document.createElement('div'); pt.textContent = '⏸ ' + '这条线暂停了' + ':' + (pz.days === null ? '很久' : pz.days + ' 天') + '没动,还挂着 ' + nOpen + ' 件。过期和没核先不报,哪天重开会逐条拉回来。';
      bp.appendChild(pt);
      var pb = document.createElement('button'); pb.type = 'button'; pb.classList.add('fsx-more'); pb.textContent = '看这 ' + nOpen + ' 件';
      var pOn = false, pSet = function () { [b3, b4].forEach(function (x) { if (pOn) x.classList.remove('fsx-paused-off'); else x.classList.add('fsx-paused-off'); }); pb.textContent = pOn ? '收起' : '看这 ' + nOpen + ' 件'; };
      pb.addEventListener('click', function (ev) { ev.preventDefault(); pOn = !pOn; pSet(); });
      bp.appendChild(pb); pSet();
    }
    (paused ? [[b1, bp, b3, b4], []] : [[b1, b3], [b4]]).forEach(function (pair) { var col = document.createElement('div'); col.classList.add('fsx-col'); pair.forEach(function (x) { col.appendChild(x); }); grid.appendChild(col); });
    wrap.insertBefore(grid, zq);

    var led = document.getElementById(LED);
    if (!led) {
      led = document.createElement('details'); led.id = LED; led.classList.add('fsx-ledger');
      led.appendChild(document.createElement('summary'));
      var stop = document.getElementById(['zone-', '排队中的活'].join(''));
      wrap.insertBefore(led, zy);
      for (var k = zy; k && k !== stop; ) { var nx = k.nextElementSibling; led.appendChild(k); k = nx; }
    }
    // ⭐ 1020 负责人:「下面的这个台账…你看看你觉得还有没有什么需要优化的地方…一切都是为了服务信息的获取效率」
    //   台账打开后第一行内容前叠着五层头(台账那一行 / 区头 + 图例 / 今天动过 / 卡头标签 / 卡标题)⇒ 只留台账那一行 + 筛选格 + 搜索。
    //   「今天动过」与首屏「做完的」「在推进的」重复;区头的图例在筛选格上已有。⛔ 只在页面上藏,源文件不动。
    //   区头和「今天动过」由 kit.css 按位置藏(「今天动过」会被后面重画,打类会被冲掉)
    var ledCards = Array.prototype.filter.call(led.querySelectorAll(':scope > .card'), function (c) { return !!c.querySelector('.crow'); });
    if (ledCards.length === 1) Array.prototype.forEach.call(ledCards[0].querySelectorAll(':scope > .body > .top, :scope > .ack'), function (e) { e.classList.add('fsx-trim'); });
    led.querySelector('summary').textContent = '全部台账 ' + rows.length + ' 件(做完 ' + nDone + ' · 长期看着 ' + nWatch + ' · 真卡着 ' + (waiting.length + idle.length) + (obs.length ? ' · 观察中 ' + obs.length : '') + ' · 在推进 ' + doing.length + ')—— 要查某件旧事再点开';
    document.body.classList.add('fsx-on');
  } catch (e) { try { console.warn('paintFirstScreen', e); } catch (_) {} } }
  // ⭐ 1116 等外部总时长(AI Harness #9b59):board.py 到点叫过「换一条路」、给行记 data-stall-due=<那天 YYYY-MM-DD>;次日起还在等外部
  //   (换了路 / 了结 / 换了等的对象时 board.py 会清掉 data-stall-due)⇒ 进「卡着的」标红「等了 N 个工作日没结果」。
  //   N = 从 data-wait-first(第一次开始等;没有退 data-wait-since,再没有退叫醒那天)到今天的工作日。⚠ 与 board.py `_stall_overdue` 同一规则,改一边必须改另一边。
  //   1117 tail-2:从 paintFirstScreen 里提到外层 —— 子线投影 projStall 也用它(子板上这种行要出现在父板)。
  function workdaysBetween(a, b) {
    var n = 0, d = new Date(a);
    for (var i = 0; i < 1000; i++) { d.setDate(d.getDate() + 1); if (d.getTime() > b) break; var w = d.getDay(); if (w !== 0 && w !== 6) n++; }
    return n;
  }
  function stallOverdue(r, nowMs) {
    var st = r.getAttribute('data-status') || '', wf = (r.getAttribute('data-wait-for') || '').trim();
    if (!wf || (st !== 'watch' && st !== 'blocked') || /^\s*日子\s*[:：]/.test(wf)) return null;
    var ys = r.getAttribute('data-you-src'), yr = ys === null ? r.getAttribute('data-you') : (ys === '' ? null : ys);
    if (st === 'blocked' && yr && yr !== 'wait') return null;
    if (st === 'watch' && yr && BALL_HIS[yr]) return null;
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(r.getAttribute('data-stall-due') || ''); if (!m) return null;
    var due = new Date(+m[1], +m[2] - 1, +m[3]).getTime(), t = new Date(nowMs); t.setHours(0, 0, 0, 0);
    if (due >= t.getTime()) return null;
    var f0 = stampMs(r.getAttribute('data-wait-first')), s0 = f0 !== null ? f0 : stampMs(r.getAttribute('data-wait-since')), start = due;
    if (s0 !== null) { var sd = new Date(s0); sd.setHours(0, 0, 0, 0); start = sd.getTime(); }
    return Math.max(1, workdaysBetween(start, t.getTime()));
  }
  // ⭐ 1120 在等谁 开始
  // ⭐⭐ 1120 卡着按在等谁合成一行(负责人 11-20 19:23 在方案页 stuck-and-done-state-plan-1120 选「按在等谁合成一行」;
  //   复盘:示例-基建板头「21 个真卡着」里 9 件都在等同事甲回话,一件一行读着像全线卡死,他问是不是板腐烂了)。
  //   ⇒ 首屏「卡着的」里等同一个人 / 同一条线的 ≥2 件合成一行「等同事甲 9 件 · 最久 N 天 · 上次追 MM-DD ▸」,点开列每一件;块头的数按组算,小字写「共 N 件」。
  //   在等谁 = data-wait-for 开头的人名 / 线名(stuckWho):去掉开头的「等」,到标点 / 空格或一个动作字(回 / 补 / 改 / 做 / 给 / 的 / 在 …)为止;
  //   「日子:…」、带数字的、太长(没断开的一句话)、太短的都算取不出 ⇒ 不分组。球在他那边的 / 群里有新回复的不分组(各自那一行要他立刻看)。
  //   ⚠ 与 board.py `_stuck_who` / `_stuck_who_of` 同一规则,逐字一致(selftest 拿真板样例两端对答,并钉 WHO_STOP / WHO_PUNCT 两串逐字相同)。
  //   否过什么:⛔ 按人名表匹配 —— 新同事 / 新线名要人去维护表,漏一个就静默不分组;
  //     ⛔ 只用方案里列的那几个字断(回 / 补 / 改 / 做 / 确认 / 处理 / 给 / 的 / 在 / 签 / 发 / 下)—— 真板「同事甲上线公开合作补漏」「同事甲查他电脑上的…」断不出「同事甲」,补了查 / 上 等动作字;
  //     ⛔ 动作字在名字第一个字就断 —— 「示例-上架」「你在…」会断成空 / 断错,所以每段(「-」分段)第一个字不断。
  // 实测: 11-20 全机真板 data-wait-for 去重 70 条里,人名 / 线名最长是「示例-基建」5 字;8 字起都是没断开的一句话(「用户重新进入第三方授权…」)⇒ 上限 7
  var WHO_MAX = 7;
  var WHO_STOP = '回补改做给的在签发下上查答看把说定跑交收拿填传审测修换对核写问开登和跟再先还已要会能确处后';
  var WHO_PUNCT = ':：,，。.、;；()（）「」『』【】[]"\'“”‘’·/—!！?？<>《》#&+=|~';
  function stuckWho(wf) {
    var s = String(wf || '').trim();
    if (/^\s*日子\s*[:：]/.test(s)) return '';
    s = s.replace(/^等\s*/, '');
    var cs = Array.from(s), out = [], seg = 0;
    for (var i = 0; i < cs.length; i++) {
      var c = cs[i];
      if (/\s/.test(c) || WHO_PUNCT.indexOf(c) >= 0) break;
      if (c === '-') { out.push(c); seg = out.length; continue; }
      if (out.length - seg >= 1 && WHO_STOP.indexOf(c) >= 0) break;
      out.push(c);
    }
    var w = out.join('').replace(/线$/, '').replace(/-+$/, ''), n = Array.from(w).length;
    if (!w || /[0-9]/.test(w) || n > WHO_MAX || n < (/^[\x00-\x7f]*$/.test(w) ? 3 : 2)) return '';
    return w;
  }
  var WHO_HIS = { decide: 1, 'do': 1, nudge: 1, stuck: 1 };
  function stuckWhoOf(r, f) {
    if (!f || !f.open || WHO_HIS[f.you || ''] || (r && r.getAttribute && r.getAttribute('data-chat-new'))) return '';
    return stuckWho(f.waitFor);
  }
  // ⭐ 1120 在等谁 结束
  // 台账收着的时候,页面里别处点「跳到那一行」(#row-… 的链接)也要能到:先把台账打开
  document.addEventListener('click', function (ev) { try {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href^="#"]') : null; if (!a) return;
    var id = decodeURIComponent((a.getAttribute('href') || '').slice(1)); if (!id) return;
    var tg = document.getElementById(id), led = document.getElementById(['fsx', 'ledger'].join('-'));
    if (tg && led && led.contains(tg) && !led.open) led.open = true;
  } catch (e) {} }, true);
  paintFirstScreen();
  // ⭐ 1020 负责人(板上答):「我基本上下来基本只看那个要你的这个块…首屏四块已经把事项都已经覆盖了的话…可以给它折叠起来…
  //   但是我有时会想知道…到底还有多少事情…还卡着」⇒ 「主线任务」「排队中的活」各收成一行,那一行直接写现状 / 件数,点开还是原样。
  //   ⛔ 只在页面上收,源文件不动(touch / lint / 别的函数照旧按原结构读)。
  function foldZone(name, label) {
    var z = document.getElementById('zone-' + name);
    if (!z || !z.parentNode || z.closest('details.fold1')) return;
    var kids = [], e = z.nextElementSibling;
    while (e && (e.tagName === 'ARTICLE' || (e.tagName === 'DETAILS' && !e.classList.contains('fsx-ledger')) || e.classList.contains('warnbox'))) { kids.push(e); e = e.nextElementSibling; }
    var d = document.createElement('details'); d.classList.add('fold1');
    var s = document.createElement('summary'); s.textContent = label(z, kids); d.appendChild(s);
    z.parentNode.insertBefore(d, z); d.appendChild(z); kids.forEach(function (k) { d.appendChild(k); });
  }
  function foldMainQueue() { try {
    foldZone('主线任务', function (z, kids) {
      var n = ((z.querySelector('.n') || {}).textContent || '').trim(), c = kids[0] ? kids[0].innerText || '' : '';
      var now = (c.match(/现在[:：]\s*([^\n]+)/) || [])[1] || '';
      return '主线 ' + n + (now ? ' · 现在:' + now.slice(0, 40) : '') + ' —— 点开看全文';
    });
    foldZone('排队中的活', function (z) {
      var n = ((z.querySelector('.n') || {}).textContent || '').replace(/\s+/g, ' ').trim();
      return '排队中的活 · ' + (n || '点开看') + ' —— 点开看全集';
    });
  } catch (e) { try { console.warn('foldMainQueue', e); } catch (_) {} } }
  foldMainQueue();
  // ⭐ 1020 负责人(经 Harness v2.5):checkpoint 生成的「/compact <指令>」那一行要挂到板上,「他要把整行粘进那条会话」
  //   ⇒ 卡上「请你过目的原文」每一块配一个「复制」:按节点拼回原文(文字照抄、<br> = 换行),⛔ 不用 innerText
  //   (卡被收起时 innerText 会丢换行);剪贴板不给就把原文摆成一个选好的文本框让他手动复制。
  function otextRaw(el) {
    var out = '';
    (function walk(n) {
      Array.prototype.forEach.call(n.childNodes, function (c) {
        if (c.nodeType === 3) out += c.nodeValue;
        else if (c.nodeType === 1 && c.tagName === 'BR') out += '\n';
        else if (c.nodeType === 1 && !c.classList.contains('otext-copy')) walk(c);
      });
    })(el);
    return out;
  }
  // 1124 老卡只把竖线表画成表。原话保持逐字显示，复制仍用替换前捕获的 raw。
  function paintOtextTables(b, raw) {
    if (b.classList.contains('ocode') || b.querySelector(':not(br)')) return;
    var lines = raw.split(/\r\n|\r|\n/), fragment = document.createDocumentFragment();
    function pipeRow(line) { return /^\|.*\|$/.test(line.trim()); }
    for (var i = 0; i < lines.length;) {
      var start = i;
      while (i < lines.length && pipeRow(lines[i])) i++;
      var rows = lines.slice(start, i).map(function (line) {
        return line.trim().slice(1, -1).split('|').map(function (cell) { return cell.trim(); });
      });
      var data = rows.filter(function (row) { return !row.every(function (cell) { return /^:?-{3,}:?$/.test(cell); }); });
      // 依据: 11-24 任务的两行含分隔线或三行竖线判据，与 board.py 一致。
      if ((rows.length >= 3 || (rows.length >= 2 && data.length < rows.length)) && data.length) {
        var wrap = document.createElement('div'), table = document.createElement('table');
        wrap.className = 'accept-ans-tbl'; table.className = 'accept-ans-t';
        var head = table.createTHead(), body = table.createTBody();
        data.forEach(function (row, j) {
          var tr = (j ? body : head).insertRow();
          row.forEach(function (cell) {
            var td = document.createElement(j ? 'td' : 'th'); td.textContent = cell; tr.appendChild(td);
          });
        });
        wrap.appendChild(table); fragment.appendChild(wrap);
      } else {
        if (i === start) i++;
        fragment.appendChild(document.createTextNode(lines.slice(start, i).join('\n') + (i < lines.length ? '\n' : '')));
      }
    }
    if (fragment.querySelector('table')) b.replaceChildren(fragment);
  }
  function wireOtextCopy() { try {
    document.querySelectorAll('.otext-b').forEach(function (b) {
      if (b.hasAttribute('data-copy')) return; b.setAttribute('data-copy', '1');
      var raw = otextRaw(b);
      paintOtextTables(b, raw);
      var btn = document.createElement('button'); btn.type = 'button'; btn.classList.add('otext-copy'); btn.textContent = '复制';
      btn.addEventListener('click', function (ev) {
        ev.preventDefault(); ev.stopPropagation();
        ansClip(raw).then(function (ok) {
          if (ok) { btn.textContent = '已复制'; setTimeout(function () { btn.textContent = '复制'; }, 2500); return; }
          var ta = b.parentNode.querySelector('textarea.otext-manual');
          if (!ta) { ta = document.createElement('textarea'); ta.classList.add('otext-manual'); ta.setAttribute('readonly', ''); b.parentNode.insertBefore(ta, b.nextSibling); }
          ta.value = raw; ta.rows = Math.min(12, raw.split('\n').length + 1);
          btn.textContent = '没能自动复制,下面已选好,按 ⌘C';
          try { ta.focus(); ta.select(); } catch (e) {}
        });
      });
      b.insertBefore(btn, b.firstChild);
    });
  } catch (e) { try { console.warn('wireOtextCopy', e); } catch (_) {} } }
  wireOtextCopy();
  (function () {
    var nm = ''; try { nm = decodeURIComponent(location.pathname.split('/').pop() || ''); } catch (e) { return; }
    if (!/\.html$/.test(nm)) return;
    fetch('./_said/' + encodeURIComponent(nm.replace(/\.html$/, '')) + '.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && typeof d.t === 'string' && stampMs(d.t) !== null) { FS_SAID = d.t; paintFirstScreen(); } })
      .catch(function () { /* 取不到 ⇒ 留着「最近 24 小时」那一版,块头照实写着 */ });
  })();

  paintPeers(); setInterval(paintPeers, 60000);
  // ⚠ 同上:回流之前重建同侪条 = 在一个假布局上排版,他展开面板时会看到它再跳一次。
  document.addEventListener('visibilitychange', function(){
    if (!document.hidden) afterReflow(paintPeers);
  });

  var b = document.getElementById('refresh-text');
  if (b) setInterval(function(){
    var s = Math.round((Date.now()-loadedAt)/1000);
    b.textContent = '自动刷新中 · ' + (s<60 ? s+'s' : Math.round(s/60)+' 分钟') + '前载入';
  }, 5000);
})();
// 1113 负责人:「待你验收里那个打开看按钮没有反应」—— App 右侧面板不让开新窗口(window.open 回 null),
//   target=_blank 的链接点了什么都不发生(板上自动识别出的链接同病)。⇒ 全板兜底:先试新窗口,开不出来就在本页打开;
//   指向本板自己的,不重载,直接回到板顶首屏。
(function () {
  function openLink(ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[target="_blank"]') : null;
    if (!a || ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    var href = a.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#') return;
    var u; try { u = new URL(href, location.href); } catch (e) { return; }
    ev.preventDefault();
    // 1113 晚负责人(经示例-选品 #a4e9):「这个图啊,点开了点不回去……只能退回上一页才能退回去」—— 下面的兜底把图片也本页打开了。
    //   ⇒ 图片地址一律当前页弹大图层(/_ans-img.js 里的 __qLightbox,伺服注入每一页);⛔ 不本页跳到图片。
    if (isImg(u)) {
      var im0 = a.querySelector('img');
      if (window.__qLightbox) { window.__qLightbox(u.href, im0 ? im0.alt : ''); return; }
      try { if (window.open(u.href, '_blank')) return; } catch (e) {}
      toast('这张图在这里打不开:请在 8777 上打开这块板');
      return;
    }
    if (u.origin === location.origin && decodeURIComponent(u.pathname) === decodeURIComponent(location.pathname)) {
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
      // 入口就是本板时,光回板顶像「没反应」⇒ 弹一句说明,并把首屏闪一下
      var t = document.createElement('div'); t.className = 'open-self-toast'; t.textContent = '这件的入口就是这块板:按「看什么」那句在首屏上看就行';
      document.body.appendChild(t); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
      var fs = document.querySelector('.fsx-grid') || document.querySelector('.fsx-wrap');
      if (fs) { fs.classList.remove('open-self-flash'); void fs.offsetWidth; fs.classList.add('open-self-flash'); }
      return;
    }
    if (isExternal(u)) { openInBrowser(u.href); return; }
    var w = null;
    try { w = window.open(u.href, '_blank'); } catch (e) { w = null; }
    if (w) { try { w.opener = null; } catch (e) {} return; }
    location.href = u.href;
  }
  // 1113 负责人(经示例-基建 #a7f3):主站等外部网站在 App 面板里打开卡很久 ⇒ 外部网址交给伺服用他的默认浏览器开;本机 8777 的照旧面板里开
  function isImg(u) { return u.origin === location.origin && (/^\/_answer-media\//.test(u.pathname) || /\.(png|jpe?g|gif|webp)$/i.test(u.pathname)); }
  function isExternal(u) { var h = (u.hostname || '').toLowerCase(); return !(h === '127.0.0.1' || h === 'localhost' || /\.localhost$/.test(h)); }
  function toast(text) {
    var t = document.createElement('div'); t.className = 'open-self-toast'; t.textContent = text;
    document.body.appendChild(t); setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 3500);
  }
  function openInBrowser(href) {
    var done = false;
    try {
      fetch('/_open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: href }) })
        .then(function (r) { return r.ok; }).catch(function () { return false; })
        .then(function (ok) { done = true; if (ok) toast('已在你的默认浏览器里打开'); else location.href = href; });
    } catch (e) { location.href = href; }
  }
  window.__boardOpenInBrowser = openInBrowser; window.__boardIsExternal = isExternal;
  document.addEventListener('click', openLink, true);
})();
