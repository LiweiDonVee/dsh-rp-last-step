import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerFixture} from './fixtures/owner-operations.mjs';
import {baseRef} from './fixtures/narrative-events.mjs';
import {readNarratives,requireLatestNarrative} from '../src/narratives.mjs';
import {PresetError} from '../src/core.mjs';
const module=await import('../src/adoption.mjs').catch(()=>({}));
function controller(f,extra={}){assert.equal(typeof module.createOwnerOperations,'function');const operations=module.createOwnerOperations(f.ctx,{prepare:async({agent,request})=>({narrative:requireLatestNarrative('story',agent.session.snapshotEvents(),request.expectedNarrative),text:'Candidate wording.'}),complete:async()=>({sourceEventSeq:99}),...extra});operations.connect(f.registry);return operations;}

test('adoption runs in the identified maintenance turn and preserves canonical metadata and source identity',async()=>{
  const f=ownerFixture(),original=structuredClone(f.events[5]),operations=controller(f);
  const result=await operations.run({kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()}});
  assert.equal(result.result.kind,'success');assert.equal(f.events.at(-1).data.reason.kind,'blocked');assert.equal(f.calls.length,0);
  const changed=f.events.findLast(event=>event.type==='tool/result');assert.deepEqual(changed.data.meta,original.data.meta);assert.equal(changed.data.message.id,original.data.message.id);assert.deepEqual(changed.sourceEventSeqs,[4,5]);assert.equal(changed.data.message.content[0].text,'Candidate wording.');
  assert.equal(readNarratives('story',f.events)[0].text,'Candidate wording.');assert.equal(f.hookCount(),0);assert.equal(f.guards.size,0);await operations.close();assert.equal(f.commands.size,0);
});

test('competing adoptions serialize and a stale second expected ref cannot overwrite the first',async()=>{
  const f=ownerFixture(),operations=controller(f),input={kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()}};
  const results=await Promise.allSettled([operations.run(input),operations.run(input)]);
  assert.equal(results[0].value.result.kind,'success');assert.equal(results[1].reason.code,'NARRATIVE_CONFLICT');assert.equal(f.events.filter(event=>event.type==='tool/result').length,2);assert.equal(f.hookCount(),0);await operations.close();
});

test('a source changed during the final preparation cannot be replaced by an obsolete candidate',async()=>{
  const f=ownerFixture();let prepared=0;
  const operations=controller(f,{prepare:async({agent,request})=>{const narrative=requireLatestNarrative('story',agent.session.snapshotEvents(),request.expectedNarrative);if(++prepared===2)f.events.push({seq:8,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:5},data:{source:{kind:'runtime-context'}}});return{narrative,text:'Obsolete candidate.'};}});
  await assert.rejects(operations.run({kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()}}),{code:'NARRATIVE_CONFLICT'});
  assert.equal(f.events.filter(event=>event.type==='tool/result').length,1);assert.equal(f.hookCount(),0);await operations.close();
});

test('an unrelated ordinary request is not adopted or rejected by a pending owner operation',async()=>{
  const normal={id:'ordinary-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'Ordinary action'}]},f=ownerFixture({messages:[normal]}),operations=controller(f);
  await assert.rejects(operations.run({kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()}}),{code:'OWNER_REQUEST_CONFLICT'});
  assert.deepEqual(f.calls[0],[normal]);assert.equal(f.events.filter(event=>event.type==='tool/result').length,1);assert.equal(f.hookCount(),0);await operations.close();
});

test('an edit after preview propagates the structured version conflict without changing canonical content',async()=>{
  const f=ownerFixture(),operations=controller(f,{withDraftVersion:()=>{throw new PresetError('DRAFT_VERSION_CONFLICT','The previewed version changed',409);}});
  await assert.rejects(operations.run({kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef(),expectedDraftVersion:1}}),{code:'DRAFT_VERSION_CONFLICT'});
  assert.equal(f.events.filter(event=>event.type==='tool/result').length,1);assert.equal(f.hookCount(),0);await operations.close();
});

test('retry installs a turn-scoped monotonic guard for the selected rewrite only and stops a second dispatch',async()=>{
  const outcomes=[],f=ownerFixture({secondStep:true,dispatch:async({agent,guards})=>{
    const check=(name,args)=>[...guards].map(guard=>guard({agent,name,arguments:args,callId:'call',rootCallId:'call'})).find(Boolean);
    outcomes.push(check('rp_commit_turn',{}),check('rp_present',{rewriteOf:'other'}),check('rp_present',{rewriteOf:'failed',packet:{}}),check('rp_present',{rewriteOf:'failed'}));
  }}),operations=controller(f,{prepare:async()=>({})});
  const result=await operations.run({kind:'retry',sessionId:'story',request:{presentationId:'failed'}});
  assert.equal(result.result.kind,'success');assert.equal(outcomes.slice(0,3).every(Boolean),true);assert.equal(outcomes[3],undefined);assert.equal(f.calls.length,1);assert.equal(f.guards.size,0);assert.equal(f.hookCount(),0);await operations.close();
});

test('retry without an accepted result reports a clear failure and disposes its scoped guard',async()=>{
  const f=ownerFixture(),operations=controller(f,{prepare:async()=>({}),complete:async()=>{throw new PresetError('RETRY_DISPATCH_FAILED','No accepted retry was produced',409);}});
  const result=await operations.run({kind:'retry',sessionId:'story',request:{presentationId:'failed'}});
  assert.equal(result.result.kind,'error');assert.match(result.result.text,/No accepted retry/u);assert.equal(f.calls.length,1);assert.equal(f.guards.size,0);assert.equal(f.hookCount(),0);await operations.close();
});

test('cancelling before owner pre-step changes no prose and releases every listener',async()=>{
  let release;const hold=new Promise(done=>{release=done;}),f=ownerFixture({beforeStep:()=>hold}),operations=controller(f),abort=new AbortController();
  const pending=operations.run({kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()},signal:abort.signal});
  await new Promise(resolve=>setTimeout(resolve,5));abort.abort();release();await pending.catch(()=>{});await operations.close();
  assert.equal(f.events.filter(event=>event.type==='tool/result').length,1);assert.equal(f.calls.length,0);assert.equal(f.hookCount(),0);assert.equal(f.guards.size,0);
});

for(const cancellation of ['request','turn','unload'])test(`cancelling ${cancellation} during the final draft gate cannot adopt and leaves subsequent operations usable`,async()=>{
  let release,entered;const hold=new Promise(done=>{release=done;}),started=new Promise(done=>{entered=done;}),f=ownerFixture(),abort=new AbortController();
  const operations=controller(f,{withDraftVersion:async(_input,work)=>{entered();await hold;return work();}});
  const input={kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()},signal:abort.signal},pending=operations.run(input);
  const rejected=assert.rejects(pending,{name:'AbortError'});await started;
  let closing;
  if(cancellation==='request')abort.abort();else if(cancellation==='turn')f.agent.cancel({kind:'user'});else closing=operations.close();
  release();await rejected;await closing;await f.agent.whenIdle();
  assert.equal(f.events.filter(event=>event.type==='tool/result').length,1);assert.equal(readNarratives('story',f.events)[0].text,'The gate stays shut.');
  assert.equal(f.events.at(-1).data.reason.kind,'aborted');assert.equal(f.calls.length,0);assert.equal(f.hookCount(),0);assert.equal(f.guards.size,0);
  const next=cancellation==='unload'?controller(f):operations,result=await next.run({...input,signal:undefined});
  assert.equal(result.result.kind,'success');assert.equal(readNarratives('story',f.events)[0].text,'Candidate wording.');
  assert.equal(f.hookCount(),0);assert.equal(f.guards.size,0);await next.close();
});

test('unload waits for a cancelled command handler even when its caller already received abort',async()=>{
  let release;const hold=new Promise(done=>{release=done;}),f=ownerFixture({beforeStep:()=>hold}),operations=controller(f),invoke=f.ctx.typertGateway.invoke;
  f.ctx.typertGateway.invoke=request=>Promise.race([invoke(request),new Promise((_resolve,reject)=>request.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}))]);
  const pending=operations.run({kind:'adopt',sessionId:'story',request:{expectedNarrative:baseRef()}});pending.catch(()=>{});await new Promise(resolve=>setTimeout(resolve,5));
  let closed=false;const closing=operations.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,5));const early=closed;
  release();await closing;await f.agent.whenIdle();assert.equal(early,false);assert.equal(f.hookCount(),0);assert.equal(f.guards.size,0);
});
