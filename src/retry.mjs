/** One eligibility rule shared by listings, execution and atomic receipt reservation. */
export function retryEligibility(records,original,activeContexts){
  const byId=new Map(records.map(record=>[record.id,record])),active=activeContexts===undefined?null:new Set(activeContexts)
  const chain=value=>{
    const seen=new Set(),items=[]
    while(value){if(seen.has(value.id))return null;seen.add(value.id);items.push(value);if(!value.rewriteOf)return items;value=byId.get(value.rewriteOf)}
    return null
  }
  if(!original||!['failed','cancelled'].includes(original.status)||!Array.isArray(original.compiled?.messages))return{canRetry:false,code:'REWRITE_UNAVAILABLE'}
  const ancestors=chain(original)
  if(!ancestors)return{canRetry:false,code:'REWRITE_UNAVAILABLE'}
  if(active&&ancestors.some(record=>!active.has(record.contextKey)))return{canRetry:false,code:'REWRITE_SOURCE_INACTIVE'}
  const rootId=ancestors.at(-1).id
  for(const record of records){
    if(record.id===original.id||active&&!active.has(record.contextKey))continue
    const family=chain(record);if(!family||family.at(-1).id!==rootId)continue
    if(['rendered','complete'].includes(record.status))return{canRetry:false,code:'REWRITE_ALREADY_RENDERED',rootId}
    if(['prepared','assembling','rendering'].includes(record.status))return{canRetry:false,code:'PRESENTATION_BUSY',rootId}
  }
  return{canRetry:true,rootId}
}

/** Canonical failed sources survive compaction, while replaced branch sources do not. */
export function activePresentationContexts(sessionId,events){
  const nodes=[],coverage=new Map(),bySeq=new Map()
  for(const event of [...events].sort((a,b)=>a.seq-b.seq)){
    bySeq.set(event.seq,event)
    if(event.surfaceOp==='append'){nodes.push(event.seq);coverage.set(event.seq,[event.seq]);continue}
    if(event.surfaceOp?.op!=='replace')continue
    const start=nodes.indexOf(event.surfaceOp.startSeq),end=nodes.indexOf(event.surfaceOp.endSeq);if(start<0||end<start)continue
    const kept=event.type==='user/message'&&event.data?.source?.kind==='compact-checkpoint'?nodes.slice(start,end+1).flatMap(seq=>coverage.get(seq)??[seq]):[]
    coverage.set(event.seq,[...kept,event.seq]);nodes.splice(start,end-start+1,event.seq)
  }
  const active=new Set(nodes.flatMap(seq=>coverage.get(seq)??[seq])),keys=[]
  for(const seq of [...active].sort((a,b)=>a-b)){
    const event=bySeq.get(seq),message=event?.data?.message
    if(event?.type!=='assistant/message'||message?.source?.kind!=='model'||typeof message.id!=='string')continue
    for(const block of message.content??[])if(block.type==='tool-call'&&block.name==='rp_present'&&typeof block.id==='string')keys.push(JSON.stringify([sessionId,message.id,block.id]))
  }
  return keys
}
