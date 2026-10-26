/** Real React render; fake host responses test tab hiding, close cleanup and reopening. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const require = createRequire('C:/Users/fortytwo/Documents/deepseek-harness/packages/client/ui-sidebar-right/package.json')
const React = require('react'), { createRoot } = require('react-dom/client'), { JSDOM } = require('jsdom')
test('registered sidebar tab uses measured bounds, hides on tab switch, reconnects and restores on close', async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://harness.invalid/' })
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  let visible = true, Component, RuntimeNotice, definition, plugin, status = 'attached', observed = 0, disconnected = 0, responseVersion = '0.4.1', broken = false, keyboard = 'harness', currentProject
  const requests = [], timers = new Map(), effects = [], dictionaries = {}
  class Observer { observe() { observed++ } disconnect() { disconnected++ } }
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 500, y: 100, right: 1000, bottom: 700 })
  const fetch = async (_url, options) => {
    if (options.method === 'GET') return { ok: true, json: async () => ({ version: responseVersion }) }
    const input = JSON.parse(options.body); requests.push(input)
    if(input.action==='inspect-project')currentProject={name:'当前测试工程',clip_count:2,material_count:1}
    return { ok: true, json: async () => ({ version: responseVersion, active: input.visible && status === 'attached', status, currentProject, keyboard: { destination: keyboard }, candidates: [], target: { hwnd: status === 'attached' ? 20 : undefined } }) }
  }
  dom.window.__ModuleLoader__ = { load(module) { plugin = module.factory(require) } }
  vm.runInNewContext(readFileSync(new URL('./client.js', import.meta.url), 'utf8'), { window: dom.window, document: dom.window.document, crypto, fetch, console, ResizeObserver: Observer, AbortController, setTimeout, clearTimeout,
    setInterval(callback) { const id = timers.size + 1; timers.set(id, callback); return id }, clearInterval(id) { timers.delete(id) } })
  const ctx = { effect(fn) { effects.push(fn()) }, locale: { register(ns, value) { dictionaries[ns] = value.zh; return () => {} }, bind(ns) { return key => dictionaries[ns][key] } },
    sidebarRightTabs: { register(value) { definition = value; return () => {} }, guide() { return [{ providerId: definition.id, kind: definition.kind }] } }, slots: { inject(_name, fn) { return fn() }, register(options, component) { if (options.name === 'sidebar.right.pane.tab') Component = component; if (options.name === 'shell.overlay') RuntimeNotice = component; return () => {} } } }
  plugin.apply(ctx)
  assert.equal(definition.kind, 'jianying'); assert.equal(definition.keepMounted, true); assert.equal(definition.guide[0].title(), '剪映')
  const root = createRoot(document.getElementById('root'))
  const render = () => root.render(React.createElement(Component, { useTabInfo: () => { if (broken) throw new Error('tab binding failed'); return { tab: { visible } } }, t: key => dictionaries.jianyingSidebar[key] }))
  const flush = async work => React.act(async () => { work?.(); await new Promise(resolve => setTimeout(resolve, 5)) })
  try {
    await flush(render)
    assert.ok(document.querySelector('[data-jianying-sidebar]'))
    assert.ok(requests.some(input => input.visible && input.x === 500 && input.width === 500))
    visible = false; await flush(render)
    assert.ok(requests.some(input => input.action === 'sync' && input.visible === false))
    assert.equal(requests.filter(input => input.action === 'detach').length, 0, 'switching tabs must not restore the editor as a popup')
    status = 'not_running'; visible = true; await flush(render)
    assert.match(document.body.textContent, /剪映未运行/)
    const launch = [...document.querySelectorAll('button')].find(button => button.textContent === '启动剪映')
    await flush(() => launch.click())
    assert.ok(requests.some(input => input.action === 'launch'))
    status = 'attached'; await flush(() => { for (const callback of timers.values()) callback() })
    assert.match(document.body.textContent, /已接入真实剪映/)
    assert.match(document.body.textContent, /键盘：Harness/)
    keyboard='jianying'; await flush(()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='聚焦剪映').click())
    assert.ok(requests.some(input=>input.action==='focus' && input.visible===true))
    assert.match(document.body.textContent, /键盘：剪映/)
    await flush(()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='读取项目').click())
    assert.ok(requests.some(input=>input.action==='inspect-project'))
    assert.match(document.body.textContent, /当前测试工程 · 2 个片段 · 1 个素材 · 最近保存快照/)
    const beforeFocus=requests.length
    await flush(()=>dom.window.dispatchEvent(new dom.window.Event('focus')))
    assert.ok(requests.length>beforeFocus,'returning focus must trigger synchronization without clicking refresh')
    const previousError = console.error
    try { console.error = () => {}; broken = true; await flush(render) } finally { console.error = previousError }
    assert.match(document.body.textContent, /剪映页签加载失败/)
    assert.match(document.body.textContent, /tab binding failed/)
    broken = false; await flush(() => [...document.querySelectorAll('button')].find(button => button.textContent === '重试').click())
    assert.ok(document.querySelector('[data-jianying-sidebar]'))
    await flush(() => root.unmount())
    assert.ok(requests.some(input => input.action === 'detach')); assert.equal(timers.size, 0); assert.equal(observed, disconnected)
    responseVersion = undefined
    const noticeRoot = createRoot(document.getElementById('root'))
    await flush(() => noticeRoot.render(React.createElement(RuntimeNotice)))
    assert.match(document.body.textContent, /后台仍是旧版本/)
    assert.match(document.body.textContent, /应用 → 退出/)
    await flush(() => noticeRoot.unmount())
  } finally { for (const dispose of effects.reverse()) await dispose?.(); dom.window.close() }
})
