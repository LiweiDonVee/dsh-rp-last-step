import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {baseRef} from './fixtures/narrative-events.mjs';
const module=await import('../src/drafts.mjs').catch(()=>({}));

test('draft edits have optimistic versions and survive restart without changing the prior text',async t=>{
  assert.equal(typeof module.createDraftStore,'function');
  const directory=await mkdtemp(join(tmpdir(),'rpls-drafts-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await module.createDraftStore({directory});
  const first=await store.create({sessionId:'story',basedOn:baseRef(),kind:'writer',text:'Candidate one.',status:'ready'});
  const manual=await store.edit({sessionId:'story',draftId:first.id,text:'Human revision.',expectedDraftVersion:first.version});
  assert.equal(manual.version,2);assert.equal(manual.kind,'manual');assert.equal(first.text,'Candidate one.');
  await assert.rejects(store.edit({sessionId:'story',draftId:first.id,text:'Stale overwrite',expectedDraftVersion:1}),{code:'DRAFT_CONFLICT'});
  const restarted=await module.createDraftStore({directory});assert.equal((await restarted.list('story'))[0].text,'Human revision.');
  assert.deepEqual(await restarted.list('other'),[]);
  await assert.rejects(restarted.get({sessionId:'other',draftId:first.id}),{code:'DRAFT_NOT_FOUND'});
});

test('completed writer candidates expose safe actual model evidence and preserve its origin after manual edits',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'rpls-draft-model-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const store=await module.createDraftStore({directory}),first=await store.create({sessionId:'story',basedOn:baseRef(),kind:'writer',text:'',status:'generating'});
  const finished=await store.finish({sessionId:'story',draftId:first.id,expectedDraftVersion:first.version,status:'ready',text:'Current writer prose.',models:{render:{provider:'next',model:'writer-b',maxTokens:77,credential:'PRIVATE_MODEL_CANARY'}}});
  const state=JSON.parse(await readFile(join(directory,'drafts.json'),'utf8'));
  assert.deepEqual(state.drafts[first.id].at(-1).models,{render:{provider:'next',model:'writer-b',maxTokens:77}});
  assert.deepEqual(finished.models,{render:{provider:'next',model:'writer-b',maxTokens:77}});assert.equal(JSON.stringify(finished).includes('PRIVATE_MODEL_CANARY'),false);
  const manual=await store.edit({sessionId:'story',draftId:first.id,expectedDraftVersion:finished.version,text:'Human wording.'});assert.equal(manual.kind,'manual');assert.deepEqual(manual.models,finished.models);
  const restarted=await module.createDraftStore({directory});assert.equal((await restarted.list('story'))[0].text,'Human wording.');assert.deepEqual((await restarted.list('story'))[0].models,finished.models);
});
