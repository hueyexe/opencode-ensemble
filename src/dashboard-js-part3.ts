/** Dashboard JS — interaction handlers, keyboard, polling. */
export const DASHBOARD_JS_PART3 = `
function toggleMsg(id){if(expMsgs.has(id))expMsgs.delete(id);else expMsgs.add(id);render()}

function render(){
  rSel();const t=cur();
  const empty=document.getElementById('empty'),content=document.getElementById('content');
  if(!t){empty.classList.remove('hidden');empty.classList.add('flex');content.classList.add('hidden');document.getElementById('tl').classList.add('hidden');return}
  empty.classList.add('hidden');empty.classList.remove('flex');content.classList.remove('hidden');
  rHealth(t);rSum(t);rAgents(t);rTasks(t);rActivity(t);rTimeline(t);
}

function conn(ok){
  document.getElementById('cd').className='w-[7px] h-[7px] rounded-full '+(ok?'bg-emerald-500 pulse':'bg-red-500');
  document.getElementById('ct').textContent=ok?D(Date.now()-pollT)+' ago':'disconnected';
}

async function poll(){try{S=await(await fetch('/api/state')).json();fails=0;pollT=Date.now();conn(true);render()}catch{if(++fails>=3)conn(false)}}

// Clock update every second
setInterval(function(){var t=cur();if(t)rClock(t);if(fails<3)conn(true)},1000);

// Poll every 2.5s
setInterval(poll,2500);

// Keyboard shortcuts
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='SELECT'||e.target.tagName==='TEXTAREA')return;
  var t=cur();if(!t)return;
  var mm=t.members||[];
  if(e.key==='?'){e.preventDefault();document.getElementById('sco').classList.toggle('show');return}
  if(e.key==='Escape'){closeDrawer();expMsgs.clear();selCard=-1;document.getElementById('sco').classList.remove('show');render();return}
  if(e.key==='j'&&mm.length){e.preventDefault();selCard=Math.min(selCard+1,mm.length-1);render();return}
  if(e.key==='k'&&mm.length){e.preventDefault();selCard=Math.max(selCard-1,0);render();return}
  if(e.key==='Enter'&&selCard>=0&&selCard<mm.length){e.preventDefault();openDrawer(mm[selCard].name);return}
  if(e.key>='1'&&e.key<='9'){
    var teams=allTeams(),all=[...teams.active,...teams.archived];
    var idx=parseInt(e.key)-1;
    if(idx<all.length){selId=all[idx].id;render()}
  }
});

// Select handler
document.getElementById('sel').addEventListener('change',function(){selId=this.value;render()});

// Initial poll
poll();

console.log('%c Ensemble Mission Control','font-size:14px;font-weight:bold;color:#22c55e');
`;
