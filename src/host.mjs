import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createHash} from 'node:crypto';
import { PresetError, compileProfile, createProfile, emptyOverlay, importSillyTavern } from './core.mjs';
import { createPresetStore } from './store.mjs';
import { createReceiptStore, publicReceipt,publicStorySnapshot } from './receipts.mjs';
import { createModelCaller, resolveModelConfig } from './models.mjs';
import { createPresenter } from './presenter.mjs';
import { registerRpLastStepAgent, requireNativeTools, usesNativeTools } from './agent.mjs';
import { createRpLastStepRoutes } from './routes.mjs';
import { activePresentationContexts,retryEligibility } from './retry.mjs';
import {readNarratives,requireLatestNarrative,sameNarrativeRef,validNarrativeRef} from './narratives.mjs';
import {projectStoryHistory,validFactProjection} from './story-history.mjs';
import {createDraftStore} from './drafts.mjs';
import {createOwnerOperations} from './adoption.mjs';
import {createOwnerState} from './owner-state.mjs';
import {readOwnedState,selectState,preflightState,validateCanonicalState,mergeState,stateFingerprint} from './transfer.mjs';

export const name = 'rp-last-step';
export const inject = ['connection', 'typertGateway', 'agents', 'llm', 'tools', 'systemPrompt'];
const skillName = 'adapting-sillytavern-rp-presets';
const stages = ['migrate', 'assemble', 'render'];
const routeFields = ['provider', 'model', 'reasoningEffort', 'maxTokens'];
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const copy = (value) => structuredClone(value);
const routeConfig = (value) => Object.fromEntries(routeFields.filter((key) => value?.[key] !== undefined).map((key) => [key, value[key]]));
const callKey = (sessionId, callId) => JSON.stringify([sessionId, callId]);

function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function sessionId(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new PresetError('INVALID_SESSION', 'A session id is required');
}
function skillBody(text) {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  const fields = {};
  for (const line of match?.[1].split(/\r?\n/u) ?? []) {
    const field = /^(name|description):\s*(.*?)\s*$/u.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/u, '$2');
  }
  return { content: (match ? text.slice(match[0].length) : text).trim(), description: fields.description ?? 'Adapt SillyTavern RP presets into owner-reviewed agent and presentation modules.' };
}
function entriesFor(binding) {
  return [...binding.profile.entries, ...binding.overlay.additions].map((entry) => {
    const patch = Object.hasOwn(binding.overlay.entries, entry.id) ? binding.overlay.entries[entry.id] : {};
    return { ...entry, ...patch, fills: { ...entry.fills, ...patch.fills } };
  }).sort((left, right) => left.order - right.order);
}
function publicEntry(entry, body = false) {
  const result = {};
  for (const key of ['id', 'name', 'role', 'order', 'enabled', 'phase', 'required', 'locked', 'marker']) if (entry[key] !== undefined) result[key] = copy(entry[key]);
  if (body) { result.content = entry.content; if (Object.keys(entry.fills).length) result.fills = copy(entry.fills); }
  return result;
}

export const LOOP_PARTICIPANT = freeze({
  id: 'rp-last-step',
  nodes: [
    { id: 'migrate', label: 'RP 预设迁移', kind: 'model', control: 'route', description: '按配套 skill 生成供用户审阅的迁移草稿。' },
    { id: 'assemble', label: 'RP 模块热组装', kind: 'model', control: 'route', description: '模拟与工具完成后按权限组装最终呈现模块。' },
    { id: 'render', label: 'RP 最终正文', kind: 'model', control: 'route', description: '独立模型仅依据公开方向包和呈现模块生成正文。' },
  ],
  edges: [
    { id: 'submit', from: 'host.tools', to: 'assemble', label: 'RP 提交，可选' },
    { id: 'assembled', from: 'assemble', to: 'render', label: '编译通过' },
    { id: 'presented', from: 'render', to: 'host.end', label: '正文已提交' },
  ],
});

/** Public adapters only: preset state, isolated presentation and owner Remote reads. */
export async function createRpLastStepHost(ctx, options = {}) {
  const directory = options.directory ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'app-data', 'rp-last-step');
  const ownerState=await createOwnerState({directory});
  let store = options.store ?? await createPresetStore({ directory: join(directory, 'presets') });
  let receipts = options.receipts ?? await createReceiptStore({ directory: join(directory, 'presentations') });
  let draftStore=await createDraftStore({directory:join(directory,'drafts')});
  const attachStorageGate=()=>{for(const handle of[store,receipts,draftStore])handle.setMutationGate(ownerState.write);};attachStorageGate();await ownerState.ensureFloor((await store.snapshot()).revision);
  const skillDirectory = options.skillDirectory ?? fileURLToPath(new URL('./skills/adapting-sillytavern-rp-presets/', import.meta.url));
  let skillText;
  let skillReference;
  try {
    [skillText, skillReference] = await Promise.all([
      options.skillText === undefined ? readFile(join(skillDirectory, 'SKILL.md'), 'utf8') : options.skillText,
      options.skillReference === undefined ? readFile(join(skillDirectory, 'references', 'adaptation-guide.md'), 'utf8') : options.skillReference,
    ]);
  } catch { throw new PresetError('MIGRATION_SKILL_UNAVAILABLE', 'The bundled preset adaptation skill is unavailable', 503); }
  if (typeof skillText !== 'string' || typeof skillReference !== 'string') throw new TypeError('skillText and skillReference must be strings');
  const skill = skillBody(skillText);
  let stopped = false;
  let loopStudio;
  let agentAdapter;
  const bindings = new Map();
  const admissions = new Map();
  const operations = new Set();
  const reads = new Set();
  const subscribers = new Map();
  const disposers = [];
  const optionalDisposers = new Set();
  const pendingCalls = new Map();
  const presentations = new Map();
  const revisionScopes=new Map();
  const turns = new Map();
  const workScope=new AsyncLocalStorage(),ownerJobs=new Set(),canonicalJobs=new Set(),gateWaiters=new Set(),drainingAgents=new Map(),transferSessions=new Set();
  let transferPhase='open',exclusiveQueue=Promise.resolve();

  function active() { if (stopped) throw new PresetError('UNAVAILABLE', 'RP presentation has been unloaded', 503); }
  async function run(signal, work,admission={}) {
    active();
    const admitted=workScope.getStore()?.admitted||admission.internal||admission.agent&&drainingAgents.has(admission.agent);
    if(transferPhase!=='open'&&!(transferPhase==='draining'&&admitted))throw new PresetError('OWNER_STATE_BUSY','LastStep is capturing or restoring a stable state; retry after it finishes',409);
    const lifetime = new AbortController();
    operations.add(lifetime);
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let finish;const completion=new Promise(resolve=>{finish=resolve;});ownerJobs.add(completion);
    try { return await workScope.run({admitted:true},async()=>{combined.throwIfAborted();const value=await work(combined);combined.throwIfAborted();return value;}); }
    finally { operations.delete(lifetime);ownerJobs.delete(completion);finish(); }
  }
  async function until(promise,signal){let stop;const aborted=new Promise((_resolve,reject)=>{stop=()=>reject(new DOMException('Transfer cancelled','AbortError'));signal.addEventListener('abort',stop,{once:true});});try{signal.throwIfAborted();return await Promise.race([promise,aborted]);}finally{signal.removeEventListener('abort',stop);}}
  function waitForStorage(){if(!['exclusive','recovery'].includes(transferPhase))return Promise.resolve();return new Promise((resolve,reject)=>gateWaiters.add({resolve,reject}));}
  function trackCanonical(owned,work){const pending=owned?workScope.run({admitted:true},work):work();if(owned){canonicalJobs.add(pending);void pending.then(()=>canonicalJobs.delete(pending),()=>canonicalJobs.delete(pending));}return pending;}
  function sessionSet(input){if(!Array.isArray(input)||!input.length||input.some(id=>typeof id!=='string'||!id.trim()||id.length>256)||new Set(input).size!==input.length)throw new PresetError('RESTORE_PAYLOAD_INVALID','A nonempty set of Session IDs is required',409);return copy(input);}
  async function sessionFamily(ids,signal){const sessions=new Map(),queue=[...ids];for(let index=0;index<queue.length;index++){const id=queue[index];if(sessions.has(id))continue;const snapshot=await canonicalSession(id,undefined,signal);sessions.set(id,snapshot);if(snapshot.header.parentSession)queue.push(snapshot.header.parentSession);}return sessions;}
  function exclusive(ids,signal,kind,work){
    const lifetime=new AbortController(),combined=signal?AbortSignal.any([signal,lifetime.signal]):lifetime.signal;operations.add(lifetime);
    const job=exclusiveQueue.then(async()=>{
      active();combined.throwIfAborted();if(transferPhase!=='open')throw new PresetError('OWNER_STATE_BUSY','LastStep recovery is required before another transfer',409);
      if(kind==='export'&&ids.some(id=>ctx.agents.get(id)?.status==='running'))throw new PresetError('EXPORT_CHANGED','Export requires idle stories',409);
      transferPhase='draining';for(const id of ids)transferSessions.add(id);for(const agent of ctx.agents.list())if(agent.status==='running'&&(bindings.has(agent.id)||ids.includes(agent.id)))drainingAgents.set(agent,agent.session.snapshotEvents?.().findLast(event=>event.type==='turn/start')?.data.turn);
      try{
        await until(Promise.allSettled([...drainingAgents.keys()].map(agent=>agent.whenIdle())),combined);
        while(ownerJobs.size||canonicalJobs.size)await until(Promise.allSettled([...ownerJobs,...canonicalJobs]),combined);
        await Promise.all([store.drain(),receipts.drain(),draftStore.drain()]);await ownerState.read();combined.throwIfAborted();transferPhase='exclusive';
        return await work(combined);
      }finally{drainingAgents.clear();transferSessions.clear();transferPhase=await ownerState.recoveryPending()?'recovery':'open';if(transferPhase==='open'){for(const waiter of gateWaiters)waiter.resolve();gateWaiters.clear();}}
    });
    exclusiveQueue=job.then(()=>undefined,()=>undefined);void exclusiveQueue.then(()=>operations.delete(lifetime));return job;
  }
  async function refreshBindings() {
    const snapshot = await store.snapshot();
    const loaded = await Promise.all(Object.keys(snapshot.bindings).map(async (id) => [id, await store.binding(id)]));
    bindings.clear();
    for (const [id, binding] of loaded) if (binding?.profile.status === 'ready') bindings.set(id, freeze(binding));
    agentAdapter?.sync();
    return snapshot;
  }
  await refreshBindings();

  function notify(session, event) {
    for (const listener of subscribers.get(session) ?? []) { try { listener(copy(event)); } catch { /* One UI observer does not own runtime progress. */ } }
  }
  function changed(session) {
    if (session) notify(session, { type: 'changed', sessionId: session });
    else for (const id of subscribers.keys()) notify(id, { type: 'changed', sessionId: id });
  }
  async function readSession(id, signal) {
    active(); sessionId(id);
    const lifetime = new AbortController();
    reads.add(lifetime);
    const combined = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
    let iterator;
    try {
      combined.throwIfAborted();
      const stream = await ctx.typertGateway.stream({ namespace: 'session', method: 'follow', args: { request: { address: { kind: 'session', sessionId: id }, maxMessages: 100 } }, peer: ctx.connection.browserPeer, signal: combined });
      iterator = stream[Symbol.asyncIterator]();
      combined.throwIfAborted();
      const first = await iterator.next();
      combined.throwIfAborted();
      if (first.done || first.value?.type !== 'snapshot' || first.value.header?.id !== id || !Array.isArray(first.value.records)) throw new PresetError('SESSION_NOT_FOUND', 'Session is unavailable', 404);
      return first.value;
    } catch (error) {
      if (combined.aborted) combined.throwIfAborted();
      if (error instanceof PresetError) throw error;
      if (['gateway/forbidden', 'gateway/access-denied'].includes(error?.code)) throw new PresetError('FORBIDDEN', 'Session access was denied', 403);
      if (['session/not-found', 'session-query/not-found'].includes(error?.code)) throw new PresetError('SESSION_NOT_FOUND', 'Session is unavailable', 404);
      if (error?.name === 'AbortError' || error?.code === 'gateway/cancelled') throw new DOMException('The request was cancelled', 'AbortError');
      throw new PresetError('SESSION_UNAVAILABLE', 'The owner session could not be read', 503);
    } finally {
      lifetime.abort(); reads.delete(lifetime);
      try { await iterator?.return?.(); } catch { /* Closing the reader cannot replace its accepted result or safe error. */ }
    }
  }
  async function canonicalSession(id,agent,signal){
    await readSession(id,signal);
    const live=ctx.agents.get(id);
    if(agent&&agent!==live)throw new PresetError('AGENT_MISMATCH','The caller does not own this session',403);
    if(live?.session.snapshotEvents)return{header:copy(live.session.header),events:live.session.snapshotEvents(),inheritedEventCount:live.session.inheritedEventCount};
    const query=ctx.get?.('sessionQuery');
    if(!query?.observeSession)throw new PresetError('NARRATIVE_UNAVAILABLE','The canonical session log is unavailable',503);
    const view=await query.observeSession(id);try{return{header:copy(view.header),events:copy(view.events),inheritedEventCount:view.inheritedEventCount};}finally{view[Symbol.dispose]();}
  }
  async function narrativeEvents(id,agent,signal){return(await canonicalSession(id,agent,signal)).events;}
  async function descendsFrom(child,ancestor,signal){
    const seen=new Set([child.header.id]);
    while(child.header.parentSession){
      const parentId=child.header.parentSession;if(seen.has(parentId))return false;seen.add(parentId);
      const parent=await canonicalSession(parentId,undefined,signal),count=child.inheritedEventCount;
      if(!Number.isSafeInteger(count)||count<0||count>child.events.length||count>parent.events.length||!child.events.slice(0,count).every((event,index)=>isDeepStrictEqual(event,parent.events[index])))return false;
      if(parentId===ancestor)return true;child=parent;
    }
    return false;
  }
  async function frozenReceipt(id,presentationId,events){
    const receipt=await receipts.get(presentationId);
    if(receipt?.sessionId===id)return receipt;
    if(receipt){const child=await canonicalSession(id);if(!await descendsFrom(child,receipt.sessionId))throw new PresetError('RECEIPT_NOT_FOUND','Presentation record not found',404);events=child.events;}
    const narrative=receipt&&readNarratives(id,events).find(record=>record.ref.presentationId===presentationId);
    if(narrative){
      let origin;try{origin=JSON.parse(receipt.contextKey);}catch{/* Old invalid identities cannot authorize an inherited snapshot. */}
      const call=(events??[]).find(event=>event.seq===narrative.ref.callSeq);
      if(origin?.[0]===receipt.sessionId&&origin[1]===narrative.ref.assistantMessageId&&origin[2]===call?.data.callId)return receipt;
    }
    throw new PresetError('RECEIPT_NOT_FOUND','Presentation record not found',404);
  }
  function draftProgress(event){
    try{ctx.emit('rp-last-step/draft',event);}catch{/* Candidate observers do not own the writer. */}
    notify(event.sessionId,{type:'draft',...event});
  }
  async function completedFactReplay(input,agent,signal){
    const previous=await receipts.findByContextKey(input.sessionId,input.contextKey);
    if(!previous||!['rendered','complete'].includes(previous.status))return null;
    if(previous.factReceiptId!==input.factReceiptId)throw new PresetError('INVALID_FACT_RECEIPT','This presentation context belongs to a different fact receipt',409);
    const events=await narrativeEvents(input.sessionId,agent,signal);
    if(!activePresentationContexts(input.sessionId,events).includes(input.contextKey))throw new PresetError('INACTIVE_SOURCE','The presentation source is no longer active',409);
    const accepted=readNarratives(input.sessionId,events).find(record=>record.ref.presentationId===previous.id&&record.factReceiptId===input.factReceiptId&&JSON.stringify([input.sessionId,record.ref.assistantMessageId,events.find(event=>event.seq===record.ref.callSeq)?.data.callId])===input.contextKey);
    if(!accepted){
      if(previous.status==='complete')throw new PresetError('INACTIVE_SOURCE','The completed presentation has no active canonical source',409);
      return null;
    }
    return previous.status==='complete'?publicReceipt(previous):presenter.commit({sessionId:input.sessionId,presentationId:previous.id,seq:accepted.ref.baseResultSeq});
  }
  function baseFor(id, supplied) {
    const agent = ctx.agents.get(id);
    if (supplied && supplied !== agent) throw new PresetError('AGENT_MISMATCH', 'The caller does not own this live session', 403);
    const header = agent?.session.requestHeader?.();
    if (header) {
      const config = routeConfig(header.config);
      for (const key of ['reasoningEffort', 'maxTokens']) if (header.adapterDefaults?.[key] === true) delete config[key];
      return resolveModelConfig(config);
    }
    return resolveModelConfig({ ...routeConfig(ctx.get?.('agentDefaultModel')?.currentSelection?.()), ...routeConfig(agent?.options) });
  }
  function migrationBaseFor(id, snapshot) {
    const projection = snapshot.projections?.values?.modelSelection;
    const selection = projection?.next ?? projection?.lastUsed;
    if (selection === undefined || selection === null) return baseFor(id);
    // Owner migration follows the next selected route, even before a new main
    // request persists it. Cold selections need no live Agent or global model.
    const selected = resolveModelConfig(routeConfig(selection));
    const header = ctx.agents.get(id)?.session.requestHeader?.();
    const maxTokens = header?.adapterDefaults?.maxTokens === true ? undefined : header?.config?.maxTokens;
    return resolveModelConfig({ ...selected, ...(maxTokens === undefined ? {} : { maxTokens }) });
  }
  async function resolveModels({ sessionId: id,stage:selectedStage }) {
    const studio = loopStudio;
    if (!studio) return {};
    try {
      const values = await Promise.all((selectedStage?[selectedStage]:stages).map(async (stage) => [stage, copy(await studio.resolveRoute({ sessionId: id, nodeId: `rp-last-step.${stage}` }) ?? {})]));
      return Object.fromEntries(values);
    } catch { throw new PresetError('MODEL_ROUTE_UNAVAILABLE', 'The selected presentation stage route is unavailable', 503); }
  }
  function trace(value) { try { loopStudio?.recordTrace?.(value); } catch { /* Optional metadata observer. */ } }
  const modelCaller = createModelCaller(ctx);
  const callModel = async (input) => {
    const started = Date.now();
    trace({ sessionId: input.sessionId, nodeId: input.stageId, ...routeConfig(input.config), status: 'running' });
    try {
      const value = await modelCaller(input);
      trace({ sessionId: input.sessionId, nodeId: input.stageId, ...routeConfig(value.config), status: 'completed', durationMs: Date.now() - started, tokens: value.usage });
      return value;
    } catch (error) {
      trace({ sessionId: input.sessionId, nodeId: input.stageId, ...routeConfig(input.config), status: error?.name === 'AbortError' ? 'cancelled' : 'failed', durationMs: Date.now() - started });
      throw error;
    }
  };
  async function publish(event) {
    if (stopped) return;
    if (event.delta === undefined && ['rendering', 'rendered'].includes(event.status)) await refreshBindings();
    if (stopped) return;
    try { ctx.emit('rp-last-step/presentation', event); } catch { /* Public progress listeners are observers. */ }
    notify(event.sessionId, { ...event, type: 'stage' });
  }
  const makePresenter = () => createPresenter({ store, receipts, callModel, resolveModels, publish, skillText: skill.content, skillReference,
    validateRetry:({sessionId,receipt,signal})=>assertRetryFactCurrent(sessionId,receipt,ctx.agents.get(sessionId),signal),
    activeContexts:({sessionId})=>{
      const session=ctx.agents.get(sessionId)?.session;
      return session?.snapshotEvents?activePresentationContexts(sessionId,session.snapshotEvents()):[];
    },
    prepareContext:async input=>{
      const context=ctx.get?.('rpContext');
      if(!context)return null;
      return context.prepare({...input,agent:ctx.agents.get(input.sessionId)});
    },
    presentationOutcome:input=>ctx.get?.('rpContext')?.presentationOutcome?.(input),
    ...(options.maxAssemblySteps === undefined ? {} : { maxAssemblySteps: options.maxAssemblySteps }),
    ...(options.maxMigrationAttempts === undefined ? {} : { maxMigrationAttempts: options.maxMigrationAttempts }),
  });
  let presenter=makePresenter();
  async function factProjection(id,agent,signal){
    const database=ctx.get?.('rpDatabase');
    if(database?.capabilities?.factReview!==1||typeof database.factReviewProjection!=='function')return undefined;
    const projection=await database.factReviewProjection({sessionId:id,agent,signal});
    if(!validFactProjection(projection))throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','The Database fact projection is unavailable',503);
    return projection;
  }
  async function effectiveHistory(id,agent,signal,events){
    const source=events??await narrativeEvents(id,agent,signal);
    let projection;
    try{projection=await factProjection(id,agent,signal);}
    catch(error){if(error?.code!=='NOT_BOUND'||!await pureLegacyHistory(id,source,signal))throw error;}
    return projectStoryHistory(id,source,projection);
  }
  async function pureLegacyHistory(id,events,signal){
    const linked=value=>[value,value?.narrativeVersion].some(record=>record&&['factReceiptId','factRoundId','factRevision'].some(key=>record[key]!==undefined));
    if(readNarratives(id,events).some(record=>linked(record)||linked(events.find(event=>event.seq===record.ref.baseResultSeq)?.data.meta?.rpLastStep?.record)))return false;
    const contexts=new Set(activePresentationContexts(id,events));
    if((await receipts.list(id)).some(receipt=>contexts.has(receipt.contextKey)&&linked(receipt)))return false;
    if(activeGmFactResult(events))return false;
    const gm=ctx.get?.('rpGM');
    return gm==null||typeof gm.binding==='function'&&await gm.binding({sessionId:id,signal})===null;
  }
  function activeGmFactResult(input){
    const events=[...input].sort((a,b)=>a.seq-b.seq),nodes=[],coverage=new Map(),bySeq=new Map(events.map(event=>[event.seq,event]));
    for(const event of events){
      if(event.surfaceOp==='append'){nodes.push(event.seq);coverage.set(event.seq,[event.seq]);continue;}
      if(event.surfaceOp?.op!=='replace')continue;
      const start=nodes.indexOf(event.surfaceOp.startSeq),end=nodes.indexOf(event.surfaceOp.endSeq);if(start<0||end<start)continue;
      const kept=event.type==='user/message'&&event.data?.source?.kind==='compact-checkpoint'?nodes.slice(start,end+1).flatMap(seq=>coverage.get(seq)??[seq]):[];
      coverage.set(event.seq,[...kept,event.seq]);nodes.splice(start,end-start+1,event.seq);
    }
    const active=new Set(nodes.flatMap(seq=>coverage.get(seq)??[seq]));
    return events.some(event=>{
      if(event.type!=='tool/result'||!active.has(event.seq)||event.data?.message?.isError===true||event.sourceEventSeqs?.length!==1)return false;
      const call=bySeq.get(event.sourceEventSeqs[0]),message=event.data.message,assistant=call&&events.findLast(item=>item.seq<call.seq&&item.type==='assistant/message'&&item.data?.turn===call.data?.turn&&item.data?.step===call.data?.step),model=assistant?.data?.message;
      return call?.type==='tool/call'&&['rp_commit_turn','rp_propose_turn'].includes(call.data?.name)&&message?.role==='tool'&&message.source?.kind==='tool'&&message.source.callId===call.data.callId&&message.toolCallId===call.data.callId&&event.data.turn===call.data.turn&&event.data.step===call.data.step&&active.has(assistant?.seq)&&model?.source?.kind==='model'&&model.content?.some(block=>block.type==='tool-call'&&block.id===call.data.callId&&block.name===call.data.name);
    });
  }
  function needsFactReview(state){return state?.payload?.receipts?.some(receipt=>receipt.narrativeVersion?.factRoundId);}
  function factTransferRequirement(state){return needsFactReview(state)&&(ctx.get?.('rpDatabase')?.capabilities?.factReview!==1||typeof ctx.get?.('rpDatabase')?.factReviewProjection!=='function');}
  async function validateFactLinks(sessions,signal){
    for(const [id,snapshot] of sessions){
      const records=readNarratives(id,snapshot.events).filter(record=>record.narrativeVersion?.factRoundId);if(!records.length)continue;
      const projection=await factProjection(id,ctx.agents.get(id),signal);
      if(!projection)throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','Saved fact revisions require Database fact review capability',503);
      for(const record of records){const group=projection.groups.find(group=>group.roundId===record.narrativeVersion.factRoundId);if(!group||group.activeReceiptId===record.factReceiptId&&group.factRevision!==record.narrativeVersion.factRevision)throw new PresetError('RESTORE_PAYLOAD_INVALID','Canonical narrative version does not agree with the Database fact linkage',409);}
    }
  }
  async function assertFactCurrent(id,receipt,agent,signal,{legacyRequired=false,latest=false}={}){
    const factId=receipt.factReceiptId;if(!factId)return;
    const roundId=receipt.narrativeVersion?.factRoundId??receipt.factRoundId,projection=await factProjection(id,agent,signal);
    if(roundId&&!projection)throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','This fact revision requires Database fact review capability',503);
    const group=roundId?projection?.groups.find(group=>group.roundId===roundId):projection?.groups.find(group=>group.activeReceiptId===factId);
    if(group){
      if(group.activeReceiptId!==factId||receipt.narrativeVersion?.factRevision!==undefined&&receipt.narrativeVersion.factRevision!==group.factRevision)throw new PresetError('FACT_VERSION_SUPERSEDED','This fact receipt is no longer effective',409);
      if(group.pendingCandidateId)throw new PresetError('FACT_REVIEW_PENDING','This round has a pending fact review',409);
      if(latest&&projection.latestRoundId!==group.roundId)throw new PresetError('FACT_ROUND_NOT_LATEST','Only the latest ordinary fact round can be presented again',409);
      return group;
    }
    if(roundId)throw new PresetError('FACT_VERSION_SUPERSEDED','This fact round is no longer active in this branch',409);
    const gm=ctx.get?.('rpGM');
    if(!gm?.storyState){if(!legacyRequired&&!projection)return;throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','Current GM fact authority is required for this legacy receipt',503);}
    const state=await gm.storyState({sessionId:id,agent,signal});
    if(!state?.lastFactReceipt?.id)throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','The current GM fact receipt could not be confirmed',503);
    if(state.lastFactReceipt.id!==factId)throw new PresetError('FACT_VERSION_SUPERSEDED','This legacy fact receipt is no longer current',409);
  }
  async function assertRetryFactCurrent(id,receipt,agent,signal){
    try{await assertFactCurrent(id,receipt,agent,signal,{latest:true});}
    catch(error){
      if(error.code==='FACT_ROUND_NOT_LATEST')throw new PresetError('FACT_VERSION_SUPERSEDED','Later facts supersede this failed presentation',409);
      throw error;
    }
  }
  const ordered=value=>Array.isArray(value)?value.map(ordered):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
  function ownerRequest(kind,input){
    if(typeof input.sessionId!=='string'||!input.sessionId.trim()||typeof input.operationId!=='string'||!input.operationId.trim()||/\s/u.test(input.operationId)||input.operationId.length>256)throw new PresetError('INVALID_REQUEST','Story and single-token operation IDs are required');
    const request=kind==='presentFact'?{sessionId:input.sessionId,factReceiptId:input.factReceiptId,operationId:input.operationId}:{sessionId:input.sessionId,basedOn:copy(input.basedOn),operationId:input.operationId,instruction:input.instruction??''};
    if(kind==='presentFact'?(typeof request.factReceiptId!=='string'||!request.factReceiptId.trim()):(!validNarrativeRef(request.basedOn)||request.basedOn.sessionId!==request.sessionId||typeof request.instruction!=='string'))throw new PresetError('INVALID_REQUEST','An exact fact receipt or narrative reference and text instruction are required');
    const operationKind=kind==='presentFact'?'present-fact':'regenerate-prose',{operationId,...identity}=request;
    return freeze({...request,ownerOperation:{schemaVersion:1,kind:operationKind,operationId,requestHash:createHash('sha256').update(JSON.stringify(ordered({schemaVersion:1,kind:operationKind,...identity}))).digest('hex')}});
  }
  async function ownerReplay({sessionId:id,request},signal){
    const records=await receipts.list(id),matches=records.filter(record=>record.ownerOperation?.operationId===request.operationId);
    if(matches.some(record=>record.ownerOperation.requestHash!==request.ownerOperation.requestHash))throw new PresetError('OPERATION_ID_CONFLICT','The operation ID identifies a different owner request',409);
    if(!matches.length)return null;
    const events=await narrativeEvents(id,undefined,signal),canonical=readNarratives(id,events);
    const accepted=canonical.findLast(record=>matches.some(receipt=>receipt.id===record.ref.presentationId&&isDeepStrictEqual(events.find(event=>event.seq===record.ref.baseResultSeq)?.data.meta.rpLastStep.record,{...publicReceipt(receipt),status:'complete'})));
    if(!accepted)return null;
    await presenter.commit({sessionId:id,presentationId:accepted.ref.presentationId,seq:accepted.ref.baseResultSeq});
    return{status:'complete',presentationId:accepted.ref.presentationId};
  }
  async function revisionPreparation(kind,request,agent,signal){
    if(!agent)throw new PresetError('OWNER_OPERATION_UNAVAILABLE','A live native story is required for presentation dispatch',409);
    const id=agent.id,events=await narrativeEvents(id,agent,signal);
    if(kind==='regenerateProse'){
      const history=await effectiveHistory(id,agent,signal,events),current=history.records.at(-1);
      if(!current||!sameNarrativeRef(current.ref,request.basedOn))throw new PresetError('NARRATIVE_CONFLICT','The latest effective narrative changed; reload before continuing',409);
      const original=await frozenReceipt(id,current.ref.presentationId,events);
      await assertFactCurrent(id,original,agent,signal,{legacyRequired:true,latest:true});
      if(!original.factReceiptId&&events.some(event=>event.seq>current.ref.callSeq&&event.type==='tool/call'&&event.data?.name!=='rp_present'))throw new PresetError('DOWNSTREAM_WORK','Later factual or tool work exists',409);
      if(!Array.isArray(original.compiled?.messages)||!original.models?.render)throw new PresetError('REWRITE_UNAVAILABLE','The ordinary narrative has no complete frozen writer composition',409);
      return{toolArgs:{regenerateOf:original.id},original:freeze(copy(original))};
    }
    await assertFactCurrent(id,{factReceiptId:request.factReceiptId},agent,signal,{legacyRequired:true,latest:true});
    if(readNarratives(id,events).some(record=>record.factReceiptId===request.factReceiptId))throw new PresetError('FACT_ALREADY_PRESENTED','This fact receipt already has accepted prose; use the explicit writer regeneration action',409);
    const records=await receipts.list(id),failure=records.find(record=>record.factReceiptId===request.factReceiptId&&['failed','cancelled'].includes(record.status)&&Array.isArray(record.compiled?.messages));
    if(failure){await retrySource(id,failure.id,agent,signal);return{toolArgs:{rewriteOf:failure.id}};}
    return{toolArgs:{factReceiptId:request.factReceiptId}};
  }
  async function retrySource(id,presentationId,agent=ctx.agents.get(id),signal){
    const records=await receipts.list(id),original=records.find(record=>record.id===presentationId),contexts=activePresentationContexts(id,agent?.session.snapshotEvents?.()??[]),eligible=retryEligibility(records,original,contexts);
    if(original)await assertRetryFactCurrent(id,original,agent,signal);
    if(!eligible.canRetry)throw new PresetError(eligible.code,'This frozen presentation is no longer eligible for retry',409);
    return original;
  }
  const ownerOperations=createOwnerOperations(ctx,{
    replay:input=>ownerReplay(input,input.signal),
    enterScope:({kind,request,agent,turn,prepared,requestId,signal})=>{const scope=Object.freeze({kind,request,turn,prepared,requestId,signal});revisionScopes.set(agent,scope);return()=>{if(revisionScopes.get(agent)===scope)revisionScopes.delete(agent);};},
    prepare:async({kind,request,agent,signal})=>{
      signal.throwIfAborted();if(ctx.agents.get(agent.id)!==agent||!service.isEnabled(agent.id))throw new PresetError('BINDING_NOT_FOUND','The native story binding is no longer available',409);
      if(kind==='retry'){await retrySource(agent.id,request.presentationId,agent);return{};}
      if(kind==='presentFact'||kind==='regenerateProse')return revisionPreparation(kind,request,agent,signal);
      const draft=await draftStore.get({sessionId:agent.id,draftId:request.draftId});
      if(draft.version!==request.expectedDraftVersion||draft.status!=='ready')throw new PresetError('DRAFT_VERSION_CONFLICT','The previewed candidate changed before adoption; reload it',409);
      const narrative=requireLatestNarrative(agent.id,agent.session.snapshotEvents(),request.expectedNarrative);
      if(!['sessionId','presentationId','assistantMessageId','callSeq','baseResultSeq'].every(key=>draft.basedOn[key]===narrative.ref[key]))throw new PresetError('NARRATIVE_CONFLICT','The candidate belongs to a different factual turn',409);
      return{narrative,text:draft.text};
    },
    withDraftVersion:({request,agent},work)=>draftStore.withVersion({sessionId:agent.id,draftId:request.draftId,expectedDraftVersion:request.expectedDraftVersion},work),
    complete:async({kind,request,agent,turn})=>{
      const owned=kind==='retry'?[]:(await receipts.list(agent.id)).filter(receipt=>isDeepStrictEqual(receipt.ownerOperation,request.ownerOperation));
      const events=agent.session.snapshotEvents(),narrative=readNarratives(agent.id,events).findLast(record=>{
        const base=events.find(event=>event.seq===record.ref.baseResultSeq),metadata=base?.data.meta?.rpLastStep?.record;return base?.data.turn===turn&&(kind==='retry'?metadata?.rewriteOf===request.presentationId:owned.some(receipt=>receipt.id===record.ref.presentationId&&isDeepStrictEqual(metadata,{...publicReceipt(receipt),status:'complete'})));
      });
      if(!narrative){
        const attempt=kind==='retry'?null:(await receipts.list(agent.id)).find(receipt=>isDeepStrictEqual(receipt.ownerOperation,request.ownerOperation));
        if(attempt&&!['complete','failed','cancelled'].includes(attempt.status))await presenter.fail({sessionId:agent.id,presentationId:attempt.id,error:new PresetError('TOOL_RESULT_REJECTED','The writer result was not canonically accepted',409)});
        throw new PresetError(attempt?.errorCode??'RETRY_DISPATCH_FAILED','The native request did not produce accepted prose',409);
      }
      await presenter.commit({sessionId:agent.id,presentationId:narrative.ref.presentationId,seq:narrative.ref.baseResultSeq});
      return{sourceEventSeq:narrative.ref.baseResultSeq};
    },
  });
  async function bound(id, signal) {
    await readSession(id, signal);
    await refreshBindings();
    const binding = bindings.get(id);
    if (!binding) throw new PresetError('BINDING_NOT_FOUND', 'Bind a ready RP profile to this session first', 409);
    requireNativeTools(ctx, ctx.agents.get(id));
    return binding;
  }
  async function mutation(signal, work, id,admission) {
    return run(signal, async (combined) => { const result = await work(combined); await refreshBindings(); changed(id); return result; },admission);
  }
  function ownerPresentation(kind,input,signal){
    const captured=ownerRequest(kind,input);
    return run(signal,async combined=>{
      await readSession(captured.sessionId,combined);
      const replay=await ownerReplay({sessionId:captured.sessionId,request:captured},combined);if(replay)return replay;
      await revisionPreparation(kind,captured,ctx.agents.get(captured.sessionId),combined);
      try{
        const dispatch=await ownerOperations.run({kind,sessionId:captured.sessionId,request:captured,signal:combined});
        if(dispatch.replay)return dispatch.replay;
        if(dispatch.result?.kind!=='success')return{status:'failed',errorCode:'RETRY_DISPATCH_FAILED'};
        const accepted=await ownerReplay({sessionId:captured.sessionId,request:captured},combined);
        if(!accepted)return{status:'failed',errorCode:'RETRY_DISPATCH_FAILED'};
        changed(captured.sessionId);return accepted;
      }catch(error){
        return{status:error?.name==='AbortError'?'interrupted':'failed',errorCode:error instanceof PresetError?error.code:error?.name==='AbortError'?'PRESENTATION_CANCELLED':'PRESENTATION_FAILED'};
      }
    }).catch(error=>{if(error?.name==='AbortError')return{status:'interrupted',errorCode:'PRESENTATION_CANCELLED'};throw error;});
  }
  const service = {
    apiVersion:1,capabilities:Object.freeze({narrativeRevisions:1}),
    isEnabled(id) {
      if (stopped) return false;
      const admitted = admissions.get(id);
      const agent = ctx.agents.get(id);
      const enabled = admitted?.agent === agent && agent?.status === 'running' ? admitted.enabled : bindings.has(id);
      return enabled && usesNativeTools(ctx, agent);
    },
    hasBinding: (id) => !stopped && bindings.has(id),
    bindingMarker(id) {
      const binding = stopped ? undefined : bindings.get(id);
      return binding && usesNativeTools(ctx, ctx.agents.get(id)) ? JSON.stringify({ contract: 'rp-last-step/v1', enabled: true, profileId: binding.profileId, version: binding.version }) : '';
    },
    agentContext(id) {
      const binding = stopped ? undefined : bindings.get(id);
      if (!binding) return '';
      requireNativeTools(ctx, ctx.agents.get(id));
      const compiled = compileProfile(binding.profile, binding.overlay, { phase: 'agent', variables: { user: '玩家' } });
      if (compiled.blocked) {
        const error = new PresetError('COMPILE_BLOCKED', 'Required RP agent modules need owner review before the agent can run', 409);
        error.diagnostics = compiled.diagnostics;
        throw error;
      }
      return compiled.text;
    },
    contextSnapshot(id) {
      if (!stopped && bindings.has(id)) requireNativeTools(ctx, ctx.agents.get(id));
      return freeze({ enabled: !stopped && bindings.has(id), bindingMarker: service.bindingMarker(id), agentContext: service.agentContext(id) });
    },
    admitContext(agent, snapshot) {
      if (!stopped && ctx.agents.get(agent.session.id) === agent) admissions.set(agent.session.id, { agent, enabled: snapshot.enabled });
    },
    authorize: (id, signal) => run(signal, (combined) => readSession(id, combined).then(() => ({}))),
    state(id, signal) {
      return run(signal, async (combined) => {
        await readSession(id, combined);
        const snapshot = await refreshBindings();
        return { revision: snapshot.revision, profiles: snapshot.profiles.map((profile) => ({ id: profile.id, name: profile.name, version: profile.version, status: profile.status, sourceId: profile.sourceId, entryCount: profile.entries.length })),
          binding: copy(bindings.get(id) ?? null), presentations: await presenter.state(id), capabilities: { migrate: Boolean(skill.content) } };
      });
    },
    profile(input, signal) {
      const captured = copy(input);
      return run(signal, async () => { const profile = await store.profile(captured.profileId, captured.version); if (!profile) throw new PresetError('PROFILE_NOT_FOUND', 'Profile version is unavailable', 404); return { revision: (await store.snapshot()).revision, profile }; });
    },
    source(input, signal) {
      const captured = copy(input);
      return run(signal, async () => { const source = await store.source(captured.sourceId); if (!source) throw new PresetError('SOURCE_NOT_FOUND', 'Original source is unavailable', 404); return { source }; });
    },
    ensureBuiltinProfile:input=>run(input.signal,async()=>{const result=await store.ensureBuiltinProfile(input);await refreshBindings();changed();return result;}),
    contentRevision:({signal}={})=>run(signal,()=>ownerState.read(revision=>({revision}))),
    async exportState(input){
      const ids=sessionSet(input.sessionIds),refs=input.additionalProfileRefs===undefined?[]:copy(input.additionalProfileRefs);
      if(!Array.isArray(refs)||refs.some(ref=>!object(ref)||Object.keys(ref).length!==2||typeof ref.profileId!=='string'||!ref.profileId.trim()||ref.profileId.length>256||!Number.isSafeInteger(ref.version)||ref.version<1))throw new PresetError('INVALID_PROFILE','Additional profile references require only profileId and a positive integer version');
      for(const id of ids){const snapshot=await canonicalSession(id,undefined,input.signal);if(snapshot.header.parentSession&&!await store.binding(id)&&await store.binding(snapshot.header.parentSession))await service.inheritSession({parentSessionId:snapshot.header.parentSession,sessionId:id,signal:input.signal});}
      return exclusive(ids,input.signal,'export',async signal=>{
        const sessions=await sessionFamily(ids,signal),captured=await ownerState.read(async revision=>({revision,raw:await readOwnedState(directory)})),payload=selectState(captured.raw,ids,sessions,refs);validateCanonicalState(payload,sessions);await validateFactLinks(sessions,signal);
        return{schemaVersion:1,revision:captured.revision,payload};
      });
    },
    preflightRestore(input){const ids=sessionSet(input.sessionIds),state=copy(input.state);return run(input.signal,()=>ownerState.read(async()=>{const preview=preflightState(await readOwnedState(directory),ids,state);if(factTransferRequirement(state)){preview.supported=false;preview.conflicts.push({code:'RESTORE_REQUIREMENT_MISSING',id:'Database.factReview'});preview.requirements.push('Database factReview=1 and factReviewProjection are required');}return preview;}));},
    async restoreState(input){
      if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new PresetError('EXPECTED_REVISION_REQUIRED','A nonnegative aggregate content revision is required',409);
      const ids=sessionSet(input.sessionIds),restoreId=input.restoreId;let state;
      try{state=copy(input.state);if(!object(state)||!Number.isSafeInteger(state.schemaVersion)||state.schemaVersion<1||!Number.isSafeInteger(state.revision)||state.revision<0||!object(state.payload))throw Error('Invalid restore envelope');JSON.stringify(state);}catch{throw new PresetError('RESTORE_PAYLOAD_INVALID','A serializable versioned LastStep state is required',409);}
      if(typeof restoreId!=='string'||!restoreId.trim())throw new PresetError('RESTORE_PAYLOAD_INVALID','A restore operation ID is required',409);
      const hash=stateFingerprint(ids,state);
      return exclusive(ids,input.signal,'restore',async signal=>{
        const raw=await ownerState.read(()=>readOwnedState(directory)),previous=Object.hasOwn(raw.transfers.jobs,restoreId)?raw.transfers.jobs[restoreId]:null;
        if(previous){if(previous.hash!==hash)throw new PresetError('RESTORE_ID_CONFLICT','The restore ID identifies different payload or Sessions',409);return copy(previous.result);}
        const preview=preflightState(raw,ids,state);if(!preview.supported)throw new PresetError(preview.conflicts[0].code,'The saved LastStep content has a conflict or missing requirement',409);
        if(factTransferRequirement(state))throw new PresetError('EFFECTIVE_HISTORY_UNAVAILABLE','Saved fact revisions require Database fact review capability',503);
        const sessions=await sessionFamily(ids,signal);validateCanonicalState(state.payload,sessions);await validateFactLinks(sessions,signal);signal.throwIfAborted();
        const result=await ownerState.switchRoot({expectedRevision:input.expectedRevision,build:async(stage,generation)=>{
          const restored=await mergeState(stage,raw,state,{restoreId,sessionIds:ids,generation,hash}),merged=await readOwnedState(stage),check=preflightState(merged,ids,state);if(!check.supported)throw new PresetError('RESTORE_PAYLOAD_INVALID','Staged LastStep data failed validation',409);return restored;
        }});
        store=await createPresetStore({directory:join(directory,'presets')});receipts=await createReceiptStore({directory:join(directory,'presentations')});draftStore=await createDraftStore({directory:join(directory,'drafts')});attachStorageGate();presenter=makePresenter();admissions.clear();await refreshBindings();for(const id of ids)changed(id);return result;
      });
    },
    inheritSession(input){const captured=copy({parentSessionId:input.parentSessionId,sessionId:input.sessionId});return run(input.signal,async signal=>{
      const child=await canonicalSession(captured.sessionId,undefined,signal);
      if(child.header.parentSession!==captured.parentSessionId||!await descendsFrom(child,captured.parentSessionId,signal))throw new PresetError('SESSION_ANCESTRY_REQUIRED','The target is not a verified child prefix of this parent',409);
      if(await store.binding(captured.sessionId))return{revision:(await store.snapshot()).revision};
      const latest=readNarratives(captured.sessionId,child.events).filter(record=>record.ref.baseResultSeq<child.inheritedEventCount).at(-1);
      let composition;
      if(latest){const receipt=await frozenReceipt(captured.sessionId,latest.ref.presentationId,child.events);composition={profileId:receipt.profileId,version:receipt.profileVersion,overlay:receipt.overlay};}
      else{const parent=await store.binding(captured.parentSessionId);if(!parent)throw new PresetError('BINDING_NOT_FOUND','The parent has no pinned profile to inherit',409);composition={profileId:parent.profileId,version:parent.version,overlay:emptyOverlay()};}
      const result=await store.bindCapturedSession(captured.sessionId,{...composition,expectedRevision:(await store.snapshot()).revision});await refreshBindings();changed(captured.sessionId);return result;
    });},
    exportContent:input=>run(input.signal,()=>store.exportContent(input)),
    importContent:input=>mutation(input.signal,()=>{if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<0)throw new PresetError('EXPECTED_REVISION_REQUIRED','A nonnegative content revision is required');return store.importContent({...input,expectedContentRevision:input.expectedRevision});}),
    material(input,signal=input.signal){
      const captured=copy({sessionId:input.sessionId,presentationId:input.presentationId});
      return run(signal,async signal=>{
        await readSession(captured.sessionId,signal);
        const receipt=await frozenReceipt(captured.sessionId,captured.presentationId);
        return {presentationId:receipt.id,packet:copy(receipt.packet),...(receipt.factReceiptId?{factReceiptRef:receipt.factReceiptId}:{}),...receipt.narrativeVersion?{narrativeVersion:copy(receipt.narrativeVersion)}:{},...receipt.ownerOperation?{ownerOperation:copy(receipt.ownerOperation)}:{},...receipt.storySnapshot?{storySnapshot:publicStorySnapshot(receipt.storySnapshot)}:{},contextPreparation:copy(receipt.contextPreparation??null),compiled:copy(receipt.compiled??null),models:copy(receipt.models??{}),status:receipt.status};
      });
    },
    narratives(input,signal=input.signal){return run(signal,async combined=>({records:readNarratives(input.sessionId,await narrativeEvents(input.sessionId,input.agent,combined))}));},
    storyHistory(input,signal=input.signal){return run(signal,combined=>effectiveHistory(input.sessionId,input.agent,combined));},
    presentFact(input,signal=input.signal){return ownerPresentation('presentFact',input,signal);},
    regenerateProse(input,signal=input.signal){return ownerPresentation('regenerateProse',input,signal);},
    presentationSummaries(input,signal=input.signal){return run(signal,async combined=>{
      await readSession(input.sessionId,combined);const records=await receipts.list(input.sessionId),agent=ctx.agents.get(input.sessionId),contexts=activePresentationContexts(input.sessionId,agent?.session.snapshotEvents?.()??[]);
      const presentations=await Promise.all(records.map(async record=>{let eligible=retryEligibility(records,record,contexts);if(['failed','cancelled'].includes(record.status))try{await assertRetryFactCurrent(input.sessionId,record,agent,combined);}catch(error){eligible={canRetry:false,code:error.code??'EFFECTIVE_HISTORY_UNAVAILABLE'};}return{presentationId:record.id,status:record.status,createdAt:record.createdAt,canRetry:eligible.canRetry,...eligible.canRetry?{}:{retryBlockCode:eligible.code},...typeof record.errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/u.test(record.errorCode)?{errorCode:record.errorCode}:{},...typeof record.factReceiptId==='string'?{factReceiptId:record.factReceiptId}:{},...typeof record.rewriteOf==='string'?{rewriteOf:record.rewriteOf}:{},...record.narrativeVersion?{narrativeVersion:copy(record.narrativeVersion)}:{}};}));
      let canRegenerate=false,regenerateBlockCode;
      try{const history=await effectiveHistory(input.sessionId,agent,combined),latest=history.records.at(-1);if(latest){await revisionPreparation('regenerateProse',{basedOn:latest.ref},agent,combined);canRegenerate=true;}}catch(error){regenerateBlockCode=error.code??'EFFECTIVE_HISTORY_UNAVAILABLE';}
      return{presentations,canRegenerate,...regenerateBlockCode?{regenerateBlockCode}:{},capabilities:{narrativeRevisions:1,regenerateDispatch:service.isEnabled(input.sessionId)&&ownerOperations.capable(agent,'regenerateProse'),retryDispatch:service.isEnabled(input.sessionId)&&ownerOperations.capable(agent,'retry')}};
    });},
    drafts(input,signal=input.signal){return run(signal,async combined=>{await readSession(input.sessionId,combined);return{drafts:await draftStore.list(input.sessionId)};});},
    createDraft(input,signal=input.signal){
      const captured=copy({sessionId:input.sessionId,basedOn:input.basedOn,instruction:input.instruction,kind:input.kind??'writer',text:input.text});
      return run(signal,async combined=>{
        if(!['writer','manual'].includes(captured.kind)||captured.text!==undefined&&(captured.kind!=='manual'||typeof captured.text!=='string'||!captured.text.trim()))throw new PresetError('INVALID_DRAFT','Provide a writer candidate or nonempty manual text');
        const events=await narrativeEvents(captured.sessionId,undefined,combined),current=requireLatestNarrative(captured.sessionId,events,captured.basedOn);
        const receipt=await frozenReceipt(captured.sessionId,captured.basedOn.presentationId,events);
        let draft=await draftStore.create({sessionId:captured.sessionId,basedOn:captured.basedOn,...receipt.factReceiptId?{factReceiptId:receipt.factReceiptId}:{},kind:captured.kind,status:captured.kind==='manual'?'ready':'generating',text:captured.kind==='manual'?captured.text??current.text:''});
        if(captured.kind==='manual'){draftProgress({sessionId:captured.sessionId,draftId:draft.id,status:'ready'});return draft;}
        draftProgress({sessionId:captured.sessionId,draftId:draft.id,status:'generating'});
        try{
          const baseModel=migrationBaseFor(captured.sessionId,await readSession(captured.sessionId,combined));
          const result=await presenter.draft({sessionId:captured.sessionId,receipt,instruction:captured.instruction,baseModel,signal:combined,onText:delta=>draftProgress({sessionId:captured.sessionId,draftId:draft.id,status:'generating',delta})});
          draft=await draftStore.finish({sessionId:captured.sessionId,draftId:draft.id,expectedDraftVersion:draft.version,status:'ready',text:result.text,models:result.models});
          draftProgress({sessionId:captured.sessionId,draftId:draft.id,status:'ready'});return draft;
        }catch(error){await draftStore.finish({sessionId:captured.sessionId,draftId:draft.id,expectedDraftVersion:draft.version,status:'failed',text:''});draftProgress({sessionId:captured.sessionId,draftId:draft.id,status:'failed'});throw error;}
      });
    },
    editDraft(input,signal=input.signal){const captured=copy({sessionId:input.sessionId,draftId:input.draftId,text:input.text,expectedDraftVersion:input.expectedDraftVersion});return run(signal,async combined=>{await readSession(captured.sessionId,combined);const draft=await draftStore.edit(captured);draftProgress({sessionId:captured.sessionId,draftId:draft.id,status:draft.status});return draft;});},
    adoptDraft(input,signal=input.signal){const captured=copy({sessionId:input.sessionId,draftId:input.draftId,expectedNarrative:input.expectedNarrative,expectedDraftVersion:input.expectedDraftVersion});return run(signal,async combined=>{
      if(!Number.isSafeInteger(captured.expectedDraftVersion)||captured.expectedDraftVersion<1)throw new PresetError('DRAFT_VERSION_CONFLICT','The previewed candidate version is required',409);
      await readSession(captured.sessionId,combined);
      const dispatch=await ownerOperations.run({kind:'adopt',sessionId:captured.sessionId,request:captured,signal:combined});
      if(dispatch.result?.kind!=='success')throw new PresetError('ADOPTION_REJECTED',dispatch.result?.text??'The candidate was not adopted',409);
      const records=readNarratives(captured.sessionId,await narrativeEvents(captured.sessionId,undefined,combined)),narrative=records.find(record=>record.ref.resultSeq===dispatch.result.sourceEventSeq);
      if(!narrative)throw new PresetError('ADOPTION_REJECTED','The canonical adopted result could not be confirmed',409);
      changed(captured.sessionId);return{narrative};
    });},
    retryPresentation(input,signal=input.signal){const captured=copy({sessionId:input.sessionId,presentationId:input.presentationId});return run(signal,async combined=>{await readSession(captured.sessionId,combined);await retrySource(captured.sessionId,captured.presentationId);const result=await ownerOperations.run({kind:'retry',sessionId:captured.sessionId,request:captured,signal:combined});changed(captured.sessionId);return result;});},
    createProfile(input, signal) {
      const captured = copy(input);
      return mutation(signal, () => store.saveProfile(createProfile({ name: captured.name }), { expectedRevision: captured.expectedRevision }));
    },
    importSillyTavern(input, signal) {
      const captured = copy(input);
      return mutation(signal, async () => {
        const { diagnostics } = importSillyTavern(captured.rawText, { name: captured.name, orderCharacterId: captured.orderCharacterId });
        return { ...await store.importSource(captured.rawText, captured), diagnostics };
      });
    },
    saveProfile(input, signal) {
      const captured = copy(input);
      return mutation(signal, () => store.saveProfile(captured.profile, { expectedRevision: captured.expectedRevision }));
    },
    bindSession(input, signal) {
      const captured = copy(input);
      return mutation(signal, async (combined) => { await readSession(captured.sessionId, combined); requireNativeTools(ctx, ctx.agents.get(captured.sessionId)); combined.throwIfAborted(); return store.bindSession(captured.sessionId, captured); }, captured.sessionId);
    },
    preview(input, signal) {
      const captured = copy(input);
      return run(signal, () => compileProfile(captured.profile, emptyOverlay(), { phase: captured.phase, variables: captured.variables ?? {}, allowDraft: true }));
    },
    migrate(input, signal) {
      const captured = copy(input);
      return mutation(signal, async (combined) => {
        const snapshot = await readSession(captured.sessionId, combined);
        return presenter.migrate({ ...captured, baseModel: migrationBaseFor(captured.sessionId, snapshot), signal: combined });
      });
    },
    catalog(input) {
      const captured = { sessionId: input.sessionId, signal: input.signal };
      return run(captured.signal, async (combined) => { const binding = await bound(captured.sessionId, combined); return { revision: (await store.snapshot()).revision, profileId: binding.profileId, version: binding.version, entries: entriesFor(binding).map((entry) => publicEntry(entry)),presentations:(await presenter.state(captured.sessionId)).filter(item=>item.canRetry).map(item=>({id:item.id,status:item.status,canRetry:true})) }; },{agent:input.agent});
    },
    read(input) {
      const captured = { sessionId: input.sessionId, entryIds: copy(input.entryIds), signal: input.signal };
      return run(captured.signal, async (combined) => {
        if (!Array.isArray(captured.entryIds) || captured.entryIds.some((id) => typeof id !== 'string' || !id.trim())) throw new PresetError('INVALID_TOOL_ARGUMENTS', 'entryIds must contain module ids');
        const binding = await bound(captured.sessionId, combined);
        const entries = entriesFor(binding);
        const selected = [...new Set(captured.entryIds)].map((id) => { const entry = entries.find((item) => item.id === id); if (!entry) throw new PresetError('UNKNOWN_ENTRY', 'The selected module is unavailable', 404); return publicEntry(entry, true); });
        return { revision: (await store.snapshot()).revision, entries: selected };
      },{agent:input.agent});
    },
    patch(input) {
      const captured = { sessionId: input.sessionId, expectedRevision: input.expectedRevision, operations: copy(input.operations) };
      return mutation(input.signal, async (combined) => { await bound(captured.sessionId, combined); combined.throwIfAborted(); return store.applyOperations(captured.sessionId, captured.operations, { expectedRevision: captured.expectedRevision }); }, captured.sessionId,{agent:input.agent});
    },
    present(input) {
      const captured = { sessionId: input.sessionId, contextKey: input.contextKey, packet: copy(input.packet), factReceiptId:input.factReceiptId,rewriteOf:input.rewriteOf,regenerateOf:input.regenerateOf,callId: input.callId };
      const scopeSignal=revisionScopes.get(input.agent??ctx.agents.get(captured.sessionId))?.signal;
      return run(scopeSignal?AbortSignal.any([scopeSignal,...input.signal?[input.signal]:[]]):input.signal, async (combined) => {
        let dispatched=false;
        try {
          await bound(captured.sessionId, combined);
          const agent=input.agent??ctx.agents.get(captured.sessionId),scope=revisionScopes.get(agent);
          if(captured.regenerateOf!==undefined&&!scope)throw new PresetError('OWNER_OPERATION_REQUIRED','Writer regeneration requires its exact owner dispatch scope',403);
          if(scope){
            const expected=scope.prepared.toolArgs,mode=Object.keys(expected)[0],turn=agent.session.snapshotEvents().findLast(event=>event.type==='turn/start')?.data.turn;
            if(turn!==scope.turn||['packet','factReceiptId','rewriteOf','regenerateOf'].filter(key=>captured[key]!==undefined).length!==1||captured[mode]!==expected[mode])throw new PresetError('OWNER_REQUEST_CONFLICT','Only the exact captured owner presentation is permitted',409);
            if(scope.kind==='regenerateProse')await assertFactCurrent(captured.sessionId,scope.prepared.original,agent,combined,{legacyRequired:true,latest:true});
          }
          let resolved;
          const gm=ctx.get?.('rpGM');
          if(captured.rewriteOf!==undefined)await retrySource(captured.sessionId,captured.rewriteOf,agent,combined);
          if(captured.rewriteOf===undefined&&captured.regenerateOf===undefined){
            if(captured.factReceiptId!==undefined){
              const replay=await completedFactReplay(captured,input.agent,combined);
              if(replay){if(captured.callId)presentations.set(callKey(captured.sessionId,captured.callId),replay.id);return replay;}
              if(!gm?.presentation)throw new PresetError('GM_UNAVAILABLE','The fact receipt service is unavailable',503);
              resolved=await gm.presentation({sessionId:captured.sessionId,agent:input.agent??ctx.agents.get(captured.sessionId),factReceiptId:captured.factReceiptId,signal:combined});
              if(resolved.factReceipt.id!==captured.factReceiptId)throw new PresetError('INVALID_FACT_RECEIPT','The resolved fact receipt does not match',409);
              if(resolved.factReceipt.factRoundId)await assertFactCurrent(captured.sessionId,{factReceiptId:captured.factReceiptId,factRoundId:resolved.factReceipt.factRoundId},agent,combined);
            }else if(await gm?.binding?.({sessionId:captured.sessionId,signal:combined}))throw new PresetError('FACT_RECEIPT_REQUIRED','This story requires its committed fact receipt before presentation',409);
          }
          const baseModel=baseFor(captured.sessionId,input.agent);dispatched=true;
          const ownerOperation=scope?.request.ownerOperation;
          const result = captured.regenerateOf!==undefined?await presenter.regenerate({sessionId:captured.sessionId,contextKey:captured.contextKey,original:scope.prepared.original,instruction:scope.request.instruction,ownerOperation,baseModel,signal:combined}):captured.rewriteOf===undefined?await presenter.present({ sessionId: captured.sessionId, contextKey: captured.contextKey, packet: resolved?.packet??captured.packet,...(resolved?{factReceiptId:captured.factReceiptId,factRoundId:resolved.factReceipt.factRoundId,factRevision:resolved.factReceipt.factRevision,story:resolved.story,...resolved.factReceipt.kind==='opening'?{openingText:resolved.factReceipt.openingText}:{}}:{}),ownerOperation,baseModel, signal: combined }):await presenter.rewrite({sessionId:captured.sessionId,contextKey:captured.contextKey,presentationId:captured.rewriteOf,ownerOperation,baseModel,signal:combined});
          if (captured.callId) presentations.set(callKey(captured.sessionId, captured.callId), result.id);
          return result;
        } catch (error) {
          const receipt = await receipts.findByContextKey(captured.sessionId, captured.contextKey);
          if (dispatched && receipt && !['failed', 'cancelled', 'complete'].includes(receipt.status)) await presenter.fail({ sessionId: captured.sessionId, presentationId: receipt.id, error });
          // Validation and route errors can precede receipt creation.
          if (!stopped && !receipt) await publish({ sessionId: captured.sessionId, stageId: 'rp-last-step.render', status: error?.name === 'AbortError' ? 'cancelled' : 'failed', code: error instanceof PresetError ? error.code : 'PRESENTATION_FAILED' });
          throw error;
        } finally { await refreshBindings(); changed(captured.sessionId); }
      },{agent:input.agent});
    },
    commit: (input) => run(undefined,()=>presenter.commit(input),{internal:true}),
    fail: (input) => run(undefined,()=>presenter.fail(input),{internal:true}),
    subscribe(id, listener) {
      active(); sessionId(id);
      const listeners = subscribers.get(id) ?? new Set();
      listeners.add(listener); subscribers.set(id, listeners);
      return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(id); };
    },
    async close() {
      if (stopped) return;
      stopped = true;
      for (const controller of [...reads, ...operations]) controller.abort();
      for(const waiter of gateWaiters)waiter.reject(new DOMException('LastStep unloaded','AbortError'));gateWaiters.clear();
      await ownerOperations.close();
      await exclusiveQueue;
      for (const dispose of disposers.splice(0).reverse()) await dispose();
      for (const dispose of optionalDisposers) await dispose();
      subscribers.clear(); bindings.clear(); admissions.clear(); pendingCalls.clear(); presentations.clear(); turns.clear();
    },
  };

  agentAdapter = registerRpLastStepAgent(ctx, service);
  disposers.push(agentAdapter);
  disposers.push(ctx.on('agent/pre-step',(proposal,next)=>{
    if(transferPhase==='open'||!bindings.has(proposal.agent.id)&&!transferSessions.has(proposal.agent.id))return next();
    if(transferPhase==='draining'&&drainingAgents.has(proposal.agent)){const captured=drainingAgents.get(proposal.agent);if(captured===undefined){drainingAgents.set(proposal.agent,proposal.turn);return next();}if(captured===proposal.turn)return next();}
    return{kind:'reject'};
  }));
  disposers.push(ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    if (stopped || frame.type !== 'start' || ctx.agents.get(agent.session.id) !== agent) return;
    const id = agent.session.id;
    let turn = turns.get(id);
    if (turn?.session !== agent.session || turn.turn !== frame.turn) {
      turn = { session: agent.session, turn: frame.turn, requested: false, required: false, accepted: false };
      turns.set(id, turn);
    }
    turn.requested = true;
    if (service.isEnabled(id)) turn.required = true;
  }));
  const observeSessionEvent=async (session, event) => {
    if (stopped) return;
    const id = session.id;
    if (event.type === 'turn/start') {
      admissions.delete(id);
      turns.set(id, { session, turn: event.data.turn, requested: false, required: false, accepted: false });
      return;
    }
    if (event.type === 'turn/end') {
      const turn = turns.get(id);
      turns.delete(id); admissions.delete(id);
      if (turn?.session === session && turn.turn === event.data.turn && event.data.reason?.kind === 'completed'
        && turn.requested && turn.required && !turn.accepted) {
        await publish({ sessionId: id, stageId: 'rp-last-step.render', status: 'failed', code: 'PRESENTATION_REQUIRED' });
      }
      return;
    }
    if (event.type === 'tool/call') {
      if (event.data.name === 'rp_present') pendingCalls.set(callKey(id, event.data.callId), true);
      return;
    }
    if (event.type !== 'tool/result') return;
    const message = event.data.message;
    if (message?.source?.kind !== 'tool' || typeof message.source.callId !== 'string'
      || (message.toolCallId !== undefined && message.toolCallId !== message.source.callId)) return;
    const key = callKey(id, message.source.callId);
    if (!pendingCalls.delete(key)) return;
    const presentationId = presentations.get(key);
    presentations.delete(key);
    const envelope = event.data.meta?.rpLastStep;
    const record = envelope?.record;
    const accepted = message.isError !== true && envelope?.schemaVersion === 1 && object(record)
      && typeof record.id === 'string' && uuid.test(record.id) && record.status === 'complete' && typeof record.text === 'string'
      && (!presentationId || record.id === presentationId);
    const turn = turns.get(id);
    // Canonical acceptance precedes asynchronous receipt bookkeeping. Only a
    // record returned by this session's presentation call can satisfy its turn.
    if (accepted && record.id === presentationId && turn?.session === session && turn.turn === event.data.turn) turn.accepted = true;
    // Start after canonical publication; observers never append session events.
    await Promise.resolve();
    try {
      await waitForStorage();
      if (event.data.message?.isError === true) {
        if (presentationId) await presenter.fail({ sessionId: id, presentationId, error: new PresetError('TOOL_RESULT_REJECTED', 'The presentation tool result was not accepted', 409) });
        return;
      }
      if (!accepted) return;
      await presenter.commit({ sessionId: id, presentationId: record.id, seq: event.seq });
    } catch { /* Foreign, stale or rejected canonical metadata cannot complete a receipt. */ }
  };
  disposers.push(ctx.on('session/event',(session,event)=>trackCanonical(event.type==='tool/result'&&pendingCalls.has(callKey(session.id,event.data?.message?.source?.callId)),()=>observeSessionEvent(session,event))));
  disposers.push(ctx.on('agent/disposed', ({ agent }) => {
    if (admissions.get(agent.session.id)?.agent === agent) admissions.delete(agent.session.id);
    if (turns.get(agent.session.id)?.session === agent.session) turns.delete(agent.session.id);
  }));
  const observeToolResult=async (exec, result) => {
    if (stopped || exec.name !== 'rp_present' || result.isError !== true) return;
    const id = exec.agent?.session?.id;
    const presentationId = presentations.get(callKey(id, exec.callId));
    if (!presentationId) return;
    try { await waitForStorage();await presenter.fail({ sessionId: id, presentationId, error: new PresetError('TOOL_RESULT_REJECTED', 'The presentation tool result was not accepted', 409) }); }
    catch { /* Error normalization does not expose provider details. */ }
  };
  disposers.push(ctx.on('tools/result',(exec,result)=>trackCanonical(exec.name==='rp_present'&&result.isError===true,()=>observeToolResult(exec,result))));

  function optional(names, install) {
    const register = (child) => {
      if (stopped) return;
      const mount = () => {
        const cleanup = install(child);
        let disposed = false;
        const dispose = () => { if (disposed) return; disposed = true; optionalDisposers.delete(dispose); cleanup?.(); };
        optionalDisposers.add(dispose);
        return dispose;
      };
      if (typeof child.effect === 'function') child.effect(mount, 'RP last-step optional integration');
      else mount();
    };
    if (typeof ctx.inject === 'function') ctx.inject(names, register);
    else if (names.every((name) => ctx.get?.(name))) register(Object.fromEntries(names.map((name) => [name, ctx.get(name)])));
  }
  optional(['skills'], (child) => child.skills.register({ name: skillName, description: skill.description, content: skill.content, source: 'bundled', resourceBase: { kind: 'directory', path: skillDirectory } }));
  optional(['commands'],child=>ownerOperations.connect(child.commands));
  optional(['loopStudio'], (child) => {
    const studio = child.loopStudio;
    const unregister = studio.registerParticipant(copy(LOOP_PARTICIPANT));
    loopStudio = studio;
    return () => { unregister(); if (loopStudio === studio) loopStudio = undefined; };
  });
  return service;
}

export async function apply(ctx, options = {}) {
  const service = await createRpLastStepHost(ctx, options);
  const routes = createRpLastStepRoutes(service);
  ctx.provide('rpLastStep', service);
  const unregister = [
    ctx.connection.fetch.register({ path: '/api/rp-last-step/request', methods: ['POST'], requestBody: 'buffered', fetch: (request) => routes.request(request) }),
    ctx.connection.fetch.register({ path: '/api/rp-last-step/events', methods: ['GET'], requestBody: 'buffered', fetch: (request) => routes.events(request) }),
  ];
  ctx.effect(() => async () => { routes.close(); await service.close(); for (const dispose of unregister) await dispose(); }, 'RP last-step runtime');
}
