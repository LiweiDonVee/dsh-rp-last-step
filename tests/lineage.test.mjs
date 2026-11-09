import assert from 'node:assert/strict';
import test from 'node:test';
import {withSessionLineage} from '../src/lineage.mjs';
const event={seq:0,type:'system/message',data:{text:'public prefix'}};
function fixture(){
  const sessions=new Map([['parent',{header:{id:'parent'},events:[event],inheritedEventCount:0}],['child',{header:{id:'child'},events:[structuredClone(event),{seq:1,type:'session/end-seed',data:{inherited:true}}],inheritedEventCount:1}]]);
  let disposed=0;
  const query={observeSession:async id=>({...structuredClone(sessions.get(id)),[Symbol.dispose](){disposed++;}})};
  return{sessions,ctx:{get:name=>name==='sessionQuery'?query:undefined},disposed:()=>disposed,lineages:[{sessionId:'parent',parentSessionId:null},{sessionId:'child',parentSessionId:'parent'}]};
}
test('restored fork lineage verifies actual detached prefixes while preserving canonical headers',async()=>{
  const f=fixture(),source=f.sessions.get('child'),value=await withSessionLineage(f.ctx,source,undefined,f.lineages);
  assert.equal(value.parentSession,'parent');assert.equal(value.inheritedEventCount,1);assert.equal(value.header,source.header);assert.equal(Object.hasOwn(source.header,'parentSession'),false);assert.equal(f.disposed(),2);
  f.sessions.get('parent').events[0].data.text='changed';
  await assert.rejects(withSessionLineage(f.ctx,source,undefined,f.lineages),{code:'INVALID_ANCESTRY'});assert.equal(f.disposed(),4);
});
test('missing, duplicate and conflicting restored lineage cannot authorize inheritance',async()=>{
  const f=fixture(),source=f.sessions.get('child');
  await assert.rejects(withSessionLineage(f.ctx,source,undefined,[]),{code:'INVALID_ANCESTRY'});
  await assert.rejects(withSessionLineage(f.ctx,source,undefined,[...f.lineages,f.lineages[1]]),{code:'INVALID_ANCESTRY'});
  source.header.parentSession='other';
  await assert.rejects(withSessionLineage(f.ctx,source,undefined,f.lineages),{code:'INVALID_ANCESTRY'});
});
test('online ancestry uses the independent GM provenance result and rejects legacy conflicts',async()=>{
  const f=fixture(),source=f.sessions.get('child');
  f.ctx.get=name=>name==='rpGM'?{sessionLineage:async()=>({sessionId:'child',parentSessionId:'parent',inheritedEventCount:1})}:undefined;
  assert.equal((await withSessionLineage(f.ctx,source)).parentSession,'parent');
  source.header.parentSession='wrong';await assert.rejects(withSessionLineage(f.ctx,source),{code:'INVALID_ANCESTRY'});
});
