import test from 'node:test';
import assert from 'node:assert/strict';
import {baseEvents,presentationId} from './fixtures/narrative-events.mjs';
import {readNarratives} from '../src/narratives.mjs';
const module=await import('../src/story-history.mjs').catch(()=>({}));
const version=(revision,kind='original',basePresentationId)=>({schemaVersion:1,groupId:'round',kind,factRoundId:'round',factRevision:revision,...basePresentationId?{basePresentationId}:{}});
function original(){const events=baseEvents();Object.assign(events[5].data.meta.rpLastStep.record,{factReceiptId:'fact-1',narrativeVersion:version(1)});return events;}
function append(events,options={}){
  const{id='prose-2',narrativeVersion=version(1,'writer-regeneration',presentationId),text='New wording.'}=options,factReceiptId=Object.hasOwn(options,'factReceiptId')?options.factReceiptId:'fact-1';
  const seq=events.at(-1).seq+1,turn=seq,callId='call-'+seq,assistantMessageId='assistant-'+seq;
  events.push({seq,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:assistantMessageId,role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:callId,name:'rp_present',arguments:'{}'}]}}},{seq:seq+1,type:'tool/call',data:{turn,step:1,callId,name:'rp_present'}},{seq:seq+2,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[seq+1],data:{turn,step:1,message:{id:'result-'+seq,role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:false,content:[{type:'text',text}]},meta:{rpLastStep:{schemaVersion:1,record:{id,status:'complete',text,...factReceiptId?{factReceiptId}:{},narrativeVersion}}}}});
}
const projection=(activeReceiptId='fact-1',factRevision=1,pendingCandidateId=null)=>({schemaVersion:1,latestRoundId:'round',groups:[{roundId:'round',source:{sessionId:'story'},activeReceiptId,factRevision,pendingCandidateId}]});
function history(events,p){assert.equal(typeof module.projectStoryHistory,'function');return module.projectStoryHistory('story',events,p);}

test('effective history selects only the current fact receipt while retaining every canonical prose version',()=>{
  const events=original();append(events);const h=history(events,projection());
  assert.equal(h.records.length,1);assert.equal(h.records[0].text,'New wording.');
  assert.equal(readNarratives('story',events).length,2);
  assert.deepEqual(h.folded[0],{groupId:'round',factRoundId:'round',activeFactReceiptId:'fact-1',selectedPresentationId:'prose-2',pendingFacts:false,versions:[{presentationId,factReceiptId:'fact-1',resultSeq:5},{presentationId:'prose-2',factReceiptId:'fact-1',resultSeq:9}]});
  assert.match(h.projectionKey,/^[a-f0-9]{64}$/u);
  const current=history(events,projection('fact-2',2));
  assert.deepEqual(current.records,[]);assert.equal(current.folded[0].selectedPresentationId,null);assert.notEqual(current.projectionKey,h.projectionKey);
  append(events,{id:'prose-3',factReceiptId:'fact-2',narrativeVersion:version(2),text:'New facts, new prose.'});
  assert.equal(history(events,projection('fact-2',2)).records[0].text,'New facts, new prose.');
});

test('pending facts retain current prose and expose pending status; unpresented approved rounds have no body',()=>{
  const events=original(),pending=history(events,projection('fact-1',1,'candidate-2'));
  assert.equal(pending.records[0].text,'The gate stays shut.');assert.equal(pending.folded[0].pendingFacts,true);
  const h=history([],projection('fact-2',2));assert.deepEqual(h.records,[]);assert.equal(h.folded[0].activeFactReceiptId,'fact-2');
});

test('new fact histories require Database projection; legacy packet writer families remain independent',()=>{
  assert.throws(()=>history(original()),{code:'EFFECTIVE_HISTORY_UNAVAILABLE'});
  const events=baseEvents();append(events,{factReceiptId:undefined,narrativeVersion:{schemaVersion:1,groupId:presentationId,kind:'writer-regeneration',basePresentationId:presentationId}});
  const h=history(events);assert.equal(h.records.length,1);assert.equal(h.records[0].text,'New wording.');assert.equal(h.folded[0].versions.length,2);
  assert.equal(history(events).projectionKey,h.projectionKey);
});

test('prefix and compaction use actual result sources rather than presentation IDs alone',()=>{
  const events=original();append(events);const before=history(events.slice(0,7),projection());
  assert.equal(before.records[0].ref.presentationId,presentationId);
  events.push({seq:10,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:9},sourceEventSeqs:[2,3,5,7,9],data:{source:{kind:'compact-checkpoint'}}});
  assert.equal(history(events,projection()).records[0].ref.presentationId,'prose-2');
  events.push({seq:11,type:'user/message',surfaceOp:{op:'replace',startSeq:10,endSeq:10},data:{source:{kind:'runtime-context'}}});
  assert.deepEqual(history(events,projection()).records,[]);
});

test('a writer revision with a causally removed canonical parent remains audit-only',()=>{
  const events=baseEvents();append(events,{factReceiptId:undefined,narrativeVersion:{schemaVersion:1,groupId:presentationId,kind:'writer-regeneration',basePresentationId:presentationId}});
  events.push({seq:10,type:'user/message',surfaceOp:{op:'replace',startSeq:3,endSeq:5},data:{source:{kind:'runtime-context'}}});
  assert.equal(readNarratives('story',events).length,1);const h=history(events);assert.deepEqual(h.records,[]);assert.equal(h.folded[0].versions.length,1);assert.equal(h.folded[0].selectedPresentationId,null);
});
