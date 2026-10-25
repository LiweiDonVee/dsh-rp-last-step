import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
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
