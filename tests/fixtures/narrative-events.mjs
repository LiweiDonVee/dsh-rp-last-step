export const presentationId = '00000000-0000-4000-8000-000000000001';
export const baseEvents = () => [
  {seq:0,type:'system/message',surfaceOp:'append',data:{message:{id:'sys',role:'system',content:[]}}},
  {seq:1,type:'turn/start',data:{turn:1}},
  {seq:2,type:'user/message',surfaceOp:'append',data:{id:'user',role:'user',source:{kind:'user'},content:[{type:'text',text:'Push the gate.'}]}},
  {seq:3,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'assistant',role:'assistant',source:{kind:'model'},content:[{type:'tool-call',id:'present',name:'rp_present',arguments:'{}'}]}}},
  {seq:4,type:'tool/call',data:{turn:1,step:1,callId:'present',name:'rp_present',arguments:'{}'}},
  {seq:5,type:'tool/result',surfaceOp:'append',sourceEventSeqs:[4],data:{turn:1,step:1,message:{id:'result',role:'tool',source:{kind:'tool',callId:'present'},toolCallId:'present',isError:false,content:[{type:'text',text:'The gate stays shut.'}]},meta:{rpLastStep:{schemaVersion:1,record:{id:presentationId,status:'complete',text:'The gate stays shut.',createdAt:'2026-10-25T00:00:00Z'}}}}},
  {seq:6,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
];
export const baseRef = () => ({sessionId:'story',presentationId,assistantMessageId:'assistant',callSeq:4,baseResultSeq:5,resultSeq:5});
export function replacement(events,text='The closed gate resists.',seq=10){
  const target=events.findLast(event=>event.type==='tool/result');
  return {seq,type:'tool/result',surfaceOp:{op:'replace',startSeq:target.seq,endSeq:target.seq},sourceEventSeqs:[4,target.seq],data:{...structuredClone(target.data),message:{...structuredClone(target.data.message),content:[{type:'text',text}]}}};
}
