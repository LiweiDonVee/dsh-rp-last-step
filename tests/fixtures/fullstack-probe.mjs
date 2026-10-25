// Public deterministic fixture: no production provider or private card data.
export const name='rp-fullstack-probe'
export const inject=['llm','agents','tools','connection','typertGateway']
const textOf=message=>(message?.content??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n')
async function* textChunks(text){yield{type:'text-delta',index:0,text};yield{type:'finish',reason:{kind:'stop'}}}
async function* toolChunks(name,args,id){yield{type:'block-start',index:0,blockType:'tool-call'};yield{type:'tool-call-delta',index:0,id,name,argumentsDelta:JSON.stringify(args)};yield{type:'block-end',index:0,block:{type:'tool-call',name,id,arguments:JSON.stringify(args)}};yield{type:'finish',reason:{kind:'tool-calls'}}}

export function apply(ctx){
  const calls=[],worldCalls=new Map(),gmSteps=new Map();let failNextWriter=false
  ctx.tools.register({name:'fullstack_world',description:'Resolve synthetic facts once.',parameters:{type:'object',properties:{},additionalProperties:false},output:{schema:{type:'object'},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},execute:async(_args,exec)=>{const count=(worldCalls.get(exec.agent.id)??0)+1;worldCalls.set(exec.agent.id,count);return{publicWorldCount:count,visible:'门依旧关闭。',private:'MAIN_PRIVATE_WORLD_CANARY'}}})
  const adapter={providerInfo:id=>({id,name:id}),providerRetryPolicy:()=>undefined,imageRequestPricing:()=>undefined,imageRequestTarget:(_p,_m,value)=>value,
    listModels:async provider=>['main','gm','summary','assembler','quality'].map(id=>({provider,id,name:id})),resolveModel:async(provider,id)=>({provider,id,name:id}),
    async prepareCall(provider,id,signal){return{model:await this.resolveModel(provider,id,signal),stream:options=>this.stream(options)}},
    async*stream(options){
      const system=options.system??'',stage=/RP_(CONTEXT_(?:PREPARE|SUMMARIZE)|LAST_STEP_(?:MIGRATE|ASSEMBLE|RENDER))/u.exec(system)?.[1]
      const sid=ctx.agents.currentInitiator()?.id
      if(stage){
        const input=JSON.parse(textOf(options.messages[0]));calls.push({kind:stage,sessionId:sid,provider:options.provider,model:options.model,tools:options.tools?.length??0})
        if(stage==='LAST_STEP_MIGRATE'){yield*textChunks(JSON.stringify({updates:input.profile.entries.map(entry=>({id:entry.id,phase:entry.id==='agent'?'agent':'render'})),report:{summary:'将事实处理和文风分开。',blocked:[]}}));return}
        if(stage==='CONTEXT_SUMMARIZE'){
          if(options.model!=='summary')throw Error('Summary route was not used')
          yield*textChunks(JSON.stringify({summaries:input.history.map(record=>({id:record.id,summary:'门未打开，玩家的尝试没有改变门锁。'}))}));return
        }
        if(stage==='CONTEXT_PREPARE'){
          if(options.model!=='gm'||options.tools?.length)throw Error('GM route or independent call failed')
          const key=input.packet.playerAction,step=(gmSteps.get(key)??0)+1;gmSteps.set(key,step)
          const turn=Number(/第(\d+)次/u.exec(key)?.[1]??1)
          if(step===1){
            if(input.candidates.some(entry=>entry.id==='archive-target'))throw Error('Target unexpectedly in initial candidate list')
            if(turn===3){if(input.history[0]?.mode!=='summary'||input.history[0].content.includes('铜门环'))throw Error('Default old-history summary not applied')}
            yield*textChunks(JSON.stringify({search:['旧信档案锚点'],readHistory:turn>=3?[input.history[0].id]:[],commit:false}));return
          }
          if(step===2){
            if(!input.searchResults.some(result=>result.candidates.some(entry=>entry.id==='archive-target')))throw Error('Outside-candidate search did not discover target')
            if(turn>=3&&!input.readHistory.some(record=>record.text.includes('铜门环')))throw Error('Exact original history expansion failed')
            yield*textChunks(JSON.stringify({databaseOperations:[{op:'update',id:'canon',patch:{content:'FORBIDDEN_OVERRIDE'}}],commit:true}));return
          }
          if(step===3){
            if(!input.diagnostics.some(item=>item.code==='READ_ONLY'))throw Error('Readonly GM edit was not rejected')
            yield*textChunks(JSON.stringify({readEntries:['archive-target'],commit:false}));return
          }
          if(!input.readEntries.some(entry=>entry.id==='archive-target'&&entry.content.includes('线索')))throw Error('Selected source was not read')
          yield*textChunks(JSON.stringify({selectedEntries:['archive-target','editable'],databaseOperations:[{op:'update',id:'editable',patch:{content:`会话更新 ${turn}`}},{op:'add',entry:{id:`created-${turn}`,title:`新条目 ${turn}`,content:'仅属于当前故事'}},{op:'note',id:'editable',text:'本次准备保持门未打开。'}],historyOperations:turn===3?[{id:input.history[0].id,mode:'full'}]:turn>=4?[{id:input.history[0].id,mode:'index'}]:[],unresolved:['守门人的承诺尚未兑现。'],notes:'人物只按亲历和传闻判断，不自动全知。',commit:true}));return
        }
        if(stage==='LAST_STEP_ASSEMBLE'){yield*textChunks(JSON.stringify({commit:true}));return}
        if(stage==='LAST_STEP_RENDER'){
          if(options.model!=='quality'||options.tools?.length)throw Error('Writer stage isolation failed')
          const serialized=JSON.stringify(input)
          if(/MAIN_PRIVATE_WORLD_CANARY|DISABLED_DATABASE_CANARY|AGENT_MODULE_CANARY/u.test(serialized))throw Error('Forbidden source reached writer')
          if(!input.context?.entries.some(entry=>entry.id==='archive-target')||!input.context.entries.some(entry=>entry.id==='canon'))throw Error('Selected/required database snapshot missing')
          const turn=Number(/第(\d+)次/u.exec(input.packet.playerAction)?.[1]??1)
          if(!input.context.entries.some(entry=>entry.id==='editable'&&entry.content===`会话更新 ${turn}`))throw Error('Staged database edit missing from frozen writer material')
          if(turn===3&&!input.context.history.some(record=>record.mode==='full'&&record.content.includes('铜门环')))throw Error('Explicit history expansion not in writer material')
          if(turn>=4&&input.context.history[0]?.mode!=='index')throw Error('Explicit history fold not in writer material')
          if(failNextWriter){failNextWriter=false;throw Error('Synthetic writer failure')}
          const prose=turn===1?'门仍紧闭。雨水沿着铜门环滴落。':`第${turn}次尝试后，门仍未打开。远处的钟声慢慢散去。`
          yield*textChunks(prose);return
        }
      }
      const human=options.messages.findLastIndex(message=>message.role==='user'&&message.source?.kind==='user')
      if(human<0){yield*textChunks('合成故事');return}
      const input=textOf(options.messages[human]),tail=options.messages.slice(human+1)
      calls.push({kind:'MAIN',sessionId:sid,provider:options.provider,model:options.model})
      if(input.startsWith('仅重试正文 ')){yield*toolChunks('rp_present',{rewriteOf:input.slice('仅重试正文 '.length).trim()},'reused-present');return}
      const world=tail.find(message=>message.role==='tool'&&message.toolCallId==='reused-world')
      if(!world){yield*toolChunks('fullstack_world',{},'reused-world');return}
      if(tail.some(message=>message.role==='tool'&&message.toolCallId==='reused-present'))throw Error('Main Agent echoed after terminal presentation')
      yield*toolChunks('rp_present',{packet:{playerAction:input,resolvedChanges:['推门失败，门没有打开。'],visibleConsequences:['门仍紧闭。'],proseConstraints:['不替玩家决定下一步。']}},'reused-present')
    },
  }
  ctx.llm.registerAdapter(['fs-cloud','fs-local'],adapter)
  const invoke=(method,request,signal)=>ctx.typertGateway.invoke({namespace:'session',method,args:{request},peer:ctx.connection.browserPeer,signal})
  ctx.connection.fetch.register({path:'/api/fullstack-test',methods:['POST'],requestBody:'buffered',fetch:async request=>{try{
    const input=await request.json()
    if(input.action==='create')return Response.json(await invoke('create',{agentPreset:'fullstack-story'},request.signal))
    if(input.action==='fork')return Response.json(await invoke('fork',{sessionId:input.sessionId,atSeq:input.atSeq},request.signal))
    if(input.action==='run'){await invoke('prompt',{sessionId:input.sessionId,requestId:crypto.randomUUID(),mode:'queue',content:[{type:'text',text:input.text}]},request.signal);const agent=ctx.agents.get(input.sessionId);await agent.whenIdle();return Response.json({calls:calls.filter(call=>call.sessionId===input.sessionId),worldCalls:worldCalls.get(input.sessionId)??0,cursor:agent.session.seq-1})}
    if(input.action==='stats')return Response.json({calls,worldCalls:[...worldCalls]})
    if(input.action==='failWriter'){failNextWriter=true;return Response.json({armed:true})}
    if(input.action==='rollbackFifth'){
      const session=ctx.agents.get(input.sessionId).session,events=session.snapshotEvents(),start=events.find(event=>event.type==='user/message'&&event.data.source?.kind==='user'&&textOf(event.data).startsWith('第5次'))?.seq
      const nodes=session.surface.nodes,end=nodes.at(-1),offset=nodes.indexOf(start)
      if(offset<0)throw Error('Synthetic rollback point not found')
      session.append('user/message',{id:crypto.randomUUID(),role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'测试回退至第五次行动之前。'}]},{surfaceOp:{op:'replace',startSeq:start,endSeq:end},sourceEventSeqs:nodes.slice(offset)})
      const sessions=ctx.get('sessions');if(typeof sessions.flush==='function')await sessions.flush(session)
      return Response.json({rolledBack:true})
    }
    return Response.json({error:'Unknown fixture action'},{status:400})
  }catch(error){return Response.json({error:error.message,code:error.code},{status:500})}}})
}
