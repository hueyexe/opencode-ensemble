/** Dashboard JS — render functions. */
export const DASHBOARD_JS_PART2 = `
function rSel(){
  const el=document.getElementById('sel'),{active,archived}=allTeams(),c=cur();
  if(!active.length&&!archived.length){el.innerHTML='<option>No teams</option>';return}
  let h='';
  if(active.length){h+='<optgroup label="Active">';h+=active.map(t=>'<option value="'+t.id+'">'+E(t.name)+' ('+relT(t.timeUpdated)+')</option>').join('');h+='</optgroup>'}
  if(archived.length){h+='<optgroup label="Archived">';h+=archived.slice(0,5).map(t=>'<option value="'+t.id+'">'+E(t.name)+'</option>').join('');if(archived.length>5)h+='<option disabled>+ '+(archived.length-5)+' more</option>';h+='</optgroup>'}
  if(el._lh!==h){el.innerHTML=h;el._lh=h}
  if(c)el.value=c.id;
}

function rHealth(t){
  const el=document.getElementById('hring'),h=deriveHealth(t);
  if(!h.total){el.style.background='conic-gradient(#2a3144 0deg,#2a3144 360deg)';return}
  const total=h.total,segs=[];let deg=0;
  if(h.w){const d=h.w/total*360;segs.push('#3b82f6 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.i){const d=h.i/total*360;segs.push('#5e6a82 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.e){const d=h.e/total*360;segs.push('#ef4444 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  if(h.d){const d=h.d/total*360;segs.push('#2a3144 '+deg+'deg '+(deg+d)+'deg');deg+=d}
  el.style.background='conic-gradient('+segs.join(',')+')';
  el.style.mask='radial-gradient(circle at center,transparent 7px,black 8px)';
  el.style.webkitMask=el.style.mask;
}

function rClock(t){
  const el=document.getElementById('clk');
  const now=new Date();
  const hh=String(now.getHours()).padStart(2,'0'),mm=String(now.getMinutes()).padStart(2,'0'),ss=String(now.getSeconds()).padStart(2,'0');
  const uptime=t?D(Date.now()-t.timeCreated):'';
  el.textContent=hh+':'+mm+':'+ss+(uptime?' \\u00B7 '+uptime:'');
}

function rSum(t){
  const el=document.getElementById('sum'),mm=t.members||[],tk=t.tasks||[],msgs=t.messages||[];
  const h=deriveHealth(t),tc=tk.filter(x=>x.status==='completed').length;
  patch(el,
    '<span class="w-[6px] h-[6px] rounded-full '+(t.status==='active'?'bg-emerald-500':'bg-txt-500')+'"></span>'+
    '<span class="font-mono font-semibold text-txt-200">'+E(t.name)+'</span>'+
    (mm.length?chip(mm.length+' agent'+(mm.length!==1?'s':''),'gray'):'')+
    (h.w?chip(h.w+' working','blue'):'')+
    (h.i?chip(h.i+' idle','muted'):'')+
    (h.d?chip(h.d+' done','muted'):'')+
    (h.e?chip(h.e+' error','red'):'')+
    (tk.length?chip(tc+'/'+tk.length+' tasks','green'):'')+
    (msgs.length?chip(msgs.length+' msgs','muted'):'')
  );
}

function rAgents(t){
  const el=document.getElementById('agents'),mm=t.members||[];
  if(!mm.length){patch(el,'<div class="col-span-full text-center py-12"><div class="text-txt-400 text-sm mb-1">No agents yet</div><div class="text-txt-500 text-[11px]">Spawn teammates with <code class="px-1 py-0.5 bg-base-900 rounded font-mono text-[10px]">team_spawn</code></div></div>');return}
  const n=Date.now(),msgs=t.messages||[],sorted=[...mm].sort((a,b)=>{const o={busy:0,ready:1,shutdown_requested:2,error:3,shutdown:4};return(o[a.status]??5)-(o[b.status]??5)});
  const html=sorted.map((m,idx)=>{
    const s=si(m.status),task=(t.tasks||[]).find(x=>x.assignee===m.name&&x.status==='in_progress'),msg=msgs.find(x=>x.fromName===m.name);
    const d=D(n-m.timeUpdated),mi=msg?relT(msg.timeCreated):'\\u2014';
    const tt=task?.content,tr=tt&&tt.length>90?tt.slice(0,90)+'\\u2026':tt;
    const spark=deriveSparkline(m.name,msgs);
    const isSel=selCard===idx;
    return '<div class="rounded-lg border '+s.c+' p-3 transition-all duration-300 cursor-pointer hover:border-base-600'+(s.dim?' opacity-50 hover:opacity-70':'')+(isSel?' card-sel':'')+'" data-card="'+E(m.name)+'" onclick="openDrawer(\\''+E(m.name)+'\\')">'+
      '<div class="flex items-center gap-2">'+
        '<span class="w-[8px] h-[8px] rounded-full '+s.d+(m.status==='busy'?' pulse':'')+' shrink-0"></span>'+
        '<span class="font-mono font-semibold text-[14px] truncate">'+E(m.name)+'</span>'+
        '<span class="text-[10px] px-1.5 py-[1px] rounded '+s.t+' bg-base-800/80 shrink-0">'+s.l+'</span>'+
        spark+
        '<span class="text-[10px] text-txt-500 ml-auto shrink-0">'+E(m.agent)+'</span>'+
      '</div>'+
      (tr?'<div class="mt-2 text-[13px] text-txt-200 leading-snug truncate">'+E(tr)+'</div>':'')+
      '<div class="mt-2 flex items-center gap-1.5 flex-wrap">'+
        chip(d,'muted')+chip('msg '+mi,'muted')+
        (m.worktreeBranch?chip(E(m.worktreeBranch),'muted'):'')+
      '</div></div>';
  }).join('');
  patch(el,html);
}

function openDrawer(name){
  var t=cur();if(!t)return;
  var m=(t.members||[]).find(x=>x.name===name);if(!m)return;
  var s=si(m.status),msgs=(t.messages||[]).filter(x=>x.fromName===name);
  var h='';
  // Header
  h+='<div class="flex items-center justify-between mb-4">';
  h+='<div class="flex items-center gap-2"><span class="w-[10px] h-[10px] rounded-full '+s.d+(m.status==='busy'?' pulse':'')+'"></span><span class="font-mono font-semibold text-[16px]">'+E(m.name)+'</span><span class="text-[11px] px-2 py-[2px] rounded '+s.t+' bg-base-800/80">'+s.l+'</span></div>';
  h+='<button onclick="closeDrawer()" class="text-txt-500 hover:text-txt-200 transition-colors p-1"><svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg></button>';
  h+='</div>';
  // Meta chips
  var meta=[];
  meta.push(chip(E(m.agent),'gray'));
  if(m.model)meta.push(chip(E(m.model),'gray'));
  meta.push(chip(E(m.executionStatus||m.status),m.status==='busy'?'blue':m.status==='error'?'red':'muted'));
  if(m.planApproval&&m.planApproval!=='none')meta.push(chip(E(m.planApproval),m.planApproval==='approved'?'green':m.planApproval==='rejected'?'red':'amber'));
  meta.push(chip('spawned '+relT(m.timeCreated),'muted'));
  if(m.worktreeBranch)meta.push(chip(E(m.worktreeBranch),'muted'));
  h+='<div class="flex flex-wrap gap-1.5 mb-4 pb-4 border-b border-base-800/50">'+meta.join('')+'</div>';
  // Prompt
  if(m.prompt){
    h+='<div class="mb-4"><div class="text-txt-400 text-[10px] uppercase tracking-wider mb-2">Original Prompt</div>';
    h+='<div class="text-[13px] text-txt-200 md bg-base-800/20 rounded-lg p-3 border border-base-800/30">'+md(m.prompt)+'</div></div>';
  }
  // Chat log
  h+='<div class="text-txt-400 text-[10px] uppercase tracking-wider mb-3">Conversation</div>';
  if(!msgs.length){h+='<div class="text-txt-500 text-[12px]">No messages yet</div>'}
  else{
    // Get all messages involving this agent (sent or received)
    var allMsgs=(t.messages||[]).filter(function(x){return x.fromName===name||x.toName===name});
    allMsgs.sort(function(a,b){return a.timeCreated-b.timeCreated});
    allMsgs.forEach(function(am){
      var isAgent=am.fromName===name;
      var p=parseR(am.content);
      var deliv=am.delivered?(am.read?'\\u2713\\u2713':'\\u2713'):'';
      var align=isAgent?'mr-8':'ml-8';
      var bubbleBg=isAgent?'bg-blue-500/[0.07] border-blue-500/20':'bg-base-800/40 border-base-700/30';
      var sender=isAgent?E(am.fromName):'lead';
      h+='<div class="mb-2 '+align+'">';
      h+='<div class="rounded-xl border '+bubbleBg+' p-3">';
      h+='<div class="flex items-center gap-2 mb-1.5">';
      h+='<span class="text-[10px] font-medium '+(isAgent?'text-blue-400':'text-txt-300')+'">'+sender+'</span>';
      h+=chip(relT(am.timeCreated),'muted');
      if(am.toName)h+=chip('\\u2192 '+E(am.toName),'muted');
      if(deliv)h+='<span class="text-txt-500 text-[10px] ml-auto">'+deliv+'</span>';
      h+='</div>';
      if(p){
        h+='<div class="mb-1">'+chip(E(p.status),p.status==='completed'?'green':'red')+' <span class="text-[13px] text-txt-200 font-medium">'+E(p.summary)+'</span></div>';
        if(p.details)h+='<div class="text-[12px] text-txt-300 md mt-2">'+md(p.details)+'</div>';
      }else{
        h+='<div class="text-[12px] text-txt-300 md">'+md(am.content)+'</div>';
      }
      h+='</div></div>';
    });
  }
  document.getElementById('drawer').innerHTML=h;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('drawer-bg').classList.add('open');
}

function closeDrawer(){
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('drawer-bg').classList.remove('open');
}

function rTasks(t){
  const el=document.getElementById('tasks'),tk=t.tasks||[];
  if(!tk.length){patch(el,'<div class="text-txt-500 text-sm py-6 text-center">No tasks yet</div>');return}
  const c=tk.filter(x=>x.status==='completed').length,pct=Math.max(Math.round(c/tk.length*100),tk.length>0?2:0);
  const allDone=c===tk.length&&tk.length>0;
  const g={in_progress:[],pending:[],completed:[],blocked:[],cancelled:[]};for(const x of tk)(g[x.status]||(g[x.status]=[])).push(x);
  const ds=saveD(el);
  const taskMap={};tk.forEach(x=>{taskMap[x.id]=x});
  function grp(label,items,dc,defOpen){
    if(!items.length)return'';
    const rows=items.map(x=>{
      const ic=x.status==='completed'?'\\u2713':x.status==='in_progress'?'\\u25CF':'\\u25CB';
      const icl=x.status==='completed'?'text-emerald-500':x.status==='in_progress'?'text-blue-400':'text-txt-500';
      const p=PR[x.priority]||PR.low,cn=x.content.length>55?x.content.slice(0,55)+'\\u2026':x.content;
      let dep='';
      if(x.dependsOn){const parent=taskMap[x.dependsOn];dep='<div class="text-[10px] text-txt-500 mt-0.5">\\u2514\\u2192 '+(parent?E(parent.content.slice(0,30)):E(x.dependsOn))+'</div>'}
      return '<div class="flex items-start gap-2 py-1.5 px-1 rounded hover:bg-base-800/40 transition-colors">'+
        '<span class="'+icl+' text-[11px] mt-[2px] shrink-0">'+ic+'</span>'+
        '<div class="flex-1 min-w-0"><div class="text-[13px] text-txt-200 truncate">'+E(cn)+'</div>'+
        '<div class="flex gap-2 mt-1 text-[10px]"><span class="rounded px-1.5 py-[0px] '+p+'">'+E(x.priority)+'</span>'+
        '<span class="text-txt-500">'+(E(x.assignee)||'unassigned')+'</span></div>'+dep+'</div></div>';
    }).join('');
    return '<details '+(defOpen?'open':'')+'><summary class="flex items-center gap-2 text-[11px] text-txt-300 cursor-pointer py-1.5 hover:text-txt-200 transition-colors select-none">'+
      '<svg class="w-3 h-3 transition-transform [details[open]>summary>&]:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>'+
      '<span class="w-[6px] h-[6px] rounded-full '+dc+'"></span>'+label+' <span class="text-txt-500">('+items.length+')</span></summary>'+
      '<div class="ml-5 mt-1">'+rows+'</div></details>';
  }
  el.innerHTML='<div class="flex items-center gap-3 mb-3">'+
    '<span class="text-[11px] text-txt-300 font-semibold uppercase tracking-wider">Tasks</span>'+
    '<div class="flex-1 bg-base-800 rounded-full h-[5px]"><div class="'+(allDone?'shimmer':'bg-emerald-500')+' h-[5px] rounded-full transition-all duration-500" style="width:'+pct+'%"></div></div>'+
    '<span class="text-[11px] text-txt-400 font-mono">'+c+'/'+tk.length+'</span>'+
    (allDone?'<span class="text-emerald-400 text-[10px] font-medium">All complete</span>':'')+
  '</div>'+
  grp('In Progress',g.in_progress,'bg-blue-500',true)+grp('Pending',g.pending,'bg-txt-500',true)+grp('Blocked',g.blocked||[],'bg-amber-500',true)+grp('Completed',g.completed,'bg-emerald-500',false);
  restD(el,ds);
}

function rActivity(t){
  const el=document.getElementById('activity'),msgs=t.messages||[];
  if(!msgs.length){patch(el,'<div class="text-txt-500 text-sm py-6 text-center">Waiting for agent messages...</div>');return}
  const sp=saveSc(el);
  const newCount=msgs.length,hasNew=newCount>prevMC&&prevMC>0;
  let html='<div class="text-[11px] text-txt-300 font-semibold uppercase tracking-wider mb-3">Activity '+chip(msgs.length+' msgs','muted')+'</div>';
  html+='<div class="max-h-[50vh] overflow-y-auto scroll space-y-2">';
  msgs.slice(0,30).forEach(function(m,mi){
    const isNew=hasNew&&mi<(newCount-prevMC);
    const isExp=expMsgs.has(m.id);
    const p=parseR(m.content);
    const deliv=m.delivered?(m.read?'\\u2713\\u2713':'\\u2713'):'';
    const isFromAgent=m.fromName!=='lead'&&m.fromName!=='system';
    const isPeer=isFromAgent&&m.toName&&m.toName!=='lead'&&m.toName!=='all';
    const align=isFromAgent?'mr-6':'ml-6';
    const bubbleBg=isPeer?'bg-violet-500/[0.06] border-violet-500/15':isFromAgent?'bg-blue-500/[0.06] border-blue-500/15':'bg-base-800/40 border-base-700/30';
    const initial=m.fromName.charAt(0).toUpperCase();
    const avatarColor=m.fromName==='system'?'bg-amber-500/20 text-amber-400':isPeer?'bg-violet-500/20 text-violet-400':isFromAgent?'bg-blue-500/20 text-blue-400':'bg-emerald-500/20 text-emerald-400';
    html+='<div class="'+align+(isNew?' hl':'')+' cursor-pointer" data-msg="'+E(m.id)+'" onclick="toggleMsg(\\''+E(m.id)+'\\')">';
    html+='<div class="flex items-start gap-2">';
    html+='<span class="w-5 h-5 rounded-full '+avatarColor+' flex items-center justify-center text-[9px] font-semibold shrink-0 mt-0.5">'+E(initial)+'</span>';
    html+='<div class="flex-1 min-w-0 rounded-xl border '+bubbleBg+' px-3 py-2">';
    html+='<div class="flex items-center gap-1.5 mb-1">';
    html+='<span class="text-[11px] font-medium '+(isPeer?'text-violet-400':isFromAgent?'text-blue-400':'text-txt-300')+'">'+E(m.fromName)+'</span>';
    if(m.toName)html+=chip('\\u2192 '+E(m.toName),'muted');
    html+=chip(relT(m.timeCreated),'muted');
    if(deliv)html+='<span class="text-txt-500 text-[10px] ml-auto">'+deliv+'</span>';
    html+='</div>';
    if(p){
      html+='<div>'+chip(E(p.status),p.status==='completed'?'green':'red')+' <span class="text-[13px] text-txt-200">'+E(p.summary)+'</span></div>';
      if(isExp&&p.details)html+='<div class="mt-2 text-[12px] text-txt-300 md">'+md(p.details)+'</div>';
      if(!isExp&&p.details)html+='<div class="mt-1 text-[10px] text-txt-500">Click to expand details</div>';
    }else{
      if(isExp){html+='<div class="text-[12px] text-txt-300 md">'+md(m.content)+'</div>'}
      else{const preview=m.content.length>120?m.content.slice(0,120)+'\\u2026':m.content;html+='<div class="text-[13px] text-txt-300 truncate">'+E(preview)+'</div>'}
    }
    html+='</div></div></div>';
  });
  if(msgs.length>30)html+='<div class="text-center text-[10px] text-txt-500 py-2">+'+(msgs.length-30)+' older messages</div>';
  html+='</div>';
  prevMC=newCount;
  el.innerHTML=html;
  restSc(el,sp);
}

function rTimeline(t){
  const el=document.getElementById('tl'),evs=deriveTimeline(t);
  if(!evs.length){el.classList.add('hidden');return}
  el.classList.remove('hidden');
  const html=evs.map(ev=>{
    return '<div class="flex flex-col items-center mx-1 shrink-0 group" title="'+E(ev.label)+' \\u00B7 '+relT(ev.t)+'"><div class="w-[6px] h-[6px] rounded-full '+ev.c+' group-hover:scale-150 transition-transform"></div><div class="text-[8px] text-txt-500 mt-0.5 hidden group-hover:block whitespace-nowrap">'+E(ev.label)+'</div></div>';
  }).join('<div class="w-3 h-px bg-base-700 shrink-0 self-center"></div>');
  patch(el,'<span class="text-[9px] text-txt-500 uppercase tracking-wider mr-3 shrink-0">Timeline</span>'+html);
}
`;
