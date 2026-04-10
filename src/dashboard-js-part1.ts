/** Dashboard JS — utilities, data helpers, and state management. */
export const DASHBOARD_JS_PART1 = `
let S=null,selId=null,fails=0,pollT=Date.now(),prevMC=0,selCard=-1;
const expCards=new Set(),expMsgs=new Set();
const E=s=>s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'):'';
const D=ms=>{const s=Math.floor(Math.abs(ms)/1000);return s<60?s+'s':s<3600?Math.floor(s/60)+'m':Math.floor(s/3600)+'h'};
const T=e=>new Date(e).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
function relT(ep){const ms=Date.now()-ep;if(ms<60000)return Math.floor(ms/1000)+'s ago';if(ms<3600000)return Math.floor(ms/60000)+'m ago';if(ms<86400000)return Math.floor(ms/3600000)+'h ago';return T(ep)}

// Chip: small readable badge with background tint
function chip(text,color){
  var colors={
    blue:'bg-blue-500/15 text-blue-400 border-blue-500/20',
    green:'bg-emerald-500/15 text-emerald-400 border-emerald-500/20',
    amber:'bg-amber-500/15 text-amber-400 border-amber-500/20',
    red:'bg-red-500/15 text-red-400 border-red-500/20',
    gray:'bg-base-700/40 text-txt-300 border-base-700/30',
    muted:'bg-base-800/60 text-txt-400 border-base-700/20',
  };
  var c=colors[color]||colors.muted;
  return '<span class="inline-flex items-center px-1.5 py-[1px] rounded text-[10px] font-medium border '+c+'">'+text+'</span>';
}

function md(s){
  let h=E(s);
  h=h.replace(/\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g,function(_,l,c){return '<pre><code>'+c.trim()+'</code></pre>'});
  h=h.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  h=h.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  h=h.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  h=h.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  h=h.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');
  h=h.replace(/\\*(.+?)\\*/g,'<em>$1</em>');
  h=h.replace(/\\[([^\\]]+)\\]\\(([^)]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
  h=h.replace(/^- (.+)$/gm,'<li>$1</li>');
  h=h.replace(/(<li>.*<\\/li>\\n?)+/g,'<ul>$&</ul>');
  h=h.replace(/^\\d+\\. (.+)$/gm,'<li>$1</li>');
  h=h.replace(/\\n\\n/g,'</p><p>');
  h=h.replace(/\\n/g,'<br>');
  return '<p>'+h+'</p>';
}

function saveD(el){const s={};el.querySelectorAll('details').forEach((d,i)=>{s[i]=d.open});return s}
function restD(el,s){if(!s)return;el.querySelectorAll('details').forEach((d,i)=>{if(i in s)d.open=s[i]})}
function saveSc(el){const s=el.querySelector('.scroll');return s?s.scrollTop:0}
function restSc(el,p){const s=el.querySelector('.scroll');if(s)s.scrollTop=p}
function patch(el,h){if(el.innerHTML!==h)el.innerHTML=h}

const ST={
  busy:{c:'border-blue-500 bg-blue-500/[0.04]',d:'bg-blue-500',t:'text-blue-400',l:'working',dim:false},
  ready:{c:'border-base-700 bg-base-950/50',d:'bg-txt-400',t:'text-txt-400',l:'idle',dim:true},
  shutdown_requested:{c:'border-amber-500/50 bg-amber-500/[0.04]',d:'bg-amber-500',t:'text-amber-400',l:'stopping',dim:false},
  shutdown:{c:'border-base-800 bg-base-950/30',d:'bg-base-700',t:'text-txt-500',l:'done',dim:true},
  error:{c:'border-red-500/50 bg-red-500/[0.04]',d:'bg-red-500',t:'text-red-400',l:'error',dim:false},
};
const si=s=>ST[s]||ST.ready;
const PR={high:'text-red-400 bg-red-500/10 border border-red-500/20',medium:'text-amber-400 bg-amber-500/10 border border-amber-500/20',low:'text-txt-400 bg-base-800 border border-base-700'};

function parseR(c){const m=c.match(/<task-result>([\\s\\S]*?)<\\/task-result>/);if(!m)return null;const i=m[1],s=(i.match(/<status>([\\s\\S]*?)<\\/status>/)||[])[1]?.trim(),u=(i.match(/<summary>([\\s\\S]*?)<\\/summary>/)||[])[1]?.trim(),d=(i.match(/<details>([\\s\\S]*?)<\\/details>/)||[])[1]?.trim();return s&&u?{status:s,summary:u,details:d||''}:null}

function allTeams(){
  if(!S?.teams)return{active:[],archived:[]};
  const active=[...S.teams.filter(t=>t.status==='active')].sort((a,b)=>b.timeUpdated-a.timeUpdated);
  const archived=[...S.teams.filter(t=>t.status!=='active')].sort((a,b)=>b.timeUpdated-a.timeUpdated);
  return{active,archived};
}
function cur(){const{active,archived}=allTeams(),all=[...active,...archived];if(!all.length)return null;if(selId){const t=all.find(t=>t.id===selId);if(t)return t}return active[0]||all[0]}

function deriveHealth(t){
  const mm=t.members||[];if(!mm.length)return{w:0,i:0,e:0,d:0,total:0};
  return{w:mm.filter(m=>m.status==='busy').length,i:mm.filter(m=>m.status==='ready').length,e:mm.filter(m=>m.status==='error').length,d:mm.filter(m=>m.status==='shutdown'||m.status==='shutdown_requested').length,total:mm.length};
}

function deriveSparkline(name,msgs){
  const mine=msgs.filter(m=>m.fromName===name).map(m=>m.timeCreated).sort();
  if(mine.length<2)return '';
  const min=mine[0],max=mine[mine.length-1],range=max-min||1;
  const buckets=new Array(12).fill(0);
  mine.forEach(t=>{const idx=Math.min(11,Math.floor((t-min)/range*12));buckets[idx]++});
  const mx=Math.max(...buckets)||1;
  const bars=buckets.map((v,i)=>{const h=Math.max(1,Math.round(v/mx*14));return '<rect x="'+(i*5)+'" y="'+(14-h)+'" width="3.5" height="'+h+'" rx="0.5" fill="currentColor" opacity="'+(0.3+v/mx*0.7)+'"/>'}).join('');
  return '<svg class="inline-block text-blue-500/60" width="60" height="14" viewBox="0 0 60 14">'+bars+'</svg>';
}

function deriveTimeline(t){
  const ev=[];
  (t.members||[]).forEach(m=>{ev.push({t:m.timeCreated,type:'spawn',label:E(m.name)+' spawned',c:'bg-blue-400'});if(m.status==='shutdown')ev.push({t:m.timeUpdated,type:'off',label:E(m.name)+' shut down',c:'bg-txt-500'});if(m.status==='error')ev.push({t:m.timeUpdated,type:'err',label:E(m.name)+' error',c:'bg-red-500'})});
  (t.messages||[]).forEach(m=>{const p=parseR(m.content);ev.push({t:m.timeCreated,type:'msg',label:E(m.fromName)+' \\u2192 '+(E(m.toName)||'all'),c:p?'bg-emerald-500':'bg-blue-400'})});
  (t.tasks||[]).filter(x=>x.status==='completed').forEach(x=>{ev.push({t:x.timeUpdated,type:'done',label:'Task done',c:'bg-emerald-500'})});
  return ev.sort((a,b)=>a.t-b.t).slice(-50);
}

function deriveThreads(msgs){
  const threads={};
  msgs.forEach(m=>{const k=m.fromName;if(!threads[k])threads[k]={from:m.fromName,msgs:[]};threads[k].msgs.push(m)});
  return Object.values(threads).sort((a,b)=>b.msgs[0].timeCreated-a.msgs[0].timeCreated);
}
`;
