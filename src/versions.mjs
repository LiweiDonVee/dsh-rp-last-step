const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const id=value=>typeof value==='string'&&value.trim().length>0&&value.length<=256;
export function validNarrativeVersion(value){
  return object(value)&&Object.keys(value).every(key=>['schemaVersion','groupId','kind','basePresentationId','factRoundId','factRevision'].includes(key))&&value.schemaVersion===1&&id(value.groupId)&&['original','writer-regeneration'].includes(value.kind)
    &&(value.kind==='writer-regeneration'?id(value.basePresentationId):value.basePresentationId===undefined)
    &&(value.factRoundId===undefined?value.factRevision===undefined:id(value.factRoundId)&&value.groupId===value.factRoundId&&Number.isSafeInteger(value.factRevision)&&value.factRevision>=1);
}
export function validOwnerOperation(value){return object(value)&&Object.keys(value).length===4&&value.schemaVersion===1&&['present-fact','regenerate-prose'].includes(value.kind)&&id(value.operationId)&&!(/\s/u.test(value.operationId))&&typeof value.requestHash==='string'&&/^[a-f0-9]{64}$/u.test(value.requestHash);}
