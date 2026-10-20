/** 看板页面。没有外部依赖，能离线打开。 */

export function pageHtml() {
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>tapd-loop</title>
<style>
body{background:#0b0e14;color:#e6edf3;font:13px/1.55 ui-monospace,Consolas,monospace;margin:0;padding:24px}
h1{font-size:15px;margin:0 0 4px;letter-spacing:.02em}#meta{color:#8b949e;margin-bottom:16px;font-size:12px}
#filters{display:flex;align-items:center;gap:8px;margin:0 0 12px;font-size:12px;color:#8b949e}
#filters button{background:#11161f;color:#8b949e;border:1px solid #21262d;border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer}
#filters button:hover{border-color:#30363d;color:#c9d1d9}
#filters button.on{background:#1f6feb22;border-color:#1f6feb;color:#c9d1d9}
table{border-collapse:collapse;width:100%;table-layout:fixed}th,td{text-align:left;padding:8px 10px;border-top:1px solid #21262d;vertical-align:top}
th:nth-child(1),td:nth-child(1){width:50%}
th:nth-child(2),td:nth-child(2){width:35%}
th:nth-child(3),td:nth-child(3){width:8%;white-space:nowrap;color:#8b949e}
th:nth-child(4),td:nth-child(4){width:7%;white-space:nowrap}
th{color:#8b949e;font-weight:500;font-size:11px;text-transform:uppercase;letter-spacing:.06em}
tr.card{cursor:pointer}tr.card:hover{background:#11161f}tr.sel{background:#161d29;box-shadow:inset 2px 0 0 #388bfd}
tr.dim{opacity:.55}
.what{max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ok{color:#3fb950}.bad{color:#f85149}.dim2{color:#6e7681}.run{color:#58a6ff}.warn{color:#d29922}
#modal details.pane{margin:0 0 12px;border:1px solid #21262d;border-radius:6px;padding:8px 12px;background:#0d1117}
#modal details.pane summary{color:#8b949e;font-size:12px;cursor:pointer;outline:none}
#modal details.pane .body{margin:8px 0 0;max-height:46vh;overflow:auto;color:#c9d1d9}
.tlbar{display:flex;align-items:center;justify-content:space-between;margin:0 0 8px;font-size:12px;color:#8b949e}
.tlwrap{border:1px solid #21262d;border-radius:6px;background:#0d1117}
.tlhead,.tl{display:grid;grid-template-columns:66px 62px minmax(0,1fr) 62px;gap:12px;align-items:baseline}
.tlhead{color:#6e7681;font-size:11px;text-transform:uppercase;letter-spacing:.06em;padding:8px 12px 6px;border-bottom:1px solid #21262d}
.tllist{max-height:58vh;overflow:auto;overscroll-behavior:contain}
.tl{padding:4px 12px;border-top:1px solid #161b22}.tl:first-child{border-top:0}
.tl>.act{min-width:0;white-space:pre-wrap;word-break:break-word}
.tl.say>.act{color:#8fb8d8;max-height:5.6em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 72%,transparent);cursor:pointer}
.tl.say.open>.act{max-height:none;-webkit-mask-image:none}
.tl.think>.act{color:#7d8590;font-style:italic;max-height:4.6em;overflow:hidden;-webkit-mask-image:linear-gradient(#000 72%,transparent);cursor:pointer}
.tl.think.open>.act{max-height:none;-webkit-mask-image:none}
.tl.arm>.act{color:#d2a8ff}
.armrow{display:flex;gap:10px;align-items:baseline;padding:6px 4px;border-top:1px solid #161b22;cursor:pointer}
.armrow:first-child{border-top:0}.armrow:hover{background:#11161f}
.armrow .nm{color:#d2a8ff;min-width:90px}.armrow .meta{color:#8b949e;font-size:11px}
#modal{position:fixed;inset:0;background:#05070bcc;display:none;padding:36px;z-index:20}
#modal.on{display:block}
#modal .box{max-width:1180px;margin:0 auto;background:#0d1117;border:1px solid #30363d;border-radius:8px;padding:16px 20px;max-height:88vh;overflow:auto;box-shadow:0 20px 60px #0009}
#modal h3{font-size:14px;margin:0 0 4px}#modal .mh{display:flex;justify-content:space-between;align-items:flex-start;gap:16px}
#modal .sub{color:#8b949e;font-size:12px;margin:0 0 12px}
#modal .mactions{display:flex;gap:8px;align-items:center}
#modal #mback{background:#11161f;color:#8b949e;border:1px solid #21262d;border-radius:6px;padding:3px 10px;font:inherit;cursor:pointer;display:none}
.tl.tool>.act{color:#c9d1d9}
.tl>span:last-child{text-align:right;color:#6e7681}
.md{font:12px/1.6 ui-monospace,Consolas,monospace;word-break:break-word;white-space:normal}
.md pre{white-space:pre}
.md h1,.md h2,.md h3,.md h4,.md h5,.md h6{margin:.6em 0 .3em;font-size:1.05em;color:#e6edf3;line-height:1.35}
.md p{margin:.4em 0}.md ul,.md ol{margin:.35em 0;padding-left:1.5em}.md li{margin:.15em 0}
.md code{background:#1b2230;color:#e6edf3;padding:1px 4px;border-radius:3px}
.md pre.md-code{background:#161b22;padding:8px 10px;border-radius:6px;overflow:auto;margin:.45em 0}
.md pre.md-code code{background:none;padding:0}
.md blockquote{border-left:3px solid #30363d;margin:.45em 0;padding-left:10px;color:#8b949e}
.md a{color:#58a6ff}.md img{max-width:100%;border:1px solid #21262d;border-radius:6px;margin:.4em 0}
.md hr{border:0;border-top:1px solid #21262d;margin:.7em 0}
.diff{font:12px/1.45 ui-monospace,Consolas,monospace;background:#0d1117;border:1px solid #21262d;border-radius:6px;overflow:auto;max-height:60vh}
.dline{padding:1px 10px;white-space:pre-wrap;word-break:break-word}
.dline.dadd{background:#12261e;color:#7ee787}
.dline.ddel{background:#2d1214;color:#ff7b72}
.dline.dhunk{color:#8b949e;background:#161b22;border-top:1px solid #21262d}
.dline.dmeta{color:#6e7681}
.dline.dctx{color:#c9d1d9}
.drow{display:grid;grid-template-columns:1fr 1fr;border-top:1px solid #161b22}
.drow>span{padding:1px 8px;white-space:pre-wrap;word-break:break-word;min-width:0}
.drow>.ldel{background:#2d1214;color:#ff7b72}
.drow>.radd{background:#12261e;color:#7ee787}
.drow>.lctx,.drow>.rctx{color:#8b949e}
.diffbar{display:flex;gap:6px;margin:0 0 8px}
.diffbar button{background:#11161f;color:#8b949e;border:1px solid #21262d;border-radius:6px;padding:2px 10px;font:inherit;cursor:pointer}
.diffbar button.on{background:#1f6feb22;border-color:#1f6feb;color:#c9d1d9}
</style></head><body>
<h1>tapd-loop</h1><div id="meta">连接中…</div>
<div id="filters">
  <button data-days="0" class="on">全部</button>
  <button data-days="1">近 1 天</button>
  <button data-days="7">近 7 天</button>
  <label style="margin-left:6px"><input type="checkbox" id="onlyAlive">只看运行中</label>
</div>
<table><thead><tr><th>卡片</th><th>现在</th><th>用时</th><th>状态</th></tr></thead>
<tbody id="rows"></tbody></table>
<div id="modal"><div class="box"><div class="mh"><div id="mhead"></div><div class="mactions"><button id="mback">返回</button></div></div><div id="mbody"></div></div></div>
<script>
(function(){
  var rowsEl=document.getElementById('rows'),meta=document.getElementById('meta');
  var stack=[],cardSig=null,armSig=null;
  var state={runs:[],selected:null,card:null};
  var deep=null;
  try{var q=new URLSearchParams(location.search);if(q.get('run')&&q.get('id'))deep={runId:q.get('run'),cardId:q.get('id')};}catch(e){}
  var view={days:0,onlyAlive:false};
  var autoscroll=true;
  var paneState={};
  try{paneState=JSON.parse(localStorage.getItem('tapd-loop-panes')||'{}')||{};}catch(e){paneState={};}
  var diffMode='single';
  try{diffMode=localStorage.getItem('tapd-loop-diff')||'single';}catch(e){}
  var currentDiff='';
  var lastSig=null;
  try{var saved=JSON.parse(localStorage.getItem('tapd-loop-view')||'null');if(saved&&typeof saved.days==='number')view=saved;}catch(e){}
  function saveView(){try{localStorage.setItem('tapd-loop-view',JSON.stringify(view));}catch(e){}}
  function esc(t){var d=document.createElement('div');d.textContent=t==null?'':String(t);return d.innerHTML;}
  var TICK=String.fromCharCode(96);
  var RE_CODE=new RegExp(TICK+'([^'+TICK+'\\\\n]+)'+TICK,'g');
  function inlineM(text){
    var tokens=[];var t=esc(text);
    t=t.replace(RE_CODE,function(m,code){tokens.push(code);return '@@C'+(tokens.length-1)+'@@';});
    t=t.replace(/!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)/g,'<img alt="$1" src="$2">');
    t=t.replace(/\\[([^\\]]+)\\]\\(([^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noreferrer">$1</a>');
    t=t.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>');
    t=t.replace(/\\*([^*\\n]+)\\*/g,'<em>$1</em>');
    t=t.replace(/@@C(\\d+)@@/g,function(m,n){return '<code>'+tokens[+n]+'</code>';});
    return t;
  }
  function md(src){
    var text=String(src||'');if(!text.trim())return '';
    var lines=text.replace(/\\r\\n?/g,'\\n').split('\\n'),out=[],para=[],list=null,i=0,fence=TICK+TICK+TICK;
    function flush(){if(para.length){out.push('<p>'+inlineM(para.join(' '))+'</p>');para=[];}}
    function closeList(){if(list){out.push('</'+list+'>');list=null;}}
    while(i<lines.length){
      var line=lines[i];
      if(line.indexOf(fence)===0){closeList();flush();var buf=[];i++;while(i<lines.length&&lines[i].indexOf(fence)!==0){buf.push(lines[i]);i++;}i++;out.push('<pre class="md-code"><code>'+esc(buf.join('\\n'))+'</code></pre>');continue;}
      var h=/^(#{1,6})\\s+(.*)$/.exec(line);
      if(h){closeList();flush();var lv=h[1].length;out.push('<h'+lv+'>'+inlineM(h[2])+'</h'+lv+'>');i++;continue;}
      if(/^\\s*([-*+]|\\d+[.)])\\s+/.test(line)){flush();var want=/^\\s*\\d+[.)]\\s+/.test(line)?'ol':'ul';if(list&&list!==want)closeList();if(!list){out.push('<'+want+'>');list=want;}out.push('<li>'+inlineM(line.replace(/^\\s*([-*+]|\\d+[.)])\\s+/,''))+'</li>');i++;continue;}
      if(/^\\s*>\\s?/.test(line)){closeList();flush();out.push('<blockquote>'+inlineM(line.replace(/^\\s*>\\s?/,''))+'</blockquote>');i++;continue;}
      if(/^\\s*(---+|\\*\\*\\*+|___+)\\s*$/.test(line)){closeList();flush();out.push('<hr>');i++;continue;}
      if(!line.trim()){closeList();flush();i++;continue;}
      para.push(line.trim());i++;
    }
    closeList();flush();return out.join('\\n');
  }
  function paneHtml(key,title,body){
    return '<details class="pane" data-pane="'+esc(key)+'"'+(paneState[key]?' open':'')+'><summary>'+title+'</summary><div class="body">'+body+'</div></details>';
  }
  function wirePanes(root){
    var list=root.querySelectorAll('details.pane');
    for(var i=0;i<list.length;i++){(function(el){
      el.addEventListener('toggle',function(){
        paneState[el.getAttribute('data-pane')]=el.open;
        try{localStorage.setItem('tapd-loop-panes',JSON.stringify(paneState));}catch(e){}
      });
    })(list[i]);}
  }
  function wireDiff(root){
    var btns=root.querySelectorAll('.diffbar button');
    for(var i=0;i<btns.length;i++){(function(btn){
      btn.onclick=function(){
        diffMode=btn.getAttribute('data-mode');
        try{localStorage.setItem('tapd-loop-diff',diffMode);}catch(e){}
        var box=root.querySelector('#diffbox');
        if(box)box.innerHTML=diffHtml(currentDiff,diffMode);
        var all=root.querySelectorAll('.diffbar button');
        for(var k=0;k<all.length;k++)all[k].className=all[k].getAttribute('data-mode')===diffMode?'on':'';
      };
    })(btns[i]);}
  }
  function diffHtml(text, mode){
    var lines=String(text||'').split('\\n');
    if(lines.length>4000)lines=lines.slice(0,4000).concat(['... 已截断']);
    var out=['<div class="diff">'],i,j;
    if(mode==='dual'){
      i=0;
      while(i<lines.length){
        var line=lines[i];
        if(line.indexOf('@@')===0){out.push('<div class="drow"><span class="lctx">'+esc(line)+'</span><span class="rctx">'+esc(line)+'</span></div>');i++;continue;}
        if(line.charAt(0)==='-'&&line.indexOf('---')!==0){
          var dels=[],adds=[];
          while(i<lines.length&&lines[i].charAt(0)==='-'&&lines[i].indexOf('---')!==0)dels.push(lines[i++]);
          while(i<lines.length&&lines[i].charAt(0)==='+')adds.push(lines[i++]);
          var n=Math.max(dels.length,adds.length);
          for(j=0;j<n;j++){
            var l=dels[j]||'',r=adds[j]||'';
            out.push('<div class="drow"><span class="'+(l?'ldel':'lctx')+'">'+esc(l)+'</span><span class="'+(r?'radd':'rctx')+'">'+esc(r)+'</span></div>');
          }
          continue;
        }
        if(line.charAt(0)==='+'){out.push('<div class="drow"><span class="lctx"></span><span class="radd">'+esc(line)+'</span></div>');i++;continue;}
        out.push('<div class="drow"><span class="lctx">'+esc(line)+'</span><span class="rctx">'+esc(line)+'</span></div>');
        i++;
      }
    } else {
      for(j=0;j<lines.length;j++){
        var s=lines[j],cls='dctx';
        if(s.indexOf('@@')===0)cls='dhunk';
        else if(s.indexOf('diff --git')===0||s.indexOf('index ')===0||s.indexOf('---')===0||s.indexOf('+++')===0)cls='dmeta';
        else if(s.charAt(0)==='+')cls='dadd';
        else if(s.charAt(0)==='-')cls='ddel';
        out.push('<div class="dline '+cls+'">'+esc(s)+'</div>');
      }
    }
    out.push('</div>');
    return out.join('');
  }
  function dur(ms){var s=Math.max(0,Math.round((ms||0)/1000));var h=Math.floor(s/3600),m=Math.floor(s%3600/60);return h>0?h+'h'+m+'m':(m>0?m+'m'+(s%60)+'s':s+'s');}
  function clock(t){if(!t)return'';var d=new Date(t);function p(n){return (n<10?'0':'')+n;}return p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());}
  function rel(t){if(!t)return'';var s=Math.round((Date.now()-t)/1000);return s<2?'刚刚':(s<60?s+' 秒前':dur(s*1000)+'前');}
  function msText(ms){return typeof ms!=='number'?'':(ms<1000?ms+'ms':(Math.round(ms/100)/10)+'s');}
  var PHASE={claim:'占住卡片',fetch:'抓取工单与图片',fetched:'已抓取',running:'内循环运行中',timeout:'超时'};
  var STATUS={running:['▶','运行中','run'],done:['●','完成','ok'],failed:['✕','失败','bad'],preview:['◐','预览','warn'],blocked:['⊘','状态挡住','dim2'],queued:['○','排队','dim2'],skipped:['⊘','跳过','dim2']};
  function st(s){var hit=STATUS[s]||['·',s||'未知','dim2'];return '<span class="'+hit[2]+'">'+hit[0]+' '+esc(hit[1])+'</span>';}
  function what(c){if(c.status==='running')return PHASE[c.phase]||'运行中';return c.note||PHASE[c.phase]||'—';}
  function elapsed(c){if(!c.startedAt)return'';var end=c.endedAt||Date.now();return dur(end-c.startedAt);}
  function visible(run){var t=run.startedAt||0;if(view.days>0&&Date.now()-t>view.days*86400000)return false;if(view.onlyAlive&&!run.alive)return false;if(!run.cards.length&&!run.alive)return false;return true;}
  function pick(){var runs=state.runs.filter(visible);for(var i=0;i<runs.length;i++){var r=runs[i];for(var j=0;j<r.cards.length;j++){if(r.cards[j].status==='running')return {run:r,card:r.cards[j]};}}if(!runs.length)return null;var first=runs[0];return first.cards.length?{run:first,card:first.cards[0]}:{run:first,card:null};}
  function render(){
    var runs=state.runs.filter(visible);rowsEl.innerHTML='';
    if(deep){state.selected=deep;}
    var current=pick();
    var exists=state.selected&&state.runs.some(function(r){return r.runId===state.selected.runId&&r.cards.some(function(c){return c.id===state.selected.cardId;});});
    if(!exists){state.selected=current?{runId:current.run.runId,cardId:current.card?current.card.id:null}:null;}
    if(!runs.length){rowsEl.innerHTML='<tr><td colspan="4" class="dim2" style="padding:18px 10px">还没有 run。跑一次 loop 就有了。</td></tr>';meta.textContent='没有数据';return;}
    var total=0;
    for(var i=0;i<runs.length;i++){
      var run=runs[i];
      var head=document.createElement('tr');head.className='dim';
      head.innerHTML='<td colspan="4" style="padding-top:14px;color:#8b949e">'+esc(run.runId)+' · '+esc(run.workdir||'')+' · '+esc(run.alive?'运行中':(run.reason||'已结束'))+' · '+esc(rel(run.startedAt))+'</td>';
      rowsEl.appendChild(head);
      for(var j=0;j<run.cards.length;j++){
        var c=run.cards[j];total++;
        var tr=document.createElement('tr');
        tr.className='card'+(state.selected&&state.selected.runId===run.runId&&state.selected.cardId===c.id?' sel':'')+(c.status==='blocked'||c.status==='skipped'?' dim':'');
        tr.innerHTML='<td><div class="what" title="'+esc(c.title)+'">'+esc(c.title||c.id)+'</div><div class="dim2" style="font-size:11px">'+esc(c.id)+(c.priorityLabel?' · '+esc(c.priorityLabel):'')+(c.commit?' · '+esc(c.commit):'')+'</div></td>'+
          '<td><div class="what">'+esc(what(c))+'</div><div class="dim2" style="font-size:11px">'+esc(rel(c.endedAt||c.startedAt))+'</div></td>'+
          '<td>'+esc(elapsed(c))+'</td><td>'+st(c.status)+'</td>';
        (function(runId,cardId){tr.onclick=function(){openCard(runId,cardId);};})(run.runId,c.id);
        rowsEl.appendChild(tr);
      }
    }
    var alive=state.runs.filter(function(r){return r.alive;}).length;
    meta.textContent=(view.days>0?'近 '+view.days+' 天':'全部')+' · '+runs.length+' 个 run · '+total+' 张卡'+(alive?'（'+alive+' 个运行中）':'')+' · 每 2 秒刷新';
  }
  function tlHtml(evs){
    var out=[],base=evs.length?evs[0].t:0,i;
    for(i=0;i<evs.length;i++){
      var e=evs[i],off=e.t?Math.max(0,e.t-base):null;
      var cls=e.kind==='say'?'say':(e.kind==='think'?'think':((e.kind==='arm_start'||e.kind==='arm_end')?'arm':'tool'));
      var open='';
      var icon=e.kind==='say'?'💬':(e.kind==='think'?'🧠':(e.kind==='tool'?'⚙':(e.kind==='tool_end'?(e.error?'✕':'✓'):(e.kind==='arm_start'?'🤖':'■'))));
      var body;
      if(e.kind==='say'||e.kind==='think')body='<div class="md">'+md(e.text)+'</div>';
      else if(e.kind==='tool')body=esc(e.name+' '+(e.detail||''));
      else if(e.kind==='tool_end')body=esc(e.name+' 结束');
      else body=esc(e.text||'');
      out.push('<div class="tl '+cls+open+'"><span class="dim2">'+clock(e.t)+'</span><span class="dim2">'+(off==null?'':dur(off))+'</span><div class="act">'+icon+' '+body+'</div><span>'+esc(msText(e.ms))+'</span></div>');
    }
    if(!evs.length)out.push('<div class="tl"><span></span><span></span><div class="act dim2">还没有事件</div><span></span></div>');
    return out.join('');
  }
  function wireTl(root){
    var rows=root.querySelectorAll('.tl.say>.act,.tl.think>.act');
    for(var i=0;i<rows.length;i++){(function(el){el.onclick=function(){el.parentNode.classList.toggle('open');};})(rows[i]);}
  }
  function openCard(runId,cardId){
    state.selected={runId:runId,cardId:cardId};
    stack=[{type:'card',runId:runId,cardId:cardId}];
    cardSig=null;armSig=null;
    try{history.replaceState(null,'','?run='+encodeURIComponent(runId)+'&id='+encodeURIComponent(cardId));}catch(e){}
    render();
    showModal();
  }
  function openArm(name){
    var top=stack[stack.length-1];
    if(!top||top.type!=='card')return;
    stack.push({type:'arm',name:name});
    armSig=null;
    showModal();
  }
  function back(){
    stack.pop();
    cardSig=null;
    if(stack.length)showModal();else closeModal();
  }
  function closeModal(){
    stack=[];cardSig=null;armSig=null;
    document.getElementById('modal').classList.remove('on');
  }
  function showModal(){
    var top=stack[stack.length-1];
    document.getElementById('mback').style.display=stack.length>1?'inline-block':'none';
    document.getElementById('modal').classList.add('on');
    if(!top)return;
    if(top.type==='card')renderCard(top);else renderArm(top);
  }
  function refreshModal(){
    var top=stack[stack.length-1];
    if(!top)return;
    if(top.type==='card')renderCard(top);else renderArm(top);
  }
  function renderArm(top){
    var card=stack[0];
    if(!card||card.type!=='card')return;
    fetch('api/arm?run='+encodeURIComponent(card.runId)+'&id='+encodeURIComponent(card.cardId)+'&arm='+encodeURIComponent(top.name)).then(function(r){return r.json();}).then(function(d){
      var mbody=document.getElementById('mbody');
      if(d.error){mbody.innerHTML='<div class="bad">读不到：'+esc(d.error)+'</div>';return;}
      var sig=top.name+'|'+(d.events||[]).length;
      if(sig===armSig)return;
      armSig=sig;
      var head=(d.reports||[]).map(function(r){return esc([r.label,r.model,r.status,r.tokens?r.tokens+' tok':'',dur(r.elapsedMs)].filter(Boolean).join(' · '));}).join('<br>');
      document.getElementById('mhead').innerHTML='<h3>子代理 '+esc(top.name)+'</h3><div class="sub">'+head+'</div>';
      mbody.innerHTML='<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div><div class="tllist" id="tllist" style="max-height:62vh">'+tlHtml(d.events||[])+'</div></div>';
      wireTl(mbody);
      var box=document.getElementById('tllist');
      if(box)box.scrollTop=box.scrollHeight;
    });
  }
  function renderCard(sel){
    fetch('api/card?run='+encodeURIComponent(sel.runId)+'&id='+encodeURIComponent(sel.cardId)).then(function(r){return r.json();}).then(function(d){
      var mbody=document.getElementById('mbody');
      if(d.error){mbody.innerHTML='<div class="bad">读不到：'+esc(d.error)+'</div>';return;}
      var sig=[sel.runId,sel.cardId,(d.events||[]).length,d.diff?d.diff.length:0,d.cardMd?d.cardMd.length:0].join('|');
      if(sig===cardSig)return;cardSig=sig;
      var run=state.runs.filter(function(r){return r.runId===sel.runId;})[0];
      var card=(run&&run.cards.filter(function(c){return c.id===sel.cardId;})[0])||{};
      document.getElementById('mhead').innerHTML='<h3>'+esc(card.title||sel.cardId)+'</h3><div class="sub">'+esc(card.id)+' · '+(d.detail?esc(d.detail.statusLabel+' · '+d.detail.priorityLabel+' · '+d.detail.owner):'')+' · '+esc(elapsed(card))+' · '+st(card.status||'queued')+'</div>';
      var html=[];
      if(d.cardMd){
        var cardMd=String(d.cardMd).replace(/\\]\\(images\\//g,'](/img/'+sel.runId+'/'+sel.cardId+'/');
        html.push(paneHtml(sel.runId+'|'+sel.cardId+'|card','工单','<div class="md">'+md(cardMd)+'</div>'));
      }
      var says=(d.events||[]).filter(function(e){return e.kind==='say';});
      if(says.length){
        html.push(paneHtml(sel.runId+'|'+sel.cardId+'|say','主 Agent 结论','<div class="md">'+md(says[says.length-1].text)+'</div>'));
      }
      if(d.brief)html.push(paneHtml(sel.runId+'|'+sel.cardId+'|brief','交给内循环的 brief','<div class="md">'+md(d.brief)+'</div>'));
      if(d.verify)html.push(paneHtml(sel.runId+'|'+sel.cardId+'|verify','验证输出','<pre>'+esc(d.verify)+'</pre>'));
      if(d.diff){
        currentDiff=d.diff;
        html.push(paneHtml(sel.runId+'|'+sel.cardId+'|diff','改动 diff',
          '<div class="diffbar"><button data-mode="single"'+(diffMode==='single'?' class="on"':'')+'>单列</button><button data-mode="dual"'+(diffMode==='dual'?' class="on"':'')+'>双列</button></div><div id="diffbox">'+diffHtml(currentDiff,diffMode)+'</div>'));
      }
      if(d.logTail)html.push(paneHtml(sel.runId+'|'+sel.cardId+'|log','进程日志尾部','<pre>'+esc(d.logTail)+'</pre>'));
      if(d.arms&&d.arms.length){
        var armBody='';
        for(var a=0;a<d.arms.length;a++){var arm=d.arms[a];
          armBody+='<div class="armrow" data-arm="'+esc(arm.name)+'"><span class="nm">🤖 '+esc(arm.name)+'</span><span>'+esc((arm.labels||[]).join(','))+'</span><span class="meta">'+esc([arm.status,arm.tokens?arm.tokens+' tok':'',dur(arm.elapsedMs),arm.events+' 条事件'].filter(Boolean).join(' · '))+'</span></div>';
        }
        html.push(paneHtml(sel.runId+'|'+sel.cardId+'|arms','子代理 · '+d.arms.length+' 个',armBody));
      }
      var evs=d.events||[];
      html.push('<div class="tlbar"><span>内循环时间线 · '+evs.length+' 条</span><label><input type="checkbox" id="autoscroll">自动滚到最新</label></div>');
      html.push('<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div><div class="tllist" id="tllist">'+tlHtml(evs)+'</div></div>');
      mbody.innerHTML=html.join('');
      var box=document.getElementById('tllist'),cb=document.getElementById('autoscroll');
      if(cb){cb.checked=autoscroll;cb.onchange=function(){autoscroll=cb.checked;if(autoscroll)box.scrollTop=box.scrollHeight;};}
      if(box&&autoscroll)box.scrollTop=box.scrollHeight;
      wirePanes(mbody);
      wireDiff(mbody);
      wireTl(mbody);
      var armRows=mbody.querySelectorAll('.armrow');
      for(var k=0;k<armRows.length;k++){(function(el){el.onclick=function(){openArm(el.getAttribute('data-arm'));};})(armRows[k]);}
    }).catch(function(){document.getElementById('mbody').innerHTML='<div class="bad">读取失败，重试中…</div>';});
  }
  function poll(){
    fetch('api/state').then(function(r){return r.json();}).then(function(d){state.runs=d.runs||[];render();if(deep){var d0=deep;deep=null;openCard(d0.runId,d0.cardId);return;}refreshModal();})
      .catch(function(){meta.textContent='连接断开，重试中…';});
  }
  function syncFilters(){var btns=document.querySelectorAll('#filters button');for(var i=0;i<btns.length;i++){btns[i].className=Number(btns[i].getAttribute('data-days'))===view.days?'on':'';}}
  (function wire(){var btns=document.querySelectorAll('#filters button');for(var i=0;i<btns.length;i++){(function(b){b.onclick=function(){view.days=Number(b.getAttribute('data-days'));saveView();syncFilters();poll();};})(btns[i]);}var cb=document.getElementById('onlyAlive');cb.checked=view.onlyAlive;cb.onchange=function(){view.onlyAlive=cb.checked;saveView();poll();};syncFilters();
    document.getElementById('mback').onclick=back;
    document.getElementById('modal').addEventListener('click',function(e){if(e.target===this)closeModal();});
    document.addEventListener('keydown',function(e){if(e.key==='Escape'){if(stack.length>1)back();else closeModal();}});
  })();
  poll();setInterval(poll,2000);
})();
</script></body></html>`
}
