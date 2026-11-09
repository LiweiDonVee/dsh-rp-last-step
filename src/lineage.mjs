import {isDeepStrictEqual} from 'node:util';
import {PresetError as LineageError} from './core.mjs';
const invalid=message=>{throw new LineageError('INVALID_ANCESTRY',message,409);};
const id=value=>typeof value==='string'&&value.trim().length>0;

/** Resolve plugin-owned lineage without changing the canonical header. */
export async function withSessionLineage(ctx,snapshot,signal,lineages){
  const sessionId=snapshot.header?.id,legacy=snapshot.header?.parentSession;
  let parentSessionId=legacy??null,count=snapshot.inheritedEventCount;
  if(lineages!==undefined){
    if(!Array.isArray(lineages)||lineages.some(row=>!row||Object.keys(row).some(key=>!['sessionId','parentSessionId'].includes(key))||!id(row.sessionId)||row.parentSessionId!==null&&!id(row.parentSessionId))||new Set(lineages.map(row=>row.sessionId)).size!==lineages.length)invalid('Invalid explicit Session lineage mapping');
    const row=lineages.find(row=>row.sessionId===sessionId);if(!row)invalid('The destination is missing its explicit Session lineage');
    parentSessionId=row.parentSessionId;
    if(legacy!==undefined&&legacy!==parentSessionId)invalid('Explicit lineage conflicts with the canonical legacy parent');
    const query=ctx.get?.('sessionQuery')??ctx.sessionQuery;
    if(typeof query?.observeSession!=='function')invalid('Canonical Session query is required to verify restored lineage');
    const child=await query.observeSession(sessionId,{projectionMode:'none',signal});
    try{
      signal?.throwIfAborted();if(child.header.id!==sessionId)invalid('Canonical Session identity changed');count=child.inheritedEventCount;
      if(!Number.isSafeInteger(count)||count<0||count>child.events.length)invalid('Canonical inherited event count is invalid');
      if(parentSessionId!==null){
        if(parentSessionId===sessionId)invalid('A Session cannot inherit itself');
        const parent=await query.observeSession(parentSessionId,{projectionMode:'none',signal});
        try{signal?.throwIfAborted();if(count<1||count>parent.events.length||!isDeepStrictEqual(child.events.slice(0,count),parent.events.slice(0,count)))invalid('The restored child does not preserve its recorded parent prefix');}
        finally{parent[Symbol.dispose]();}
      }
    }finally{child[Symbol.dispose]();}
  }else{
    const gm=ctx.get?.('rpGM');
    if(typeof gm?.sessionLineage==='function'){
      const row=await gm.sessionLineage({sessionId,signal});
      if(row?.sessionId!==sessionId||row.parentSessionId!==null&&!id(row.parentSessionId)||!Number.isSafeInteger(row.inheritedEventCount)||row.inheritedEventCount<0)invalid('The GM returned invalid Session lineage');
      parentSessionId=row.parentSessionId;count=row.inheritedEventCount;
      if(legacy!==undefined&&legacy!==parentSessionId)invalid('GM lineage conflicts with the canonical legacy parent');
    }
  }
  return{...snapshot,parentSession:parentSessionId??undefined,...count===undefined?{}:{inheritedEventCount:count}};
}
