import {randomUUID} from 'node:crypto';
import {PresetError} from './core.mjs';
import {requireLatestNarrative} from './narratives.mjs';

const commands={adopt:'rp_adopt_draft',retry:'rp_retry_presentation'};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const safeError=error=>error instanceof PresetError?`${error.code}: ${error.message}`:error?.name==='AbortError'?'正文管理操作已取消。':'正文管理操作未能完成。';

/** Owner commands create real native turns; temporary hooks match one inbox request and turn. */
export function createOwnerOperations(ctx,{prepare,complete,withDraftVersion=(_input,work)=>work()}){
  const pending=new Map(),queues=new Map(),lifetimes=new Set(),jobs=new Set(),activities=new Set();
  let connected=false,disconnect=()=>{},stopped=false;
  function capable(agent,kind){return !stopped&&connected&&typeof ctx.typertGateway?.invoke==='function'&&agent?.status==='idle'&&typeof agent.followup==='function'&&typeof agent.whenIdle==='function'&&typeof agent.session?.snapshotEvents==='function'&&typeof agent.session?.append==='function'&&(kind!=='retry'||typeof agent.ctx?.tools?.guard==='function');}
  async function execute(operation,agent,commandSignal){
    if(!capable(agent,operation.kind))throw new PresetError('OWNER_OPERATION_UNAVAILABLE','This story must be idle with native owner operations available',409);
    const signal=commandSignal?AbortSignal.any([operation.signal,commandSignal]):operation.signal;
    signal.throwIfAborted();await prepare({kind:operation.kind,request:operation.request,agent,signal});signal.throwIfAborted();
    if(agent.status!=='idle')throw new PresetError('PRESENTATION_BUSY','The story started other work before this operation',409);
    const requestId=randomUUID(),releases=[];
    let turn,step,seq,failure,finished=false,resolveEnd,guarded=false;
    const end=new Promise(resolve=>{resolveEnd=resolve;});
    const cleanup=()=>{for(const release of releases.splice(0).reverse())release();};
    const reject=error=>{failure??=error;return{kind:'reject'};};
    const aborted=()=>{
      failure??=new DOMException('Owner operation cancelled','AbortError');
      if(turn!==undefined&&!finished&&agent.session.snapshotEvents().findLast(event=>event.type==='turn/start')?.data.turn===turn)agent.cancel({kind:'user'},{keepInbox:true});
    };
    signal.addEventListener('abort',aborted,{once:true});
    releases.push(()=>signal.removeEventListener('abort',aborted));
    releases.push(ctx.on('session/event',(session,event)=>{
      if(session===agent.session&&turn!==undefined&&event.type==='turn/end'&&event.data.turn===turn){finished=true;cleanup();resolveEnd();}
    }));
    releases.push(ctx.on('agent/pre-step',async(proposal,next)=>{
      if(proposal.agent!==agent)return next();
      if(turn!==undefined){
        if(proposal.turn!==turn)return next();
        if(operation.kind==='retry'&&proposal.step!==step)return{kind:'reject'};
        return next();
      }
      const mine=proposal.messages?.some(message=>message.id===requestId);
      if(!mine)return next();
      if(proposal.messages.some(message=>message.id!==requestId)){
        failure=new PresetError('OWNER_REQUEST_CONFLICT','Another request was combined with this owner action; reload before retrying',409);
        const decision=await next();return decision.kind==='enter'?{...decision,messages:decision.messages.filter(message=>message.id!==requestId)}:decision;
      }
      turn=proposal.turn;step=proposal.step;
      if(signal.aborted)return reject(new DOMException('Owner operation cancelled','AbortError'));
      try{
        const prepared=await prepare({kind:operation.kind,request:operation.request,agent,signal});signal.throwIfAborted();
        if(operation.kind==='adopt'){
          seq=await withDraftVersion({request:operation.request,agent},()=>{
            const events=agent.session.snapshotEvents(),ref=prepared.narrative.ref;requireLatestNarrative(agent.id,events,ref);
            const current=events.find(event=>event.seq===ref.resultSeq);
            if(!current)throw new PresetError('NARRATIVE_CONFLICT','The selected narrative changed before adoption',409);
            const data=structuredClone(current.data);data.message.content=[{type:'text',text:prepared.text}];
            return agent.session.append('tool/result',data,{surfaceOp:{op:'replace',startSeq:current.seq,endSeq:current.seq},sourceEventSeqs:[ref.callSeq,current.seq]}).seq;
          });
          return{kind:'reject'};
        }
        releases.push(agent.ctx.tools.guard(exec=>{
          if(exec.agent!==agent)return undefined;
          const currentTurn=agent.session.snapshotEvents().findLast(event=>event.type==='turn/start')?.data.turn;
          if(currentTurn!==turn)return undefined;
          const args=exec.arguments;
          return exec.name==='rp_present'&&exec.parent===undefined&&exec.rootCallId===exec.callId&&object(args)&&Object.keys(args).length===1&&args.rewriteOf===operation.request.presentationId?undefined:'Only rp_present with the selected failed presentation rewriteOf is permitted for this retry request';
        }));guarded=true;
        const decision=await next();
        if(decision.kind==='enter'&&!decision.messages.some(message=>message.id===requestId))return reject(new PresetError('OWNER_REQUEST_CONFLICT','The retry request identity changed before dispatch',409));
        return decision;
      }catch(error){return reject(error);}
    }));
    try{
      agent.followup({id:requestId,role:'user',source:{kind:'user'},content:[{type:'text',text:operation.kind==='adopt'?'采用上一轮正文的表达候选，不改变任何事实，也不推进剧情。':`仅重试已冻结正文：单独调用 rp_present({"rewriteOf":${JSON.stringify(operation.request.presentationId)}})。不提交 packet/factReceiptId，不运行事实或其他工具。`}]});
      await Promise.race([end,agent.whenIdle()]);
      if(failure)throw failure;signal.throwIfAborted();
      if(turn===undefined)throw new PresetError('OWNER_REQUEST_CONFLICT','The specific owner request was not admitted; story text is unchanged',409);
      if(operation.kind==='adopt'){
        if(seq===undefined)throw new PresetError('ADOPTION_REJECTED','The candidate was not adopted',409);
        return{kind:'success',text:'正文已采用。宿主将本次正文管理回合标记为 blocked；这不表示剧情行动失败。',sourceEventSeq:seq};
      }
      if(!guarded)throw new PresetError('RETRY_DISPATCH_FAILED','The retry execution restriction could not be installed',409);
      const result=await complete({kind:operation.kind,request:operation.request,agent,turn,signal});
      return{kind:'success',text:'已通过原生终止工具重试正文；没有重新处理事实或材料。',sourceEventSeq:result.sourceEventSeq};
    }finally{cleanup();}
  }
  return Object.freeze({
    capable,
    connect(registry){
      disconnect();const releases=[];connected=true;
      for(const [kind,name] of Object.entries(commands))releases.push(registry.register({name,description:kind==='adopt'?'采用 owner 正文候选':'仅重试所选冻结失败正文',input:{hint:'<owner operation>'},recordInput:false,handler:async invocation=>{
        const token=invocation.rawInput.trim(),operation=pending.get(token);
        if(!operation||operation.claimed||operation.kind!==kind||operation.sessionId!==invocation.agent.id)return{kind:'error',text:'The owner operation is no longer available for this story'};
        operation.claimed=true;
        const activity=execute(operation,invocation.agent,invocation.signal);activities.add(activity);
        try{return await activity;}catch(error){operation.error=error;return{kind:'error',text:safeError(error)};}finally{activities.delete(activity);}
      }}));
      let active=true;disconnect=()=>{if(!active)return;active=false;connected=false;for(const release of releases.reverse())release();};return disconnect;
    },
    run(input){
      const captured=structuredClone({kind:input.kind,sessionId:input.sessionId,request:input.request}),lifetime=new AbortController(),signal=input.signal?AbortSignal.any([input.signal,lifetime.signal]):lifetime.signal;
      lifetimes.add(lifetime);
      const job=(queues.get(captured.sessionId)??Promise.resolve()).then(async()=>{
        signal.throwIfAborted();if(!capable(ctx.agents.get(captured.sessionId),captured.kind))throw new PresetError('OWNER_OPERATION_UNAVAILABLE','This idle native story cannot dispatch the requested operation',409);
        const token=randomUUID(),operation={...captured,signal,claimed:false};pending.set(token,operation);
        try{const dispatch=await ctx.typertGateway.invoke({namespace:'commands',method:'execute',args:{agentId:captured.sessionId,line:`/${commands[captured.kind]} ${token}`,submittedAttachments:[]},peer:ctx.connection.browserPeer,signal});if(captured.kind==='adopt'&&operation.error)throw operation.error instanceof PresetError||operation.error?.name==='AbortError'?operation.error:new PresetError('ADOPTION_REJECTED','The candidate could not be adopted',409);return dispatch;}
        finally{pending.delete(token);}
      });
      const settled=job.then(()=>undefined,()=>undefined);queues.set(captured.sessionId,settled);jobs.add(settled);
      void settled.then(()=>{lifetimes.delete(lifetime);jobs.delete(settled);if(queues.get(captured.sessionId)===settled)queues.delete(captured.sessionId);});return job;
    },
    async close(){stopped=true;for(const lifetime of lifetimes)lifetime.abort();await Promise.allSettled([...jobs,...activities]);disconnect();pending.clear();},
  });
}
