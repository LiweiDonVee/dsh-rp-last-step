import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {PresetError} from './core.mjs';
import {validNarrativeRef} from './narratives.mjs';

const queues=new Map(),statuses=new Set(['draft','generating','ready','failed']);
/** Owner candidates are a separate versioned archive, never a Session narrative. */
export async function createDraftStore({directory}){
  const root=resolve(directory),file=join(root,'drafts.json');await mkdir(root,{recursive:true});
  const serial=work=>{const pending=(queues.get(root)??Promise.resolve()).then(work),settled=pending.then(()=>undefined,()=>undefined);queues.set(root,settled);void settled.then(()=>{if(queues.get(root)===settled)queues.delete(root);});return pending;};
  async function read(){
    try{const state=JSON.parse(await readFile(file,'utf8'));if(state.schemaVersion!==1||!state.drafts||typeof state.drafts!=='object'||Array.isArray(state.drafts))throw new Error('Invalid drafts');return state;}
    catch(error){if(error.code==='ENOENT')return{schemaVersion:1,drafts:{}};throw new PresetError('DRAFT_STORE_UNAVAILABLE','Draft archive could not be read',500);}
  }
  async function write(state){const temp=join(root,`.draft-${randomUUID()}.tmp`);try{await writeFile(temp,JSON.stringify(state)+'\n',{flag:'wx'});await rename(temp,file);}finally{await rm(temp,{force:true});}}
  function owned(state,sessionId,draftId){const value=Object.hasOwn(state.drafts,draftId)?state.drafts[draftId].at(-1):null;if(!value||value.sessionId!==sessionId)throw new PresetError('DRAFT_NOT_FOUND','Candidate not found in this story',404);return value;}
  async function revise(input,change){const captured=structuredClone(input);return serial(async()=>{const state=await read(),current=owned(state,captured.sessionId,captured.draftId);if(current.version!==captured.expectedDraftVersion)throw new PresetError('DRAFT_CONFLICT','This candidate changed; reload before editing or adopting',409);const next={...current,...change(captured),version:current.version+1};state.drafts[current.id].push(next);await write(state);return structuredClone(next);});}
  return Object.freeze({
    create(input){const captured=structuredClone(input);if(!validNarrativeRef(captured.basedOn)||captured.basedOn.sessionId!==captured.sessionId||!statuses.has(captured.status)||!['writer','manual'].includes(captured.kind)||typeof captured.text!=='string')throw new PresetError('INVALID_DRAFT','A valid story candidate is required');return serial(async()=>{const state=await read(),value={id:randomUUID(),version:1,sessionId:captured.sessionId,basedOn:captured.basedOn,...captured.factReceiptId?{factReceiptId:captured.factReceiptId}:{},kind:captured.kind,text:captured.text,status:captured.status,createdAt:new Date().toISOString()};state.drafts[value.id]=[value];await write(state);return structuredClone(value);});},
    get(input){return serial(async()=>structuredClone(owned(await read(),input.sessionId,input.draftId)));},
    list(sessionId){return serial(async()=>Object.values((await read()).drafts).map(versions=>versions.at(-1)).filter(value=>value.sessionId===sessionId).map(value=>structuredClone(value)).reverse());},
    edit(input){if(typeof input.text!=='string'||!input.text.trim())throw new PresetError('INVALID_DRAFT','Candidate text must be nonempty');return revise(input,value=>({text:value.text,kind:'manual',status:'ready'}));},
    finish(input){if(!['ready','failed'].includes(input.status)||typeof input.text!=='string')throw new PresetError('INVALID_DRAFT','Invalid candidate completion');return revise(input,value=>({text:value.text,status:value.status}));},
  });
}
