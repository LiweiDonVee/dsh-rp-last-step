import React from 'react'
import {afterEach,describe,expect,it,vi} from 'vitest'
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react'
import {apply,TAB_ID,TAB_KIND} from '../../src/client.jsx'

vi.mock('../../src/styles.css',()=>({default:'/* plugin styles */'}))

const nativeSlots=['conversation.session.header.actions','conversation.hero.options']
const studioSlot='rp.studio.workspace.actions'

function host(){
  const tabs=new Map(),entries=new Map(),listeners=new Set(),disposers=[]
  const notify=()=>{for(const listener of listeners)listener()}
  const registry={
    get:kind=>tabs.get(kind),
    subscribe:vi.fn(listener=>{listeners.add(listener);return()=>listeners.delete(listener)}),
    register:definition=>{tabs.set(definition.kind,definition);notify();return()=>{tabs.delete(definition.kind);notify()}},
  }
  const openTab=vi.fn()
  const ctx={
    sidebarRightTabs:registry,
    sidebarRight:{openTab},
    uiWorkspace:{openSession:vi.fn()},
    effect:effect=>{const dispose=effect();if(dispose)disposers.push(dispose);return dispose},
    slots:{
      inject:(_name,effect)=>effect(),
      register:(definition,Component)=>{entries.set(definition.name,{...definition,Component});return()=>entries.delete(definition.name)},
    },
  }
  return{ctx,registry,tabs,entries,listeners,openTab,dispose:()=>{for(const dispose of disposers.reverse())dispose()}}
}

function Entries({entries}){
  return <>{[...nativeSlots,studioSlot].map(name=>{const {Component,inject}=entries.get(name);return <section key={name} data-testid={name}><Component {...inject()}/></section>})}</>
}

const standalone=name=>within(screen.getByTestId(name))
afterEach(cleanup)

describe('native entry and Studio lifecycle',()=>{
  it('opens its native tab, groups duplicate entries on install, and restores them on unload',()=>{
    const f=host();apply(f.ctx)
    const mounted=render(<Entries entries={f.entries}/>)
    expect(f.registry.get(TAB_KIND)).toMatchObject({id:TAB_ID,kind:TAB_KIND,guide:[expect.objectContaining({id:TAB_KIND})]})
    expect(f.entries.has('sidebar.right.pane.tab')).toBe(true)
    for(const name of nativeSlots){fireEvent.click(standalone(name).getByRole('button'));expect(f.openTab).toHaveBeenLastCalledWith(TAB_KIND)}
    let removeStudio
    act(()=>{removeStudio=f.registry.register({id:'dsh-rp-studio/workspace',kind:'rp-studio'})})
    for(const name of nativeSlots)expect(standalone(name).queryByRole('button')).toBeNull()
    fireEvent.click(standalone(studioSlot).getByRole('button'))
    expect(f.openTab).toHaveBeenLastCalledWith(TAB_KIND)
    expect(f.registry.get(TAB_KIND)?.guide).toHaveLength(1)
    expect(f.entries.has('sidebar.right.pane.tab')).toBe(true)
    act(()=>removeStudio())
    for(const name of nativeSlots)expect(standalone(name).getByRole('button')).toBeEnabled()
    mounted.unmount();expect(f.listeners.size).toBe(0)
    f.dispose();expect(f.entries.size).toBe(0);expect(f.registry.get(TAB_KIND)).toBeUndefined()
  })

  it('handles Owner loading after Studio and keeps subscriptions stable across rerenders',()=>{
    const f=host(),removeStudio=f.registry.register({id:'dsh-rp-studio/workspace',kind:'rp-studio'})
    apply(f.ctx)
    const mounted=render(<Entries entries={f.entries}/>)
    for(const name of nativeSlots)expect(standalone(name).queryByRole('button')).toBeNull()
    expect(standalone(studioSlot).getByRole('button')).toBeEnabled()
    const subscriptions=f.registry.subscribe.mock.calls.length
    mounted.rerender(<Entries entries={f.entries}/>)
    act(()=>{f.registry.register({id:'unrelated/workspace',kind:'unrelated'})})
    expect(f.registry.subscribe).toHaveBeenCalledTimes(subscriptions)
    expect(f.listeners.size).toBe(2)
    act(()=>removeStudio())
    for(const name of nativeSlots){fireEvent.click(standalone(name).getByRole('button'));expect(f.openTab).toHaveBeenLastCalledWith(TAB_KIND)}
    mounted.unmount();expect(f.listeners.size).toBe(0)
    f.dispose()
  })
})
