import test from 'node:test';
import assert from 'node:assert/strict';
import {baseEvents,baseRef,replacement,presentationId} from './fixtures/narrative-events.mjs';
const readers=await import('../src/narratives.mjs').catch(()=>({}));

test('effective narratives follow content replacements while retaining the actual original call',()=>{
  assert.equal(typeof readers.readNarratives,'function');
  const events=baseEvents();events.push(replacement(events));
  const records=readers.readNarratives('story',events);
  assert.deepEqual(records,[{id:JSON.stringify([presentationId,10]),ref:{...baseRef(),resultSeq:10},turn:1,action:'Push the gate.',text:'The closed gate resists.',createdAt:'2026-10-25T00:00:00Z'}]);
  assert.equal(events[5].data.meta.rpLastStep.record.text,'The gate stays shut.');
});

test('compaction preserves effective originals but a branch replacement removes them',()=>{
  const events=baseEvents();events.push(replacement(events));
  events.push({seq:12,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:10},sourceEventSeqs:[2,3,10],data:{source:{kind:'compact-checkpoint'}}});
  assert.equal(readers.readNarratives('story',events)[0].text,'The closed gate resists.');
  events.push({seq:13,type:'user/message',surfaceOp:{op:'replace',startSeq:12,endSeq:12},data:{source:{kind:'runtime-context'}}});
  assert.deepEqual(readers.readNarratives('story',events),[]);
});

test('forged replacement source lists, changed metadata and unrelated assistant calls are excluded',()=>{
  for(const mutate of [event=>{event.sourceEventSeqs=[4]},event=>{event.sourceEventSeqs=[3,4,5]},event=>{event.data.meta.rpLastStep.record.text='forged'},event=>{event.data.message.id='foreign'}]){
    const events=baseEvents(),changed=replacement(events);mutate(changed);events.push(changed);
    assert.deepEqual(readers.readNarratives('story',events),[]);
  }
  const events=baseEvents();events[3].data.message.content[0].id='foreign';
  assert.deepEqual(readers.readNarratives('story',events),[]);
});

test('adoption gates compare the full current ref and reject downstream factual work',()=>{
  const events=baseEvents();
  assert.equal(readers.requireLatestNarrative('story',events,baseRef()).text,'The gate stays shut.');
  events.push(replacement(events));
  assert.throws(()=>readers.requireLatestNarrative('story',events,baseRef()),{code:'NARRATIVE_CONFLICT'});
  const current={...baseRef(),resultSeq:10};
  assert.equal(readers.requireLatestNarrative('story',events,current).ref.resultSeq,10);
  events.push({seq:13,type:'assistant/message',surfaceOp:'append',data:{turn:3,step:1,message:{id:'next-facts',role:'assistant',source:{kind:'model'},content:[{type:'tool-call',name:'rp_commit_turn',id:'fact-next'}]}}},{seq:14,type:'tool/call',data:{turn:3,step:1,name:'rp_commit_turn',callId:'fact-next'}});
  assert.throws(()=>readers.requireLatestNarrative('story',events,current),{code:'DOWNSTREAM_WORK'});
});
