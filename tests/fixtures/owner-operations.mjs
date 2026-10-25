import {baseEvents} from './narrative-events.mjs';
export function ownerFixture(options={}){
  const listeners=new Map(),commands=new Map(),guards=new Set(),events=baseEvents(),calls=[];
  let work=Promise.resolve(),turn=1,closed=false;
  const on=(name,handler)=>{const entries=listeners.get(name)??new Set();entries.add(handler);listeners.set(name,entries);return()=>entries.delete(handler);};
  const emit=async(name,...args)=>{for(const handler of listeners.get(name)??[])await handler(...args);};
  async function waterfall(name,payload){const handlers=[...listeners.get(name)??[]];const next=index=>handlers[index]?handlers[index](payload,()=>next(index+1)):Promise.resolve({kind:'enter',messages:payload.messages});return next(0);}
  const append=(type,data,intent={})=>{const event={seq:events.at(-1).seq+1,type,data:structuredClone(data),...intent};events.push(event);return event;};
  const agent={id:'story',status:'idle',session:{id:'story',snapshotEvents:()=>structuredClone(events),append},ctx:{tools:{guard(fn){guards.add(fn);return()=>guards.delete(fn);}}},
    followup(message){agent.status='running';const abort=new AbortController();agent.cancel=()=>abort.abort();work=Promise.resolve().then(async()=>{
      await options.beforeStep?.();turn++;append('turn/start',{turn});
      let decision=await waterfall('agent/pre-step',{agent,turn,step:1,signal:abort.signal,messages:options.messages??[message]});
      if(decision.kind==='enter'&&!abort.signal.aborted){calls.push(decision.messages);await options.dispatch?.({agent,turn,message,guards,events});if(options.secondStep)decision=await waterfall('agent/pre-step',{agent,turn,step:2,signal:abort.signal,messages:[]});}
      append('turn/end',{turn,reason:{kind:abort.signal.aborted?'aborted':decision.kind==='reject'?'blocked':'completed'}});await emit('session/event',agent.session,events.at(-1));
    }).finally(()=>{agent.status='idle';});},whenIdle:()=>work,cancel(){},
  };
  const ctx={on,agents:{get:id=>id==='story'?agent:undefined},connection:{browserPeer:{owner:true}},get:name=>name==='commands'?registry:undefined,
    typertGateway:{invoke:async request=>{if(request.namespace!=='commands'||request.method!=='execute'||request.args.agentId!=='story')throw Error('Wrong command route');const [,name,rawInput]=/^\/([^ ]+)\s+(.*)$/u.exec(request.args.line);return{commandId:'command',result:await commands.get(name).handler({agent,rawInput,signal:request.signal})};}},
  };
  const registry={register(definition){commands.set(definition.name,definition);return()=>commands.delete(definition.name);}};
  return{ctx,agent,events,calls,guards,registry,commands,listeners,hookCount:()=>[...listeners.values()].reduce((n,set)=>n+set.size,0),close(){closed=true;},get closed(){return closed;}};
}
