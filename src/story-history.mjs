import {createHash} from 'node:crypto';
import {PresetError} from './core.mjs';
import {readNarratives} from './narratives.mjs';
const id=value=>typeof value==='string'&&value.length>0;
const unavailable=()=>{throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','The current Database fact projection is required for this history',503);};
export function validFactProjection(value){
  return value?.schemaVersion===1&&(value.latestRoundId===null||id(value.latestRoundId))&&Array.isArray(value.groups)&&new Set(value.groups.map(group=>group?.roundId)).size===value.groups.length&&value.groups.every(group=>id(group?.roundId)&&(group.activeReceiptId===null||id(group.activeReceiptId))&&(group.pendingCandidateId===null||id(group.pendingCandidateId))&&(group.activeReceiptId===null?group.factRevision===null:Number.isSafeInteger(group.factRevision)&&group.factRevision>=1));
}

/** Database selects facts; only real accepted canonical results can supply a body. */
export function projectStoryHistory(sessionId,events,projection){
  const canonical=readNarratives(sessionId,events),byId=new Map(canonical.map(record=>[record.ref.presentationId,record]));
  if(projection!==undefined&&!validFactProjection(projection))unavailable();
  if(canonical.some(record=>record.narrativeVersion?.factRoundId)&&projection===undefined)unavailable();
  const groups=new Map(),db=new Map((projection?.groups??[]).map(group=>[group.roundId,group]));
  function linked(record,seen=new Set()){
    const version=record.narrativeVersion;if(version?.kind!=='writer-regeneration')return true;
    if(seen.has(record.ref.presentationId))return false;seen.add(record.ref.presentationId);
    const parent=byId.get(version.basePresentationId);
    return Boolean(parent&&parent.ref.resultSeq<record.ref.callSeq&&parent.factReceiptId===record.factReceiptId&&(parent.narrativeVersion?.groupId??parent.ref.presentationId)===version.groupId&&linked(parent,seen));
  }
  for(const record of canonical){
    let root=record,seen=new Set();
    while(!root.narrativeVersion&&!seen.has(root.ref.presentationId)){
      const metadata=events.find(event=>event.seq===root.ref.baseResultSeq)?.data?.meta?.rpLastStep?.record;
      if(!metadata?.rewriteOf||!byId.has(metadata.rewriteOf))break;
      seen.add(root.ref.presentationId);root=byId.get(metadata.rewriteOf);
    }
    const groupId=record.narrativeVersion?.groupId??root.ref.presentationId;
    if(!groups.has(groupId))groups.set(groupId,{groupId,...record.narrativeVersion?.factRoundId?{factRoundId:record.narrativeVersion.factRoundId}:{},items:[]});
    groups.get(groupId).items.push(record);
  }
  for(const group of projection?.groups??[])if(!groups.has(group.roundId))groups.set(group.roundId,{groupId:group.roundId,factRoundId:group.roundId,items:[]});
  const records=[],folded=[];
  for(const group of groups.values()){
    const state=group.factRoundId?db.get(group.factRoundId):null;
    const eligible=group.items.filter(record=>linked(record)&&(!group.factRoundId||record.factReceiptId===state?.activeReceiptId&&record.narrativeVersion?.factRevision===state?.factRevision));
    const selected=eligible.at(-1);
    if(selected)records.push(selected);
    folded.push({groupId:group.groupId,...group.factRoundId?{factRoundId:group.factRoundId}:{},activeFactReceiptId:state?.activeReceiptId??selected?.factReceiptId??null,selectedPresentationId:selected?.ref.presentationId??null,pendingFacts:Boolean(state?.pendingCandidateId),versions:group.items.map(record=>({presentationId:record.ref.presentationId,...record.factReceiptId?{factReceiptId:record.factReceiptId}:{},resultSeq:record.ref.resultSeq}))});
  }
  records.sort((a,b)=>a.ref.callSeq-b.ref.callSeq);
  const basis={selected:records.map(record=>record.ref),facts:[...db.values()].map(group=>[group.roundId,group.activeReceiptId]).sort((a,b)=>a[0].localeCompare(b[0]))};
  return{schemaVersion:1,records,folded,projectionKey:createHash('sha256').update(JSON.stringify(basis)).digest('hex')};
}
