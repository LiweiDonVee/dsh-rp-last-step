import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PresetError } from './core.mjs';
import { resolveModelConfig } from './models.mjs';
import { retryEligibility } from './retry.mjs';
import {validNarrativeVersion,validOwnerOperation} from './versions.mjs';

const queues = new Map();
const STATUSES = new Set(['prepared', 'assembling', 'rendering', 'rendered', 'complete', 'failed', 'cancelled']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = (value) => structuredClone(value);

export function publicStorySnapshot(value){
  if(!record(value))return undefined;
  const pick=(input,keys)=>Object.fromEntries(keys.filter(key=>key==='version'?Number.isSafeInteger(input?.[key])&&input[key]>0:typeof input?.[key]==='string').map(key=>[key,clone(input[key])]));
  return{...pick(value,['title','examples']),...record(value.character)?{character:pick(value.character,['assetId','version','name','description','personality','scenario'])}:{},...record(value.persona)?{persona:pick(value.persona,['assetId','version','name','description'])}:{}};
}

export function publicReceipt(value) {
  if (!value) return null;
  const result = {};
  for (const key of ['id', 'status', 'createdAt', 'profileId', 'profileVersion', 'profileHash']) {
    if (value[key] !== undefined) result[key] = clone(value[key]);
  }
  result.text = typeof value.text === 'string' ? value.text : '';
  if(typeof value.playerAction==='string')result.playerAction=value.playerAction;
  if (typeof value.factReceiptId === 'string') result.factReceiptId = value.factReceiptId;
  if(validNarrativeVersion(value.narrativeVersion))result.narrativeVersion=clone(value.narrativeVersion);
  if(typeof value.regenerateOf==='string')result.regenerateOf=value.regenerateOf;
  if(validOwnerOperation(value.ownerOperation))result.ownerOperation=clone(value.ownerOperation);
  if (record(value.models)) result.models = Object.fromEntries(Object.entries(value.models).map(([stage, config]) => [stage, resolveModelConfig(config)]));
  if (value.truncated === true) result.truncated = true;
  if (typeof value.rewriteOf==='string') {result.rewriteOf=value.rewriteOf;result.playerAction=value.packet?.playerAction;}
  if (record(value.contextPreparation)) {
    const prepared=value.contextPreparation;
    result.context={id:prepared.id,...prepared.database?{database:clone(prepared.database)}:{},...prepared.historyProjection?{historyProjection:clone(prepared.historyProjection)}:{},history:(prepared.materials?.history??[]).map(item=>({id:item.id,mode:item.mode,source:clone(item.source)})),chars:prepared.materials?.chars,models:clone(prepared.models??{})};
  }
  return result;
}

export async function createReceiptStore({ directory } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw new PresetError('INVALID_RECEIPT_DIRECTORY', 'A receipt directory is required');
  const root = resolve(directory);
  const records = join(root, 'receipts');
  const sessions = join(root, 'sessions');
  await mkdir(records, { recursive: true });
  await mkdir(sessions, { recursive: true });
  let mutationGate=work=>work();

  function serial(work) {
    const pending = (queues.get(root) ?? Promise.resolve()).then(work);
    const settled = pending.then(() => undefined, () => undefined);
    queues.set(root, settled);
    void settled.then(() => { if (queues.get(root) === settled) queues.delete(root); });
    return pending;
  }
  async function read(file, fallback) {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return fallback;
      if (error instanceof SyntaxError) throw new PresetError('RECEIPT_CORRUPT', 'Stored presentation metadata is invalid', 500);
      throw error;
    }
  }
  async function write(file, value) {
    const temporary = join(root, `.receipt-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
  }
  function indexFile(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new PresetError('INVALID_SESSION', 'A session id is required');
    return join(sessions, `${createHash('sha256').update(sessionId, 'utf8').digest('hex')}.json`);
  }
  async function get(id) {
    if (typeof id !== 'string' || !UUID.test(id)) return null;
    return read(join(records, `${id}.json`), null);
  }
  async function list(sessionId) {
    const index = await read(indexFile(sessionId), []);
    if (!Array.isArray(index) || index.some((id) => typeof id !== 'string' || !UUID.test(id))) throw new PresetError('RECEIPT_CORRUPT', 'Stored presentation index is invalid', 500);
    const values = await Promise.all(index.map(get));
    return values.filter((value) => value?.sessionId === sessionId).reverse();
  }
  function validate(value) {
    if (!record(value) || !STATUSES.has(value.status)) throw new PresetError('INVALID_RECEIPT', 'A valid presentation record and status are required');
    indexFile(value.sessionId);
    if(value.narrativeVersion!==undefined&&!validNarrativeVersion(value.narrativeVersion)||value.ownerOperation!==undefined&&!validOwnerOperation(value.ownerOperation))throw new PresetError('INVALID_RECEIPT','Invalid recorded presentation version');
    if(value.playerAction!==undefined&&(typeof value.playerAction!=='string'||value.playerAction!==value.packet?.playerAction))throw new PresetError('INVALID_RECEIPT','The recorded player action must match the frozen packet');
  }
  return Object.freeze({
    setMutationGate(gate){mutationGate=gate;},
    drain:()=>serial(()=>{}),
    async create(input,options={}) {
      const captured = clone(input);
      const contexts=clone(options.activeContexts);
      validate(captured);
      return serial(() => mutationGate(async () => {
        const existingRecords=await list(captured.sessionId);
        if (captured.contextKey !== undefined && existingRecords.some((value) => value.contextKey === captured.contextKey)) {
          throw new PresetError('PRESENTATION_BUSY', 'This context already has a presentation attempt', 409);
        }
        if(captured.rewriteOf){
          const original=existingRecords.find(record=>record.id===captured.rewriteOf),eligible=retryEligibility(existingRecords,original,contexts);
          if(!eligible.canRetry||contexts!==undefined&&!new Set(contexts).has(captured.contextKey))throw new PresetError(eligible.canRetry?'REWRITE_SOURCE_INACTIVE':eligible.code,'The frozen presentation is not eligible for this retry',409);
        }
        const value = { ...captured, id: randomUUID(), createdAt: new Date().toISOString() };
        if(options.originalVersion)value.narrativeVersion={schemaVersion:1,groupId:options.originalVersion.factRoundId??value.id,kind:'original',...options.originalVersion.factRoundId?{factRoundId:options.originalVersion.factRoundId,factRevision:options.originalVersion.factRevision}:{}};
        validate(value);
        const index = indexFile(value.sessionId);
        const ids = await read(index, []);
        if (!Array.isArray(ids)) throw new PresetError('RECEIPT_CORRUPT', 'Stored presentation index is invalid', 500);
        await write(join(records, `${value.id}.json`), value);
        await write(index, [...ids, value.id]);
        return clone(value);
      }));
    },
    async get(id) { return serial(async () => clone(await get(id))); },
    async update(id, patch) {
      const captured = clone(patch);
      if (!record(captured)) throw new PresetError('INVALID_RECEIPT', 'A receipt patch is required');
      if (['id', 'sessionId', 'contextKey', 'createdAt','narrativeVersion','ownerOperation','regenerateOf','playerAction'].some((key) => Object.hasOwn(captured, key))) throw new PresetError('RECEIPT_IDENTITY_IMMUTABLE', 'Presentation identity cannot be changed', 403);
      return serial(() => mutationGate(async () => {
        const current = await get(id);
        if (!current) throw new PresetError('RECEIPT_NOT_FOUND', 'Presentation record not found', 404);
        const next = { ...current, ...captured };
        validate(next);
        await write(join(records, `${id}.json`), next);
        return clone(next);
      }));
    },
    async list(sessionId) { return serial(async () => clone(await list(sessionId))); },
    async findByContextKey(sessionId, contextKey) {
      return serial(async () => clone((await list(sessionId)).find((value) => value.contextKey === contextKey) ?? null));
    },
  });
}
