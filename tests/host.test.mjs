import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {createHash} from 'node:crypto';
import { createPresetStore } from '../src/store.mjs';
import {PresetError} from '../src/core.mjs';
import * as module from '../src/host.mjs';
import {baseEvents,replacement} from './fixtures/narrative-events.mjs';
const entry = (id, content, extra = {}) => ({ id, name: id, content, role: 'system', order: 0, enabled: true, required: false, locked: false, phase: 'render', ...extra });
const ready = (entries = [entry('style', 'Use quiet prose.')]) => ({ id: 'preset', name: 'Preset', version: 1, status: 'ready', sourceId: null, entries });
const packet = { playerAction: 'Try the gate', resolvedChanges: ['The attempt failed.'], visibleConsequences: ['The gate stays shut.'] };

class Scope {
  listeners = new Map();
  pending = new Set();
  effects = [];
  errors = [];
  on(name, handler) {
    const handlers = this.listeners.get(name) ?? new Set();
    handlers.add(handler); this.listeners.set(name, handlers);
    return () => handlers.delete(handler);
  }
  emit(name, ...args) {
    for (const handler of Array.from(this.listeners.get(name) ?? [])) {
      try {
        const work = Promise.resolve(handler(...args)).catch((error) => this.errors.push(error));
        this.pending.add(work); void work.finally(() => this.pending.delete(work));
      } catch (error) { this.errors.push(error); }
    }
  }
  async flush() { while (this.pending.size) await Promise.all(this.pending); }
  effect(factory) {
    const cleanup = factory();
    if (cleanup !== undefined && cleanup !== null && typeof cleanup !== 'function') throw new TypeError('Invalid effect');
    this.effects.push(cleanup);
    return cleanup;
  }
  async close() { for (const cleanup of this.effects.splice(0).reverse()) await cleanup?.(); }
  count() { return [...this.listeners.values()].reduce((count, handlers) => count + handlers.size, 0); }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'rpls-host-'));
  const store = await createPresetStore({ directory: join(directory, 'presets') });
  if (options.persisted) {
    await store.saveProfile(ready(options.entries), { expectedRevision: 0 });
    await store.bindSession('story', { profileId: 'preset', version: 1, expectedRevision: 1 });
  }
  const ctx = new Scope();
  const ctxTools = new Map();
  const globalTools = new Map();
  const toolScopes = new Map();
  const contexts = new Map();
  const toolProviders = new Set();
  const fetchRoutes = new Map();
  const skillEntries = new Map();
  const peer = { principal: { kind: 'owner' } };
  const calls = [];
  const remoteCalls = [];
  const presentations = [];
  const stages = options.stages ?? [{ commit: true }, 'The gate stays shut.'];
  const agents = new Map();
  const makeAgent = (id, extra = {}) => {
    const scope = { own: id === 'story' ? ctxTools : new Map(), denials: new Set(), mode: options.toolModes?.[id], ...extra };
    const agent = {
      id, options: { provider: 'local', model: 'base', reasoningEffort: 'high' },
      session: { id, header: { id }, inheritedEventCount:0, requestHeader: () => ({ config: { provider: 'local', model: 'main-header', reasoningEffort: 'high', maxTokens: 500 } }),
        snapshotEvents: () => [], deriveMessages: () => [{ id: 'assistant-1', role: 'assistant', content: [{ type: 'tool-call', name: 'rp_present', id: 'call-1', arguments: '{}' }] }],
        append: () => { throw new Error('Session observers must never append'); },
      },
      ctx: { tools: {
        register: (tool) => { scope.own.set(tool.name, tool); ctx.emit('tools/change'); return () => { scope.own.delete(tool.name); ctx.emit('tools/change'); }; },
        restrict: ({ deny }) => { const denied = new Set(deny); scope.denials.add(denied); ctx.emit('tools/change'); return () => { scope.denials.delete(denied); ctx.emit('tools/change'); }; },
      } },
    };
    toolScopes.set(agent, scope);
    return agent;
  };
  agents.set('story', makeAgent('story'));
  agents.set('code', makeAgent('code'));
  let current = agents.get('story');
  ctx.agents = { get: (id) => agents.get(id), list: () => [...agents.values()], currentInitiator: () => current };
  const effectiveMode = (agent) => {
    const scope = toolScopes.get(agent);
    return scope?.mode ?? (scope?.parent ? effectiveMode(scope.parent) : options.defaultToolMode ?? 'native');
  };
  const visibleTool = (name, agent) => {
    if (name === 'run_code') return effectiveMode(agent) === 'ptc' ? { name: 'run_code' } : undefined;
    const scope = toolScopes.get(agent);
    if (scope?.own.has(name)) return scope.own.get(name);
    if ([...scope?.denials ?? []].some((denied) => denied.has(name))) return undefined;
    return scope?.parent ? visibleTool(name, scope.parent) : globalTools.get(name);
  };
  const schemas = (agent) => {
    const names = new Set(globalTools.keys());
    for (let current = agent; current; current = toolScopes.get(current)?.parent) for (const name of toolScopes.get(current).own.keys()) names.add(name);
    if (effectiveMode(agent) === 'ptc') names.add('run_code');
    return [...names].map((name) => visibleTool(name, agent)).filter(Boolean).map(({ name, parameters = {} }) => ({ name, parameters }));
  };
  ctx.tools = {
    register: (tool) => { globalTools.set(tool.name, tool); ctx.emit('tools/change'); return () => { globalTools.delete(tool.name); ctx.emit('tools/change'); }; },
    get: visibleTool, schemas,
  };
  ctx.systemPrompt = {
    context: (context) => { contexts.set(context.name, context); return () => contexts.delete(context.name); },
    tools: (provider) => { toolProviders.add(provider); return () => toolProviders.delete(provider); },
  };
  ctx.connection = { browserPeer: peer, fetch: { register: (route) => { fetchRoutes.set(route.path, route); return async () => fetchRoutes.delete(route.path); } } };
  const services = { skills: { register: (skill) => { skillEntries.set(skill.name, skill); return () => skillEntries.delete(skill.name); } }, ...options.services };
  ctx.get = (name) => services[name];
  ctx.provide = (name, value) => { services[name] = value; };
  const injections = [];
  ctx.inject = (names, callback) => {
    if (!names.every((name) => services[name])) return;
    const child = new Scope();
    for (const name of names) child[name] = services[name];
    injections.push(child); callback(child);
  };
  ctx.typertGateway = { stream: async (request) => {
    remoteCalls.push(request);
    assert.equal(request.peer, peer);
    assert.equal(request.namespace, 'session'); assert.equal(request.method, 'follow');
    const id = request.args.request.address.sessionId;
    if (id === 'denied') throw Object.assign(new Error('owner denied private data'), { code: 'gateway/forbidden' });
    if (id === 'missing') throw Object.assign(new Error('private path'), { code: 'session/not-found' });
    if (options.remote) return options.remote(request);
    if (!agents.has(id)) agents.set(id, makeAgent(id));
    return (async function* () { yield { type: 'snapshot', header: { id }, records: [], cursor: -1, hasMore: false, projections: { values: options.projections?.[id] ?? {}, asOfSeq: -1 } }; })();
  } };
  ctx.llm = { prepareCall: async (config, signal) => {
    calls.push({ config, signal });
    return { config, stream: async function* (request) {
      calls.at(-1).request = request;
      let stage = stages.shift();
      if (typeof stage === 'function') stage = await stage(request);
      if (stage instanceof Error) throw stage;
      const text = typeof stage === 'string' ? stage : JSON.stringify(stage);
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 5, outputTokens: 3, private: 'secret' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
  ctx.on('rp-last-step/presentation', (event) => presentations.push(event));
  assert.equal(typeof module.createRpLastStepHost, 'function');
  const hostOptions = { directory, store, skillText: '---\nname: adapting-sillytavern-rp-presets\ndescription: Adapt imported RP presets.\n---\nBundled migration instructions.', skillReference: 'Bundled reference.', skillDirectory: join(directory, 'bundled-skill'), ...options.host };
  let host;
  t.after(async () => { await ctx.close(); await host?.close(); for (const child of injections) await child.close(); await ctx.flush(); await rm(directory, { recursive: true, force: true }); });
  if (options.plugin) {
    const result = await module.apply(ctx, hostOptions);
    // Cordis awaits async apply and collects only a function or nullable result.
    ctx.effect(() => result);
    host = services.rpLastStep;
  } else host = await module.createRpLastStepHost(ctx, hostOptions);
  const surface = (agent) => {
    const visible = schemas(agent);
    return effectiveMode(agent) === 'ptc' ? { tools: visible.filter((tool) => tool.name === 'run_code'), sections: [{ name: 'tools:sdk', text: visible.filter((tool) => tool.name !== 'run_code').map((tool) => tool.name).join('\n') }] } : { tools: visible, sections: [] };
  };
  return { ctx, host, store, directory, ctxTools, globalTools, toolScopes, surface, makeAgent, contexts, toolProviders, services, injections, fetchRoutes, skillEntries, agents, calls, remoteCalls, presentations, current: (id) => { current = agents.get(id); } };
}

async function bind(f, profile = ready()) {
  const saved = await f.host.saveProfile({ profile, expectedRevision: (await f.store.snapshot()).revision });
  await f.host.bindSession({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
}

async function revisionFixture(t,{legacy=false,stages,projection:providedProjection}={}){
  const commands=new Map(),counts={gm:0,prepare:0,main:0},guards=new Set(),events=[];
  let activeReceiptId='fact-1',factRevision=1,pendingCandidateId=null,dispatchArgs,accept=true,work=Promise.resolve(),turn=0;
  const projection=()=>providedProjection??{schemaVersion:1,latestRoundId:'round',groups:[{roundId:'round',source:{sessionId:'story'},activeReceiptId,factRevision,pendingCandidateId}]};
  const services={commands:{register(def){commands.set(def.name,def);return()=>commands.delete(def.name);}},...legacy?{}:{rpDatabase:{capabilities:{factReview:1},factReviewProjection:async()=>projection()}},rpGM:{binding:async()=>legacy?null:{id:'gm'},storyState:async()=>({lastFactReceipt:{id:activeReceiptId}}),presentation:async({factReceiptId})=>{counts.gm++;if(factReceiptId!==activeReceiptId)throw new PresetError('FACT_VERSION_SUPERSEDED','Old facts',409);return{factReceipt:{id:factReceiptId,kind:'turn',...legacy?{}:{factRoundId:'round',factRevision}},packet,story:{title:'Gate'}};}},rpContext:{prepare:async()=>{counts.prepare++;return{id:'frozen',authorNote:{id:'note',version:1,claimId:'claim'},materials:{entries:[],history:[],recentProse:[],guidance:'Frozen context'}};}}};
  const f=await fixture(t,{services,stages:stages??[{commit:true},'Original prose.','New prose.']}),agent=f.agents.get('story');await bind(f);
  agent.status='idle';agent.session.header={id:'story'};agent.session.snapshotEvents=()=>structuredClone(events);agent.session.deriveMessages=()=>events.filter(event=>event.type==='assistant/message').map(event=>event.data.message);
  const append=(type,data,intent={})=>{const event={seq:events.length,type,data:structuredClone(data),...intent};events.push(event);f.ctx.emit('session/event',agent.session,event);return event;};agent.session.append=append;
  agent.ctx.tools.guard=guard=>{guards.add(guard);return()=>guards.delete(guard);};
  async function canonical(args,currentTurn){
    const callId='call-'+events.length,assistant='assistant-'+events.length;
    append('assistant/message',{turn:currentTurn,step:1,message:{id:assistant,role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:callId,name:'rp_present',arguments:JSON.stringify(args)}]}},{surfaceOp:'append'});
    const call=append('tool/call',{turn:currentTurn,step:1,name:'rp_present',callId,arguments:JSON.stringify(args)}),tool=f.ctxTools.get('rp_present');
    const exec={agent,name:'rp_present',arguments:args,callId,rootCallId:callId,signal:new AbortController().signal,concludeTurn(){}};
    for(const guard of guards){const denied=guard(exec);if(denied)throw new PresetError('TOOL_DENIED',denied,409);}
    let result;try{result=await tool.execute(args,exec);}catch(error){append('tool/result',{turn:currentTurn,step:1,message:{id:'failure-'+callId,role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:true,content:[{type:'text',text:error.code??'Failed'}]}},{surfaceOp:'append',sourceEventSeqs:[call.seq]});await f.ctx.flush();throw error;}
    if(accept)append('tool/result',{turn:currentTurn,step:1,message:{id:'result-'+callId,role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:false,content:tool.output.render(args,result)},meta:tool.output.presentationMeta(args,result)},{surfaceOp:'append',sourceEventSeqs:[call.seq]});
    await f.ctx.flush();return result;
  }
  const next=async proposal=>{const handlers=[...f.ctx.listeners.get('agent/pre-step')??[]];const step=index=>handlers[index]?handlers[index](proposal,()=>step(index+1)):Promise.resolve({kind:'enter',messages:proposal.messages});return step(0);};
  agent.followup=message=>{agent.status='running';work=Promise.resolve().then(async()=>{turn++;append('turn/start',{turn});const decision=await next({agent,turn,step:1,messages:[message],signal:new AbortController().signal});if(decision.kind==='enter'){counts.main++;const instruction=message.content[0].text;const args=dispatchArgs??JSON.parse(instruction.match(/rp_present\((\{.*\})\)/u)[1]);await canonical(args,turn).catch(()=>{});}append('turn/end',{turn,reason:{kind:'completed'}});await f.ctx.flush();}).finally(()=>{agent.status='idle';});};agent.whenIdle=()=>work;agent.cancel=()=>{};
  f.ctx.typertGateway.invoke=async request=>{const [,name,args]=/^\/([^ ]+)\s+(.*)$/u.exec(request.args.line),commandId='command-'+events.length;append('command/run',{commandId,name,args,source:{kind:'user'}});const result=await commands.get(name).handler({agent,rawInput:args,commandId,signal:request.signal});append('command/done',{commandId,result});return{commandId,result};};
  return{...f,agent,events,counts,guards,canonical:async args=>{turn++;append('turn/start',{turn});const result=await canonical(args,turn);append('turn/end',{turn,reason:{kind:'completed'}});await f.ctx.flush();return result;},setFact:(id,revision)=>{activeReceiptId=id;factRevision=revision;},pending:id=>{pendingCandidateId=id;},setDispatchArgs:value=>{dispatchArgs=value;},setAccept:value=>{accept=value;}};
}

test('owner prose regeneration accepts a new canonical result, preserves old bytes and replays before stale ref checks',async t=>{
  const f=await revisionFixture(t),first=await f.canonical({factReceiptId:'fact-1'}),before=structuredClone(f.events),ref=(await f.host.narratives({sessionId:'story'})).records[0].ref;
  assert.equal(typeof f.host.regenerateProse,'function');
  const request={sessionId:'story',basedOn:ref,operationId:'owner-prose-1',instruction:'Shorter.'},result=await f.host.regenerateProse(request);
  assert.equal(result.status,'complete');assert.notEqual(result.presentationId,first.id);assert.deepEqual(f.events.slice(0,before.length),before);
  assert.deepEqual(f.counts,{gm:1,prepare:1,main:1});assert.equal(f.calls.length,3);assert.equal(JSON.parse(f.calls.at(-1).request.messages[0].content[0].text).instruction,'Shorter.');
  assert.equal((await f.host.storyHistory({sessionId:'story'})).records[0].text,'New prose.');assert.equal((await f.host.narratives({sessionId:'story'})).records.length,2);
  const material=await f.host.material({sessionId:'story',presentationId:result.presentationId}),normalized={basedOn:{assistantMessageId:ref.assistantMessageId,baseResultSeq:ref.baseResultSeq,callSeq:ref.callSeq,presentationId:ref.presentationId,resultSeq:ref.resultSeq,sessionId:'story'},instruction:'Shorter.',kind:'regenerate-prose',schemaVersion:1,sessionId:'story'},requestHash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  assert.deepEqual(material.ownerOperation,{schemaVersion:1,kind:'regenerate-prose',operationId:'owner-prose-1',requestHash});
  const args=f.events.find(event=>event.type==='command/run').data.args.trim().split(/\s+/u);assert.equal(args.length,3);assert.equal(args[0],'owner-prose-1');assert.equal(args[1],requestHash);
  const size=f.events.length;assert.deepEqual(await f.host.regenerateProse(request),result);assert.equal(f.events.length,size);
  await assert.rejects(f.host.regenerateProse({...request,instruction:'Changed.'}),{code:'OPERATION_ID_CONFLICT'});
  await assert.rejects(f.host.regenerateProse({...request,operationId:'new-op'}),{code:'NARRATIVE_CONFLICT'});assert.equal(f.guards.size,0);
});

test('owner dispatch cannot call wrong tools or IDs and requires genuine canonical acceptance',async t=>{
  const f=await revisionFixture(t);await f.canonical({factReceiptId:'fact-1'});const ref=(await f.host.narratives({sessionId:'story'})).records[0].ref;
  f.setDispatchArgs({regenerateOf:'wrong'});const denied=await f.host.regenerateProse({sessionId:'story',basedOn:ref,operationId:'wrong'});assert.equal(denied.status,'failed');assert.equal(f.calls.length,2);assert.equal(f.guards.size,0);
  await assert.rejects(f.host.present({sessionId:'story',agent:f.agent,contextKey:'outside',regenerateOf:ref.presentationId}),{code:'OWNER_OPERATION_REQUIRED'});
  f.setDispatchArgs(undefined);f.setAccept(false);const missing=await f.host.regenerateProse({sessionId:'story',basedOn:ref,operationId:'unaccepted'});assert.equal(missing.status,'failed');assert.equal((await f.host.storyHistory({sessionId:'story'})).records[0].text,'Original prose.');assert.equal(f.guards.size,0);
});

test('completed owner replay requires agreement with the complete actual canonical metadata',async t=>{
  const f=await revisionFixture(t);await f.canonical({factReceiptId:'fact-1'});const basedOn=(await f.host.narratives({sessionId:'story'})).records[0].ref,request={sessionId:'story',basedOn,operationId:'metadata-proof'};
  const result=await f.host.regenerateProse(request),event=f.events.find(item=>item.data?.meta?.rpLastStep?.record?.id===result.presentationId);event.data.meta.rpLastStep.record.models.render.model='foreign-writer';
  await assert.rejects(f.host.regenerateProse(request),{code:'NARRATIVE_CONFLICT'});assert.equal(f.calls.length,3);
});

test('cancelling owner regeneration aborts its writer and releases the dispatch scope without replacing the old body',async t=>{
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),hold=new Promise(resolve=>{release=resolve;});
  const f=await revisionFixture(t,{stages:[{commit:true},'Original prose.',async()=>{entered();await hold;return'Cancelled new prose.';}]}),first=await f.canonical({factReceiptId:'fact-1'}),basedOn=(await f.host.narratives({sessionId:'story'})).records[0].ref,controller=new AbortController();
  const pending=f.host.regenerateProse({sessionId:'story',basedOn,operationId:'cancelled',signal:controller.signal});await started;controller.abort();release();
  assert.equal((await pending).status,'interrupted');await f.agent.whenIdle();assert.equal(f.guards.size,0);assert.equal((await f.host.storyHistory({sessionId:'story'})).records[0].ref.presentationId,first.id);assert.equal((await f.host.narratives({sessionId:'story'})).records.length,1);
});

test('presentFact uses the selected receipt and same-fact frozen failure; superseded failures cannot retry',async t=>{
  const f=await revisionFixture(t,{stages:[{commit:true},new Error('writer failed'),'Recovered prose.']});
  assert.equal(typeof f.host.presentFact,'function');const failed=await f.host.presentFact({sessionId:'story',factReceiptId:'fact-1',operationId:'present-1'});assert.equal(failed.status,'failed');
  const summaries=(await f.host.presentationSummaries({sessionId:'story'})).presentations;assert.equal(summaries[0].canRetry,true);
  const recovered=await f.host.presentFact({sessionId:'story',factReceiptId:'fact-1',operationId:'present-2'});assert.equal(recovered.status,'complete');assert.deepEqual(f.counts,{gm:1,prepare:1,main:2});assert.equal(f.calls.length,3);
  const size=f.events.length;await assert.rejects(f.host.presentFact({sessionId:'story',factReceiptId:'fact-1',operationId:'already'}),{code:'FACT_ALREADY_PRESENTED'});assert.equal(f.events.length,size);
  f.setFact('fact-2',2);assert.deepEqual((await f.host.storyHistory({sessionId:'story'})).records,[]);
  assert.equal((await f.host.catalog({sessionId:'story'})).presentations.length,0);
  await assert.rejects(f.host.retryPresentation({sessionId:'story',presentationId:summaries[0].presentationId}),{code:'FACT_VERSION_SUPERSEDED'});
  await assert.rejects(f.host.presentFact({sessionId:'story',factReceiptId:'fact-1',operationId:'old'}),{code:'FACT_VERSION_SUPERSEDED'});
});

test('failed regeneration keeps same-fact old prose and current legacy fact authority is mandatory',async t=>{
  const f=await revisionFixture(t,{stages:[{commit:true},'Original prose.',new Error('writer failure')]}),first=await f.canonical({factReceiptId:'fact-1'}),basedOn=(await f.host.narratives({sessionId:'story'})).records[0].ref;
  const failed=await f.host.regenerateProse({sessionId:'story',basedOn,operationId:'failed-regen'});assert.equal(failed.status,'failed');assert.equal((await f.host.storyHistory({sessionId:'story'})).records[0].ref.presentationId,first.id);
  const summary=(await f.host.presentationSummaries({sessionId:'story'})).presentations.find(item=>item.status==='failed');assert.equal(summary.canRetry,true);
  f.setFact('fact-2',2);assert.equal((await f.host.presentationSummaries({sessionId:'story'})).presentations.find(item=>item.presentationId===summary.presentationId).retryBlockCode,'FACT_VERSION_SUPERSEDED');assert.equal((await f.host.catalog({sessionId:'story'})).presentations.length,0);
  const old=await revisionFixture(t,{legacy:true});await old.canonical({factReceiptId:'fact-1'});const ref=(await old.host.narratives({sessionId:'story'})).records[0].ref;delete old.services.rpGM.storyState;
  await assert.rejects(old.host.regenerateProse({sessionId:'story',basedOn:ref,operationId:'no-authority'}),{code:'EFFECTIVE_HISTORY_UNAVAILABLE'});
  old.services.rpGM.storyState=async()=>({lastFactReceipt:{id:'different'}});await assert.rejects(old.host.regenerateProse({sessionId:'story',basedOn:ref,operationId:'stale-legacy'}),{code:'FACT_VERSION_SUPERSEDED'});assert.equal(old.calls.length,2);
});

test('pending fact reviews and missing current authority stop prose operations while pure legacy packets work',async t=>{
  const f=await revisionFixture(t);await f.canonical({factReceiptId:'fact-1'});const ref=(await f.host.narratives({sessionId:'story'})).records[0].ref;
  f.pending('candidate');await assert.rejects(f.host.regenerateProse({sessionId:'story',basedOn:ref,operationId:'pending'}),{code:'FACT_REVIEW_PENDING'});
  f.pending(null);delete f.services.rpDatabase;await assert.rejects(f.host.storyHistory({sessionId:'story'}),{code:'EFFECTIVE_HISTORY_UNAVAILABLE'});
  const old=await revisionFixture(t,{legacy:true});await old.canonical({packet});const oldRef=(await old.host.narratives({sessionId:'story'})).records[0].ref;assert.equal((await old.host.regenerateProse({sessionId:'story',basedOn:oldRef,operationId:'legacy'})).status,'complete');
});

test('revision transfer validates optional metadata and canonical source agreement without copying Database truth',async t=>{
  const source=await revisionFixture(t);await source.canonical({factReceiptId:'fact-1'});const basedOn=(await source.host.narratives({sessionId:'story'})).records[0].ref;
  const request={sessionId:'story',basedOn,operationId:'saved-regeneration'},result=await source.host.regenerateProse(request),state=await source.host.exportState({sessionIds:['story']});
  const destination=await revisionFixture(t);destination.events.push(...structuredClone(source.events));
  const forged=structuredClone(state),receipt=forged.payload.receipts.find(item=>item.id===result.presentationId);receipt.narrativeVersion.factRevision='current';
  assert.equal((await destination.host.preflightRestore({sessionIds:['story'],state:forged})).supported,false);
  const changed=structuredClone(state);changed.payload.receipts.find(item=>item.id===result.presentationId).narrativeVersion.factRevision=2;
  await assert.rejects(destination.host.restoreState({sessionIds:['story'],state:changed,restoreId:'forged-version',expectedRevision:(await destination.host.contentRevision()).revision}),{code:'RESTORE_PAYLOAD_INVALID'});
  await destination.host.restoreState({sessionIds:['story'],state,restoreId:'revision-transfer',expectedRevision:(await destination.host.contentRevision()).revision});
  assert.equal(destination.calls.length,0);assert.equal((await destination.host.storyHistory({sessionId:'story'})).records[0].ref.presentationId,result.presentationId);
  assert.deepEqual(await destination.host.regenerateProse(request),result);assert.equal(destination.calls.length,0);
  const missing=await revisionFixture(t,{legacy:true});missing.events.push(...structuredClone(source.events));
  assert.equal((await missing.host.preflightRestore({sessionIds:['story'],state})).supported,false);
});

function acceptedEvents(result){
  const events=baseEvents();
  events[3].data.message.id='assistant-1';events[3].data.message.content[0]={type:'tool-call',id:'call-1',name:'rp_present',arguments:JSON.stringify({factReceiptId:result.factReceiptId})};
  events[4].data.callId='call-1';events[4].data.arguments=events[3].data.message.content[0].arguments;
  events[5].data.message.source.callId='call-1';events[5].data.message.toolCallId='call-1';events[5].data.message.content[0].text=result.text;events[5].data.meta.rpLastStep.record={...result,status:'complete'};
  return events;
}

function retryEvents(result,rewriteOf){
  const events=acceptedEvents(result).slice(1).map(event=>({...event,seq:event.seq+6}));
  for(const event of events)if(event.data.turn!==undefined)event.data.turn=2;
  events[2].data.message.id='assistant-retry';events[2].data.message.content[0]={type:'tool-call',id:'call-retry',name:'rp_present',arguments:JSON.stringify({rewriteOf})};
  events[3].data.callId='call-retry';events[3].data.arguments=events[2].data.message.content[0].arguments;
  events[4].sourceEventSeqs=[10];events[4].data.message.source.callId='call-retry';events[4].data.message.toolCallId='call-retry';return events;
}

test('a completed identical fact context replays before the strict GM resolver',async t=>{
  let gmCalls=0;const contextKey='["story","assistant-1","call-1"]';
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async input=>{gmCalls++;if((await f.host.narratives({sessionId:input.sessionId,agent:input.agent})).records.some(record=>record.factReceiptId===input.factReceiptId))throw new PresetError('FACT_ALREADY_PRESENTED','Already formal',409);return{factReceipt:{id:input.factReceiptId,kind:'opening',openingText:'Exact opening.'},packet:{playerAction:'Begin.'},story:{title:'The Gate'}};}}}});await bind(f);
  const request={sessionId:'story',agent:f.agents.get('story'),contextKey,factReceiptId:'fact-once',callId:'call-1'},first=await f.host.present(request);
  const events=acceptedEvents(first);f.agents.get('story').session.snapshotEvents=()=>events;await f.host.commit({sessionId:'story',presentationId:first.id,seq:5});
  const replay=await f.host.present(request);
  assert.equal(replay.id,first.id);assert.equal(replay.text,'Exact opening.');assert.equal(replay.status,'complete');assert.equal(replay.factReceiptId,'fact-once');assert.equal(gmCalls,1);assert.equal(f.calls.length,0);
  events.push({seq:7,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:5},sourceEventSeqs:[2,3,5],data:{source:{kind:'compact-checkpoint'}}});
  assert.equal((await f.host.present(request)).id,first.id);assert.equal(gmCalls,1);
  await assert.rejects(f.host.present({...request,factReceiptId:'different-fact'}),{code:'INVALID_FACT_RECEIPT'});assert.equal(gmCalls,1);
  assert.equal((await f.host.state('story')).presentations.length,1);
});

test('canonical acceptance allows identical replay while receipt completion bookkeeping lags',async t=>{
  let gmCalls=0;
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async input=>{gmCalls++;if((await f.host.narratives({sessionId:input.sessionId,agent:input.agent})).records.some(record=>record.factReceiptId===input.factReceiptId))throw new PresetError('FACT_ALREADY_PRESENTED','Already formal',409);return{factReceipt:{id:'fact-lag',kind:'turn'},packet,story:{title:'The Gate'}};}}}});await bind(f);
  const request={sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-lag'},first=await f.host.present(request);
  assert.equal(first.status,'rendered');f.agents.get('story').session.snapshotEvents=()=>acceptedEvents(first);
  await assert.rejects(f.host.present({...request,factReceiptId:'different-fact'}),{code:'INVALID_FACT_RECEIPT'});
  assert.equal((await f.host.material({sessionId:'story',presentationId:first.id})).status,'rendered');
  const replay=await f.host.present(request);
  assert.equal(replay.id,first.id);assert.equal(replay.status,'complete');assert.equal(gmCalls,1);assert.equal(f.calls.length,2);assert.equal((await f.host.state('story')).presentations.length,1);
});

test('a new context still reaches the strict GM rule against duplicate formal facts',async t=>{
  let gmCalls=0;
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm',status:'starting'}),presentation:async input=>{gmCalls++;if((await f.host.narratives({sessionId:input.sessionId,agent:input.agent})).records.some(record=>record.factReceiptId===input.factReceiptId))throw new PresetError('FACT_ALREADY_PRESENTED','Already formal despite a lagging story flag',409);return{factReceipt:{id:'fact-once',kind:'opening',openingText:'Only one opening.'},packet:{playerAction:'Begin.'}};}}}});await bind(f);
  const request={sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-once'},first=await f.host.present(request);
  f.agents.get('story').session.snapshotEvents=()=>acceptedEvents(first);await f.host.commit({sessionId:'story',presentationId:first.id,seq:5});
  await assert.rejects(f.host.present({...request,contextKey:'["story","new-assistant","new-call"]'}),{code:'FACT_ALREADY_PRESENTED'});
  assert.equal(gmCalls,2);assert.equal(f.calls.length,0);assert.equal((await f.host.state('story')).presentations.length,1);
});

test('rewound complete fact contexts cannot replay archived prose or bypass active source checks',async t=>{
  let gmCalls=0,sourceActive=true;
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>{gmCalls++;if(!sourceActive)throw new PresetError('INACTIVE_SOURCE','Source was rewound',409);return{factReceipt:{id:'fact-old',kind:'opening',openingText:'Archived opening.'},packet:{playerAction:'Begin.'}};}}}});await bind(f);
  const request={sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-old'},first=await f.host.present(request),events=acceptedEvents(first);
  f.agents.get('story').session.snapshotEvents=()=>events;await f.host.commit({sessionId:'story',presentationId:first.id,seq:5});
  events.push({seq:7,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:5},data:{source:{kind:'runtime-context'}}});sourceActive=false;
  await assert.rejects(f.host.present(request),{code:'INACTIVE_SOURCE'});
  assert.equal(gmCalls,1);assert.equal(f.calls.length,0);assert.equal((await f.host.material({sessionId:'story',presentationId:first.id})).status,'complete');
});

test('fresh superseded fact receipt errors propagate without creating presentation work',async t=>{
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>{throw new PresetError('FACT_RECEIPT_SUPERSEDED','A later accepted factual receipt supersedes this one',409);}}}});await bind(f);
  await assert.rejects(f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'new-context',factReceiptId:'older-unresolved'}),{code:'FACT_RECEIPT_SUPERSEDED'});
  assert.equal(f.calls.length,0);assert.deepEqual((await f.host.state('story')).presentations,[]);
});

test('presentation summaries use centralized active-family eligibility and truthful native retry capability',async t=>{
  const registered=new Map(),f=await fixture(t,{stages:[{commit:true},new Error('writer unavailable')],services:{commands:{register:definition=>{registered.set(definition.name,definition);return()=>registered.delete(definition.name);}}}});await bind(f);
  const events=baseEvents();events[3].data.message.id='assistant-1';events[3].data.message.content[0].id='call-1';f.agents.get('story').session.snapshotEvents=()=>events;
  await assert.rejects(f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet}));
  const state=await f.host.state('story'),result=await f.host.presentationSummaries({sessionId:'story'}),summary=result.presentations[0];
  assert.equal(summary.presentationId,state.presentations[0].id);assert.equal(summary.status,'failed');assert.equal(summary.canRetry,true);assert.equal(summary.errorCode,'MODEL_CALL_FAILED');assert.equal(summary.text,undefined);assert.equal(summary.packet,undefined);assert.equal(result.capabilities.retryDispatch,false);assert.equal(state.presentations[0].presentationId,undefined);
  const agent=f.agents.get('story');agent.status='idle';agent.followup=()=>{};agent.whenIdle=async()=>{};agent.ctx.tools.guard=()=>()=>{};f.ctx.typertGateway.invoke=async()=>({});
  assert.equal((await f.host.presentationSummaries({sessionId:'story'})).capabilities.retryDispatch,true);agent.status='running';assert.equal((await f.host.presentationSummaries({sessionId:'story'})).capabilities.retryDispatch,false);agent.status='idle';
  events.push({seq:7,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:5},data:{source:{kind:'runtime-context'}}});
  const inactive=(await f.host.presentationSummaries({sessionId:'story'})).presentations[0];assert.equal(inactive.canRetry,false);assert.equal(inactive.retryBlockCode,'REWRITE_SOURCE_INACTIVE');
  await assert.rejects(f.host.retryPresentation({sessionId:'story',presentationId:summary.presentationId}),{code:'REWRITE_SOURCE_INACTIVE'});
  await assert.rejects(f.host.presentationSummaries({sessionId:'denied'}),{code:'FORBIDDEN'});
});

test('GM opening receipt uses exact owner prose through the terminal receipt without any model call',async t=>{
  const factReceipt={schemaVersion:1,id:'fact-opening',kind:'opening',openingText:'  Exact opening.\nOwner-selected.  ',packet:{playerAction:'Begin the story.'}};
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm-story'}),presentation:async input=>{assert.equal(input.factReceiptId,'fact-opening');assert.equal(input.agent.session.id,'story');return{factReceipt,packet:factReceipt.packet,story:{title:'The Gate'}}}}}});
  await bind(f);
  await assert.rejects(f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'legacy',packet}),{code:'FACT_RECEIPT_REQUIRED'});
  const result=await f.ctxTools.get('rp_present').execute({factReceiptId:'fact-opening'},{agent:f.agents.get('story'),callId:'call-1',rootCallId:'call-1',signal:new AbortController().signal,concludeTurn(){}});
  assert.equal(result.text,'  Exact opening.\nOwner-selected.  ');
  assert.equal(result.factReceiptId,'fact-opening');
  assert.equal(f.ctxTools.get('rp_present').output.presentationMeta({},result).rpLastStep.record.factReceiptId,'fact-opening');
  assert.equal(result.status,'rendered');assert.equal(f.calls.length,0);
  const material=await f.host.material({sessionId:'story',presentationId:result.id});
  assert.deepEqual(material.packet,factReceipt.packet);assert.equal(material.status,'rendered');
  assert.equal(material.factReceiptRef,'fact-opening');
  assert.equal(material.contextPreparation,null);
});

test('ordinary GM receipt passes exact identities and story to frozen Context and accepted outcome',async t=>{
  const outcomes=[],prepared=[],factReceipt={schemaVersion:1,id:'fact-turn',kind:'turn',packet};
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>({factReceipt,packet,story:{title:'Gate',examples:'Short lines.'}})},rpContext:{prepare:async input=>{prepared.push(input);return{id:'material',authorNote:{id:'note',version:2,claimId:'claim'},materials:{entries:[],history:[],recentProse:[],guidance:'Author note: wait.'}}},presentationOutcome:async input=>outcomes.push(input)}}});
  await bind(f);
  const result=await f.ctxTools.get('rp_present').execute({factReceiptId:'fact-turn'},{agent:f.agents.get('story'),callId:'call-1',rootCallId:'call-1',signal:new AbortController().signal,concludeTurn(){}});
  assert.equal(result.factReceiptId,'fact-turn');
  assert.equal(f.ctxTools.get('rp_present').output.presentationMeta({},result).rpLastStep.record.factReceiptId,'fact-turn');
  assert.equal(prepared[0].presentationId,result.id);assert.equal(prepared[0].factReceiptId,'fact-turn');assert.equal(prepared[0].story.title,'Gate');
  f.ctx.emit('session/event',f.agents.get('story').session,{type:'tool/call',seq:10,data:{name:'rp_present',callId:'call-1'}});
  f.ctx.emit('session/event',f.agents.get('story').session,{type:'tool/result',seq:11,data:{message:{role:'tool',source:{kind:'tool',callId:'call-1'},toolCallId:'call-1',isError:false,content:[{type:'text',text:result.text}]},meta:{rpLastStep:{schemaVersion:1,record:{...result,status:'complete'}}}}});
  await f.ctx.flush();
  assert.equal(outcomes.at(-1).presentationId,result.id);assert.equal(outcomes.at(-1).status,'accepted');
  const material=await f.host.material({sessionId:'story',presentationId:result.id});
  assert.equal(material.contextPreparation.authorNote.claimId,'claim');
  assert.equal(material.factReceiptRef,'fact-turn');
  await assert.rejects(f.host.material({sessionId:'denied',presentationId:result.id}),{code:'FORBIDDEN'});
});

test('owner material audit reads a pre-freeze failure without a live narrative reader or model work',async t=>{
  let preparations=0;
  const f=await fixture(t,{services:{rpContext:{prepare:async()=>{preparations++;throw new Error('Material service unavailable');}}}});await bind(f);
  await assert.rejects(f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'failed-capture',packet}));
  const failed=(await f.host.state('story')).presentations[0];
  f.agents.get('story').session.snapshotEvents=undefined;
  const material=await f.host.material({sessionId:'story',presentationId:failed.id});
  assert.equal(material.status,'failed');assert.equal(material.contextPreparation,null);assert.equal(material.compiled,null);assert.deepEqual(material.packet,packet);
  assert.equal(preparations,1);assert.equal(f.calls.length,0);
  await assert.rejects(f.host.material({sessionId:'denied',presentationId:failed.id}),{code:'FORBIDDEN'});
  await assert.rejects(f.host.material({sessionId:'code',presentationId:failed.id}),{code:'RECEIPT_NOT_FOUND'});
});

test('failed and retry material audits preserve fact association and the exact captured note through acceptance',async t=>{
  let gmCalls=0,preparations=0;const note={id:'note-original',version:3,claimId:'original-claim'},outcomes=[],acceptedAudits=[];
  const f=await fixture(t,{stages:[{commit:true},new Error('writer unavailable'),'Recovered prose.'],services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>{gmCalls++;return{factReceipt:{id:'fact-retry',kind:'turn'},packet,story:{title:'The Gate'}};}},rpContext:{prepare:async()=>{preparations++;return{id:'frozen',authorNote:structuredClone(note),materials:{entries:[],history:[],recentProse:[],guidance:'Keep the failure.'}};},presentationOutcome:async input=>{outcomes.push(input);if(input.status==='accepted')acceptedAudits.push(await f.host.material({sessionId:input.sessionId,presentationId:input.presentationId}));}}}});
  await bind(f);const events=baseEvents();events[3].data.message.id='assistant-1';events[3].data.message.content[0].id='call-1';events[5].data.message.isError=true;delete events[5].data.meta;
  events.push({seq:8,type:'assistant/message',surfaceOp:'append',data:{turn:2,step:1,message:{id:'retry-assistant',role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:'retry-call',name:'rp_present',arguments:'{}'}]}}});
  f.agents.get('story').session.snapshotEvents=()=>events;
  await assert.rejects(f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-retry'}));
  const failed=(await f.host.state('story')).presentations[0],failureAudit=await f.host.material({sessionId:'story',presentationId:failed.id});
  assert.equal(failureAudit.status,'failed');assert.equal(failureAudit.factReceiptRef,'fact-retry');assert.deepEqual(failureAudit.contextPreparation.authorNote,note);assert.equal(Array.isArray(failureAudit.compiled.messages),true);
  const retried=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","retry-assistant","retry-call"]',rewriteOf:failed.id});
  assert.equal(retried.factReceiptId,'fact-retry');assert.equal(f.ctxTools.get('rp_present').output.presentationMeta({},retried).rpLastStep.record.factReceiptId,'fact-retry');
  const retryAudit=await f.host.material({sessionId:'story',presentationId:retried.id});assert.equal(retryAudit.status,'rendered');assert.equal(retryAudit.factReceiptRef,'fact-retry');assert.deepEqual(retryAudit.contextPreparation,failureAudit.contextPreparation);
  await f.host.commit({sessionId:'story',presentationId:retried.id,seq:11});
  assert.equal(acceptedAudits.length,1);assert.equal(acceptedAudits[0].status,'complete');assert.deepEqual(acceptedAudits[0].contextPreparation.authorNote,note);
  assert.equal(outcomes.at(-1).claimId,'original-claim');assert.equal(outcomes.at(-1).presentationId,retried.id);assert.equal(outcomes.at(-1).status,'accepted');
  assert.equal(gmCalls,1);assert.equal(preparations,1);assert.equal(f.calls.length,3);
});

test('authorized draft workflow reads actual narrative revisions and keeps candidates out of formal history',async t=>{
  const f=await fixture(t,{projections:{story:{modelSelection:{next:{provider:'local',model:'owner-next',reasoningEffort:'low'}}}},stages:[{commit:true},'Accepted prose.','Alternative prose.']});await bind(f);
  const result=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet});
  await f.host.commit({sessionId:'story',presentationId:result.id,seq:5});
  const events=baseEvents();events[3].data.message.id='assistant-1';events[3].data.message.content[0].id='call-1';events[4].data.callId='call-1';events[5].data.message.source.callId='call-1';events[5].data.message.toolCallId='call-1';events[5].data.message.content[0].text=result.text;events[5].data.meta.rpLastStep.record={...result,status:'complete'};
  f.agents.get('story').session.snapshotEvents=()=>events;
  const ref=(await f.host.narratives({sessionId:'story'})).records[0].ref,before=f.presentations.length,draftEvents=[];
  f.ctx.on('rp-last-step/draft',event=>draftEvents.push(event));
  const draft=await f.host.createDraft({sessionId:'story',basedOn:ref,instruction:'Shorter.'});
  assert.equal(draft.text,'Alternative prose.');assert.equal(draft.basedOn.resultSeq,5);assert.equal(f.calls.length,3);assert.equal(f.presentations.length,before);
  assert.equal(f.calls[1].config.model,'main-header');assert.equal(f.calls[2].config.model,'owner-next');
  const persisted=JSON.parse(await readFile(join(f.directory,'drafts','drafts.json'),'utf8'));
  assert.equal(persisted.drafts[draft.id].at(-1).models.render.model,'owner-next');assert.equal(draft.models.render.model,'owner-next');
  assert.equal((await f.host.narratives({sessionId:'story'})).records[0].text,'Accepted prose.');
  assert.equal(draftEvents.at(-1).status,'ready');
  const edit=await f.host.editDraft({sessionId:'story',draftId:draft.id,text:'Human wording.',expectedDraftVersion:draft.version});
  assert.equal(edit.kind,'manual');assert.equal((await f.host.drafts({sessionId:'story'})).drafts[0].text,'Human wording.');
  await assert.rejects(f.host.adoptDraft({sessionId:'story',draftId:draft.id,expectedNarrative:ref,expectedDraftVersion:edit.version}),{code:'OWNER_OPERATION_UNAVAILABLE'});
  assert.equal((await f.host.narratives({sessionId:'story'})).records[0].text,'Accepted prose.');
  await assert.rejects(f.host.createDraft({sessionId:'denied',basedOn:{...ref,sessionId:'denied'}}),{code:'FORBIDDEN'});
  await assert.rejects(f.host.createDraft({sessionId:'story',basedOn:{...ref,resultSeq:999}}),{code:'NARRATIVE_CONFLICT'});
});

test('manual-first candidates copy effective adopted prose or owner text without invoking a model',async t=>{
  let gmCalls=0,preparations=0;
  const f=await fixture(t,{stages:[{commit:true},'Original accepted prose.','Unrequested AI draft.'],services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>{gmCalls++;return{factReceipt:{id:'fact-manual',kind:'turn'},packet,story:{title:'The Gate'}};}},rpContext:{prepare:async()=>{preparations++;return{id:'material',materials:{entries:[],history:[],recentProse:[]}};}}}});await bind(f);
  const result=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-manual'});await f.host.commit({sessionId:'story',presentationId:result.id,seq:5});
  const events=baseEvents();events[3].data.message.id='assistant-1';events[3].data.message.content[0].id='call-1';events[4].data.callId='call-1';events[5].data.message.source.callId='call-1';events[5].data.message.toolCallId='call-1';events[5].data.message.content[0].text=result.text;events[5].data.meta.rpLastStep.record={...result,status:'complete'};events.push(replacement(events,'Current adopted prose.'));
  f.agents.get('story').session.snapshotEvents=()=>events;
  const ref=(await f.host.narratives({sessionId:'story'})).records[0].ref,before=f.presentations.length;
  const copied=await f.host.createDraft({sessionId:'story',basedOn:ref,kind:'manual'});
  assert.equal(copied.kind,'manual');assert.equal(copied.status,'ready');assert.equal(copied.text,'Current adopted prose.');assert.equal(copied.factReceiptId,'fact-manual');assert.equal(copied.models,undefined);
  const written=await f.host.createDraft({sessionId:'story',basedOn:ref,kind:'manual',text:'Owner expression.'});assert.equal(written.text,'Owner expression.');
  assert.equal(f.calls.length,2);assert.equal(gmCalls,1);assert.equal(preparations,1);assert.equal(f.presentations.length,before);
  assert.equal((await f.host.narratives({sessionId:'story'})).records[0].text,'Current adopted prose.');
});

test('GM story identity is frozen independently of optional Context for assembly and writer',async t=>{
  const story={title:'The Gate',character:{name:'Mara',assetId:'actor',version:1,extensions:{private:'UNKNOWN_CARD_EXTENSION'}},persona:{name:'Reader',description:'A careful visitor.'},examples:'Quiet speech.',extensions:{script:'INERT_UNKNOWN_SOURCE'}};
  const f=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>({factReceipt:{id:'fact',kind:'turn'},packet,story})}},stages:[request=>{const input=JSON.parse(request.messages[0].content[0].text);assert.equal(input.story.character.name,'Mara');story.character.name='Changed later';return{commit:true};},request=>{const input=JSON.parse(request.messages[0].content[0].text);assert.equal(input.story.character.name,'Mara');assert.equal(input.story.examples,'Quiet speech.');return'Frozen identity prose.';}]});
  await bind(f);const result=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'story-input',factReceiptId:'fact'});
  assert.equal(result.text,'Frozen identity prose.');
  const material=await f.host.material({sessionId:'story',presentationId:result.id});assert.equal(material.storySnapshot.character.name,'Mara');assert.equal(material.storySnapshot.character.extensions,undefined);assert.equal(material.storySnapshot.extensions,undefined);
  material.storySnapshot.character.name='Audit caller edit';assert.equal((await f.host.material({sessionId:'story',presentationId:result.id})).storySnapshot.character.name,'Mara');
});

test('real child ancestry inherits prefix-captured composition and permits only its active parent material',async t=>{
  const f=await fixture(t);const profile=ready([entry('style','Base style.')]);await bind(f,profile);
  await f.host.patch({sessionId:'story',expectedRevision:(await f.store.snapshot()).revision,operations:[{op:'replace',entryId:'style',content:'Prefix style.'}]});
  const result=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet});await f.host.commit({sessionId:'story',presentationId:result.id,seq:5});
  const parentEvents=acceptedEvents(result);f.agents.get('story').session.snapshotEvents=()=>parentEvents;
  await f.host.patch({sessionId:'story',expectedRevision:(await f.store.snapshot()).revision,operations:[{op:'replace',entryId:'style',content:'Later parent style.'}]});
  const child=f.makeAgent('child');child.session.header={id:'child',parentSession:'story',isSeeded:true};child.session.inheritedEventCount=parentEvents.length;child.session.snapshotEvents=()=>structuredClone(parentEvents);f.agents.set('child',child);
  await f.host.inheritSession({parentSessionId:'story',sessionId:'child'});assert.equal((await f.store.binding('child')).overlay.entries.style.content,'Prefix style.');
  const audit=await f.host.material({sessionId:'child',presentationId:result.id});assert.equal(audit.compiled.messages[0].content,'Prefix style.');
  await f.host.patch({sessionId:'child',expectedRevision:(await f.store.snapshot()).revision,operations:[{op:'replace',entryId:'style',content:'Independent child.'}]});
  await f.host.inheritSession({parentSessionId:'story',sessionId:'child'});assert.equal((await f.store.binding('child')).overlay.entries.style.content,'Independent child.');
  const foreign=f.makeAgent('foreign-child');foreign.session.header={id:'foreign-child',parentSession:'code',isSeeded:true};foreign.session.inheritedEventCount=parentEvents.length;foreign.session.snapshotEvents=()=>structuredClone(parentEvents);f.agents.set('foreign-child',foreign);
  await assert.rejects(f.host.inheritSession({parentSessionId:'story',sessionId:'foreign-child'}),{code:'SESSION_ANCESTRY_REQUIRED'});
  await assert.rejects(f.host.material({sessionId:'foreign-child',presentationId:result.id}),{code:'RECEIPT_NOT_FOUND'});
});

test('durable content revision covers receipts and drafts while legacy edits retain their preset revision domain',async t=>{
  const f=await fixture(t);await bind(f);const library=(await f.host.state('story')).revision,before=(await f.host.contentRevision()).revision;
  const result=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet});const rendered=(await f.host.contentRevision()).revision;assert.ok(rendered>before);assert.equal((await f.host.state('story')).revision,library);
  await f.host.commit({sessionId:'story',presentationId:result.id,seq:5});assert.ok((await f.host.contentRevision()).revision>rendered);f.agents.get('story').session.snapshotEvents=()=>acceptedEvents(result);
  const ref=(await f.host.narratives({sessionId:'story'})).records[0].ref,draft=await f.host.createDraft({sessionId:'story',basedOn:ref,kind:'manual'}),generated=(await f.host.contentRevision()).revision;
  await f.host.editDraft({sessionId:'story',draftId:draft.id,expectedDraftVersion:draft.version,text:'Owner edit.'});assert.ok((await f.host.contentRevision()).revision>generated);assert.equal((await f.host.state('story')).revision,library);
  const content=await f.host.exportContent({profileId:'preset',version:1}),expectedRevision=(await f.host.contentRevision()).revision;
  const imported=await f.host.importContent({...content,requestId:'aggregate-import',expectedRevision});assert.ok(imported.revision>expectedRevision);assert.equal((await f.host.state('story')).revision,library+1);
  assert.deepEqual(await f.host.importContent({...content,requestId:'aggregate-import',expectedRevision}),imported);
});

test('state transfer preserves exact required profiles, receipts and drafts while retaining unrelated destination data',async t=>{
  const source=await fixture(t);await bind(source,{...ready(),id:'__proto__'});
  const result=await source.host.present({sessionId:'story',agent:source.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet});await source.host.commit({sessionId:'story',presentationId:result.id,seq:5});const events=acceptedEvents(result);source.agents.get('story').session.snapshotEvents=()=>events;
  const ref=(await source.host.narratives({sessionId:'story'})).records[0].ref,draft=await source.host.createDraft({sessionId:'story',basedOn:ref,kind:'manual',text:'Saved private candidate.'});
  await source.host.saveProfile({profile:{...ready(),id:'unrelated-source',name:'Do not export'},expectedRevision:(await source.store.snapshot()).revision});
  const state=await source.host.exportState({sessionIds:['story']});assert.equal(state.schemaVersion,1);assert.equal(state.payload.profiles.some(profile=>profile.id==='unrelated-source'),false);assert.equal(state.payload.receipts.length,1);assert.equal(state.payload.drafts[draft.id][0].text,'Saved private candidate.');
  const destination=await fixture(t);await destination.host.saveProfile({profile:{...ready(),id:'destination-keep',name:'Keep me'},expectedRevision:0});
  const preview=await destination.host.preflightRestore({sessionIds:['story'],state});assert.equal(preview.supported,true);assert.equal((await destination.host.state('story')).profiles.length,1);
  const cyclic=structuredClone(state);cyclic.payload.receipts[0].rewriteOf=cyclic.payload.receipts[0].id;const invalid=await destination.host.preflightRestore({sessionIds:['story'],state:cyclic});assert.equal(invalid.supported,false);assert.equal(invalid.conflicts[0].code,'RESTORE_PAYLOAD_INVALID');
  const extensions=structuredClone(state);extensions.payload.receipts[0].storySnapshot={title:'The Gate',extensions:{script:'UNKNOWN_IMPORTED_EXTENSION'}};assert.equal((await destination.host.preflightRestore({sessionIds:['story'],state:extensions})).supported,false);
  await assert.rejects(destination.host.restoreState({restoreId:'restore-one',sessionIds:['story'],state,expectedRevision:(await destination.host.contentRevision()).revision}),{code:'RESTORE_PAYLOAD_INVALID'});assert.equal((await destination.host.state('story')).profiles.length,1);
  destination.agents.get('story').session.snapshotEvents=()=>events;
  await assert.rejects(destination.host.restoreState({restoreId:'missing-revision',sessionIds:['story'],state}),{code:'EXPECTED_REVISION_REQUIRED'});assert.equal((await destination.host.state('story')).profiles.length,1);
  const expectedRevision=(await destination.host.contentRevision()).revision,restored=await destination.host.restoreState({restoreId:'restore-one',sessionIds:['story'],state,expectedRevision});assert.deepEqual(restored.restoredSessionIds,['story']);
  assert.equal((await destination.host.material({sessionId:'story',presentationId:result.id})).packet.playerAction,packet.playerAction);assert.equal((await destination.host.drafts({sessionId:'story'})).drafts[0].text,'Saved private candidate.');assert.ok(await destination.store.profile('destination-keep',1));assert.ok(await destination.store.binding('story'));
  assert.deepEqual(await destination.host.restoreState({restoreId:'restore-one',sessionIds:['story'],state,expectedRevision}),restored);
  const beforeLookup=destination.remoteCalls.length;await assert.rejects(destination.host.restoreState({restoreId:'restore-one',sessionIds:['story'],state:{schemaVersion:'bad',revision:0,payload:{}},expectedRevision:restored.revision}),{code:'RESTORE_PAYLOAD_INVALID'});assert.equal(destination.remoteCalls.length,beforeLookup);
  await assert.rejects(destination.host.restoreState({restoreId:'restore-one',sessionIds:['story','other'],state,expectedRevision:restored.revision}),{code:'RESTORE_ID_CONFLICT'});
  const changed=structuredClone(state);changed.payload.receipts[0].text='Forged accepted body.';await assert.rejects(destination.host.restoreState({restoreId:'restore-one',sessionIds:['story'],state:changed,expectedRevision:restored.revision}),{code:'RESTORE_ID_CONFLICT'});
  assert.equal((await destination.host.preflightRestore({sessionIds:['story'],state:changed})).supported,false);assert.equal((await destination.host.contentRevision()).revision,restored.revision);
});

test('additional pinned draft profiles restore as exact library-only content while the current builtin binding stays unchanged',async t=>{
  const source=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>({factReceipt:{id:'fact-builtin',kind:'opening',openingText:'Builtin story opening.'},packet:{playerAction:'Begin.'}})}}});
  const builtin=await source.host.ensureBuiltinProfile({key:'gm-builtin.v1',profile:{name:'GM builtin',entries:ready().entries}});
  await source.host.bindSession({sessionId:'story',...builtin,expectedRevision:(await source.host.state('story')).revision});
  const rawText='{ "name":"StyleV1", "prompts":[{"identifier":"style","content":"Pinned draft style."}], "extensions":{"profileRef":{"profileId":"unrelated","version":1}} }';
  const imported=await source.host.importSillyTavern({rawText,expectedRevision:(await source.host.state('story')).revision}),style=(await source.host.profile({profileId:imported.profileId,version:1})).profile;
  await source.host.saveProfile({profile:{...style,entries:style.entries.map(item=>({...item,content:'Later style version.'}))},expectedRevision:(await source.host.state('story')).revision});
  await source.host.saveProfile({profile:{...ready(),id:'unrelated'},expectedRevision:(await source.host.state('story')).revision});
  const opening=await source.host.present({sessionId:'story',agent:source.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-builtin'}),events=acceptedEvents(opening);
  source.agents.get('story').session.snapshotEvents=()=>events;await source.host.commit({sessionId:'story',presentationId:opening.id,seq:5});
  const before=await source.host.state('story'),revision=await source.host.contentRevision(),ordinary=await source.host.exportState({sessionIds:['story']});
  assert.deepEqual(await source.host.exportState({sessionIds:['story'],additionalProfileRefs:[]}),ordinary);assert.equal(ordinary.payload.profiles.length,1);
  const refs=[{profileId:style.id,version:1},{profileId:style.id,version:1},{profileId:builtin.profileId,version:builtin.version}],pending=source.host.exportState({sessionIds:['story'],additionalProfileRefs:refs});
  refs[0].version=2;refs.push({profileId:'unrelated',version:1});const state=await pending;
  assert.deepEqual(Object.keys(state),['schemaVersion','revision','payload']);assert.equal(state.schemaVersion,1);assert.equal(state.revision,revision.revision);assert.ok(state.revision>before.revision);
  assert.deepEqual(state.payload.profiles.map(profile=>[profile.id,profile.version,profile.status]).sort(),[[builtin.profileId,1,'ready'],[style.id,1,'draft']].sort());
  assert.equal(state.payload.sources.length,1);assert.equal(state.payload.sources[0].rawText,rawText);assert.equal(state.payload.sources[0].id,style.sourceId);
  assert.deepEqual((await source.host.state('story')).binding,before.binding);assert.deepEqual(await source.host.contentRevision(),revision);assert.equal(source.calls.length,0);
  const destination=await fixture(t);destination.agents.get('story').session.snapshotEvents=()=>events;
  assert.equal((await destination.host.preflightRestore({sessionIds:['story'],state})).supported,true);
  await destination.host.restoreState({restoreId:'pinned-style-default',sessionIds:['story'],state,expectedRevision:(await destination.host.contentRevision()).revision});
  assert.deepEqual((await destination.host.profile({profileId:style.id,version:1})).profile,style);assert.equal((await destination.host.source({sourceId:style.sourceId})).source.rawText,rawText);
  await assert.rejects(destination.host.profile({profileId:style.id,version:2}),{code:'PROFILE_NOT_FOUND'});await assert.rejects(destination.host.profile({profileId:'unrelated',version:1}),{code:'PROFILE_NOT_FOUND'});
  assert.deepEqual((await destination.host.state('story')).binding,before.binding);assert.equal(destination.calls.length,0);
});

test('additional pinned profile export fails explicitly for a missing exact version without using latest or changing state',async t=>{
  const f=await fixture(t);await bind(f);const before=await f.host.state('story'),revision=await f.host.contentRevision();
  for(const ref of [{profileId:'preset',version:99},{profileId:'absent',version:1}])await assert.rejects(f.host.exportState({sessionIds:['story'],additionalProfileRefs:[ref]}),error=>error.code==='EXPORT_REQUIREMENT_MISSING'&&error.message.includes(JSON.stringify([ref.profileId,ref.version])));
  assert.deepEqual(await f.host.contentRevision(),revision);assert.deepEqual(await f.host.state('story'),before);assert.equal(f.calls.length,0);
});

test('additional profile refs require an exact typed profileId and positive integer version before export work',async t=>{
  const f=await fixture(t);const before=f.remoteCalls.length;
  for(const additionalProfileRefs of [null,{},[{profileId:'preset'}],[{profileId:'preset',version:0}],[{profileId:'preset',version:1,sourceId:'inert'}]])await assert.rejects(f.host.exportState({sessionIds:['story'],additionalProfileRefs}),{code:'INVALID_PROFILE'});
  assert.equal(f.remoteCalls.length,before);assert.equal((await f.host.contentRevision()).revision,0);
});

test('restore rejects a successful retry child downgraded to failed or cancelled without reopening its family',async t=>{
  const source=await fixture(t,{stages:[{commit:true},new Error('Writer unavailable'),'Accepted retry prose.']});await bind(source);
  const firstContext='["story","assistant-1","call-1"]';
  await assert.rejects(source.host.present({sessionId:'story',agent:source.agents.get('story'),contextKey:firstContext,packet}));
  const failed=(await source.host.state('story')).presentations[0],events=acceptedEvents(failed);
  events[5].data.message.isError=true;delete events[5].data.meta;source.agents.get('story').session.snapshotEvents=()=>events;
  assert.equal((await source.host.presentationSummaries({sessionId:'story'})).presentations[0].canRetry,true);
  events.push(...retryEvents({text:''},failed.id).slice(0,4));
  const retry=await source.host.present({sessionId:'story',agent:source.agents.get('story'),contextKey:'["story","assistant-retry","call-retry"]',rewriteOf:failed.id});
  events.push(...retryEvents(retry,failed.id).slice(4));
  await source.host.commit({sessionId:'story',presentationId:retry.id,seq:11});
  const state=await source.host.exportState({sessionIds:['story']}),destination=await fixture(t);
  destination.agents.get('story').session.snapshotEvents=()=>events;
  await destination.host.saveProfile({profile:{...ready(),id:'destination-keep'},expectedRevision:0});
  const before=await destination.host.contentRevision();
  for(const status of ['failed','cancelled']){
    const downgraded=structuredClone(state);downgraded.payload.receipts.find(receipt=>receipt.id===retry.id).status=status;
    // T2 preflight is structural; canonical proof belongs to restore after logs exist.
    assert.equal((await destination.host.preflightRestore({sessionIds:['story'],state:downgraded})).supported,true);
    await assert.rejects(destination.host.restoreState({restoreId:`downgraded-${status}`,sessionIds:['story'],state:downgraded,expectedRevision:before.revision}),{code:'RESTORE_PAYLOAD_INVALID'});
    assert.deepEqual(await destination.host.contentRevision(),before);assert.deepEqual((await destination.host.state('story')).presentations,[]);
    assert.equal((await destination.host.state('story')).profiles.length,1);assert.ok(await destination.store.profile('destination-keep',1));
  }
  await destination.host.restoreState({restoreId:'valid-success',sessionIds:['story'],state,expectedRevision:before.revision});
  const summaries=(await destination.host.presentationSummaries({sessionId:'story'})).presentations;
  assert.equal(summaries.find(record=>record.presentationId===failed.id).retryBlockCode,'REWRITE_ALREADY_RENDERED');
  assert.equal(summaries.find(record=>record.presentationId===retry.id).canRetry,false);
  await assert.rejects(destination.host.retryPresentation({sessionId:'story',presentationId:failed.id}),{code:'REWRITE_ALREADY_RENDERED'});assert.equal(destination.calls.length,0);
});

for(const status of ['failed','cancelled'])test(`restored legitimate ${status} frozen material can still retry without assembly or Context`,async t=>{
  const error=status==='cancelled'?new DOMException('Writer cancelled','AbortError'):new Error('Writer unavailable');
  const source=await fixture(t,{stages:[{commit:true},error]});await bind(source);
  await assert.rejects(source.host.present({sessionId:'story',agent:source.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet}));
  const failed=(await source.host.state('story')).presentations[0],events=acceptedEvents(failed);
  assert.equal(failed.status,status);events[5].data.message.isError=true;delete events[5].data.meta;source.agents.get('story').session.snapshotEvents=()=>events;
  const state=await source.host.exportState({sessionIds:['story']}),destination=await fixture(t,{stages:['Restored writer-only retry.'],services:{rpContext:{prepare:()=>{throw Error('Context must not rerun');}}}});
  destination.agents.get('story').session.snapshotEvents=()=>events;
  await destination.host.restoreState({restoreId:`valid-${status}`,sessionIds:['story'],state,expectedRevision:(await destination.host.contentRevision()).revision});
  assert.equal((await destination.host.presentationSummaries({sessionId:'story'})).presentations[0].canRetry,true);
  events.push(...retryEvents({text:''},failed.id).slice(0,4));
  const retry=await destination.host.present({sessionId:'story',agent:destination.agents.get('story'),contextKey:'["story","assistant-retry","call-retry"]',rewriteOf:failed.id});
  assert.equal(retry.text,'Restored writer-only retry.');assert.equal(retry.rewriteOf,failed.id);assert.equal(destination.calls.length,1);
  assert.deepEqual((await destination.host.material({sessionId:'story',presentationId:retry.id})).compiled,(await source.host.material({sessionId:'story',presentationId:failed.id})).compiled);
});

test('restore preserves canonical accepted rendered receipts for identical R12 replay without resolving GM again',async t=>{
  const source=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:async()=>({factReceipt:{id:'fact-restore-lag',kind:'opening',openingText:'Accepted opening.'},packet:{playerAction:'Begin.'}})}}});await bind(source);
  const request={sessionId:'story',contextKey:'["story","assistant-1","call-1"]',factReceiptId:'fact-restore-lag'},first=await source.host.present({...request,agent:source.agents.get('story')}),events=acceptedEvents(first);
  source.agents.get('story').session.snapshotEvents=()=>events;
  const state=await source.host.exportState({sessionIds:['story']});assert.equal(state.payload.receipts[0].status,'rendered');
  let gmCalls=0;const destination=await fixture(t,{services:{rpGM:{binding:async()=>({id:'gm'}),presentation:()=>{gmCalls++;throw Error('Strict GM must not resolve an accepted fact');}}}});
  destination.agents.get('story').session.snapshotEvents=()=>events;
  await destination.host.restoreState({restoreId:'valid-rendered-lag',sessionIds:['story'],state,expectedRevision:(await destination.host.contentRevision()).revision});
  const replay=await destination.host.present({...request,agent:destination.agents.get('story')});
  assert.equal(replay.id,first.id);assert.equal(replay.status,'complete');assert.equal(gmCalls,0);assert.equal(destination.calls.length,0);
});

test('export drains an in-flight candidate and rejects new owner work while capturing stable state',async t=>{
  let release,entered;const hold=new Promise(done=>{release=done}),started=new Promise(done=>{entered=done});
  const f=await fixture(t,{stages:[{commit:true},'Accepted prose.',async()=>{entered();await hold;return'Finished candidate.'}]});await bind(f);const result=await f.host.present({sessionId:'story',agent:f.agents.get('story'),contextKey:'["story","assistant-1","call-1"]',packet});await f.host.commit({sessionId:'story',presentationId:result.id,seq:5});f.agents.get('story').session.snapshotEvents=()=>acceptedEvents(result);
  const ref=(await f.host.narratives({sessionId:'story'})).records[0].ref,pending=f.host.createDraft({sessionId:'story',basedOn:ref});await started;let exported=false;
  const capture=f.host.exportState({sessionIds:['story']}).then(value=>{exported=true;return value;});await new Promise(done=>setTimeout(done,5));
  const gate=[...f.ctx.listeners.get('agent/pre-step')][0],normal=async()=>({kind:'enter',messages:[]});assert.equal((await gate({agent:f.agents.get('code'),turn:1},normal)).kind,'enter');assert.equal((await gate({agent:f.agents.get('story'),turn:2},normal)).kind,'reject');
  await assert.rejects(f.host.createDraft({sessionId:'story',basedOn:ref,kind:'manual'}),{code:'OWNER_STATE_BUSY'});assert.equal(exported,false);release();const draft=await pending,state=await capture;assert.equal(state.payload.drafts[draft.id].at(-1).status,'ready');assert.equal(state.payload.drafts[draft.id].at(-1).text,'Finished candidate.');
});

test('state capture drains asynchronous canonical-result bookkeeping and its outcome callbacks',async t=>{
  let release,entered;const hold=new Promise(done=>{release=done}),started=new Promise(done=>{entered=done});
  const f=await fixture(t,{services:{rpContext:{prepare:async()=>({id:'material',materials:{entries:[],history:[],recentProse:[]}}),presentationOutcome:async input=>{if(input.status==='accepted'){entered();await hold;}}}}});await bind(f);
  const result=await f.ctxTools.get('rp_present').execute({packet},{agent:f.agents.get('story'),callId:'call-1',rootCallId:'call-1',signal:new AbortController().signal,concludeTurn(){}}),events=acceptedEvents(result);f.agents.get('story').session.snapshotEvents=()=>events;
  f.ctx.emit('session/event',f.agents.get('story').session,events[4]);f.ctx.emit('session/event',f.agents.get('story').session,events[5]);await started;
  let exported=false;const capture=f.host.exportState({sessionIds:['story']}).then(value=>{exported=true;return value;});await new Promise(done=>setTimeout(done,20));const early=exported;
  release();await capture;await f.ctx.flush();assert.equal(early,false);
});

test('plugin apply provides its service and routes while returning a valid Cordis effect result', async (t) => {
  const f = await fixture(t, { plugin: true });
  assert.equal(f.services.rpLastStep, f.host);
  assert.deepEqual([...f.fetchRoutes.keys()], ['/api/rp-last-step/request', '/api/rp-last-step/events']);
  const response = await f.fetchRoutes.get('/api/rp-last-step/request').fetch(new Request('http://localhost/api/rp-last-step/request', { method: 'POST', body: JSON.stringify({ action: 'state', sessionId: 'story' }) }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).binding, null);
  await f.ctx.close();
  assert.equal(f.fetchRoutes.size, 0);
  assert.equal(f.host.isEnabled('story'), false);
});

test('starts with persisted opt-in bindings and injects only compiled agent/shared modules', async (t) => {
  const f = await fixture(t, { persisted: true, entries: [entry('render', 'RENDER PRIVATE STYLE'), entry('agent', 'AGENT RULE', { phase: 'agent' }), entry('shared', 'Hello {{user}}', { phase: 'shared' })] });
  assert.equal(f.host.isEnabled('story'), true);
  assert.equal(f.host.isEnabled('code'), false);
  assert.equal(f.host.isEnabled('missing'), false);
  assert.equal(f.host.isEnabled('story') instanceof Promise, false);
  assert.deepEqual(JSON.parse(f.contexts.get('rp-last-step-binding').text({})), { contract: 'rp-last-step/v1', enabled: true, profileId: 'preset', version: 1 });
  const context = f.contexts.get('rp-last-step-agent').text({});
  assert.match(context, /AGENT RULE/u); assert.match(context, /Hello 玩家/u); assert.doesNotMatch(context, /RENDER PRIVATE STYLE/u);
  f.current('code');
  assert.equal(f.contexts.get('rp-last-step-binding').text({}), '');
  const profile = await f.host.profile({ profileId: 'preset' });
  assert.equal(profile.profile.version, 1);
  assert.equal(f.remoteCalls.length, 0);
});

test('owner library actions preserve sources and pinned versions without requiring a session', async (t) => {
  const f = await fixture(t);
  const text = '\uFEFF {"name":"Imported","prompts":[{"identifier":"style","content":"Exact source content"}]}\r\n';
  const imported = await f.host.importSillyTavern({ rawText: text, expectedRevision: 0 });
  const profileReply = await f.host.profile({ profileId: imported.profileId });
  const sourceReply = await f.host.source({ sourceId: profileReply.profile.sourceId });
  assert.equal(sourceReply.source.rawText, text);
  assert.equal(f.remoteCalls.length, 0);
  await assert.rejects(f.host.bindSession({ sessionId: 'story', profileId: imported.profileId, version: 1, expectedRevision: 1 }), { code: 'PROFILE_NOT_READY' });
  const changed = { ...profileReply.profile, status: 'ready', entries: profileReply.profile.entries.map((item) => ({ ...item, phase: 'render' })) };
  const saved = await f.host.saveProfile({ profile: changed, expectedRevision: 1 });
  await f.host.bindSession({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.equal(f.host.isEnabled('story'), true);
  assert.equal((await f.host.state('story')).binding.version, 2);
  await f.host.saveProfile({ profile: { ...changed, version: saved.version, name: 'Newer' }, expectedRevision: 3 });
  const state = await f.host.state('story');
  assert.deepEqual(state.profiles.map(({ id, name, version, status, sourceId, entryCount }) => ({ id, name, version, status, sourceId, entryCount })), [{ id: imported.profileId, name: 'Newer', version: 3, status: 'ready', sourceId: profileReply.profile.sourceId, entryCount: 1 }]);
  assert.equal(state.binding.profile.name, 'Imported');
  assert.equal(state.binding.version, 2);
  assert.equal(state.revision, 4);
  assert.equal(state.capabilities.migrate, true);
  assert.equal(JSON.stringify(state).includes(text), false);
  await assert.rejects(f.host.saveProfile({ profile: changed, expectedRevision: 2 }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.host.source({ sourceId: profileReply.profile.sourceId })).source.rawText, text);
});

test('state, bind and agent operations use exact owner Remote follow snapshots and deny inaccessible sessions', async (t) => {
  const f = await fixture(t);
  const created = await f.host.createProfile({ name: 'Empty owner draft', expectedRevision: 0 });
  assert.equal(f.remoteCalls.length, 0);
  assert.equal(created.revision, 1);
  for (const id of ['denied', 'missing']) {
    await assert.rejects(f.host.state(id));
    await assert.rejects(f.host.bindSession({ sessionId: id, profileId: created.profileId, version: 1, expectedRevision: 1 }));
    await assert.rejects(f.host.catalog({ sessionId: id }));
  }
  const state = await f.host.state('cold');
  assert.equal(state.binding, null);
  const call = f.remoteCalls.at(-1);
  assert.deepEqual(call.args, { request: { address: { kind: 'session', sessionId: 'cold' }, maxMessages: 100 } });
  assert.equal(call.signal.aborted, true);
  await assert.rejects(f.host.state(''), { code: 'INVALID_SESSION' });
});

test('unbound native and PTC sessions have no RP schemas or SDK names and bind rejects pure PTC', async (t) => {
  const f = await fixture(t, { defaultToolMode: 'ptc', toolModes: { code: 'native' } });
  for (const id of ['story', 'code']) assert.doesNotMatch(JSON.stringify(f.surface(f.agents.get(id))), /rp_present|rp_last_step/u);
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await assert.rejects(f.host.bindSession({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: 1 }), { code: 'NATIVE_TOOLS_REQUIRED' });
  assert.equal((await f.host.state('story')).binding, null);
  assert.equal((await f.store.snapshot()).revision, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.globalTools.size, 0);
  assert.equal(f.ctxTools.size, 0);
  assert.equal(f.host.isEnabled('story'), false);
  const preview = await f.host.preview({ profile: ready(), phase: 'render' });
  assert.equal(preview.blocked, false);
  assert.equal((await f.host.profile({ profileId: 'preset' })).profile.name, 'Preset');
});

test('a native agent within a PTC deployment receives only its own scoped RP tools and cleanup', async (t) => {
  const f = await fixture(t, { defaultToolMode: 'ptc', toolModes: { story: 'native' } });
  await bind(f);
  assert.deepEqual(f.surface(f.agents.get('story')).tools.map((tool) => tool.name), ['rp_last_step_catalog', 'rp_last_step_read', 'rp_last_step_patch', 'rp_present']);
  assert.doesNotMatch(JSON.stringify(f.surface(f.agents.get('code'))), /rp_present|rp_last_step/u);
  assert.equal(f.globalTools.size, 0);
  assert.equal((await f.ctxTools.get('rp_last_step_catalog').execute({}, { agent: f.agents.get('story'), signal: new AbortController().signal })).profileId, 'preset');
  await f.host.close();
  assert.equal(f.ctxTools.size, 0);
  assert.doesNotMatch(JSON.stringify(f.surface(f.agents.get('story'))), /rp_present|rp_last_step/u);
});

test('persisted PTC bindings fail activation before contexts or model calls while migration stays available', async (t) => {
  const f = await fixture(t, { persisted: true, defaultToolMode: 'ptc', stages: [{ updates: [], additions: [], report: { summary: 'Owner review draft' } }] });
  assert.equal(f.host.isEnabled('story'), false);
  const agent = f.agents.get('story');
  assert.throws(() => { for (const provider of f.toolProviders) provider({ agent, scope: agent }); }, { code: 'NATIVE_TOOLS_REQUIRED' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.ctxTools.size, 0);
  assert.doesNotMatch(JSON.stringify(f.surface(agent)), /rp_present|rp_last_step/u);
  const migrated = await f.host.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2 });
  assert.equal(migrated.version, 2);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.host.profile({ profileId: 'preset' })).profile.status, 'draft');
});

test('unbound PTC descendants mask inherited RP tools and scopes follow agent lifecycle', async (t) => {
  const f = await fixture(t);
  const parent = f.agents.get('story');
  const child = f.makeAgent('child', { parent, mode: 'ptc' });
  f.agents.set('child', child);
  f.ctx.emit('agent/created', { agent: child });
  await bind(f);
  assert.doesNotMatch(JSON.stringify(f.surface(child)), /rp_present|rp_last_step/u);
  assert.equal(f.toolScopes.get(child).denials.size, 1);
  for (const name of ['rp_last_step_catalog', 'rp_last_step_read', 'rp_last_step_patch', 'rp_present']) assert.equal(f.ctx.tools.get(name, child), undefined);
  const own = f.toolScopes.get(parent).own;
  f.agents.delete('story');
  f.ctx.emit('agent/disposed', { agent: parent });
  assert.equal(own.size, 0);
  await f.host.close();
  assert.equal(f.toolScopes.get(child).denials.size, 0);
});

test('agent reads are selected, lock-checked patches refresh the cache and conflicts preserve the overlay', async (t) => {
  const f = await fixture(t);
  await bind(f, ready([entry('style', 'SECRET MODULE BODY'), entry('agent', 'Before', { phase: 'agent' }), entry('locked', 'Owner fixed', { locked: true }), entry('required', 'Required', { required: true })]));
  const catalog = await f.host.catalog({ sessionId: 'story' });
  assert.equal(catalog.revision, 2);
  assert.equal(catalog.entries.length, 4);
  assert.doesNotMatch(JSON.stringify(catalog), /SECRET MODULE BODY|Owner fixed/u);
  assert.deepEqual((await f.host.read({ sessionId: 'story', entryIds: ['style'] })).entries.map((item) => item.content), ['SECRET MODULE BODY']);
  await assert.rejects(f.host.read({ sessionId: 'story', entryIds: ['absent'] }), { code: 'UNKNOWN_ENTRY' });
  await assert.rejects(f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'replace', entryId: 'locked', content: 'Bypass' }] }), { code: 'ENTRY_LOCKED' });
  await assert.rejects(f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'disable', entryId: 'required' }] }), { code: 'ENTRY_REQUIRED' });
  const patched = await f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'replace', entryId: 'agent', content: 'After' }] });
  assert.equal(patched.revision, 3);
  assert.match(f.host.agentContext('story'), /After/u);
  await assert.rejects(f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'disable', entryId: 'style' }] }), { code: 'REVISION_CONFLICT' });
  assert.equal((await f.host.profile({ profileId: 'preset' })).profile.entries[1].content, 'Before');
});

test('required agent diagnostics block assembly and preview permits owner draft review', async (t) => {
  const f = await fixture(t);
  await bind(f, ready([entry('rules', '{{unknown}}', { phase: 'agent', required: true })]));
  assert.throws(() => f.host.agentContext('story'), { code: 'COMPILE_BLOCKED' });
  const draft = { ...ready([entry('draft', 'Hello {{user}}', { phase: 'agent' })]), status: 'draft' };
  const preview = await f.host.preview({ profile: draft, phase: 'agent', variables: { user: 'Reader' } });
  assert.equal(preview.blocked, false);
  assert.equal(preview.text, 'Hello Reader');
});

test('admission refresh keeps schemas and context on one frozen binding until the next assembly', async (t) => {
  const f = await fixture(t);
  const agent = f.agents.get('story');
  agent.status = 'running';
  const context = { agent, scope: agent, signal: new AbortController().signal };
  for (const provider of f.toolProviders) provider(context);
  const filter = [...f.ctx.listeners.get('system-prompt/assemble')][0];
  const assembly = { sections: [], contexts: [], variables: {}, tools: [{ name: 'lookup' }, ...[...f.ctxTools.keys()].map((name) => ({ name }))] };
  let release;
  let entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const reached = new Promise((resolve) => { entered = resolve; });
  const pending = filter(assembly, context, async () => { entered(); await waiting; return assembly; });
  await reached;
  await bind(f, ready([entry('agent', 'BEFORE OWNER EDIT', { phase: 'agent' })]));
  assert.equal(f.host.isEnabled('story'), false);
  assert.equal((await f.host.state('story')).binding.profileId, 'preset');
  release();
  assert.deepEqual((await pending).tools, [{ name: 'lookup' }]);
  const refresh = { agent, scope: agent, signal: context.signal };
  assert.equal(f.contexts.get('rp-last-step-binding').text(refresh), '');
  assert.equal(f.contexts.get('rp-last-step-agent').text(refresh), '');

  const second = { agent, scope: agent, signal: context.signal };
  for (const provider of f.toolProviders) provider(second);
  const nextAssembly = { ...assembly, tools: [{ name: 'lookup' }, ...f.surface(agent).tools] };
  assert.equal((await filter(nextAssembly, second, async () => nextAssembly)).tools.length, 5);
  assert.equal(f.host.isEnabled('story'), true);
  assert.match(f.contexts.get('rp-last-step-agent').text(second), /BEFORE OWNER EDIT/u);
  await f.host.patch({ sessionId: 'story', expectedRevision: 2, operations: [{ op: 'replace', entryId: 'agent', content: 'AFTER OWNER EDIT' }] });
  assert.match(f.host.agentContext('story'), /AFTER OWNER EDIT/u);
  assert.match(f.contexts.get('rp-last-step-agent').text({ agent, scope: agent, signal: context.signal }), /BEFORE OWNER EDIT/u);
  const third = { agent, scope: agent, signal: context.signal };
  for (const provider of f.toolProviders) provider(third);
  assert.match(f.contexts.get('rp-last-step-agent').text(third), /AFTER OWNER EDIT/u);
});

test('terminal presentation remains rendered until an accepted canonical rp_present result commits it', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const tool = f.ctxTools.get('rp_present');
  let conclusions = 0;
  const value = await tool.execute({ packet }, { agent: f.agents.get('story'), callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => conclusions++ });
  assert.equal(value.status, 'rendered');
  assert.equal(conclusions, 1);
  assert.deepEqual(f.calls.map(({ config }) => config.model), ['main-header', 'main-header']);
  assert.equal((await f.host.state('story')).presentations[0].status, 'rendered');
  assert.equal(f.presentations.some((event) => event.status === 'complete'), false);
  const meta = tool.output.presentationMeta({}, value);
  f.ctx.emit('session/event', f.agents.get('story').session, { type: 'tool/call', seq: 10, data: { callId: 'call-1', name: 'rp_present', arguments: '{}' } });
  f.ctx.emit('session/event', f.agents.get('story').session, { type: 'tool/result', seq: 11, data: { message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: tool.output.render({}, value) }, meta } });
  await f.ctx.flush();
  assert.equal((await f.host.state('story')).presentations[0].status, 'complete');
  assert.equal(f.presentations.at(-1).seq, 11);
  assert.equal(f.ctx.errors.length, 0);
  assert.doesNotMatch(JSON.stringify(f.presentations), /playerAction|resolvedChanges|system|prompts|usage/u);
  assert.equal(f.calls[1].request.messages[0].content[0].text.includes('The attempt failed.'), true);
  assert.equal(f.calls[1].request.tools, undefined);
});

test('a completed bound main request without canonical presentation emits one safe failure', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  f.ctx.emit('session/event', agent.session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  for (const provider of f.toolProviders) provider({ agent, scope: agent });
  f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'main-1', revision: 1, turn: 1, step: 1 } });
  f.ctx.emit('session/event', agent.session, { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { id: 'main', role: 'assistant', source: { kind: 'model', provider: 'local', model: 'main' }, content: [{ type: 'text', text: 'PRIVATE MAIN TEXT token=secret' }] }, stream: [] } });
  const end = { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } };
  f.ctx.emit('session/event', agent.session, end);
  f.ctx.emit('session/event', agent.session, end);
  await f.ctx.flush();
  assert.deepEqual(f.presentations, [{ sessionId: 'story', stageId: 'rp-last-step.render', status: 'failed', code: 'PRESENTATION_REQUIRED' }]);
  assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(f.presentations), /PRIVATE|secret|token=/u);
});

test('no-request, cancellation, error, unbound and migration-only turns do not report missing presentation', async (t) => {
  const f = await fixture(t, { stages: [{ updates: [], additions: [], report: { summary: 'Owner migration review' } }] });
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  let turn = 0;
  for (const [request, reason] of [
    [false, { kind: 'completed' }],
    [true, { kind: 'aborted', reason: { kind: 'legacy' } }],
    [true, { kind: 'error', error: { code: 'MODEL_FAILED', message: 'private' } }],
    [true, { kind: 'blocked' }],
    [true, { kind: 'max-tokens' }],
  ]) {
    turn++;
    f.ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
    for (const provider of f.toolProviders) provider({ agent, scope: agent });
    if (request) f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: `main-${turn}`, revision: turn, turn, step: 1 } });
    f.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason } });
  }
  const unbound = f.agents.get('code');
  f.current('code'); unbound.status = 'running';
  f.ctx.emit('session/event', unbound.session, { type: 'turn/start', data: { turn: 1 } });
  for (const provider of f.toolProviders) provider({ agent: unbound, scope: unbound });
  f.ctx.emit('agent/assistant-stream', { agent: unbound, frame: { type: 'start', attemptId: 'code-1', revision: 1, turn: 1, step: 1 } });
  f.ctx.emit('session/event', unbound.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  f.current('story');
  f.ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: 6 } });
  await f.host.migrate({ sessionId: 'story', profileId: 'preset', version: 1, expectedRevision: 2 });
  f.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 6, reason: { kind: 'completed' } } });
  await f.ctx.flush();
  assert.equal(f.presentations.some((event) => event.code === 'PRESENTATION_REQUIRED'), false);
  assert.equal(f.calls.length, 1);
});

test('accepted canonical metadata is marked before asynchronous receipt commit can lag behind turn end', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  f.ctx.emit('session/event', agent.session, { type: 'turn/start', seq: 1, data: { turn: 1 } });
  for (const provider of f.toolProviders) provider({ agent, scope: agent });
  f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'main-1', revision: 1, turn: 1, step: 1 } });
  const tool = f.ctxTools.get('rp_present');
  const value = await tool.execute({ packet }, { agent, callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => {} });
  f.ctx.emit('session/event', agent.session, { type: 'tool/call', seq: 2, data: { turn: 1, step: 1, callId: 'call-1', name: 'rp_present', arguments: '{}' } });
  f.ctx.emit('session/event', agent.session, { type: 'tool/result', seq: 3, data: { turn: 1, step: 1, message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', isError: false, content: tool.output.render({}, value) }, meta: tool.output.presentationMeta({}, value) } });
  f.ctx.emit('session/event', agent.session, { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } });
  assert.equal(f.presentations.some((event) => event.code === 'PRESENTATION_REQUIRED'), false);
  await f.ctx.flush();
  assert.equal(f.presentations.some((event) => event.code === 'PRESENTATION_REQUIRED'), false);
  assert.equal((await f.host.state('story')).presentations[0].status, 'complete');
});

test('unowned or failed canonical metadata cannot mask a missing presentation', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const agent = f.agents.get('story');
  agent.status = 'running';
  for (const [turn, isError] of [[1, false], [2, true]]) {
    f.ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn } });
    for (const provider of f.toolProviders) provider({ agent, scope: agent });
    f.ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: `main-${turn}`, revision: turn, turn, step: 1 } });
    f.ctx.emit('session/event', agent.session, { type: 'tool/call', data: { turn, step: 1, callId: 'guessed', name: 'rp_present' } });
    f.ctx.emit('session/event', agent.session, { type: 'tool/result', data: { turn, step: 1, message: { id: 'foreign', role: 'tool', source: { kind: 'tool', callId: 'guessed' }, toolCallId: 'guessed', isError, content: [] }, meta: { rpLastStep: { schemaVersion: 1, record: { id: '00000000-0000-4000-8000-000000000001', text: 'Foreign', status: 'complete' } } } } });
    f.ctx.emit('session/event', agent.session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  }
  await f.ctx.flush();
  assert.equal(f.presentations.filter((event) => event.code === 'PRESENTATION_REQUIRED').length, 2);
  assert.equal(f.calls.length, 0);
});

test('failed tool acceptance, wrong tool metadata and other-session receipts never become complete', async (t) => {
  const f = await fixture(t);
  await bind(f);
  const value = await f.host.present({ sessionId: 'story', packet, contextKey: '["story","assistant-1","call-1"]', callId: 'call-1' });
  const meta = { rpLastStep: { schemaVersion: 1, record: { ...value, status: 'complete' } } };
  const publish = (sessionId, callId, toolName, isError, payload = meta) => {
    f.ctx.emit('session/event', f.agents.get(sessionId).session, { type: 'tool/call', seq: 1, data: { callId, name: toolName } });
    f.ctx.emit('session/event', f.agents.get(sessionId).session, { type: 'tool/result', seq: 2, data: { message: { role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError }, meta: payload } });
  };
  publish('story', 'wrong', 'lookup', false);
  publish('code', 'foreign', 'rp_present', false);
  publish('story', 'wrong-version', 'rp_present', false, { rpLastStep: { schemaVersion: 2, record: { ...value, status: 'complete' } } });
  await f.ctx.flush();
  assert.equal((await f.host.state('story')).presentations[0].status, 'rendered');
  publish('story', 'call-1', 'rp_present', true);
  await f.ctx.flush();
  assert.equal((await f.host.state('story')).presentations[0].status, 'failed');
  assert.equal(f.presentations.some((event) => event.status === 'complete'), false);
  assert.equal(f.ctx.errors.length, 0);
});

test('Loop Studio routes are frozen for every stage and trace records contain only model metadata', async (t) => {
  const participants = [];
  const routes = { migrate: { provider: 'local', model: 'migrator' }, assemble: { provider: 'local', model: 'assembler', reasoningEffort: 'low' }, render: { provider: 'local', model: 'writer', maxTokens: 123 } };
  const selected = [];
  const traces = [];
  let unregistered = 0;
  const studio = {
    registerParticipant: (participant) => { participants.push(participant); return () => unregistered++; },
    resolveRoute: ({ sessionId, nodeId }) => { selected.push({ sessionId, nodeId }); return routes[nodeId.split('.').at(-1)]; },
    recordTrace: (trace) => traces.push(trace),
  };
  const f = await fixture(t, { services: { loopStudio: studio }, stages: [() => { routes.render = { provider: 'cloud', model: 'late-edit' }; return { commit: true }; }, 'The gate stays shut.'] });
  await bind(f);
  await f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' });
  assert.deepEqual(selected.map((value) => value.nodeId), ['rp-last-step.migrate', 'rp-last-step.assemble', 'rp-last-step.render']);
  assert.deepEqual(f.calls.map(({ config }) => config), [{ provider: 'local', model: 'assembler', reasoningEffort: 'low', maxTokens: 500 }, { provider: 'local', model: 'writer', maxTokens: 123 }]);
  assert.equal(participants[0].id, 'rp-last-step');
  assert.equal(participants[0].nodes.every((node) => node.control === 'route' && node.kind === 'model'), true);
  assert.equal(participants[0].edges.some((edge) => edge.label.includes('可选')), true);
  assert.doesNotMatch(JSON.stringify(traces), /playerAction|SECRET|messages|system|private/u);
  assert.equal(traces.some((trace) => trace.model === 'writer' && trace.tokens?.outputTokens === 3), true);
  await f.host.close();
  assert.equal(unregistered, 1);
});

test('configured stage route failures do not silently fall back to another model', async (t) => {
  const f = await fixture(t, { services: { loopStudio: { registerParticipant: () => () => {}, resolveRoute: () => { throw new Error('private unavailable local route'); } } } });
  await bind(f);
  await assert.rejects(f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' }), { code: 'MODEL_ROUTE_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.presentations.at(-1).status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.presentations), /private unavailable/u);
});

test('owner migration uses the authenticated pending model selection ahead of an older request header', async (t) => {
  const f = await fixture(t, {
    projections: { story: { modelSelection: { next: { provider: 'local', model: 'pending-local', reasoningEffort: 'low' }, lastUsed: { provider: 'cloud', model: 'old-cloud', reasoningEffort: 'high' } } } },
    stages: [{ updates: [], additions: [], report: { summary: 'Owner review' } }],
  });
  const agent = f.agents.get('story');
  const prior = { config: { provider: 'cloud', model: 'old-cloud', reasoningEffort: 'high' } };
  agent.session.requestHeader = () => prior;
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await f.host.migrate({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'local', model: 'pending-local', reasoningEffort: 'low' }]);
  assert.deepEqual(agent.session.requestHeader(), prior);
});

test('cold owner migration uses stored next or lastUsed selection without an active agent or global fallback', async (t) => {
  for (const [next, lastUsed, expected] of [
    [{ provider: 'local', model: 'cold-next' }, { provider: 'cloud', model: 'old-cloud', reasoningEffort: 'high' }, { provider: 'local', model: 'cold-next' }],
    [null, { provider: 'local', model: 'cold-last-used', reasoningEffort: 'medium' }, { provider: 'local', model: 'cold-last-used', reasoningEffort: 'medium' }],
  ]) {
    const f = await fixture(t, {
      services: { agentDefaultModel: { currentSelection: () => { throw new Error('Stored session selection must be sufficient'); } } },
      remote: async (request) => (async function* () { yield { type: 'snapshot', header: { id: request.args.request.address.sessionId }, records: [], cursor: -1, hasMore: false, projections: { values: { modelSelection: { next, lastUsed } }, asOfSeq: -1 } }; })(),
      stages: [{ updates: [], additions: [], report: { summary: 'Cold owner review' } }],
    });
    const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
    await f.host.migrate({ sessionId: 'cold', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
    assert.equal(f.agents.has('cold'), false);
    assert.deepEqual(f.calls.map((call) => call.config), [expected]);
  }
});

test('explicit Loop migration stage routing wins over a pending session model selection', async (t) => {
  const f = await fixture(t, {
    projections: { story: { modelSelection: { next: { provider: 'local', model: 'pending-local' }, lastUsed: null } } },
    services: { loopStudio: { registerParticipant: () => () => {}, resolveRoute: ({ nodeId }) => nodeId === 'rp-last-step.migrate' ? { provider: 'local', model: 'explicit-migrator', reasoningEffort: 'high' } : null } },
    stages: [{ updates: [], additions: [], report: { summary: 'Explicit route review' } }],
  });
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await f.host.migrate({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'local', model: 'explicit-migrator', reasoningEffort: 'high', maxTokens: 500 }]);
});

test('fresh migration with no stored selection or request header inherits the valid read-only global default', async (t) => {
  const f = await fixture(t, {
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'local', model: 'configured-default', reasoningEffort: 'low' }) } },
    stages: [{ updates: [], additions: [], report: { summary: 'Fresh owner review' } }],
  });
  const agent = f.agents.get('story');
  agent.options = {};
  agent.session.requestHeader = () => undefined;
  const saved = await f.host.saveProfile({ profile: ready(), expectedRevision: 0 });
  await f.host.migrate({ sessionId: 'story', profileId: saved.profileId, version: saved.version, expectedRevision: saved.revision });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'local', model: 'configured-default', reasoningEffort: 'low' }]);
});

test('presentation continues to inherit the current actual main header despite a pending next model selection', async (t) => {
  const f = await fixture(t, { projections: { story: { modelSelection: { next: { provider: 'local', model: 'pending-local' }, lastUsed: { provider: 'cloud', model: 'actual-main' } } } } });
  f.agents.get('story').session.requestHeader = () => ({ config: { provider: 'cloud', model: 'actual-main', reasoningEffort: 'high' } });
  await bind(f);
  await f.host.present({ sessionId: 'story', contextKey: 'main-current', packet });
  assert.deepEqual(f.calls.map((call) => call.config), [{ provider: 'cloud', model: 'actual-main', reasoningEffort: 'high' }, { provider: 'cloud', model: 'actual-main', reasoningEffort: 'high' }]);
});

test('session failures before receipt creation expose only safe errors and never conclude the turn', async (t) => {
  const f = await fixture(t, { persisted: true, remote: async () => { throw new Error('private source path token=secret'); } });
  let conclusions = 0;
  await assert.rejects(f.ctxTools.get('rp_present').execute({ packet }, {
    agent: f.agents.get('story'), callId: 'call-1', rootCallId: 'call-1', signal: new AbortController().signal, concludeTurn: () => conclusions++,
  }), (error) => error.code === 'SESSION_UNAVAILABLE' && !/private|secret|token=/u.test(error.message));
  assert.equal(conclusions, 0);
  assert.equal(f.calls.length, 0);
  assert.equal(f.presentations.at(-1).status, 'failed');
  assert.doesNotMatch(JSON.stringify(f.presentations), /private|secret|token=/u);
});

test('an isolated writer failure publishes one terminal failure and preserves the resolved tools', async (t) => {
  const f = await fixture(t, { stages: [{ commit: true }, new Error('provider token=secret')] });
  await bind(f);
  await assert.rejects(f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' }), { code: 'MODEL_CALL_FAILED' });
  assert.equal(f.presentations.filter((event) => event.status === 'failed').length, 1);
  assert.equal((await f.host.state('story')).presentations[0].status, 'failed');
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(f.presentations), /provider token|secret/u);
});

test('optional Loop Studio unloading stops observers while preserving already frozen stage selections', async (t) => {
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  let unregistered = 0;
  const studio = { registerParticipant: () => () => unregistered++, resolveRoute: ({ nodeId }) => ({ provider: 'local', model: nodeId.split('.').at(-1) }), recordTrace: () => {} };
  const f = await fixture(t, { services: { loopStudio: studio }, stages: [async () => { started(); await waiting; return { commit: true }; }, 'Still selected.'] });
  await bind(f);
  const pending = f.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' });
  await entered;
  await f.injections.find((child) => child.loopStudio).close();
  release();
  assert.equal((await pending).text, 'Still selected.');
  assert.deepEqual(f.calls.map(({ config }) => config.model), ['assemble', 'render']);
  assert.equal(unregistered, 1);
});

test('registers the bundled standard skill body and resource base and releases it on unload', async (t) => {
  const f = await fixture(t);
  const skill = f.skillEntries.get('adapting-sillytavern-rp-presets');
  assert.equal(skill.source, 'bundled');
  assert.equal(skill.content, 'Bundled migration instructions.');
  assert.equal(skill.description, 'Adapt imported RP presets.');
  assert.deepEqual(skill.resourceBase, { kind: 'directory', path: join(f.directory, 'bundled-skill') });
  await f.host.close();
  assert.equal(f.skillEntries.size, 0);
  assert.equal(f.ctxTools.size, 0);
  assert.equal(f.contexts.size, 0);
  assert.equal(f.host.isEnabled('story'), false);
});

test('unload aborts pending Remote follows and isolated model work and releases listeners', { timeout: 2000 }, async (t) => {
  let readSignal;
  const f = await fixture(t, { remote: async (request) => {
    readSignal = request.signal;
    return { [Symbol.asyncIterator]: () => ({ next: () => new Promise((resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); }), return: async () => ({ done: true }) }) };
  } });
  const pending = f.host.state('story');
  while (!readSignal) await new Promise((resolve) => setImmediate(resolve));
  await f.host.close();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(readSignal.aborted, true);
  assert.equal(f.ctx.count(), 1);
  await assert.rejects(f.host.state('story'), { code: 'UNAVAILABLE' });

  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const g = await fixture(t, { stages: [async (request) => { started(request.signal); return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })); }] });
  await bind(g);
  const presentation = g.host.present({ sessionId: 'story', packet, contextKey: 'turn-1' });
  const signal = await entered;
  await g.host.close();
  await assert.rejects(presentation, { name: 'AbortError' });
  assert.equal(signal.aborted, true);
  assert.equal(g.ctx.count(), 1);
});
