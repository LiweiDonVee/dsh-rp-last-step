import React from 'react'
import {describe,it,expect,vi,afterEach} from 'vitest'
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react'
import * as module from '../../src/PresentationWorkspace.jsx'
afterEach(cleanup)
const ref={sessionId:'story',presentationId:'formal',assistantMessageId:'assistant',callSeq:4,baseResultSeq:5,resultSeq:5}
function fixture(){
  let listener,items=[],retryDispatch=true
  const client={narratives:vi.fn(async()=>({records:[{id:'formal-5',ref,text:'Accepted current prose.',action:'Push the gate.'}]})),presentationSummaries:vi.fn(async()=>({presentations:[{presentationId:'failed',status:'failed',createdAt:'2026-10-25T00:00:00Z',canRetry:true,errorCode:'MODEL_CALL_FAILED'}],capabilities:{retryDispatch}})),drafts:vi.fn(async()=>({drafts:items})),subscribe:vi.fn((_id,receive)=>{listener=receive;return()=>{listener=undefined}}),
    createDraft:vi.fn(async(_id,input)=>{const draft={id:'manual',version:1,sessionId:'story',basedOn:ref,kind:input.kind??'writer',status:'ready',text:input.text??'Accepted current prose.',createdAt:'2026-10-25T00:00:00Z'};items=[draft];return draft}),editDraft:vi.fn(async(_id,input)=>{const draft={...items[0],version:input.expectedDraftVersion+1,text:input.text,kind:'manual'};items=[draft];return draft}),adoptDraft:vi.fn(async()=>({narrative:{id:'formal-9',ref:{...ref,resultSeq:9},text:'Owner revised prose.'}})),retryPresentation:vi.fn(async()=>({result:{kind:'success',text:'Native retry completed'}})),material:vi.fn(async()=>({presentationId:'failed',packet:{playerAction:'Push the gate.'},contextPreparation:{candidates:[{key:'gate',ref:{sourceKey:'world',entryId:'gate'},title:'Gate',version:2}],materials:{entries:[{ref:{sourceKey:'world',entryId:'gate'},version:2,content:'Frozen gate fact.'}],history:[],recentProse:[],guidance:'Owner writing guidance.',chars:96}},compiled:{messages:[{role:'system',content:'Frozen style.'}]},models:{render:{provider:'local',model:'writer'}},status:'failed'}))}
  return{client,emit:()=>listener?.({type:'draft'}),setDrafts:value=>{items=value},disableRetry:()=>{retryDispatch=false}}
}
function mount(f){expect(typeof module.PresentationWorkspace).toBe('function');return render(<module.PresentationWorkspace sessionId="story" visible client={f.client}/>)}

describe('LastStep native prose controls',()=>{
  it('uses effective history, exposes independent writer regeneration and folds canonical old versions',async()=>{
    const f=fixture(),nextRef={...ref,presentationId:'new-prose',assistantMessageId:'new-assistant',callSeq:9,baseResultSeq:10,resultSeq:10};
    f.client.storyHistory=vi.fn(async()=>({schemaVersion:1,records:[{id:'new',ref:nextRef,text:'Current revision prose.'}],folded:[{groupId:'round',factRoundId:'round',activeFactReceiptId:'fact-2',selectedPresentationId:'new-prose',pendingFacts:false,versions:[{presentationId:'formal',factReceiptId:'fact-1',resultSeq:5},{presentationId:'new-prose',factReceiptId:'fact-2',resultSeq:10}]}],projectionKey:'key'}));
    f.client.presentationSummaries.mockResolvedValue({presentations:[],canRegenerate:true,capabilities:{narrativeRevisions:1,regenerateDispatch:true,retryDispatch:true}});
    f.client.regenerateProse=vi.fn(async()=>({status:'complete',presentationId:'regenerated'}));mount(f);
    await screen.findByText('Current revision prose.');expect(screen.getByRole('region',{name:'当前分支正式正文'})).not.toHaveTextContent('Accepted current prose.');
    expect(screen.getByText('Accepted current prose.').closest('details')).not.toHaveAttribute('open');
    fireEvent.change(screen.getByRole('textbox',{name:'写作调整'}),{target:{value:'Shorter.'}});fireEvent.click(screen.getByRole('button',{name:'只重新写作'}));
    await waitFor(()=>expect(f.client.regenerateProse).toHaveBeenCalledWith('story',{basedOn:nextRef,operationId:expect.any(String),instruction:'Shorter.'},expect.any(AbortSignal)));
    expect(f.client.createDraft).not.toHaveBeenCalled();expect(f.client.adoptDraft).not.toHaveBeenCalled();
  });
  it('creates a manual candidate directly, saves a version and adopts against the exact current ref',async()=>{
    const f=fixture();mount(f);await screen.findByText('Accepted current prose.')
    fireEvent.click(screen.getByRole('button',{name:'直接手改'}));const editor=await screen.findByRole('textbox',{name:'候选正文'})
    expect(f.client.createDraft).toHaveBeenCalledWith('story',{basedOn:ref,kind:'manual'},expect.any(AbortSignal))
    fireEvent.change(editor,{target:{value:'Owner revised prose.'}});expect(screen.getByRole('button',{name:'采用此稿'})).toBeDisabled()
    fireEvent.click(screen.getByRole('button',{name:'保存手改版本'}));await waitFor(()=>expect(f.client.editDraft).toHaveBeenCalledWith('story',{draftId:'manual',text:'Owner revised prose.',expectedDraftVersion:1},expect.any(AbortSignal)))
    await waitFor(()=>expect(screen.getByRole('button',{name:'采用此稿'})).toBeEnabled());fireEvent.click(screen.getByRole('button',{name:'采用此稿'}))
    await waitFor(()=>expect(f.client.adoptDraft).toHaveBeenCalledWith('story',{draftId:'manual',expectedNarrative:ref,expectedDraftVersion:2},expect.any(AbortSignal)))
    expect(await screen.findByRole('status')).toHaveTextContent('采用')
  })
  it('keeps unsaved wording and the old expected version after SSE and conflict',async()=>{
    const f=fixture();mount(f);await screen.findByText('Accepted current prose.');fireEvent.click(screen.getByRole('button',{name:'直接手改'}))
    const editor=await screen.findByRole('textbox',{name:'候选正文'});fireEvent.change(editor,{target:{value:'Unsaved owner words.'}})
    f.setDrafts([{id:'manual',version:3,sessionId:'story',basedOn:ref,kind:'manual',status:'ready',text:'Other saved version.'}]);f.emit()
    await screen.findByText(/候选已有更新/u);f.client.editDraft.mockRejectedValueOnce(Object.assign(new Error('Candidate changed; reload'),{code:'DRAFT_CONFLICT'}))
    fireEvent.click(screen.getByRole('button',{name:'保存手改版本'}));expect(await screen.findByRole('alert')).toHaveTextContent('Candidate changed');expect(editor).toHaveValue('Unsaved owner words.')
    expect(f.client.editDraft.mock.calls[0][1].expectedDraftVersion).toBe(1)
  })
  it('keeps a stale saved preview and requires explicit reload before adopting a newer version',async()=>{
    const f=fixture();mount(f);await screen.findByText('Accepted current prose.');fireEvent.click(screen.getByRole('button',{name:'直接手改'}));const editor=await screen.findByRole('textbox',{name:'候选正文'})
    f.setDrafts([{id:'manual',version:3,sessionId:'story',basedOn:ref,kind:'manual',status:'ready',text:'Unseen remote edit.'}]);f.emit();await screen.findByText(/候选已有更新/u)
    expect(editor).toHaveValue('Accepted current prose.');expect(screen.getByRole('button',{name:'采用此稿'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'重新载入候选（放弃未保存手改）'}));expect(editor).toHaveValue('Unseen remote edit.')
  })
  it('requires both program retry gates and inspects stored candidates/material without reprepare',async()=>{
    const f=fixture();mount(f);await screen.findByRole('button',{name:'仅重试正文'});f.disableRetry();f.emit()
    await waitFor(()=>expect(screen.getByRole('button',{name:'仅重试正文'})).toBeDisabled())
    fireEvent.click(screen.getByRole('button',{name:'查看冻结材料'}));expect(await screen.findByText('Frozen gate fact.')).toBeInTheDocument();expect(screen.getByText('记录的候选池')).toBeInTheDocument();expect(screen.getAllByText('world / gate @2')).toHaveLength(2);expect(f.client.material).toHaveBeenCalledWith('story','failed',expect.any(AbortSignal));expect(f.client.createDraft).not.toHaveBeenCalled()
  })
})
