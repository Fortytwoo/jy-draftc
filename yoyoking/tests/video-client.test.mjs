/** Render the shipped Harness browser module against shared React, including hostile replay data. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-client-ui-tool'))
const { createElement } = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')

test('native slot renders controls, escaped metadata and visible failures; disposal removes style and slot', () => {
  let entry, card, replyCard, locale, cssRemoved = false, slotRemoved = false
  const cleanups = []
  runInNewContext(source, {
    window: { __ModuleLoader__: { load: value => { entry = value } } },
    document: { createElement: () => ({ dataset: {}, remove: () => { cssRemoved = true } }), head: { append() {} } },
  })
  assert.equal(entry.id, '@local/dsh-yoyoking')
  entry.factory(require).apply({
    effect: fn => { cleanups.push(fn()) },
    locale: { register: (name, data) => { if (name === 'yoyoking.video') locale = data; return () => {} } },
    slots: { inject: (_name, fn) => fn(), register: (options, component) => {
      if (options.name === 'tool.call.toolview') { assert.equal(options.key, 'yoyoking_preview_video'); card = component }
      else if (options.name === 'conversation.chat.turnTail') replyCard = component
      else assert.equal(options.name, 'sidebar.footer.action')
      cleanups.push(() => { slotRemoved = true })
    } },
  })
  const path = 'G:/素材/镜头.mp4'
  const video = { kind: 'yoyoking.video', version: 1, title: '<script>bad</script>', path, src: `api/yoyoking.video.${'a'.repeat(24)}?path=${encodeURIComponent(path)}`, start: 0.5, duration: 3, width: 320, height: 180, codec: 'h264', hasAudio: true }
  const render = (payload, extra = {}) => renderToStaticMarkup(createElement(card, { t: key => locale.zh[key], phase: 'result', block: { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: false }, ...extra }))
  const html = render(video)
  assert.match(html, /<video[^>]+controls=""/)
  assert.match(html, /preload="metadata"/); assert.match(html, /#t=0.5/)
  assert.match(html, /320 × 180/); assert.match(html, /&lt;script&gt;bad/)
  assert.ok(!html.includes('autoplay'))
  for (const invalid of [{ ...video, src: 'https://evil.test/video.mp4' }, { ...video, width: {} }, { ...video, duration: '3' }, { ...video, start: -1 }, { ...video, path: 'another.mp4' }, { ...video, codec: {} }, { ...video, version: 2 }, null]) {
    assert.match(render(invalid), /role="alert"/)
    assert.ok(!render(invalid).includes('<video'))
  }
  assert.match(render(video, { phase: 'preparing' }), /正在准备视频/)
  assert.match(render(video, { block: { isError: true } }), /视频预览失败/)
  const closing = { finalNode: { seq: 7 }, blocks: [{ kind: 'text', text: `交付回执：\n| MP4 | \`${path}\` |` }] }
  const turn = { status: 'closed', data: new Map([['turn-tail', { closing }]]) }
  const reply = renderToStaticMarkup(createElement(replyCard, { turn, seq: 7, t: key => locale.zh[key] }))
  assert.match(reply, /yoyoking-reply-videos/); assert.match(reply, /视频快速预览/)
  assert.equal(renderToStaticMarkup(createElement(replyCard, { turn: { ...turn, status: 'open' }, seq: 7 })), '')
  assert.equal(renderToStaticMarkup(createElement(replyCard, { turn, seq: 6 })), '')
  cleanups.reverse().forEach(fn => fn?.())
  assert.ok(cssRemoved && slotRemoved)
})

test('sidebar account control renders safe login states and never accepts an external authorization URL', () => {
  let entry, accountControl
  const locales = {}
  let account = { id: 'a'.repeat(20), state: 'disconnected', service_state: 'running' }
  let hook = 0
  const mockReact = { ...require('react'), useState: () => { const index = hook++; return [index === 0 ? [account] : false, () => {}] }, useEffect: () => {}, useRef: () => ({ current: true }) }
  runInNewContext(source, { URL, window: { __ModuleLoader__: { load: value => { entry = value } } }, document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } } })
  const mod = entry.factory(name => name === 'react' ? mockReact : require(name))
  mod.apply({ effect: fn => fn(), locale: { register: (name, data) => { locales[name] = data; return () => {} } }, slots: { inject: (_name, fn) => fn(), register: (options, component) => { if (options.name === 'sidebar.footer.action') accountControl = component } } })
  const t = key => locales['yoyoking.douyin'].zh[key]
  const render = wide => { hook = 0; return renderToStaticMarkup(accountControl({ t, wide })) }
  assert.match(render(true), /登录抖音/)
  assert.match(render(false), /narrow/)
  const trusted = { ...account, state: 'awaiting_authorization', endpoint: 'http://127.0.0.1:8014/mcp', authorization_url: 'http://127.0.0.1:8014/authorize?state=synthetic' }
  account = mod.readDouyinAccount(trusted)
  const html = render(true)
  assert.match(html, /打开官方登录/)
  assert.match(html, /noopener noreferrer/)
  for (const url of ['https://example.invalid/authorize', 'javascript:alert(1)', 'http://127.0.0.1:8015/authorize', 'http://127.0.0.1:8014/other']) assert.equal(mod.readDouyinAccount({ ...trusted, authorization_url: url }).authorizationUrl, undefined)
  account = { ...account, state: 'connected' }
  assert.match(render(true), /已登录/)
  assert.match(render(true), /退出连接/)
})

test('sidebar login action posts only after a user click and sends no configuration parameters', async () => {
  let entry, accountControl, hooks = 0
  const accounts = [{ id: 'b'.repeat(20), state: 'disconnected', service_state: 'running' }]
  const calls = []
  const react = { ...require('react'), useState: () => { const index = hooks++; return [index === 0 ? accounts : false, () => {}] }, useEffect: () => {}, useRef: () => ({ current: true }) }
  runInNewContext(source, {
    URL, window: { __ModuleLoader__: { load: value => { entry = value } } },
    document: { createElement: () => ({ dataset: {}, remove() {} }), head: { append() {} } },
    fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({ ...accounts[0], state: 'awaiting_authorization' }) } },
  })
  entry.factory(name => name === 'react' ? react : require(name)).apply({ effect: fn => fn(), locale: { register: () => () => {} }, slots: { inject: (_name, fn) => fn(), register: (options, component) => { if (options.name === 'sidebar.footer.action') accountControl = component } } })
  const tree = accountControl({ t: key => key, wide: true })
  const buttons = []
  function walk(node) { if (!node || typeof node !== 'object') return; if (node.type === 'button') buttons.push(node); for (const child of [node.props?.children].flat(Infinity)) walk(child) }
  walk(tree)
  assert.equal(calls.length, 0)
  await buttons.find(button => button.props.children === 'login').props.onClick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'api/yoyoking.douyin')
  assert.equal(calls[0].options.headers['x-yoyoking-action'], '1')
  assert.deepEqual(JSON.parse(calls[0].options.body), { id: accounts[0].id, action: 'login' })
})

test('automatic reply previews recognize local receipts and links, deduplicate and cap sources', () => {
  let entry
  runInNewContext(source, { window: { __ModuleLoader__: { load: value => { entry = value } } } })
  const paths = entry.factory(require).replyVideoPaths
  assert.deepEqual(Array.from(paths('交付 `C:\\视频素材\\成片.mp4`，重复 `c:/视频素材/成片.mp4`')), ['C:\\视频素材\\成片.mp4'])
  assert.deepEqual(Array.from(paths('[预览](<G:/素材/镜头%20A.webm>)')), ['G:/素材/镜头 A.webm'])
  assert.deepEqual(Array.from(paths('`https://evil.test/a.mp4` `//evil.test/a.mp4` `relative.mp4` `C:/code/server.ts`')), [])
  assert.equal(paths('`C:/1.mp4` `C:/2.mp4` `C:/3.mp4` `C:/4.mp4`').length, 3)
  assert.deepEqual(Array.from(paths(null)), [])
})
