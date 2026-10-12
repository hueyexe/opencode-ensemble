/** Dashboard JS — dependency graph view, task inspection, and tab interactions. */
export const DASHBOARD_JS_GRAPH = `
let dashboardTab='overview',graphSelectedId=null,graphTeamId=null;
function selectDashboardTab(view){
  dashboardTab=view==='dependencies'?'dependencies':'overview';
  ['overview','dependencies'].forEach(name=>{
    const active=dashboardTab===name,tab=document.getElementById('tab-'+name);
    tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
    document.getElementById('panel-'+name).hidden=!active;
  });
  const team=cur();if(team)rGraph(team);
}
function graphTabKeydown(e){
  if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;
  e.preventDefault();
  const view=e.key==='Home'?'overview':e.key==='End'?'dependencies':e.target.id==='tab-overview'?'dependencies':'overview';
  selectDashboardTab(view);document.getElementById('tab-'+view).focus();
}
function rGraph(team){
  const switched=graphTeamId!==team.id;
  if(switched){graphTeamId=team.id;graphSelectedId=null;resetGraphView()}
  if(graphSelectedId!==null&&!(team.tasks||[]).some(task=>task.id===graphSelectedId))graphSelectedId=null;
  if(dashboardTab!=='dependencies')return;
  const root=document.getElementById('graph-content'),scroll=document.getElementById('graph-scroll');
  const left=scroll.scrollLeft,top=scroll.scrollTop,focused=document.activeElement;
  const focusData=root.contains(focused)?{task:focused.dataset?.graphTask,select:focused.dataset?.graphSelect,agent:focused.dataset?.graphAgent,scroll:focused.id==='graph-scroll'}:null;
  const html=graphMarkup(team,graphLayout(team.tasks||[]),graphSelectedId);
  if(root.innerHTML===html)return;
  patch(root,html);
  if(focusData){
    const target=focusData.scroll?document.getElementById('graph-scroll'):[...root.querySelectorAll('button')].find(button=>
      (focusData.task!==undefined&&button.dataset.graphTask===focusData.task)||
      (focusData.select!==undefined&&button.dataset.graphSelect===focusData.select)||
      (focusData.agent!==undefined&&button.dataset.graphAgent===focusData.agent));
    if(target)target.focus({preventScroll:true});else document.getElementById('graph-scroll').focus({preventScroll:true});
  }
  const nextScroll=document.getElementById('graph-scroll');nextScroll.scrollLeft=left;nextScroll.scrollTop=top;
}
function selectGraphTask(id){const team=cur();if(!team||!(team.tasks||[]).some(task=>task.id===id))return;rGraph(team);graphSelectedId=id;rGraph(team)}
function resetGraphView(){const scroll=document.getElementById('graph-scroll');if(scroll){scroll.scrollLeft=0;scroll.scrollTop=0}}
function graphTaskInfo(task,byId){
  const deps=graphDependencies(task),waiting=deps.filter(id=>byId.get(id)?.status!=='completed');
  const terminal=task.status==='completed'||task.status==='cancelled',blocked=!terminal&&(task.status==='blocked'||waiting.length>0);
  const color=task.status==='completed'?'green':blocked?'amber':task.status==='in_progress'?'blue':'muted';
  return {deps,waiting,blocked,color,hint:terminal?'':waiting.length?'Blocked by '+waiting.length+' prerequisite'+(waiting.length===1?'':'s'):deps.length?'Prerequisites satisfied':'No prerequisites'};
}
function graphCard(node,team,byId,selectedId,cyclic){
  const task=node.task,member=(team.members||[]).find(m=>m.name===task.assignee),info=graphTaskInfo(task,byId);
  const state=member?si(member.status):null;
  const tone=task.status==='completed'?'graph-done':info.blocked?'graph-blocked':task.status==='in_progress'?'graph-running':'';
  return '<button type="button" class="graph-card '+tone+'" style="left:'+node.x+'px;top:'+node.y+'px" data-graph-task="'+E(task.id)+'" aria-pressed="'+String(task.id===selectedId)+'" title="'+E(task.content)+'">'+
    '<div class="graph-card-head"><span class="graph-card-name">'+E(task.assignee||'Unassigned')+'</span>'+(state?chip('agent '+state.l,member.status==='busy'?'blue':member.status==='error'?'red':'muted'):'')+'</div>'+
    '<div class="graph-card-task">'+E(task.content)+'</div>'+
    '<div class="graph-card-meta">'+E(member?[member.agent,member.model].filter(Boolean).join(' · '):task.assignee?'Agent not in roster':'No agent assigned')+'</div>'+
    '<div class="graph-card-foot">'+chip(E(String(task.status).replace(/_/g,' ')),info.color)+chip(E(task.priority||'medium'),'muted')+(cyclic?chip('cycle affected','amber'):'')+'</div>'+
    '<div class="graph-card-meta" title="'+E(task.id)+'">'+E(info.hint||task.id)+'</div></button>';
}
function graphDetail(team,byId,selectedId){
  const task=byId.get(selectedId);
  if(!task)return '<div id="graph-detail" class="graph-detail" aria-live="polite"><h3 class="text-txt-200 font-semibold">Inspect a task</h3><p class="text-txt-400 mt-1">Select a card to see prerequisites, dependents, and its assigned agent.</p></div>';
  const member=(team.members||[]).find(m=>m.name===task.assignee),info=graphTaskInfo(task,byId);
  function links(ids){return ids.length?ids.map(id=>{
    const linked=byId.get(id);
    return linked?'<button type="button" class="graph-detail-link" data-graph-select="'+E(id)+'">'+E(linked.content)+' '+chip(E(String(linked.status).replace(/_/g,' ')),'muted')+'</button>':'<div class="text-amber-400 mt-1">Missing prerequisite: '+E(id)+'</div>';
  }).join(''):'<div class="text-txt-500 mt-1">None</div>'}
  const dependents=(team.tasks||[]).filter(t=>graphDependencies(t).includes(task.id)).map(t=>t.id);
  return '<div id="graph-detail" class="graph-detail" aria-live="polite">'+
    '<h3 class="text-txt-100 font-semibold">'+E(task.content)+'</h3><div class="text-txt-400 mt-1">'+E(task.id)+' · '+chip(E(String(task.status).replace(/_/g,' ')),info.color)+'</div>'+
    '<div class="mt-2">Agent: '+(member?'<button type="button" class="text-blue-400 underline" data-graph-agent="'+E(member.name)+'">'+E(member.name)+' — open agent detail</button>':E(task.assignee||'Unassigned'))+'</div>'+
    '<div class="graph-detail-grid"><div><h4 class="text-txt-300 font-semibold">Prerequisites</h4>'+links(info.deps)+'</div><div><h4 class="text-txt-300 font-semibold">Dependents</h4>'+links(dependents)+'</div></div></div>';
}
function graphMarkup(team,layout,selectedId){
  const tasks=team.tasks||[],byId=new Map(tasks.map(task=>[task.id,task])),nodes=new Map(layout.nodes.map(node=>[node.task.id,node]));
  if(!tasks.length)return '<div id="graph-scroll" class="graph-scroll scroll" tabindex="0" aria-label="Task dependency graph"><div class="text-center text-txt-400 text-[13px] py-12">No tasks yet<div class="text-[11px] text-txt-500 mt-2">Add tasks with <code class="font-mono">team_tasks_add</code> to see their dependencies.</div></div></div>'+graphDetail(team,byId,null);
  let warning='';
  if(layout.cyclic.length)warning+='<div class="graph-warning">Cyclic dependencies: '+layout.cyclic.length+' task'+(layout.cyclic.length===1?'':'s')+' affected. Cycle-affected tasks are shown in the last column.</div>';
  if(layout.missing.length)warning+='<div class="graph-warning">Missing prerequisite'+(layout.missing.length===1?'':'s')+': '+layout.missing.map(item=>E(byId.get(item.taskId).content)+' → '+E(item.dependencyId)).join('; ')+'</div>';
  const edges=layout.edges.map(edge=>{
    const from=nodes.get(edge.from),to=nodes.get(edge.to),done=from.task.status==='completed';
    const x1=from.x+GRAPH_CARD_WIDTH,y1=from.y+GRAPH_CARD_HEIGHT/2;
    const forward=to.x>from.x,x2=forward?to.x:to.x+GRAPH_CARD_WIDTH,y2=forward?to.y+GRAPH_CARD_HEIGHT/2:to.y+16;
    const bend=forward?(x1+x2)/2:x1+20;
    const path='M '+x1+' '+y1+' C '+bend+' '+y1+', '+bend+' '+y2+', '+x2+' '+y2;
    return '<path data-edge-from="'+E(edge.from)+'" data-edge-to="'+E(edge.to)+'" d="'+path+'" fill="none" stroke="'+(done?'#4ade80':'#64748b')+'" stroke-width="2" marker-end="url(#graph-arrow-'+(done?'done':'pending')+')"/>';
  }).join('');
  const svg='<svg class="graph-edges" width="'+layout.width+'" height="'+layout.height+'" aria-hidden="true"><defs>'+['done','pending'].map(name=>'<marker id="graph-arrow-'+name+'" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="'+(name==='done'?'#4ade80':'#64748b')+'"/></marker>').join('')+'</defs>'+edges+'</svg>';
  const cyclic=new Set(layout.cyclic),cards=layout.nodes.map(node=>graphCard(node,team,byId,selectedId,cyclic.has(node.task.id))).join('');
  return warning+'<div id="graph-scroll" class="graph-scroll scroll" tabindex="0" aria-label="Task dependency graph" aria-describedby="graph-description"><div class="graph-canvas" style="width:'+layout.width+'px;height:'+layout.height+'px">'+svg+cards+'</div></div>'+
    '<div class="graph-legend"><span class="text-emerald-400">✓ Completed prerequisite</span><span class="text-blue-400">● In progress</span><span class="text-amber-400">○ Blocked</span><span>→ Dependency direction</span></div>'+graphDetail(team,byId,selectedId);
}
`;
