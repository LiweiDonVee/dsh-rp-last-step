import React, {useState} from 'react'
import {PresetWorkspace,Quill} from './PresetWorkspace.jsx'
import {createRpLastStepApi} from './api.js'
import {PresentationWorkspace} from './PresentationWorkspace.jsx'
import css from './styles.css'

export const inject=['slots','sidebarRight','sidebarRightTabs']
export const TAB_ID='dsh-rp-last-step/workspace'
export const TAB_KIND='rp-last-step'
const api=createRpLastStepApi()

function OpenButton({open,story=false}) {
  return <button className="rpls-open-entry" type="button" aria-label={story?'配置故事预设':'打开 RP 最后一步'} title={story?'配置故事预设':'RP 预设与呈现'} onClick={open}><Quill/><span>{story?'故事预设':'预设'}</span></button>
}

export function PresentationRecords({sessionId,visible,client=api}) {
  return <PresentationWorkspace sessionId={sessionId} visible={visible} client={client}/>
}

function LastStepWorkspace({sessionId,visible}) {
  const [view,setView]=useState('presets')
  return <div className="rpls-shell" data-rp-last-step-root={sessionId}>
    <nav className="rpls-shell-tabs" aria-label="最后一步视图"><button type="button" aria-pressed={view==='presets'} onClick={()=>setView('presets')}>预设管理</button><button type="button" aria-pressed={view==='records'} onClick={()=>setView('records')}>生成记录</button></nav>
    <div className="rpls-shell-view" style={{display:view==='presets'?'flex':'none'}}><PresetWorkspace sessionId={sessionId} visible={visible&&view==='presets'}/></div>
    <div className="rpls-shell-view" style={{display:view==='records'?'flex':'none'}}><PresentationRecords sessionId={sessionId} visible={visible&&view==='records'}/></div>
  </div>
}

export function apply(ctx) {
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.rpLastStep='';style.textContent=css;document.head.append(style);return()=>style.remove()},'RP last-step styles')
  function Body({sessionId,useTabInfo}){const {tab}=useTabInfo();return <LastStepWorkspace key={sessionId} sessionId={sessionId} visible={tab.visible}/>}
  ctx.effect(()=>ctx.sidebarRightTabs.register({id:TAB_ID,kind:TAB_KIND,title:()=> 'RP 预设与呈现',guide:[{id:TAB_KIND,order:37,title:()=> 'RP 最后一步',description:()=> '预设迁移、模块权限与最终正文'}]}),'RP last-step tab')
  ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TAB_ID},Body)),'RP last-step pane')
  for(const name of ['conversation.session.header.actions','conversation.hero.options'])ctx.effect(()=>ctx.slots.inject(name,()=>ctx.slots.register({name,id:TAB_ID,order:37,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND)})},OpenButton)),`RP last-step entry ${name}`)
  ctx.effect(()=>ctx.slots.inject('rp.studio.workspace.actions',()=>ctx.slots.register({name:'rp.studio.workspace.actions',id:TAB_ID,order:37,inject:()=>({open:()=>ctx.sidebarRight.openTab(TAB_KIND),story:true})},OpenButton)),'RP Studio preset contribution')
}
