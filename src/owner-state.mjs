import * as fs from 'node:fs/promises';
import {dirname,basename,join,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {PresetError} from './core.mjs';
const queues=new Map(),uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** LastStep's short storage gate, durable generation and recoverable own-directory replacement. */
export async function createOwnerState({directory,filesystem=fs}){
  const root=resolve(directory),parent=dirname(root),stem=basename(root),journal=join(parent,`.${stem}-owner.json`);
  if(root===parent||!stem)throw new PresetError('RESTORE_PAYLOAD_INVALID','An owner data directory is required');
  await filesystem.mkdir(parent,{recursive:true});
  const serial=work=>{const pending=(queues.get(journal)??Promise.resolve()).then(work),settled=pending.then(()=>undefined,()=>undefined);queues.set(journal,settled);void settled.then(()=>{if(queues.get(journal)===settled)queues.delete(journal);});return pending;};
  async function exists(path){try{await filesystem.access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
  async function read(){try{const value=JSON.parse(await filesystem.readFile(journal,'utf8'));if(value.schemaVersion!==1||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('Invalid generation');return value;}catch(error){if(error.code==='ENOENT')return{schemaVersion:1,revision:0};throw new PresetError('RESTORE_REQUIREMENT_MISSING','The LastStep owner journal could not be read',503);}}
  async function persist(value){const temporary=join(parent,`.${stem}-owner-${randomUUID()}.tmp`);try{await filesystem.writeFile(temporary,JSON.stringify(value)+'\n',{flag:'wx'});await filesystem.rename(temporary,journal);}finally{await filesystem.rm(temporary,{force:true});}}
  function ownedPath(name,kind){const prefix=`${stem}.restore-${kind}-`;if(typeof name!=='string'||basename(name)!==name||!name.startsWith(prefix)||!uuid.test(name.slice(prefix.length)))throw new PresetError('RESTORE_PAYLOAD_INVALID','The owner restore namespace is invalid');const path=resolve(parent,name);if(dirname(path)!==parent||path===root)throw new PresetError('RESTORE_PAYLOAD_INVALID','The owner restore path is invalid');return path;}
  async function digest(directory){
    const files=['presets/preset-store.json','drafts/drafts.json','transfer-state.json'];
    for(const relative of['presentations/receipts','presentations/sessions']){
      let entries;try{entries=await filesystem.readdir(join(directory,relative),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')continue;throw error;}
      for(const entry of entries)if(entry.isFile()&&entry.name.endsWith('.json'))files.push(`${relative}/${entry.name}`);
    }
    const hash=createHash('sha256');for(const file of files.sort()){const path=join(directory,file);if(await exists(path)){const bytes=await filesystem.readFile(path);JSON.parse(bytes.toString('utf8'));hash.update(file).update('\0').update(bytes);}}
    return hash.digest('hex');
  }
  async function recover(){
    const state=await read(),intent=state.pending;if(!intent)return;
    const stage=ownedPath(intent.stage,'stage'),backup=ownedPath(intent.backup,'backup');
    if(typeof intent.digest!=='string'||!/^[a-f0-9]{64}$/u.test(intent.digest))throw new PresetError('RESTORE_PAYLOAD_INVALID','The owner restore digest is invalid');
    if(await exists(stage)){
      if(await digest(stage)!==intent.digest)throw new PresetError('RESTORE_REQUIREMENT_MISSING','Staged LastStep data failed recovery validation',503);
      if(await exists(root)){if(await exists(backup))throw new PresetError('RESTORE_REQUIREMENT_MISSING','LastStep restore requires recovery before use',503);await filesystem.rename(root,backup);}
      await filesystem.rename(stage,root);
    }else if(!await exists(root)&&await exists(backup)){
      await filesystem.rename(backup,root);delete state.pending;await persist(state);return;
    }
    if(!await exists(root)||await digest(root)!==intent.digest)throw new PresetError('RESTORE_REQUIREMENT_MISSING','Installed LastStep data failed recovery validation',503);
    if(await exists(backup)&&intent.previousDigest&&await digest(backup)!==intent.previousDigest)throw new PresetError('RESTORE_REQUIREMENT_MISSING','LastStep backup changed during recovery',503);
    delete state.pending;await persist(state);if(await exists(backup))await filesystem.rm(backup,{recursive:true,force:true});
  }
  await serial(recover);
  async function write(work,expectedRevision){return serial(async()=>{
    const state=await read();if(state.pending)throw new PresetError('RESTORE_REQUIREMENT_MISSING','LastStep recovery is required before writing',503);
    if(expectedRevision!==undefined&&expectedRevision!==state.revision)throw new PresetError('REVISION_CONFLICT','The LastStep content generation changed',409);
    if(state.revision===Number.MAX_SAFE_INTEGER)throw new PresetError('REVISION_CONFLICT','The LastStep generation cannot advance',409);
    state.revision++;await persist(state);return work(state.revision,state);
  });}
  return Object.freeze({
    write,
    read(work=value=>value){return serial(async()=>{const state=await read();if(state.pending)throw new PresetError('RESTORE_REQUIREMENT_MISSING','LastStep recovery is required before reading',503);return work(state.revision);});},
    ensureFloor(minimum){return serial(async()=>{const state=await read();if(state.revision<minimum){state.revision=minimum;await persist(state);}return state.revision;});},
    recoveryPending:()=>serial(async()=>Boolean((await read()).pending)),
    switchRoot({expectedRevision,build}){return write(async(generation,state)=>{
      const stageName=`${stem}.restore-stage-${randomUUID()}`,backupName=`${stem}.restore-backup-${randomUUID()}`,stage=ownedPath(stageName,'stage'),backup=ownedPath(backupName,'backup');
      let intent=false;
      try{
        await filesystem.cp(root,stage,{recursive:true,errorOnExist:true,force:false});
        const result=await build(stage,generation),nextDigest=await digest(stage),previousDigest=await digest(root);
        state.pending={stage:stageName,backup:backupName,digest:nextDigest,previousDigest};await persist(state);intent=true;
        await filesystem.rename(root,backup);await filesystem.rename(stage,root);
        if(await digest(root)!==nextDigest)throw new PresetError('RESTORE_REQUIREMENT_MISSING','The installed owner state could not be validated',503);
        delete state.pending;await persist(state);await filesystem.rm(backup,{recursive:true,force:true});return result;
      }catch(error){if(!intent)await filesystem.rm(stage,{recursive:true,force:true});throw error instanceof PresetError?error:new PresetError('RESTORE_REQUIREMENT_MISSING','LastStep storage recovery is required before continuing this restore',503);}
    },expectedRevision);},
  });
}
