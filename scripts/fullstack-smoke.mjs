import {spawn,execFile} from 'node:child_process'
import {createServer} from 'node:http'
import {createHash} from 'node:crypto'
import {mkdir,writeFile,readFile} from 'node:fs/promises'
import {resolve,join} from 'node:path'
import {chromium} from '@playwright/test'

const root=process.cwd(),home=resolve(`.runtime/fullstack-smoke-${Date.now()}`),evidence=resolve('.runtime/fullstack-evidence')
await mkdir(home,{recursive:true});await mkdir(evidence,{recursive:true})
await writeFile(join(home,'package.json'),JSON.stringify({name:'rp-fullstack-smoke-home',private:true,type:'module'}))
const artifacts={
  database:resolve(process.env.DSH_DATABASE_TGZ??'../dsh-rp-database/artifacts/dsh-rp-database-0.1.0.tgz'),
  context:resolve(process.env.DSH_CONTEXT_TGZ??'../dsh-rp-context/artifacts/dsh-rp-context-0.1.0.tgz'),
  lastStep:resolve('artifacts/dsh-rp-last-step-0.2.0.tgz'),
  loop:resolve(process.env.DSH_LOOP_TGZ??'../dsh-loop-studio/artifacts/dsh-loop-studio-0.1.0.tgz'),
}
if(process.env.DSH_STUDIO_TGZ)artifacts.studio=resolve(process.env.DSH_STUDIO_TGZ)
const hashes=Object.fromEntries(await Promise.all(Object.entries(artifacts).map(async([name,path])=>[name,createHash('sha256').update(await readFile(path)).digest('hex')])))
await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:false,status:'running',hashes}))
const retrievalCalls=[]
const retrieval=createServer(async(request,response)=>{
  try{
    let raw='';for await(const chunk of request)raw+=chunk
    const body=JSON.parse(raw);retrievalCalls.push({path:request.url,body})
    if(JSON.stringify(body).includes('DISABLED_DATABASE_CANARY'))throw Error('Disabled entry reached retrieval provider')
    let result
    if(request.url==='/v1/embeddings')result={data:body.input.map((text,index)=>({index,embedding:/旧信|档案锚点/u.test(text)?[0,1]:[1,0]}))}
    else if(request.url==='/v1/rerank'){
      const target=body.documents.findIndex(text=>text.includes('archive-target'))
      const order=body.documents.map((_text,index)=>index).filter(index=>index!==target)
      if(/旧信/u.test(body.query))order.unshift(target);else order.push(target)
      result={results:order.slice(0,body.top_n).map((index,rank)=>({index,relevance_score:1-rank/100}))}
    }else throw Error('Unknown retrieval endpoint')
    response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(result))
  }catch(error){response.writeHead(400,{'content-type':'application/json'});response.end(JSON.stringify({error:error.message}))}
})
await new Promise(done=>retrieval.listen(0,'127.0.0.1',done))
const retrievalURL=`http://127.0.0.1:${retrieval.address().port}/v1`
const cli=process.env.DSH_BIN??join(process.env.LOCALAPPDATA,'Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'),quote=value=>process.platform==='win32'?`"${value}"`:value
const env={...process.env,DSH_HOME:home,DEEPSEEK_API_KEY:'fullstack-unused-placeholder'}
const invokeCli=args=>new Promise((done,reject)=>{const child=spawn(quote(cli),args,{shell:process.platform==='win32',windowsHide:true,env,cwd:root,stdio:'pipe'});let out='';child.stdout.on('data',chunk=>out+=chunk);child.stderr.on('data',chunk=>out+=chunk);child.on('error',reject);child.on('exit',code=>code===0?done():reject(Error('DSH install failed '+out)))})
for(const artifact of Object.values(artifacts))await invokeCli(['plugin','--profile','web','add',quote(artifact)])
const probeFile=join(home,'fullstack-probe.mjs');await writeFile(probeFile,await readFile('tests/fixtures/fullstack-probe.mjs','utf8'))
const patch=join(home,'fullstack.patch.yml')
await writeFile(patch,`- id: agent-default-model\n  config:\n    provider: fs-cloud\n    model: main\n- id: rp-database\n  config:\n    embedding:\n      baseURL: ${retrievalURL}\n      model: fake-embedding\n    reranking:\n      baseURL: ${retrievalURL}\n      model: fake-reranker\n- insert:\n    - id: fullstack-probe\n      name: ${JSON.stringify(probeFile.replaceAll('\\','/'))}\n    - id: fullstack-story\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: fullstack-story\n        name: 铜门与钟声\n        description: 公开的合成验收故事\n        plugins:\n          - id: rp-runtime-facts\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: 处理事实之后单独调用 rp_present。\n`)
let host,browser,page,logs=''
const redact=value=>value.replace(/([?&]token=)[^\s"'<>]+/gu,'$1[REDACTED]')
async function stopHost(){if(host?.pid){if(process.platform==='win32')await new Promise(done=>execFile('taskkill.exe',['/PID',String(host.pid),'/T','/F'],{windowsHide:true},done));else host.kill('SIGTERM')}host=undefined}
async function startHost(){
  logs='';host=spawn(quote(cli),['--profile','web','--patch',quote(patch),'--host','127.0.0.1','--port','0','--no-open'],{shell:process.platform==='win32',windowsHide:true,env,cwd:root,stdio:['ignore','pipe','pipe']})
  for(const output of[host.stdout,host.stderr])output.on('data',chunk=>logs+=chunk)
  const until=Date.now()+30000;let url
  while(Date.now()<until){url=/https?:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+/u.exec(logs)?.[0];if(url)return url;if(host.exitCode!==null)throw Error('DSH startup failed');await new Promise(done=>setTimeout(done,100))}
  throw Error('DSH startup timed out')
}
try{
  const url=await startHost()
  browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{}})
  page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message))
  await page.addInitScript(()=>{Object.defineProperty(window,'__ModuleLoader__',{configurable:true,set(target){Object.defineProperty(window,'__ModuleLoader__',{configurable:true,writable:true,value:target});let load=target.load.bind(target);const observed=row=>load(row.id!=='@deepseek-ai/dsh-client-ui-workspace'?row:{...row,factory(require){const plugin=row.factory(require);return{...plugin,apply(ctx){window.__workspaceCtx=ctx;return plugin.apply(ctx)}}}});Object.defineProperty(target,'load',{configurable:true,get:()=>observed,set(next){load=next.bind(target)}})}})})
  const visit=async target=>{await page.goto(target,{waitUntil:'networkidle'});const button=page.getByRole('button',{name:'继续',exact:true});await button.waitFor({state:'visible',timeout:1000}).catch(()=>{});if(await button.isVisible())await button.click()}
  await visit(url)
  const request=(path,body)=>page.evaluate(async({path,body})=>{const response=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(40000),body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(JSON.stringify(data));return data.data??data},{path,body})
  const probe=input=>request('api/fullstack-test',input),db=(action,input={})=>request('api/rp-database/request',{action,...input}),context=(action,input={})=>request('api/rp-context/request',{action,...input}),rp=(action,input={})=>request('api/rp-last-step/request',{action,...input}),loop=input=>request('api/loop-studio/request',input)
  const{sessionId}=await probe({action:'create'});console.log('Created isolated story')
  const graph=await loop({action:'inspect',sessionId})
  await loop({action:'savePolicy',sessionId,scope:'session',expectedRevision:graph.revision,policy:{enabled:true,routes:{'rp-context.prepare':{provider:'fs-local',model:'gm'},'rp-context.summarize':{provider:'fs-local',model:'summary'},'rp-last-step.migrate':{provider:'fs-local',model:'gm'},'rp-last-step.assemble':{provider:'fs-local',model:'assembler'},'rp-last-step.render':{provider:'fs-cloud',model:'quality'}}}})
  const entries=[{id:'canon',title:'固定结果',content:'既定结果：门未打开。',readOnly:true,mode:'required'},...Array.from({length:27},(_value,index)=>({id:index===0?'editable':`near-${index}`,title:`门边资料 ${index}`,content:'门锁与钟楼的普通资料。'})),{id:'archive-target',title:'旧信',content:'旧信提供线索，但没有改变门锁。',keywords:['旧信档案锚点'],notes:'守卫未读过这封信。'},{id:'disabled',title:'禁用资料',content:'DISABLED_DATABASE_CANARY',mode:'disabled'}]
  const raw='\uFEFF'+JSON.stringify({name:'铜门档案',entries},null,2)+'\r\n'
  const imported=await db('import',{rawText:raw,expectedRevision:0})
  await db('bind',{sessionId,databaseId:imported.databaseId,version:1,expectedRevision:imported.revision})
  const initialContext=await context('state',{sessionId});await context('configure',{sessionId,settings:{recentTurns:1},expectedRevision:initialContext.revision})
  const stRaw=JSON.stringify({name:'验收文风',prompts:[{identifier:'style',name:'文风',role:'system',content:'使用克制具体的中文。'},{identifier:'agent',name:'Agent职责',role:'system',content:'AGENT_MODULE_CANARY 先读事实工具结果。'}],prompt_order:[{character_id:100001,order:[{identifier:'style',enabled:true},{identifier:'agent',enabled:true}]}]})
  const rpState=await rp('state',{sessionId}),rpImported=await rp('importSillyTavern',{rawText:stRaw,expectedRevision:rpState.revision})
  const migrated=await rp('migrate',{sessionId,profileId:rpImported.profileId,version:rpImported.version,expectedRevision:rpImported.revision})
  const loaded=await rp('profile',{profileId:migrated.profileId,version:migrated.version});loaded.profile.status='ready'
  const ready=await rp('saveProfile',{profile:loaded.profile,expectedRevision:migrated.revision});await rp('bindSession',{sessionId,profileId:ready.profileId,version:ready.version,expectedRevision:ready.revision})
  const turns=[]
  for(let turn=1;turn<=4;turn++){turns.push(await probe({action:'run',sessionId,text:`第${turn}次尝试推门。`}));console.log('Completed actual staged turn',turn)}
  const state=await db('state',{sessionId}),history=await context('state',{sessionId}),source=await db('source',{sourceId:imported.sourceId}),stats=await probe({action:'stats'})
  if(source.source.rawText!==raw||state.binding.entries.find(entry=>entry.id==='canon').content!=='既定结果：门未打开。')throw Error('Source or readonly guard changed')
  if(state.binding.entries.find(entry=>entry.id==='editable').content!=='会话更新 4'||!state.binding.entries.some(entry=>entry.id==='created-4'))throw Error('Story-local updates missing')
  if(history.history.length!==4||history.history[0].mode!=='index'||!history.unresolved.length)throw Error('Active narrative history/representation missing')
  if(turns.at(-1).worldCalls!==4||stats.calls.filter(call=>call.kind==='LAST_STEP_RENDER').length!==4||!stats.calls.some(call=>call.kind==='CONTEXT_SUMMARIZE'))throw Error('Stage counts or summaries missing')
  if(retrievalCalls.filter(call=>call.path==='/v1/embeddings').length<8||retrievalCalls.filter(call=>call.path==='/v1/rerank').length<8)throw Error('Configured semantic providers were not actually called')
  await probe({action:'failWriter'});await probe({action:'run',sessionId,text:'第5次尝试推门。'})
  const failures=await rp('state',{sessionId}),failed=failures.presentations.find(record=>record.canRetry)
  if(!failed||(await context('state',{sessionId})).history.length!==4||(await db('state',{sessionId})).binding.entries.find(entry=>entry.id==='editable').content!=='会话更新 5')throw Error('Failed prose became history or rolled back committed database changes')
  const retry=await probe({action:'run',sessionId,text:'仅重试正文 '+failed.id}),afterRetry=await probe({action:'stats'})
  if(retry.worldCalls!==5||afterRetry.calls.filter(call=>call.kind==='CONTEXT_PREPARE').length!==20||afterRetry.calls.filter(call=>call.kind==='LAST_STEP_RENDER').length!==6||(await context('state',{sessionId})).history.length!==5)throw Error('Writer-only retry repeated settled work or failed canonical acceptance')
  console.log('Writer-only frozen retry preserved settled database and facts')
  const forked=await probe({action:'fork',sessionId,atSeq:turns[1].cursor}),childId=forked.sessionId??forked.session?.id
  if(!childId)throw Error('No fork session id')
  const child=await db('state',{sessionId:childId}),childHistory=await context('state',{sessionId:childId})
  if(child.binding.entries.find(entry=>entry.id==='editable').content!=='会话更新 2'||childHistory.history.length!==2)throw Error('Fork inherited future branch data')
  await page.evaluate(id=>window.__workspaceCtx.get('uiWorkspace').openSession(id),sessionId)
  await page.getByRole('button',{name:'打开故事数据库',exact:true}).click();const editor=page.locator('.rpdb-entry-editor textarea').first();await editor.scrollIntoViewIfNeeded();if(await editor.inputValue()!=='既定结果：门未打开。')throw Error('Native source editor shows wrong version');await page.screenshot({path:join(evidence,'database-sidebar.png')})
  await page.getByRole('button',{name:'当前故事内容与变更',exact:true}).click()
  const waitEffective=text=>page.waitForFunction(expected=>Array.from(document.querySelectorAll('.rpdb-effective')).some(element=>element.querySelector('strong')?.textContent==='门边资料 0'&&element.querySelector('pre')?.textContent===expected),text)
  await waitEffective('会话更新 5')
  await probe({action:'rollbackFifth',sessionId})
  await waitEffective('会话更新 4')
  const rewound=await context('state',{sessionId}),rewoundReceipts=await rp('state',{sessionId})
  if(rewound.history.length!==4||rewoundReceipts.presentations.find(record=>record.id===failed.id)?.canRetry)throw Error('Rollback revived invalid narrative or failed retry source')
  console.log('Native rollback refreshed open database view and invalidated retry source')
  await page.getByRole('button',{name:'全屏',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-rp-database-session]')?.clientWidth>1000);await page.screenshot({path:join(evidence,'database-fullscreen.png')})
  await page.evaluate(()=>window.__workspaceCtx.get('sidebarRight').openTab('rp-context'));await page.getByRole('heading',{name:'主动上下文',exact:true}).waitFor();await page.screenshot({path:join(evidence,'context-fullscreen.png')})
  await page.setViewportSize({width:520,height:900});await page.screenshot({path:join(evidence,'context-narrow.png')});await page.setViewportSize({width:1440,height:1000})
  if(artifacts.studio){
    await page.evaluate(()=>window.__workspaceCtx.get('sidebarRight').openTab('rp-studio'))
    await page.getByRole('button',{name:'沉浸阅读',exact:true}).click()
    await page.locator('.dsh-rp-workspace').getByText('第4次尝试后，门仍未打开。远处的钟声慢慢散去。',{exact:true}).waitFor()
    if((await page.locator('.dsh-rp-workspace').innerText()).includes('第5次尝试后'))throw Error('Reader revived rolled-back retry prose')
    await page.screenshot({path:join(evidence,'studio-reader.png')})
  }
  await stopHost();await visit(await startHost())
  const restored=await db('state',{sessionId}),restoredHistory=await context('state',{sessionId})
  if(restored.binding.entries.find(entry=>entry.id==='editable').content!=='会话更新 4'||restoredHistory.history.length!==4||restoredHistory.history[0].mode!=='index')throw Error('Restart did not preserve branch state')
  if(errors.length)throw Error('Browser runtime errors '+JSON.stringify(errors))
  const result={passed:true,host:'DSH 0.2.1-rc.2',hashes,studioReader:!!artifacts.studio,worldCalls:5,formalNarratives:5,activeNarrativesAfterRollback:4,childNarratives:2,sourceUnchanged:true,readonlyEnforced:true,candidateOutsideSearch:true,historySummaryExpandFold:true,writerOnlyRetry:true,nativeRollback:true,restart:true,embeddingCalls:retrievalCalls.filter(call=>call.path==='/v1/embeddings').length,rerankCalls:retrievalCalls.filter(call=>call.path==='/v1/rerank').length,stageCalls:afterRetry.calls.filter(call=>call.kind!=='MAIN'),errors}
  await writeFile(join(evidence,'acceptance.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
}catch(error){console.error(error.message);if(page){await page.screenshot({path:join(evidence,'failure.png')}).catch(()=>{});console.error((await page.locator('body').innerText().catch(()=>'' )).slice(-5000))}console.error(redact(logs.slice(-9000)));await writeFile(join(evidence,'acceptance.json'),JSON.stringify({passed:false,hashes,error:redact(error.message)},null,2));process.exitCode=1}
finally{await browser?.close();await stopHost();retrieval.closeIdleConnections();await new Promise(done=>retrieval.close(done))}
