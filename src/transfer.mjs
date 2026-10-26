import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {PresetError,validateProfile,applyAgentOperations} from './core.mjs';
import {normalizeDirectionPacket} from './presenter.mjs';
import {resolveModelConfig} from './models.mjs';
import {publicStorySnapshot} from './receipts.mjs';
import {readNarratives,sameNarrativeRef,validNarrativeRef} from './narratives.mjs';
import {validNarrativeVersion,validOwnerOperation} from './versions.mjs';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value),id=value=>typeof value==='string'&&value.length>0&&value.length<=256,uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const statuses=new Set(['prepared','assembling','rendering','rendered','complete','failed','cancelled']);
const put=(target,key,value)=>Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});
const get=(target,key)=>Object.hasOwn(target,key)?target[key]:undefined;
const ordered=value=>Array.isArray(value)?value.map(ordered):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const stateFingerprint=(sessionIds,state)=>createHash('sha256').update(JSON.stringify(ordered({sessionIds:[...sessionIds].sort(),schemaVersion:state.schemaVersion,payload:state.payload}))).digest('hex');
const invalid=()=>{throw new PresetError('RESTORE_PAYLOAD_INVALID','The saved LastStep state or canonical reference is invalid',409);};
const requireValue=value=>{if(!value)invalid();};
async function json(path,fallback){try{return JSON.parse(await readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return structuredClone(fallback);throw new PresetError('RESTORE_PAYLOAD_INVALID','Stored LastStep data could not be read',409);}}
export async function readOwnedState(directory){
  const presets=await json(join(directory,'presets','preset-store.json'),{schemaVersion:1,revision:0,sources:{},profiles:{},bindings:{}}),drafts=await json(join(directory,'drafts','drafts.json'),{schemaVersion:1,drafts:{}}),transfers=await json(join(directory,'transfer-state.json'),{schemaVersion:1,jobs:{}}),receipts={};
  let files=[];try{files=await readdir(join(directory,'presentations','receipts'));}catch(error){if(error.code!=='ENOENT')throw error;}
  for(const file of files)if(file.endsWith('.json')&&uuid.test(file.slice(0,-5))){const value=await json(join(directory,'presentations','receipts',file),null);requireValue(value?.id===file.slice(0,-5));put(receipts,value.id,value);}
  requireValue(presets.schemaVersion===1&&object(presets.sources)&&object(presets.profiles)&&object(presets.bindings)&&drafts.schemaVersion===1&&object(drafts.drafts)&&transfers.schemaVersion===1&&object(transfers.jobs));
  return{presets,drafts,receipts,transfers};
}
function identity(sessionIds,state){
  requireValue(Array.isArray(sessionIds)&&sessionIds.length>0&&sessionIds.every(id)&&new Set(sessionIds).size===sessionIds.length);
  const payload=state?.payload;requireValue(state?.schemaVersion===1&&Number.isSafeInteger(state.revision)&&state.revision>=0&&object(payload)&&Array.isArray(payload.sessionIds)&&isDeepStrictEqual([...payload.sessionIds].sort(),[...sessionIds].sort()));return payload;
}
function sourceIn(receipt,snapshot){
  let tuple;try{tuple=JSON.parse(receipt.contextKey);}catch{return false;}
  if(!Array.isArray(tuple)||tuple.length!==3||tuple[0]!==receipt.sessionId)return false;
  const assistant=snapshot.events.find(event=>event.type==='assistant/message'&&event.data?.message?.id===tuple[1]&&event.data.message.source?.kind==='model');
  if(!assistant?.data.message.content?.some(block=>block.type==='tool-call'&&block.name==='rp_present'&&block.id===tuple[2]))return false;
  return snapshot.events.some(event=>event.type==='tool/call'&&event.seq>assistant.seq&&event.data?.name==='rp_present'&&event.data.callId===tuple[2]&&event.data.turn===assistant.data.turn&&event.data.step===assistant.data.step);
}
function descended(snapshot,ancestor,sessions){
  const seen=new Set();while(snapshot?.header.parentSession){if(seen.has(snapshot.header.id))return false;seen.add(snapshot.header.id);const parent=sessions.get(snapshot.header.parentSession),count=snapshot.inheritedEventCount;if(!parent||!Number.isSafeInteger(count)||count<0||count>parent.events.length||count>snapshot.events.length||!isDeepStrictEqual(snapshot.events.slice(0,count),parent.events.slice(0,count)))return false;if(parent.header.id===ancestor)return true;snapshot=parent;}return false;
}
export function selectState(raw,sessionIds,sessions,additionalProfileRefs=[]){
  const receipts=new Map(),profiles=new Map(),sources=new Map(),bindings={},drafts={};
  for(const sessionId of sessionIds){
    const snapshot=sessions.get(sessionId);if(!snapshot||!Number.isSafeInteger(snapshot.inheritedEventCount)||snapshot.inheritedEventCount<0)throw new PresetError('EXPORT_SOURCE_METADATA_MISSING','Authoritative Session seed metadata is required',409);
    if(Object.hasOwn(raw.presets.bindings,sessionId))put(bindings,sessionId,structuredClone(raw.presets.bindings[sessionId]));
    for(const receipt of Object.values(raw.receipts))if(receipt.sessionId===sessionId&&sourceIn(receipt,snapshot))receipts.set(receipt.id,receipt);
    for(const event of snapshot.events){const record=event.type==='tool/result'&&event.data?.meta?.rpLastStep?.record;if(record?.status==='complete'&&typeof record.id==='string'&&readNarratives(sessionId,snapshot.events.filter(item=>item.seq<=event.seq)).some(item=>item.ref.presentationId===record.id)){
      const receipt=raw.receipts[record.id];if(!receipt)throw new PresetError('RESTORE_REQUIREMENT_MISSING','A required original presentation receipt is unavailable',409);receipts.set(receipt.id,receipt);
    }}
    for(const [draftId,versions] of Object.entries(raw.drafts.drafts))if(versions.at(-1)?.sessionId===sessionId){put(drafts,draftId,structuredClone(versions));for(const draft of versions){const receipt=raw.receipts[draft.basedOn?.presentationId];if(!receipt)throw new PresetError('RESTORE_REQUIREMENT_MISSING','A candidate requires its original frozen receipt',409);receipts.set(receipt.id,receipt);}}
  }
  const addProfile=(profileId,version,code='RESTORE_REQUIREMENT_MISSING')=>{const key=JSON.stringify([profileId,version]),profile=get(raw.presets.profiles,profileId)?.find(item=>item.version===version);if(!profile)throw new PresetError(code,`A pinned LastStep profile version is unavailable: ${key}`,409);profiles.set(key,profile);if(profile.sourceId!==null){const source=get(raw.presets.sources,profile.sourceId);if(!source)throw new PresetError(code,`An immutable preset source is unavailable for profile: ${key}`,409);sources.set(source.id,source);}};
  for(const binding of Object.values(bindings))addProfile(binding.profileId,binding.version);for(const receipt of receipts.values()){addProfile(receipt.profileId,receipt.profileVersion);for(const parentId of [receipt.rewriteOf,receipt.regenerateOf,receipt.narrativeVersion?.basePresentationId].filter(Boolean))if(!receipts.has(parentId)){const original=raw.receipts[parentId];if(!original)throw new PresetError('RESTORE_REQUIREMENT_MISSING','A writer revision requires its original frozen receipt',409);receipts.set(original.id,original);}}
  for(const receipt of receipts.values())addProfile(receipt.profileId,receipt.profileVersion);
  for(const ref of additionalProfileRefs)addProfile(ref.profileId,ref.version,'EXPORT_REQUIREMENT_MISSING');
  return structuredClone({sessionIds:[...sessionIds],sources:[...sources.values()],profiles:[...profiles.values()],bindings,receipts:[...receipts.values()],drafts});
}
function validate(payload,raw,sessionIds){
  requireValue(Array.isArray(payload.sources)&&Array.isArray(payload.profiles)&&object(payload.bindings)&&Array.isArray(payload.receipts)&&object(payload.drafts)&&Object.keys(payload).every(key=>['sessionIds','sources','profiles','bindings','receipts','drafts'].includes(key)));
  const sources=new Map(),profiles=new Map(),receipts=new Map();
  for(const source of payload.sources){requireValue(object(source)&&id(source.id)&&typeof source.format==='string'&&typeof source.sha256==='string'&&(typeof source.rawText==='string')!==(typeof source.dataBase64==='string'));const bytes=source.rawText!==undefined?Buffer.from(source.rawText,'utf8'):Buffer.from(source.dataBase64,'base64');requireValue(createHash('sha256').update(bytes).digest('hex')===source.sha256);requireValue(!sources.has(source.id));sources.set(source.id,source);}
  for(const input of payload.profiles){const profile=validateProfile(input),key=JSON.stringify([profile.id,profile.version]);requireValue(!profiles.has(key));profiles.set(key,profile);if(profile.sourceId!==null&&!sources.has(profile.sourceId)&&!Object.hasOwn(raw.presets.sources,profile.sourceId))throw new PresetError('RESTORE_REQUIREMENT_MISSING','The profile source dependency is missing',409);}
  const getProfile=(profileId,version)=>profiles.get(JSON.stringify([profileId,version]))??get(raw.presets.profiles,profileId)?.find(item=>item.version===version);
  for(const [sessionId,binding] of Object.entries(payload.bindings)){requireValue(sessionIds.includes(sessionId)&&object(binding));const profile=getProfile(binding.profileId,binding.version);if(!profile)throw new PresetError('RESTORE_REQUIREMENT_MISSING','The story profile dependency is missing',409);requireValue(profile.status==='ready');applyAgentOperations(profile,binding.overlay,[]);}
  for(const receipt of payload.receipts){requireValue(object(receipt)&&uuid.test(receipt.id)&&!receipts.has(receipt.id)&&id(receipt.sessionId)&&typeof receipt.contextKey==='string'&&statuses.has(receipt.status)&&typeof receipt.text==='string'&&typeof receipt.createdAt==='string');normalizeDirectionPacket(receipt.packet);const profile=getProfile(receipt.profileId,receipt.profileVersion);if(!profile)throw new PresetError('RESTORE_REQUIREMENT_MISSING','A presentation profile dependency is missing',409);requireValue(isDeepStrictEqual(profile,validateProfile(receipt.profile)));applyAgentOperations(profile,receipt.overlay,[]);for(const model of Object.values(receipt.models??{}))requireValue(isDeepStrictEqual(model,resolveModelConfig(model)));if(receipt.storySnapshot!==undefined)requireValue(isDeepStrictEqual(receipt.storySnapshot,publicStorySnapshot(receipt.storySnapshot)));if(receipt.compiled!==undefined)requireValue(Array.isArray(receipt.compiled.messages)&&receipt.compiled.messages.every(message=>['system','user','assistant'].includes(message.role)&&typeof message.content==='string'));receipts.set(receipt.id,receipt);}
  for(const receipt of payload.receipts){let current=receipt;const seen=new Set();while(current.rewriteOf){requireValue(!seen.has(current.id));seen.add(current.id);const parent=receipts.get(current.rewriteOf)??get(raw.receipts,current.rewriteOf);if(!parent)throw new PresetError('RESTORE_REQUIREMENT_MISSING','The failed retry ancestor is missing',409);requireValue(parent.sessionId===receipt.sessionId&&['failed','cancelled'].includes(parent.status));current=parent;}}
  for(const receipt of payload.receipts){
    if(receipt.narrativeVersion!==undefined)requireValue(validNarrativeVersion(receipt.narrativeVersion));
    if(receipt.ownerOperation!==undefined)requireValue(validOwnerOperation(receipt.ownerOperation));
    if(receipt.instruction!==undefined)requireValue(typeof receipt.instruction==='string');
    if(receipt.regenerateOf!==undefined)requireValue(uuid.test(receipt.regenerateOf)&&receipt.narrativeVersion?.kind==='writer-regeneration'&&receipt.narrativeVersion.basePresentationId===receipt.regenerateOf);
    if(receipt.narrativeVersion?.factRoundId)requireValue(id(receipt.factReceiptId));
    if(receipt.narrativeVersion?.kind==='writer-regeneration'){
      const parent=receipts.get(receipt.narrativeVersion.basePresentationId)??get(raw.receipts,receipt.narrativeVersion.basePresentationId);
      if(!parent)throw new PresetError('RESTORE_REQUIREMENT_MISSING','The canonical writer ancestor is missing',409);
      requireValue(['rendered','complete'].includes(parent.status)&&parent.factReceiptId===receipt.factReceiptId&&(parent.narrativeVersion?.groupId??parent.id)===receipt.narrativeVersion.groupId);
      for(const key of ['packet','profile','overlay','compiled','recentProse','contextPreparation','storySnapshot'])requireValue(isDeepStrictEqual(parent[key],receipt[key]));
    }
    const projection=receipt.contextPreparation?.historyProjection;
    if(projection!==undefined)requireValue(object(projection)&&Object.keys(projection).length===4&&projection.schemaVersion===1&&id(projection.projectionKey)&&['selectedPresentationIds','activeFactReceiptIds'].every(key=>Array.isArray(projection[key])&&projection[key].every(id)&&new Set(projection[key]).size===projection[key].length));
  }
  for(const [draftId,versions] of Object.entries(payload.drafts)){requireValue(id(draftId)&&Array.isArray(versions)&&versions.length>0);let previous=0;for(const draft of versions){requireValue(draft.id===draftId&&sessionIds.includes(draft.sessionId)&&Number.isSafeInteger(draft.version)&&draft.version>previous&&validNarrativeRef(draft.basedOn)&&draft.basedOn.sessionId===draft.sessionId&&['writer','manual'].includes(draft.kind)&&['draft','generating','ready','failed'].includes(draft.status)&&typeof draft.text==='string');previous=draft.version;if(!receipts.has(draft.basedOn.presentationId)&&!raw.receipts[draft.basedOn.presentationId])throw new PresetError('RESTORE_REQUIREMENT_MISSING','The candidate frozen presentation is missing',409);if(draft.models)requireValue(isDeepStrictEqual(draft.models,{render:resolveModelConfig(draft.models.render)}));}}
}
export function preflightState(raw,sessionIds,state){
  const conflicts=[],requirements=[];
  try{
    const payload=identity(sessionIds,state);validate(payload,raw,sessionIds);
    const compare=(existing,incoming,identifier)=>{if(existing!==undefined&&!isDeepStrictEqual(existing,incoming))conflicts.push({code:'RESTORE_CONTENT_CONFLICT',id:identifier});};
    for(const source of payload.sources)compare(Object.hasOwn(raw.presets.sources,source.id)?raw.presets.sources[source.id]:undefined,source,source.id);
    for(const profile of payload.profiles)compare(get(raw.presets.profiles,profile.id)?.find(item=>item.version===profile.version),profile,JSON.stringify([profile.id,profile.version]));
    for(const [sessionId,binding] of Object.entries(payload.bindings))compare(Object.hasOwn(raw.presets.bindings,sessionId)?raw.presets.bindings[sessionId]:undefined,binding,sessionId);
    for(const receipt of payload.receipts)compare(raw.receipts[receipt.id],receipt,receipt.id);
    for(const [draftId,versions] of Object.entries(payload.drafts))compare(get(raw.drafts.drafts,draftId),versions,draftId);
  }catch(error){const code=error.code==='RESTORE_REQUIREMENT_MISSING'?error.code:'RESTORE_PAYLOAD_INVALID';conflicts.push({code,id:'state'});if(code==='RESTORE_REQUIREMENT_MISSING')requirements.push('required LastStep source/profile/receipt dependency');}
  return{supported:conflicts.length===0,conflicts,requirements};
}
export function validateCanonicalState(payload,sessions){
  for(const receipt of payload.receipts){
    const candidates=[...sessions.values()].filter(snapshot=>snapshot.header.id===receipt.sessionId||descended(snapshot,receipt.sessionId,sessions));
    if(!candidates.length)throw new PresetError('RESTORE_REQUIREMENT_MISSING','The original receipt Session or inherited ancestry is missing',409);
    requireValue(candidates.some(snapshot=>sourceIn(receipt,snapshot)));
    const accepted=candidates.flatMap(snapshot=>snapshot.events.filter(event=>{
      const envelope=event.type==='tool/result'&&event.data?.meta?.rpLastStep,record=envelope?.record;
      return envelope?.schemaVersion===1&&record?.id===receipt.id&&record.status==='complete'&&readNarratives(snapshot.header.id,snapshot.events.filter(item=>item.seq<=event.seq)).some(narrative=>narrative.ref.presentationId===receipt.id&&narrative.ref.baseResultSeq===event.seq);
    }));
    // Accepted history is authoritative even when the imported status denies success.
    // A rendered receipt may legitimately lag canonical completion bookkeeping.
    if(accepted.length){
      requireValue(['rendered','complete'].includes(receipt.status));
      requireValue(accepted.some(event=>{const record=event.data.meta.rpLastStep.record;return record.text===receipt.text&&record.factReceiptId===receipt.factReceiptId&&record.rewriteOf===receipt.rewriteOf&&record.regenerateOf===receipt.regenerateOf&&isDeepStrictEqual(record.narrativeVersion,receipt.narrativeVersion)&&isDeepStrictEqual(record.ownerOperation,receipt.ownerOperation);}));
    }else requireValue(receipt.status!=='complete');
  }
  for(const receipt of payload.receipts)if(receipt.narrativeVersion?.kind==='writer-regeneration')requireValue([...sessions.values()].some(snapshot=>readNarratives(snapshot.header.id,snapshot.events).some(record=>record.ref.presentationId===receipt.narrativeVersion.basePresentationId)));
  for(const versions of Object.values(payload.drafts))for(const draft of versions){const snapshot=sessions.get(draft.sessionId);requireValue(snapshot&&readNarratives(draft.sessionId,snapshot.events.filter(event=>event.seq<=draft.basedOn.resultSeq)).some(record=>sameNarrativeRef(record.ref,draft.basedOn)));}
}
export async function mergeState(directory,raw,state,{restoreId,sessionIds,generation,hash}){
  const payload=state.payload,presets=structuredClone(raw.presets),before=structuredClone(raw.presets),drafts=structuredClone(raw.drafts),jobs=structuredClone(raw.transfers);
  for(const source of payload.sources)put(presets.sources,source.id,source);
  for(const profile of payload.profiles){const versions=Object.hasOwn(presets.profiles,profile.id)?presets.profiles[profile.id]:[];if(!versions.some(item=>item.version===profile.version))put(presets.profiles,profile.id,[...versions,profile].sort((a,b)=>a.version-b.version));}
  for(const [sessionId,binding] of Object.entries(payload.bindings))put(presets.bindings,sessionId,binding);
  if(!isDeepStrictEqual(presets,before))presets.revision++;
  for(const [draftId,versions] of Object.entries(payload.drafts))put(drafts.drafts,draftId,versions);
  await mkdir(join(directory,'presets'),{recursive:true});await mkdir(join(directory,'drafts'),{recursive:true});await mkdir(join(directory,'presentations','receipts'),{recursive:true});await mkdir(join(directory,'presentations','sessions'),{recursive:true});
  await writeFile(join(directory,'presets','preset-store.json'),JSON.stringify(presets)+'\n');await writeFile(join(directory,'drafts','drafts.json'),JSON.stringify(drafts)+'\n');
  const grouped=new Map();
  for(const receipt of payload.receipts){await writeFile(join(directory,'presentations','receipts',`${receipt.id}.json`),JSON.stringify(receipt)+'\n');const list=grouped.get(receipt.sessionId)??[];list.push(receipt);grouped.set(receipt.sessionId,list);}
  for(const [sessionId,receipts] of grouped){const file=join(directory,'presentations','sessions',createHash('sha256').update(sessionId).digest('hex')+'.json'),ids=await json(file,[]);for(const receipt of receipts.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)))if(!ids.includes(receipt.id))ids.push(receipt.id);await writeFile(file,JSON.stringify(ids)+'\n');}
  const result={revision:generation,restoredSessionIds:[...sessionIds]};put(jobs.jobs,restoreId,{hash,result});await writeFile(join(directory,'transfer-state.json'),JSON.stringify(jobs)+'\n');return result;
}
