import test from 'node:test'
import assert from 'node:assert/strict'

test('retry eligibility rejects completed active descendants and inactive original sources',async()=>{
  const module=await import('../src/retry.mjs').catch(()=>({}));assert.equal(typeof module.retryEligibility,'function')
  const failed={id:'failed',status:'failed',contextKey:'a',compiled:{messages:[]}}
  const complete={id:'success',rewriteOf:'failed',status:'complete',contextKey:'b'}
  assert.equal(module.retryEligibility([failed],failed,['a']).canRetry,true)
  assert.equal(module.retryEligibility([failed,complete],failed,['a','b']).code,'REWRITE_ALREADY_RENDERED')
  assert.equal(module.retryEligibility([failed],failed,[]).code,'REWRITE_SOURCE_INACTIVE')
  assert.equal(module.retryEligibility([failed,complete],failed,['a']).canRetry,true)
})

test('native retry sources preserve compaction but exclude replaced branches and reused wire identities',async()=>{
  const{activePresentationContexts}=await import('../src/retry.mjs')
  const events=[1,2].map(seq=>({seq,type:'assistant/message',surfaceOp:'append',data:{message:{id:'m'+seq,source:{kind:'model'},content:[{type:'tool-call',name:'rp_present',id:'reused'}]}}}))
  events.push({seq:3,type:'user/message',surfaceOp:{op:'replace',startSeq:1,endSeq:1},data:{source:{kind:'compact-checkpoint'}}})
  assert.deepEqual(activePresentationContexts('s',events),['["s","m1","reused"]','["s","m2","reused"]'])
  events.push({seq:4,type:'user/message',surfaceOp:{op:'replace',startSeq:2,endSeq:2},data:{source:{kind:'runtime-context'}}})
  assert.deepEqual(activePresentationContexts('s',events),['["s","m1","reused"]'])
})
