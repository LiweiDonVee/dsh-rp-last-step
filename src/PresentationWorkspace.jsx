import React,{useEffect,useRef,useState} from 'react'
const statuses={prepared:'已预留',assembling:'组装材料',rendering:'正文生成中',rendered:'已生成，待规范接受',complete:'已规范提交',failed:'失败',cancelled:'已取消',ready:'可审阅',generating:'生成中',draft:'草稿'}
const refLabel=item=>`${item.ref?`${item.ref.sourceKey} / ${item.ref.entryId}`:item.id??'未记录引用'}${item.version?` @${item.version}`:''}`
const formatted=value=>JSON.stringify(value,null,2)
function MaterialInspector({material,onClose}){
  const prepared=material.contextPreparation,source=prepared?.materials,story=material.storySnapshot
  return <section className="rpls-material" aria-label="冻结材料检查">
    <header><div><h3>冻结材料检查</h3><p>生成审计：读取本次已保存输入，不从当前数据库重建。状态：{statuses[material.status]??material.status}</p></div><button type="button" onClick={onClose}>关闭检查</button></header>
    <details open><summary>固定角色来源</summary>{story?<div><p>{story.title}</p><pre>{formatted(story)}</pre></div>:<p>本记录未提供独立角色来源快照。</p>}</details>
    <details open><summary>本轮已决事实与公开方向</summary><pre>{formatted(material.packet)}</pre>{material.factReceiptRef&&<p>事实回执：{material.factReceiptRef}</p>}</details>
    <details><summary>冻结版本与历史选择</summary>{material.narrativeVersion?<pre>{formatted(material.narrativeVersion)}</pre>:<p>此旧记录未记录正文版本。</p>}{material.ownerOperation&&<pre>{formatted(material.ownerOperation)}</pre>}{prepared?.historyProjection?<pre>{formatted(prepared.historyProjection)}</pre>:<p>此记录未记录历史投影依据。</p>}</details>
    <details open><summary>记录的候选池</summary>{prepared?.candidates?<ul>{prepared.candidates.map((item,index)=><li key={item.key??index}><strong>{item.title??item.ref?.entryId}</strong><span>{refLabel(item)}</span>{typeof item.score==='number'&&<small>已记录分数 {item.score}</small>}</li>)}</ul>:<p>此记录未记录候选池。</p>}</details>
    <details><summary>数据库版本与来源引用</summary>{prepared?.database?<pre>{formatted(prepared.database)}</pre>:<p>未记录数据库版本引用。</p>}</details>
    <details open><summary>实际选中材料</summary>{source?.entries?.length?<ul>{source.entries.map((item,index)=><li key={index}><strong>{item.title??item.name??item.id??item.ref?.entryId}</strong><span>{refLabel(item)}</span><pre>{item.content}</pre>{item.notes&&<p>叙事备注：{item.notes}</p>}</li>)}</ul>:<p>未使用或没有选中数据库材料。</p>}</details>
    <details><summary>历史表示与叙事指导</summary>{source?.history?.map((item,index)=><div key={index}><p>{item.id} · {item.mode}</p><pre>{item.content??item.text}</pre><small>{formatted(item.source)}</small></div>)}<pre>{source?.guidance??'未记录指导。'}</pre>{prepared?.authorNote&&<p>冻结作者注：{prepared.authorNote.id} · 版本 {prepared.authorNote.version} · claim {prepared.authorNote.claimId}</p>}</details>
    <details><summary>实际呈现模块</summary>{material.compiled?.messages?.map((message,index)=><div key={index}><p>{message.role}</p><pre>{message.content}</pre></div>)??<p>尚未冻结完整 writer 模块。</p>}</details>
    <details open><summary>实际模型与规模</summary>{Object.entries(material.models??{}).map(([stage,model])=><p key={stage}>{stage}：{model.provider} / {model.model}{model.reasoningEffort?` · ${model.reasoningEffort}`:''}{model.maxTokens?` · 上限 ${model.maxTokens}`:''}</p>)}{typeof source?.chars==='number'&&<p>材料报告字符数：{source.chars}（不代表所有系统、方向包与模块的总规模）</p>}<p>本记录未记录 token 用量时不作估算。</p></details>
  </section>
}

export function PresentationWorkspace({sessionId,visible=true,client}){
  const [records,setRecords]=useState([]),[auditRecords,setAuditRecords]=useState([]),[folded,setFolded]=useState([]),[regeneration,setRegeneration]=useState({canRegenerate:false}),[summaries,setSummaries]=useState([]),[capabilities,setCapabilities]=useState({retryDispatch:false}),[drafts,setDrafts]=useState([]),[selectedId,setSelectedId]=useState(''),[editor,setEditor]=useState(null),[instruction,setInstruction]=useState(''),[compare,setCompare]=useState(false),[material,setMaterial]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState('')
  const scopeRef=useRef(null)
  useEffect(()=>{
    if(!visible||!sessionId)return
    const changed=scopeRef.current?.sessionId!==sessionId,controller=new AbortController(),scope={sessionId,controller,active:true,generation:0};scopeRef.current=scope
    if(changed){setRecords([]);setAuditRecords([]);setFolded([]);setRegeneration({canRegenerate:false});setSummaries([]);setDrafts([]);setSelectedId('');setEditor(null);setMaterial(null);setError('');setNotice('')}
    setBusy('');let loading=false,again=false
    scope.refresh=async()=>{
      if(loading){again=true;return}loading=true
      do{again=false;const generation=scope.generation
        try{const [history,presentations,candidates,audit]=await Promise.all([client.storyHistory?client.storyHistory(sessionId,controller.signal):client.narratives(sessionId,controller.signal),client.presentationSummaries(sessionId,controller.signal),client.drafts(sessionId,controller.signal),client.storyHistory?client.narratives(sessionId,controller.signal):Promise.resolve({records:[]})])
          if(scope.active&&generation===scope.generation){setRecords(history.records);setFolded(history.folded??[]);setAuditRecords(audit.records);setRegeneration({canRegenerate:presentations.canRegenerate===true,blockCode:presentations.regenerateBlockCode});setSummaries(presentations.presentations);setCapabilities(presentations.capabilities);setDrafts(candidates.drafts)}else if(scope.active)again=true
        }catch(cause){if(scope.active){setError(cause.message);if(client.storyHistory){setRecords([]);setRegeneration({canRegenerate:false})}}}
      }while(again&&scope.active);loading=false
    }
    void scope.refresh();const close=client.subscribe(sessionId,()=>{void scope.refresh()},()=>{if(scope.active)setNotice('连接恢复后会重新同步生成记录。')})
    return()=>{scope.active=false;controller.abort();close()}
  },[sessionId,visible,client])
  useEffect(()=>{if(selectedId&&editor?.id!==selectedId){const selected=drafts.find(item=>item.id===selectedId);if(selected)setEditor({id:selected.id,version:selected.version,text:selected.text,original:selected.text})}},[selectedId,drafts,editor?.id])
  const latest=records.at(-1),selected=drafts.find(item=>item.id===selectedId),dirty=editor&&editor.text!==editor.original,stale=selected&&editor&&selected.version!==editor.version,sameTurn=selected?.basedOn.presentationId===latest?.ref.presentationId
  async function perform(name,work,receive){
    const scope=scopeRef.current;if(!scope?.active||busy)return
    setBusy(name);setError('');setNotice('')
    try{const result=await work(scope.controller.signal);if(!scope.active)return;scope.generation++;receive?.(result);void scope.refresh()}
    catch(cause){if(scope.active)setError(cause.message)}finally{if(scope.active)setBusy('')}
  }
  function acceptDraft(value){setDrafts(current=>[value,...current.filter(item=>item.id!==value.id)]);setSelectedId(value.id);setEditor({id:value.id,version:value.version,text:value.text,original:value.text})}
  function create(kind){void perform(kind==='manual'?'建立手改':'生成候选',signal=>client.createDraft(sessionId,{basedOn:latest.ref,...kind==='manual'?{kind:'manual'}:{instruction}},signal),acceptDraft)}
  const inspect=presentationId=>{void perform('读取材料',signal=>client.material(sessionId,presentationId,signal),setMaterial)}
  return <section className="rpls-records rpls-prose-workspace" aria-label="正文候选与生成记录" hidden={!visible}>
    <header><h2>正文与候选</h2><p>只重新写作会追加当前事实下的新正文，旧稿保留审计。手改与候选仍需单独采用。</p>{busy&&<p role="status">{busy}…</p>}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}</header>
    {!latest?<p className="rpls-record-empty">尚无当前分支的正式正文。失败稿可从下方审计记录重试。</p>:<>
      <div className="rpls-prose-actions">{capabilities.narrativeRevisions===1&&<button type="button" disabled={Boolean(busy)||Boolean(dirty)||!regeneration.canRegenerate||!capabilities.regenerateDispatch} onClick={()=>{void perform('重新写作',signal=>client.regenerateProse(sessionId,{basedOn:latest.ref,operationId:globalThis.crypto.randomUUID(),instruction},signal),result=>{if(result.status==='complete')setNotice('新正文已规范接受，旧稿已折叠。');else setError(`重新写作${result.status==='interrupted'?'中断':'失败'}：${result.errorCode??'请查看审计'}`)})}}>只重新写作</button>}<button type="button" disabled={Boolean(busy)||Boolean(dirty)} onClick={()=>create('manual')}>直接手改</button><button type="button" disabled={Boolean(busy)||Boolean(dirty)} onClick={()=>create('writer')}>生成另一稿</button><button type="button" disabled={Boolean(busy)} onClick={()=>inspect(latest.ref.presentationId)}>检查本轮材料</button></div>
      {regeneration.blockCode&&<p>重新写作不可用：{regeneration.blockCode}</p>}
      <label className="rpls-prose-guidance">写作调整<textarea aria-label="写作调整" value={instruction} disabled={Boolean(busy)} onChange={event=>setInstruction(event.target.value)} placeholder="仅调整表达、节奏或篇幅"/></label>
    </>}
    <section className="rpls-candidates" aria-label="正文候选"><label>已保存候选<select aria-label="正文候选" value={selectedId} onChange={event=>{if(dirty){setError('先保存当前手改，或重新载入并放弃手改后再切换候选。');return}setSelectedId(event.target.value)}} disabled={Boolean(busy)}><option value="">选择候选</option>{drafts.map(item=><option key={item.id} value={item.id}>{item.kind==='manual'?'手改':'模型候选'} · v{item.version} · {statuses[item.status]??item.status}</option>)}</select></label>
      {editor&&<><label>候选正文<textarea aria-label="候选正文" value={editor.text} disabled={Boolean(busy)} onChange={event=>setEditor({...editor,text:event.target.value})}/></label>{stale&&<p>候选已有更新。保留当前手改文字，保存时将核对原版本。</p>}{(dirty||stale)&&<button type="button" disabled={Boolean(busy)} onClick={()=>{if(selected){setEditor({id:selected.id,version:selected.version,text:selected.text,original:selected.text});setError('')}}}>重新载入候选（放弃未保存手改）</button>}
        {selected?.models?.render&&<p className="rpls-model-evidence">{selected.kind==='manual'?'原生成模型':'实际生成模型'}：{selected.models.render.provider} / {selected.models.render.model}{selected.models.render.reasoningEffort?` · ${selected.models.render.reasoningEffort}`:''}</p>}
        {!sameTurn&&<p>此候选属于较早事实回合，不能覆盖当前正文。</p>}
        <div className="rpls-prose-actions"><button type="button" disabled={Boolean(busy)||!dirty||!editor.text.trim()} onClick={()=>{void perform('保存候选',signal=>client.editDraft(sessionId,{draftId:editor.id,text:editor.text,expectedDraftVersion:editor.version},signal),acceptDraft)}}>保存手改版本</button><button type="button" aria-pressed={compare} onClick={()=>setCompare(!compare)}>比较当前正文</button><button type="button" disabled={Boolean(busy)||Boolean(dirty)||Boolean(stale)||!sameTurn||selected?.status!=='ready'} onClick={()=>{void perform('采用候选',signal=>client.adoptDraft(sessionId,{draftId:selected.id,expectedNarrative:latest.ref,expectedDraftVersion:editor.version},signal),result=>{setRecords(current=>current.map(item=>item.ref.presentationId===result.narrative.ref.presentationId?result.narrative:item));setNotice('正文已采用。宿主维护回合显示 blocked 不表示剧情行动失败。')})}}>采用此稿</button></div>
        {compare&&<div className="rpls-prose-comparison"><div><h3>当前正式正文</h3><pre>{latest?.text}</pre></div><div><h3>当前候选表达</h3><pre>{editor.text}</pre></div></div>}
      </>}
    </section>
    {material&&<MaterialInspector material={material} onClose={()=>setMaterial(null)}/>}
    <section aria-label="当前分支正式正文"><h3>当前分支正式正文</h3>{records.map(record=><article key={record.id}><div className="rpls-record-meta"><span>{record.action}</span>{record.narrativeVersion&&<span>事实版本 {record.narrativeVersion.factRevision??'旧故事'} · {record.narrativeVersion.kind==='writer-regeneration'?'重新写作':'原稿'}</span>}{record.createdAt&&<span>{new Date(record.createdAt).toLocaleString()}</span>}</div><div className="rpls-record-text">{record.text}</div></article>)}</section>
    {folded.map(group=><details className="rpls-version-audit" key={group.groupId}><summary>旧版本审计 · {group.groupId}{group.pendingFacts?' · 事实待审':group.activeFactReceiptId&&!group.selectedPresentationId?' · 已生效事实待写作':''}</summary>{group.versions.filter(version=>version.presentationId!==group.selectedPresentationId).map(version=>{const record=auditRecords.find(item=>item.ref.presentationId===version.presentationId&&item.ref.resultSeq===version.resultSeq);return <article key={version.resultSeq}><p>已折叠正文 · {version.factReceiptId??'旧故事'} · {version.presentationId}</p><pre>{record?.text??'规范正文来源当前不可读取。'}</pre><button type="button" disabled={Boolean(busy)} onClick={()=>inspect(version.presentationId)}>检查旧版本材料</button></article>})}</details>)}
    <details className="rpls-audit" open><summary>生成审计与失败重试（{summaries.length}）</summary><p>这里包含成功、失败和旧稿审计；当前剧情以上方有效正式正文为准。重试可包含一次主模型派发和一次 writer，不重跑事实或材料。</p>{summaries.map(item=><article key={item.presentationId}><div className="rpls-record-meta"><span>{statuses[item.status]??item.status}</span><span>{new Date(item.createdAt).toLocaleString()}</span><code>{item.presentationId.slice(-12)}</code>{item.errorCode&&<code>{item.errorCode}</code>}</div>{['failed','cancelled'].includes(item.status)&&<><button type="button" disabled={Boolean(busy)||!item.canRetry||!capabilities.retryDispatch} onClick={()=>{void perform('重试正文',signal=>client.retryPresentation(sessionId,item.presentationId,signal),dispatch=>{if(dispatch.result?.kind==='error')setError(dispatch.result.text??'本次原生请求未形成成功正文。');else setNotice('正文重试已提交。')})}}>仅重试正文</button>{!item.canRetry&&<p>不可重试：{item.retryBlockCode??'请刷新资格'}</p>}{item.canRetry&&!capabilities.retryDispatch&&<p>当前会话的原生重试调度不可用。</p>}</>}<button type="button" disabled={Boolean(busy)} onClick={()=>inspect(item.presentationId)}>查看冻结材料</button></article>)}</details>
  </section>
}
