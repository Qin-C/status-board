(function(){
  'use strict';
  var main=document.getElementById('plan');
  var decs=[].slice.call(document.querySelectorAll('.decision'));
  var touched={}, stamp={}, kept={}, timers={};
  var OTHER='其他(我自己写)';
  var page=(function(){
    try{var p=decodeURIComponent(location.pathname.split('/').pop()||'');return p||'index.html';}
    catch(e){return 'index.html';}
  })();
  var online=/^https?:$/.test(location.protocol)&&typeof window.fetch==='function';
  var LS='plan-answers:'+page;

  function z(n){return (n<10?'0':'')+n;}
  function mmdd(ts){var t=new Date(ts);if(isNaN(t.getTime()))return '';return z(t.getMonth()+1)+'-'+z(t.getDate());}
  function note(d){return d.querySelector('.note');}
  function cur(d){
    var c=d.querySelector('input[type=radio]:checked');
    return {choice:c?c.value:(kept[d.id]||''),note:note(d).value.trim()};
  }

  function paint(){
    decs.forEach(function(d,i){
      [].forEach.call(d.querySelectorAll('.opt'),function(o){o.classList.toggle('sel',o.querySelector('input').checked);});
      var done=!!touched[d.id];
      d.classList.toggle('done',done);
      d.querySelector('.k').textContent='要你定 '+(i+1)+' / '+decs.length;
      var t=document.querySelector('.toc a[data-d="'+d.id+'"]');if(t)t.classList.toggle('done',done);
      var a=d.querySelector('.ans');
      if(done){
        var c=cur(d),day=mmdd(stamp[d.id]);
        a.textContent='你'+(day?' '+day+' ':'')+'答了：'+(c.choice||'(只写了补充)')+(c.note?'　补充：'+c.note:'');
        a.hidden=false;
      }else{a.hidden=true;}
    });
    var b=document.getElementById('next');
    if(!decs.length){b.hidden=true;return;}
    var left=decs.filter(function(d){return !touched[d.id];}).length;
    b.textContent=left?('还有 '+left+' 个要定 ↓'):'都定了 ✓';
    b.classList.toggle('zero',!left);
  }

  function dock(d,on){
    var n=note(d),sp=d.querySelector('.note-spacer');
    if(on){
      if(!sp){sp=document.createElement('div');sp.className='note-spacer';n.parentNode.insertBefore(sp,n);}
      sp.style.height=n.offsetHeight+'px';
      var tag=d.querySelector('.dock-tag');
      if(!tag){tag=document.createElement('div');tag.className='dock-tag';n.parentNode.insertBefore(tag,n);}
      tag.textContent='正在回答:'+(d.getAttribute('data-q')||'');   // 1020 晚用户:这行字滚动时会被页面内容盖住 ⇒ 改成贴在输入框顶上的实底标签(样式在 plan.css)
      d.classList.add('docked');
      tag.style.bottom=(14+n.offsetHeight-1)+'px';   // 和输入框贴成一体,中间不留缝
    }else{
      d.classList.remove('docked');
      if(sp)sp.remove();
      var t=d.querySelector('.dock-tag');if(t)t.remove();
    }
  }

  /* 本机兜底:只有接口读不到时才用它恢复 */
  function readLocal(){try{return JSON.parse(localStorage.getItem(LS)||'null');}catch(e){return null;}}
  function saveLocal(){
    try{
      var o={};
      decs.forEach(function(d){if(touched[d.id]){var c=cur(d);o[d.id]={choice:c.choice,note:c.note,ts:stamp[d.id]};}});
      localStorage.setItem(LS,JSON.stringify(o));
    }catch(e){}
  }

  /* 只记到本机服务;接口不存在(404 / 网络错)时静默跳过。不向别处发任何东西。 */
  function send(d,keep){
    clearTimeout(timers[d.id]);delete timers[d.id];
    saveLocal();
    if(!online)return;
    var c=cur(d);
    try{
      var p=fetch('/_answer',{method:'POST',headers:{'Content-Type':'application/json'},keepalive:!!keep,
        body:JSON.stringify({page:page,id:d.id,q:d.getAttribute('data-q')||'',choice:c.choice,note:c.note,ts:stamp[d.id]})});
      if(p&&p.catch)p.catch(function(){});
    }catch(e){}
  }
  function record(d,delay){
    touched[d.id]=1;stamp[d.id]=new Date().toISOString();
    paint();
    clearTimeout(timers[d.id]);
    timers[d.id]=setTimeout(function(){send(d);},delay);
  }
  function flush(keep){decs.forEach(function(d){if(timers[d.id])send(d,keep);});}

  function apply(ans){
    if(!ans||typeof ans!=='object')return;
    decs.forEach(function(d){
      var a=ans[d.id];
      if(!a||touched[d.id])return;
      var radios=[].slice.call(d.querySelectorAll('input[type=radio]')),hit=null;
      radios.forEach(function(r){if(r.value===a.choice)hit=r;});
      if(hit){hit.checked=true;}
      else{radios.forEach(function(r){r.checked=false;});if(a.choice)kept[d.id]=String(a.choice);}
      note(d).value=a.note||'';
      touched[d.id]=1;stamp[d.id]=a.ts||'';
    });
    paint();
  }
  function load(){
    if(!online){apply(readLocal());return;}
    try{
      fetch('/_answers?page='+encodeURIComponent(page))
        .then(function(r){if(!r.ok)throw new Error('no');return r.json();})
        .then(function(j){apply(j&&j.answers);},function(){apply(readLocal());})
        .catch(function(){});
    }catch(e){apply(readLocal());}
  }

  decs.forEach(function(d){
    d.addEventListener('change',function(e){
      if(!e.target||e.target.type!=='radio')return;
      delete kept[d.id];
      record(d,400);
      if(e.target.getAttribute('data-other'))try{note(d).focus();}catch(x){}
    });
    d.addEventListener('click',function(e){
      var o=e.target&&e.target.closest?e.target.closest('.opt'):null;
      if(o&&o.querySelector('input').checked)record(d,400);
    });
    note(d).addEventListener('input',function(){record(d,900);});
    note(d).addEventListener('blur',function(){if(timers[d.id])send(d);});
    /* 1020 用户反馈:用语音输入法边看边写时,一滚动页面就被拉回输入框
       浏览器每插入一个字都把光标拉回视野 ⇒ 输入框一获得焦点就停靠在屏幕底部(原位留一块同高的空白,页面不跳),
       光标一直在视野里,页面随便滚;失焦就放回原位。 */
    note(d).addEventListener('focus',function(){dock(d,true);});
    note(d).addEventListener('blur',function(){dock(d,false);});
  });
  window.addEventListener('pagehide',function(){flush(true);});

  document.getElementById('next').addEventListener('click',function(){
    var n=decs.filter(function(d){return !touched[d.id];})[0]||decs[0];
    if(!n)return;
    try{n.scrollIntoView({behavior:'smooth',block:'center'});}catch(e){n.scrollIntoView();}
  });

  function text(){
    var title=main.getAttribute('data-title')||document.title,date=main.getAttribute('data-date')||'';
    var L=['回复「'+title+'」'+(date?'('+date+')':''),''];
    if(!decs.length)L.push('(这一页没有要你定的题)');
    decs.forEach(function(d,i){
      var c=cur(d);
      L.push((i+1)+'. '+(d.getAttribute('data-q')||''));
      L.push('   → '+(c.choice||'(没选)')+(touched[d.id]?'':'　(没点开，按建议)'));
      if(c.note)L.push('   补充：'+c.note.replace(/\n/g,'\n        '));
      else if(c.choice===OTHER)L.push('   补充：(还没写)');
    });
    return L.join('\n');
  }
  var dlg=document.getElementById('dlg'),out=document.getElementById('out'),ok=document.getElementById('ok');
  document.getElementById('resp').addEventListener('click',function(){
    flush(false);
    out.textContent=text();ok.textContent='';
    if(dlg.showModal)dlg.showModal();else dlg.setAttribute('open','');
  });
  document.getElementById('close').addEventListener('click',function(){
    if(dlg.close)dlg.close();else dlg.removeAttribute('open');
  });
  /* 只复制到剪贴板,不自动发送 */
  document.getElementById('copy').addEventListener('click',function(){
    var t=out.textContent;
    function done(){ok.textContent='已复制，粘回对话即可';}
    function fallback(){
      var r=document.createRange();r.selectNodeContents(out);
      var s=getSelection();s.removeAllRanges();s.addRange(r);
      try{document.execCommand('copy');done();}catch(e){ok.textContent='已选中，按 ⌘C 复制';}
    }
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(done,fallback);}
    else fallback();
  });

  paint();
  load();
})();
