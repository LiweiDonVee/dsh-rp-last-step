import {isDeepStrictEqual} from 'node:util';
import {PresetError} from './core.mjs';

const refFields=['sessionId','presentationId','assistantMessageId','callSeq','baseResultSeq','resultSeq'];
const textOf=message=>(message?.content??[]).filter(block=>block.type==='text'&&typeof block.text==='string').map(block=>block.text).join('\n');
export const sameNarrativeRef=(left,right)=>Boolean(left&&right&&refFields.every(key=>left[key]===right[key]));
export const validNarrativeRef=value=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===refFields.length&&refFields.every(key=>key.endsWith('Seq')?Number.isSafeInteger(value[key])&&value[key]>=0:typeof value[key]==='string'&&value[key].length>0));

function surface(events){
  const nodes=[],coverage=new Map();
  for(const event of events){
    if(event.surfaceOp==='append'){nodes.push(event.seq);coverage.set(event.seq,[event.seq]);continue;}
    if(event.surfaceOp?.op!=='replace')continue;
    const start=nodes.indexOf(event.surfaceOp.startSeq),end=nodes.indexOf(event.surfaceOp.endSeq);
    if(start<0||end<start)continue;
    const originals=event.type==='user/message'&&event.data?.source?.kind==='compact-checkpoint'?nodes.slice(start,end+1).flatMap(seq=>coverage.get(seq)??[seq]):[];
    coverage.set(event.seq,[...originals,event.seq]);nodes.splice(start,end-start+1,event.seq);
  }
  return new Set(nodes.flatMap(seq=>coverage.get(seq)??[seq]));
}
function sameResultData(left,right){
  const clean=value=>({...value,message:{...value?.message,content:[]}});
  return isDeepStrictEqual(clean(left),clean(right));
}
function modelMessageFor(events,call){
  return events.findLast(event=>event.seq<call.seq&&event.type==='assistant/message'&&event.data?.turn===call.data?.turn&&event.data?.step===call.data?.step);
}

/** Canonical result projection, including content-only revisions and compacted originals. */
export function readNarratives(sessionId,input){
  const events=[...input].sort((a,b)=>a.seq-b.seq),bySeq=new Map(events.map(event=>[event.seq,event])),active=surface(events),cache=new Map();
  function resolve(event,seen=new Set()){
    if(cache.has(event?.seq))return cache.get(event.seq);
    if(!event||seen.has(event.seq)||event.type!=='tool/result')return null;
    seen.add(event.seq);
    const data=event.data,message=data?.message,envelope=data?.meta?.rpLastStep,record=envelope?.record;
    if(message?.role!=='tool'||message.source?.kind!=='tool'||message.isError===true||message.toolCallId!==message.source.callId||envelope?.schemaVersion!==1||record?.status!=='complete'||typeof record.id!=='string'||!textOf(message).trim())return null;
    const sources=event.sourceEventSeqs;
    if(!Array.isArray(sources)||new Set(sources).size!==sources.length||sources.some(seq=>!Number.isSafeInteger(seq)||seq>=event.seq))return null;
    let result;
    if(event.surfaceOp==='append'){
      if(sources.length!==1)return null;
      const call=bySeq.get(sources[0]),assistant=call&&modelMessageFor(events,call),model=assistant?.data?.message;
      if(call?.type!=='tool/call'||call.data?.name!=='rp_present'||call.data.callId!==message.source.callId||call.data.turn!==data.turn||call.data.step!==data.step||!active.has(assistant?.seq)||model?.source?.kind!=='model'||typeof model.id!=='string'||!model.content?.some(block=>block.type==='tool-call'&&block.id===call.data.callId&&block.name==='rp_present'))return null;
      result={base:event,call,assistant,ancestors:new Set([event.seq])};
    }else{
      const op=event.surfaceOp;
      if(op?.op!=='replace'||op.startSeq!==op.endSeq)return null;
      const shadowed=bySeq.get(op.startSeq),original=resolve(shadowed,seen);
      if(!original||!sameResultData(data,shadowed.data)||!sources.includes(original.call.seq)||!sources.includes(shadowed.seq)||sources.some(seq=>seq!==original.call.seq&&!original.ancestors.has(seq)))return null;
      result={...original,ancestors:new Set([...original.ancestors,event.seq])};
    }
    cache.set(event.seq,result);return result;
  }
  const records=[];
  for(const event of events){
    if(!active.has(event.seq))continue;
    const source=resolve(event);if(!source)continue;
    const {base,call,assistant}=source,record=base.data.meta.rpLastStep.record;
    const user=events.findLast(candidate=>candidate.seq<assistant.seq&&active.has(candidate.seq)&&candidate.type==='user/message'&&candidate.data?.source?.kind==='user');
    records.push({id:JSON.stringify([record.id,event.seq]),ref:{sessionId,presentationId:record.id,assistantMessageId:assistant.data.message.id,callSeq:call.seq,baseResultSeq:base.seq,resultSeq:event.seq},turn:base.data.turn,action:record.playerAction??textOf(user?.data),text:textOf(event.data.message),...(typeof record.factReceiptId==='string'?{factReceiptId:record.factReceiptId}:{}),...(typeof record.createdAt==='string'?{createdAt:record.createdAt}:{})});
  }
  return records.sort((a,b)=>a.ref.callSeq-b.ref.callSeq);
}

/** Only the current final factual turn can receive an expression revision. */
export function requireLatestNarrative(sessionId,events,expected){
  if(!validNarrativeRef(expected)||expected.sessionId!==sessionId)throw new PresetError('INVALID_NARRATIVE_REF','A complete narrative reference for this story is required');
  const records=readNarratives(sessionId,events),current=records.at(-1);
  if(!current||!sameNarrativeRef(current.ref,expected))throw new PresetError('NARRATIVE_CONFLICT','The latest narrative changed; reload before continuing',409);
  const active=surface([...events].sort((a,b)=>a.seq-b.seq));
  if(events.some(event=>event.seq>current.ref.callSeq&&event.type==='tool/call'&&active.has(modelMessageFor(events,event)?.seq)))throw new PresetError('DOWNSTREAM_WORK','Later factual or tool work exists; use rollback or a new branch',409);
  return current;
}
