/** Dashboard JS — interaction handlers, keyboard, polling. */
export const DASHBOARD_JS_EVENTS = `
function toggleMsg(id){if(expMsgs.has(id))expMsgs.delete(id);else expMsgs.add(id);render()}

function applyNavCollapse(){
  const content=document.getElementById('content'),projects=document.getElementById('projects'),rail=document.getElementById('project-rail'),toggle=document.getElementById('nav-toggle'),expand=document.getElementById('nav-expand');
  content.classList.toggle('nav-collapsed',navCollapsed);
  projects.hidden=navCollapsed;
  projects.setAttribute('aria-hidden',String(navCollapsed));
  rail.hidden=!navCollapsed;
  if(toggle)toggle.setAttribute('aria-expanded',String(!navCollapsed));
  expand.setAttribute('aria-expanded',String(!navCollapsed));
  if(document.activeElement===toggle&&navCollapsed)expand.focus();
  if(document.activeElement===expand&&!navCollapsed&&toggle)toggle.focus();
}

function render(){
  rSel();const t=cur();
  const empty=document.getElementById('empty'),content=document.getElementById('content');
  if(!t){empty.classList.remove('hidden');empty.classList.add('flex');content.classList.add('hidden');document.getElementById('tl').classList.add('hidden');return}
  empty.classList.add('hidden');empty.classList.remove('flex');content.classList.remove('hidden');
  applyNavCollapse();
  const p=curProject();document.getElementById('crumb').textContent=p?' / '+projectLabel(p)+' / '+t.name:'';
  rHealth(t);rSum(t);rAttention(t);rAgents(t);rTasks(t);rActivity(t);rTimeline(t);
}

function selectProject(id){selProjectId=id;const p=S?.projects?.find(p=>p.id===id);const t=(p?.teams||[]).filter(t=>t.status==='active').sort((a,b)=>b.timeUpdated-a.timeUpdated)[0]||(p?.teams||[])[0];if(t)selId=t.id;selCard=-1;render()}
function selectTeam(id){selId=id;selCard=-1;render()}

function conn(ok){
  document.getElementById('cd').className='w-[7px] h-[7px] rounded-full '+(ok?'bg-emerald-500 pulse':'bg-red-500');
  document.getElementById('ct').textContent=ok?D(Date.now()-pollT)+' ago':'reconnecting to dashboard state';
}

async function poll(){try{S=await(await fetch('api/state')).json();fails=0;pollT=Date.now();conn(true);render()}catch{if(++fails>=3)conn(false)}}

function setBackgroundInert(locked){
  document.querySelectorAll('header,main,#sum,#tl').forEach(function(el){
    el.inert=locked;
    if(locked)el.setAttribute('aria-hidden','true');
    else el.removeAttribute('aria-hidden');
  });
}

function modalOpen(){return document.getElementById('sco').classList.contains('show')||document.getElementById('drawer').classList.contains('open')}

function trapFocus(root,e){
  const nodes=[...root.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(function(el){return !el.disabled&&!el.inert&&el.offsetParent!==null});
  if(!nodes.length){e.preventDefault();root.focus();return}
  const first=nodes[0],last=nodes[nodes.length-1];
  if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();return}
  if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();return}
}

function openShortcuts(){
  const el=document.getElementById('sco');
  setBackgroundInert(true);
  el.classList.add('show');
  el.setAttribute('aria-hidden','false');
  document.getElementById('sco').focus();
}

function closeShortcuts(){
  const el=document.getElementById('sco');
  el.classList.remove('show');
  el.setAttribute('aria-hidden','true');
  if(!modalOpen())setBackgroundInert(false);
}

// Clock update every second
setInterval(function(){var t=cur();if(t)rClock(t);if(fails<3)conn(true)},1000);

// Poll every 2.5s
setInterval(poll,2500);

document.addEventListener('click',function(e){
  const id=e.target&&e.target.id;
  if(id!=='nav-toggle'&&id!=='nav-expand')return;
  navCollapsed=id==='nav-toggle';
  applyNavCollapse();
});

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  const shortcutsOpen=document.getElementById('sco').classList.contains('show');
  if(shortcutsOpen&&e.key==='Tab'){trapFocus(document.getElementById('sco'),e);return}
  if(shortcutsOpen&&e.key==='Escape'){e.preventDefault();closeShortcuts();return}
  const drawerOpen=document.getElementById('drawer').classList.contains('open');
  if(drawerOpen&&e.key==='Tab'){trapFocus(document.getElementById('drawer'),e);return}
  if(drawerOpen&&e.key==='Escape'){e.preventDefault();closeDrawer();return}
  if(drawerOpen&&e.key==='?'){e.preventDefault();return}
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  var t=cur();if(!t)return;
  var mm=[...(t.members||[])].sort((a,b)=>rankAgent(a,b,t));
  if(e.key==='?'){e.preventDefault();shortcutsOpen?closeShortcuts():openShortcuts();return}
  if(e.key==='Escape'){closeDrawer();expMsgs.clear();selCard=-1;closeShortcuts();render();return}
  if(e.key==='j'&&mm.length){e.preventDefault();selCard=Math.min(selCard+1,mm.length-1);render();return}
  if(e.key==='k'&&mm.length){e.preventDefault();selCard=Math.max(selCard-1,0);render();return}
  if(e.key==='Enter'&&selCard>=0&&selCard<mm.length){e.preventDefault();openDrawer(mm[selCard].name);return}
  if(e.key>='1'&&e.key<='9'){
    var teams=allTeams(),all=[...teams.active,...teams.archived];
    var idx=parseInt(e.key)-1;
    if(idx<all.length){selId=all[idx].id;render()}
  }
});

// Initial poll
poll();

console.log('%c Ensemble Mission Control','font-size:14px;font-weight:bold;color:#22c55e');
`;
