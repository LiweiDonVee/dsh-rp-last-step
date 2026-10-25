import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,basename,dirname} from 'node:path';
const module=await import('../src/owner-state.mjs').catch(()=>({}));
async function fixture(t){const parent=await fs.mkdtemp(join(tmpdir(),'rpls-owner-')),directory=join(parent,'rp-last-step');await fs.mkdir(join(directory,'presets'),{recursive:true});await fs.mkdir(join(directory,'drafts'),{recursive:true});await fs.writeFile(join(directory,'presets','preset-store.json'),JSON.stringify({schemaVersion:1,revision:0,sources:{},profiles:{},bindings:{},marker:'old'}));await fs.writeFile(join(directory,'drafts','drafts.json'),JSON.stringify({schemaVersion:1,drafts:{},marker:'old'}));await fs.writeFile(join(directory,'unrelated-owner-data.txt'),'keep');t.after(()=>fs.rm(parent,{recursive:true,force:true}));return{directory,parent};}

test('aggregate generations are durably reserved and stable reads wait for in-flight persistence',async t=>{
  assert.equal(typeof module.createOwnerState,'function');const {directory}=await fixture(t),owner=await module.createOwnerState({directory});let release,entered;
  const hold=new Promise(done=>{release=done;}),start=new Promise(done=>{entered=done;});
  const write=owner.write(async generation=>{entered();await hold;return generation;});await start;
  const journal=JSON.parse(await fs.readFile(join(dirname(directory),`.${basename(directory)}-owner.json`),'utf8'));assert.equal(journal.revision,1);
  let read=false;const stable=owner.read(value=>{read=true;return value;});await new Promise(done=>setTimeout(done,5));assert.equal(read,false);release();assert.equal(await write,1);assert.equal(await stable,1);
  await assert.rejects(owner.write(async()=>{},0),{code:'REVISION_CONFLICT'});const restarted=await module.createOwnerState({directory});assert.equal(await restarted.read(),1);
});

for(const phase of['before-switch','between-renames','after-install'])test(`owner-local restore recovers complete data after ${phase}`,async t=>{
  const {directory}=await fixture(t);let faulted=false;
  const filesystem={...fs,rename:async(from,to)=>{
    if(!faulted&&phase==='before-switch'&&from===directory){faulted=true;throw Error('Injected before switch');}
    if(!faulted&&phase==='between-renames'&&basename(from).includes('.restore-stage-')){faulted=true;throw Error('Injected between moves');}
    await fs.rename(from,to);if(!faulted&&phase==='after-install'&&basename(from).includes('.restore-stage-')){faulted=true;throw Error('Injected after install');}
  }};
  const owner=await module.createOwnerState({directory,filesystem});
  await assert.rejects(owner.switchRoot({expectedRevision:0,build:async(stage,generation)=>{const preset=JSON.parse(await fs.readFile(join(stage,'presets','preset-store.json'),'utf8'));preset.marker='restored';await fs.writeFile(join(stage,'presets','preset-store.json'),JSON.stringify(preset));await fs.writeFile(join(stage,'drafts','drafts.json'),JSON.stringify({schemaVersion:1,drafts:{},marker:'restored'}));return{revision:generation};}}));
  assert.equal(faulted,true);const restarted=await module.createOwnerState({directory});assert.equal(await restarted.read(),1);
  const preset=JSON.parse(await fs.readFile(join(directory,'presets','preset-store.json'),'utf8')),draft=JSON.parse(await fs.readFile(join(directory,'drafts','drafts.json'),'utf8'));assert.equal(preset.marker,draft.marker);assert.equal(preset.marker,'restored');assert.equal(await fs.readFile(join(directory,'unrelated-owner-data.txt'),'utf8'),'keep');
});
