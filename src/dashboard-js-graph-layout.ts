/** Dashboard JS — deterministic task dependency layout, shared with graph rendering. */
export const DASHBOARD_JS_GRAPH_LAYOUT = `
const GRAPH_CARD_WIDTH=280,GRAPH_CARD_HEIGHT=172,GRAPH_GAP_X=88,GRAPH_GAP_Y=32,GRAPH_PADDING=24;
function graphDependencies(task){return [...new Set(Array.isArray(task.dependsOn)?task.dependsOn:[])]}
function graphLayout(tasks){
  const byId=new Map(tasks.map(task=>[task.id,task])),edges=[],missing=[];
  const degree=new Map(),children=new Map(),depth=new Map();
  tasks.forEach(task=>{degree.set(task.id,0);children.set(task.id,[]);depth.set(task.id,0)});
  tasks.forEach(task=>{
    graphDependencies(task).forEach(id=>{
      if(!byId.has(id)){missing.push({taskId:task.id,dependencyId:id});return}
      edges.push({from:id,to:task.id});
      degree.set(task.id,degree.get(task.id)+1);
      children.get(id).push(task.id);
    });
  });
  const queue=tasks.filter(task=>degree.get(task.id)===0).map(task=>task.id);
  let head=0;
  while(head<queue.length){
    const id=queue[head++];
    children.get(id).forEach(child=>{
      depth.set(child,Math.max(depth.get(child),depth.get(id)+1));
      degree.set(child,degree.get(child)-1);
      if(degree.get(child)===0)queue.push(child);
    });
  }
  const cyclic=tasks.filter(task=>degree.get(task.id)>0).map(task=>task.id);
  const fallback=queue.reduce((max,id)=>Math.max(max,depth.get(id)+1),0);
  cyclic.forEach(id=>depth.set(id,fallback));
  const rows=new Map();
  const nodes=tasks.map(task=>{
    const column=depth.get(task.id),row=rows.get(column)||0;
    rows.set(column,row+1);
    return {task,x:GRAPH_PADDING+column*(GRAPH_CARD_WIDTH+GRAPH_GAP_X),y:GRAPH_PADDING+row*(GRAPH_CARD_HEIGHT+GRAPH_GAP_Y)};
  });
  const width=nodes.reduce((max,node)=>Math.max(max,node.x+GRAPH_CARD_WIDTH+GRAPH_PADDING),GRAPH_CARD_WIDTH+2*GRAPH_PADDING);
  const height=nodes.reduce((max,node)=>Math.max(max,node.y+GRAPH_CARD_HEIGHT+GRAPH_PADDING),GRAPH_CARD_HEIGHT+2*GRAPH_PADDING);
  return {nodes,edges,missing,cyclic,width,height};
}
`;
