// Deterministic native LastStep fixture; optional Context is a contracted test double.
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
export const name='last-step-drafts-probe';
export const inject=['llm','agents','tools','connection','typertGateway','sessionQuery','sessionPersistence','agentPresets'];
const textOf=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
async function* textChunks(text){yield{type:'text-delta',index:0,text};yield{type:'block-end',index:0,block:{type:'text',text}};yield{type:'finish',reason:{kind:'stop'}};}
async function* toolChunks(name,args){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id:'reused-call',name,argumentsDelta:JSON.stringify(args)};yield{type:'block-end',index:0,block:{type:'tool-call',id:'reused-call',name,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}};}
export function apply(ctx){
  const counts={facts:0,main:0,writer:0,assembly:0,context:0},failed=new Set(),handles=[];let retryMode='proper';
  let adoptionGate;
  const restoreRead=()=>{if(adoptionGate?.originalRead){fs.promises.readFile=adoptionGate.originalRead;syncBuiltinESMExports();adoptionGate.originalRead=null;}};
  function armAdoptionGate(){
    if(adoptionGate?.originalRead)throw Error('An adoption read gate is already armed');
    let release,entered;const gate={reads:[],held:false,release:()=>release(),ready:new Promise(done=>{entered=done;}),wait:new Promise(done=>{release=done;}),originalRead:fs.promises.readFile};adoptionGate=gate;
    fs.promises.readFile=async function(...args){
      const selected=String(args[0]).replaceAll('\\','/').endsWith('/rp-last-step/drafts/drafts.json'),index=selected?gate.reads.push(new Error().stack.split('\n').slice(1,5)):0;
      const value=await gate.originalRead(...args);
      // With no prose panel mounted, adoption performs initial get, pre-step get,
      // then withVersion's final read. Pause its real I/O return, not product code.
      if(index===3){gate.held=true;entered();try{await gate.wait;}finally{restoreRead();}}
      return value;
    };syncBuiltinESMExports();
  }
  const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal});
  ctx.tools.register({name:'lsb_fact',description:'One local deterministic factual action',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async()=>({count:++counts.facts,outcome:'The gate remains closed.'})});
  ctx.provide('rpContext',{prepare:async input=>{counts.context++;return{id:'frozen-'+input.presentationId,authorNote:{id:'synthetic-note',version:1,claimId:input.presentationId},candidates:[{key:'world:gate',ref:{sourceKey:'world',entryId:'gate'},title:'The gate',version:1,mode:'required',readOnly:true}],materials:{entries:[{ref:{sourceKey:'world',entryId:'gate'},id:'gate',version:1,content:'The gate remains closed.'}],history:[],recentProse:[],guidance:'Owner writing guidance: preserve the fixed failure.',chars:96},models:{}};},presentationOutcome:async()=>{}});
  const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,value)=>value,listModels:async provider=>[{provider,id:'main',name:'main'}],resolveModel:async(provider,id)=>({provider,id,name:id}),async prepareCall(provider,id){return{model:await this.resolveModel(provider,id),stream:options=>this.stream(options)};},async*stream(options){
    const system=options.system??options.messages.filter(message=>message.role==='system').map(textOf).join('\n');
    if(system.includes('RP_LAST_STEP_ASSEMBLE')){counts.assembly++;yield*textChunks('{"commit":true}');return;}
    if(system.includes('RP_LAST_STEP_RENDER')){
      counts.writer++;const input=JSON.parse(textOf(options.messages[0]));
      if(input.packet.playerAction.includes('writer-fails')&&!failed.has(input.packet.playerAction)){failed.add(input.packet.playerAction);throw Error('Synthetic writer unavailable');}
      yield*textChunks(input.instruction?'An alternative expression; the gate remains closed.':'The gate stays closed. Rain gathers on the threshold.');return;
    }
    counts.main++;const index=options.messages.findLastIndex(message=>message.role==='user'&&message.source?.kind==='user'),input=textOf(options.messages[index]),tail=options.messages.slice(index+1);
    if(input.startsWith('仅重试已冻结正文')){
      const match=/"rewriteOf":("(?:[^"\\]|\\.)*")/u.exec(input),id=match&&JSON.parse(match[1]);
      if(retryMode==='fact'){yield*toolChunks('lsb_fact',{});return;}
      if(retryMode==='wrong'){yield*toolChunks('rp_present',{rewriteOf:'wrong-failed-id'});return;}
      if(retryMode==='extra'){yield*toolChunks('rp_present',{rewriteOf:id,packet:{playerAction:'Forbidden new fact'}});return;}
      if(retryMode==='text'){yield*textChunks('No tool dispatched.');return;}
      yield*toolChunks('rp_present',{rewriteOf:id});return;
    }
    if(tail.some(message=>message.role==='tool'&&message.isError===true)){yield*textChunks('The synthetic writer failed; wait for the owner retry action.');return;}
    if(!tail.some(message=>message.role==='tool'&&textOf(message).includes('"outcome"'))){yield*toolChunks('lsb_fact',{});return;}
    yield*toolChunks('rp_present',{packet:{playerAction:input,resolvedChanges:['The attempt failed; the gate remains closed.'],visibleConsequences:['Rain gathers on the threshold.']}});
  }};
  ctx.llm.registerAdapter(['lsb-local'],adapter);
  const snapshot=async sessionId=>{await ctx.sessionPersistence.flush();const view=await ctx.sessionQuery.observeSession(sessionId);try{return{header:view.header,events:view.events,inheritedEventCount:view.inheritedEventCount,messages:ctx.agents.get(sessionId)?.session.deriveMessages(),counts:{...counts}};}finally{view[Symbol.dispose]();}};
  ctx.connection.fetch.register({path:'/api/last-step-drafts-probe',methods:['POST'],requestBody:'buffered',fetch:async request=>{
    try{
      const input=await request.json(),last=ctx.get('rpLastStep');let value;
      if(input.action==='create'){
        value=await invoke('create',{agentPreset:'last-step-drafts-story'},request.signal);
        const profile=await last.ensureBuiltinProfile({key:'last-step-native-probe.v1',profile:{name:'Synthetic native prose',entries:[{id:'style',content:'Write concise public prose, preserving the gate failure.',phase:'render',role:'system',required:true,locked:true}]}});
        await last.bindSession({sessionId:value.sessionId,...profile,expectedRevision:(await last.state(value.sessionId)).revision});
      }else if(input.action==='createUnusedStyle'){
        const rawText='{ "name":"Pinned StyleV1", "prompts":[{"identifier":"style","content":"Unused asset default style."}] }',imported=await last.importSillyTavern({rawText,expectedRevision:(await last.state(input.sessionId)).revision}),profile=(await last.profile({profileId:imported.profileId,version:1})).profile;
        const latest=await last.saveProfile({profile:{...profile,entries:profile.entries.map(entry=>({...entry,content:'Later unused style.'}))},expectedRevision:(await last.state(input.sessionId)).revision});
        value={ref:{profileId:profile.id,version:1},profile,source:(await last.source({sourceId:profile.sourceId})).source,latestVersion:latest.version};
      }else if(input.action==='run'){await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:input.text}]},request.signal);await ctx.agents.get(input.sessionId).whenIdle();value=await snapshot(input.sessionId);}
      else if(input.action==='armAdoptionGate'){armAdoptionGate();value={armed:true};}
      else if(input.action==='awaitAdoptionGate'){await Promise.race([adoptionGate.ready,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('Final adoption read did not pause')),10000))]);value={held:adoptionGate.held,reads:adoptionGate.reads};}
      else if(input.action==='cancelAdoptionGate'){if(!adoptionGate?.held)throw Error('Final adoption read is not held');const agent=ctx.agents.get(input.sessionId);agent.cancel({kind:'user'},{keepInbox:true});adoptionGate.release();await agent.whenIdle();value=await snapshot(input.sessionId);}
      else if(input.action==='snapshot')value=await snapshot(input.sessionId);
      else if(input.action==='stats')value={...counts};
      else if(input.action==='contentRevision')value=await last.contentRevision();
      else if(input.action==='retryMode'){retryMode=input.mode;value={retryMode};}
      else if(input.action==='fork'){value=await invoke('fork',{sessionId:input.sessionId,atSeq:input.atSeq},request.signal);if(typeof last.inheritSession==='function')await last.inheritSession({parentSessionId:input.sessionId,sessionId:value.sessionId,signal:request.signal});}
      else if(input.action==='exportState')value=await last.exportState({sessionIds:input.sessionIds,additionalProfileRefs:input.additionalProfileRefs,signal:request.signal});
      else if(input.action==='preflightRestore')value=await last.preflightRestore({sessionIds:input.sessionIds,state:input.state,signal:request.signal});
      else if(input.action==='restoreState')value=await last.restoreState({restoreId:input.restoreId,sessionIds:input.sessionIds,state:input.state,expectedRevision:(await last.contentRevision()).revision,signal:request.signal});
      else if(input.action==='importSession'){const handle=await ctx.sessionPersistence.create(input.header,{inheritedEventCount:input.inheritedEventCount});try{await handle.append(input.events);await handle.flush();}finally{await handle.close();}value={sessionId:input.header.id};}
      else if(input.action==='resume'){const handle=await ctx.agents.resume({resumeSessionId:input.sessionId,agentOptions:{provider:'lsb-local',model:'main'},setup:async agentCtx=>{await ctx.agentPresets.mount(agentCtx,'last-step-drafts-story');}});handles.push(handle);value=await snapshot(input.sessionId);}
      else throw Error('Unknown fixture action');return Response.json(value);
    }catch(error){return Response.json({error:{message:error.message,code:error.code,stack:error.stack}},{status:500});}
  }});
  ctx.effect(()=>async()=>{adoptionGate?.release();restoreRead();for(const handle of handles)await handle.dispose();},'native fixture handles');
}
