import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import { createScope } from '@deepseek-ai/dsh-scope'
import Skills from '@deepseek-ai/dsh-skill'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { pluginModule } from './plugin-target.mjs'
import { douyinFixture } from './fixtures/douyin-http.mjs'
const Yoyoking = await pluginModule('index.js')
const { buildDouyinConfig } = await pluginModule('config.js')
const { registerDouyin } = await pluginModule('douyin.js')
const { createDouyinOAuth, validateDouyinUrl } = await pluginModule('douyin-oauth.js')

async function waitFor(status, expected) {
  for (let i = 0; i < 250; i++) {
    const value = await status()
    if (value.state === expected) return value
    if (value.state === 'unavailable' && expected !== 'unavailable') assert.fail(JSON.stringify(value))
    await delay(20)
  }
  assert.fail(`Timed out waiting for ${expected}: ${JSON.stringify(await status())}`)
}
async function host() {
  const ctx = new Context()
  await ctx.plugin(Tools); await ctx.plugin(Skills); await ctx.plugin(SystemPrompt)
  return ctx
}
async function call(ctx, name, args = {}, agent) {
  const result = await ctx.tools.execute({ name, arguments: args, agent, callId: crypto.randomUUID(), signal: AbortSignal.timeout(10000) })
  assert.equal(result.isError, false, JSON.stringify(result))
  return result.value
}

test('Douyin config defaults to managed service and rejects unsafe overrides and namespace collisions', () => {
  const base = { workspaceDirectory: join(tmpdir(), 'yoyoking-douyin-config'), mediaRoots: [tmpdir()] }
  assert.equal(buildDouyinConfig({ ...base, douyinEnabled: false }), null)
  assert.equal(buildDouyinConfig(base).url, '')
  assert.match(buildDouyinConfig(base).sdkDirectory, /Documents[\\/]DouyinCreatorSDK$/)
  assert.equal(buildDouyinConfig({ ...base, douyinEnabled: true, visualizationOnly: true, douyinServerUrl: 'invalid' }), null)
  for (const douyinServerUrl of ['https://example.com/mcp', 'http://localhost:8014/mcp', 'http://127.0.0.1:8014/mcp?token=synthetic', 'http://a:b@127.0.0.1:8014/mcp', 'http://127.0.0.1:8014/other', 'http://127.0.0.1:8014/mcp#fragment']) {
    assert.throws(() => buildDouyinConfig({ ...base, douyinEnabled: true, douyinServerUrl }))
  }
  for (const change of [{ douyinServerName: 'yoyoking' }, { douyinServerName: 'bad name' }, { douyinToolCallTimeoutMs: 0 }, { douyinToolCallTimeoutMs: 1800001 }]) assert.throws(() => buildDouyinConfig({ ...base, douyinEnabled: true, ...change }))
  assert.equal(validateDouyinUrl('http://127.0.0.1:8014/mcp/'), 'http://127.0.0.1:8014/mcp')
})

test('OAuth enforces state/PKCE, refreshes once, rejects other origins and never exposes tokens', async () => {
  const fixture = await douyinFixture()
  let authenticatedFetch
  const oauth = createDouyinOAuth({ url: fixture.url, onAuthorized: async transport => { authenticatedFetch = transport } })
  try {
    const first = await oauth.begin()
    assert.equal(first.state, 'awaiting_authorization')
    assert.equal((await oauth.begin()).authorization_url, first.authorization_url)
    const callback = new URL(new URL(first.authorization_url).searchParams.get('redirect_uri'))
    callback.searchParams.set('code', 'synthetic-code'); callback.searchParams.set('state', 'wrong-state')
    assert.equal((await fetch(callback)).status, 400)
    assert.equal(oauth.status().state, 'awaiting_authorization')
    assert.equal((await fixture.authorize(first.authorization_url)).status, 200)
    await waitFor(() => oauth.status(), 'connected')
    fixture.state.version++
    assert.deepEqual((await Promise.all([authenticatedFetch(fixture.url, { method: 'GET' }), authenticatedFetch(fixture.url, { method: 'GET' })])).map(response => response.status), [405, 405])
    assert.equal(fixture.state.refreshes, 1)
    await assert.rejects(authenticatedFetch('http://127.0.0.1:1/mcp'), /loopback origin/)
    assert.doesNotMatch(JSON.stringify(oauth.status()), /synthetic-access|synthetic-refresh|authorization-code|code_verifier/)
    assert.equal(fixture.state.businessCalls, 0)
  } finally { await oauth.dispose(); await fixture.close() }
})

test('pending authorization expires or disposes its callback without business calls', async () => {
  const fixture = await douyinFixture()
  const oauth = createDouyinOAuth({ url: fixture.url, authorizationTimeoutMs: 60, onAuthorized: async () => assert.fail('must not connect') })
  try {
    const pending = await oauth.begin()
    const callback = new URL(pending.authorization_url).searchParams.get('redirect_uri')
    await waitFor(() => oauth.status(), 'disconnected')
    await assert.rejects(fetch(callback))
    const next = await oauth.begin()
    await oauth.dispose()
    await assert.rejects(fetch(new URL(next.authorization_url).searchParams.get('redirect_uri')))
    assert.equal(fixture.state.businessCalls, 0)
  } finally { await oauth.dispose(); await fixture.close() }
})

test('real Harness keeps 71 editing tools, discovers 24 SDK tools only after OAuth and cleans up', { timeout: 180000 }, async () => {
  const fixture = await douyinFixture()
  const ctx = await host()
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-douyin-host-'))
  try {
    const fiber = await ctx.plugin(Yoyoking, { workspaceDirectory: join(root, 'workspace'), mediaRoots: [root], douyinEnabled: true, douyinServerUrl: fixture.url })
    assert.equal(fixture.state.requests, 0)
    assert.equal(ctx.tools.schemas().length, 74)
    assert.equal((await ctx.skills.list()).length, 3)
    const pending = await call(ctx, 'yoyoking_douyin_connect')
    assert.equal(pending.state, 'awaiting_authorization')
    await fixture.authorize(pending.authorization_url)
    const connected = await waitFor(() => call(ctx, 'yoyoking_douyin_status'), 'connected')
    assert.equal(connected.tool_count, 24)
    const expectedNames = fixture.catalog.tools.map(tool => {
      const name = `mcp__yoyoking_douyin__${tool.name}`
      return name.length <= 64 ? name : `${name.slice(0, 51)}_${createHash('sha256').update(`yoyoking_douyin\0${tool.name}`).digest('hex').slice(0, 12)}`
    })
    assert.deepEqual(ctx.tools.schemas().filter(tool => tool.name.startsWith('mcp__yoyoking_douyin__')).map(tool => tool.name).sort(), expectedNames.sort())
    assert.equal(ctx.tools.schemas().length, 98)
    assert.equal((await ctx.skills.list()).length, 4)
    fixture.state.partial = true
    const result = await call(ctx, 'mcp__yoyoking_douyin__douyin_creator_get_work_list', { count: 1 })
    assert.equal(result.structuredContent.data_status, 'partial')
    assert.equal(fixture.state.businessCalls, 1)
    assert.doesNotMatch(JSON.stringify(result), /synthetic-access|synthetic-refresh/)
    await call(ctx, 'yoyoking_douyin_disconnect')
    assert.equal(ctx.tools.schemas().length, 74)
    assert.equal((await ctx.skills.list()).length, 3)
    await fiber.dispose()
    assert.equal(ctx.tools.schemas().length, 0)
    assert.equal((await ctx.skills.list()).length, 0)
    assert.doesNotMatch(renderPrompt(await ctx.systemPrompt.assemble()), /DouyinCreatorSDK/)
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

test('failed SDK discovery leaves only connection controls and no SDK skill, and can retry', async () => {
  const fixture = await douyinFixture()
  fixture.state.discoveryFails = true
  const ctx = await host()
  try {
    await ctx.plugin({ name: 'douyin-test', inject: ['tools', 'skills', 'systemPrompt'], apply: async scope => registerDouyin(scope, { url: fixture.url, serverName: 'custom_douyin', toolCallTimeoutMs: 10000 }) })
    const pending = await call(ctx, 'custom_douyin_connect')
    await fixture.authorize(pending.authorization_url)
    await waitFor(() => call(ctx, 'custom_douyin_status'), 'unavailable')
    assert.equal(ctx.tools.schemas().length, 3)
    assert.equal((await ctx.skills.list()).length, 0)
    fixture.state.discoveryFails = false
    assert.equal((await call(ctx, 'custom_douyin_connect')).state, 'connected')
    assert.equal(ctx.tools.schemas().length, 27)
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

test('rejected refresh requires explicit authorization and sanitizes SDK diagnostics', async () => {
  const fixture = await douyinFixture()
  let authenticatedFetch
  const oauth = createDouyinOAuth({ url: fixture.url, onAuthorized: async value => { authenticatedFetch = value } })
  const warnings = []
  const warn = console.warn
  try {
    const pending = await oauth.begin()
    await fixture.authorize(pending.authorization_url)
    await waitFor(() => oauth.status(), 'connected')
    fixture.state.version++
    fixture.state.rejectRefresh = true
    console.warn = (...args) => warnings.push(args.join(' '))
    await assert.rejects(authenticatedFetch(fixture.url, { method: 'GET' }), /authorization required/)
    assert.equal(oauth.status().state, 'authorization_required')
    assert.equal(fixture.state.refreshes, 1)
    assert.doesNotMatch(JSON.stringify(warnings), /synthetic-sensitive-oauth-diagnostic/)
    assert.equal(oauth.status().authorization_url, undefined)
  } finally { console.warn = warn; await oauth.dispose(); await fixture.close() }
})

test('preset scopes report their own SDK tools without leaking to the host or another agent', async () => {
  const fixture = await douyinFixture()
  const ctx = await host()
  const first = { id: 'first' }, second = { id: 'second' }
  const mounts = []
  try {
    for (const key of [first, second]) {
      await ctx.plugin({ name: `mint-${key.id}`, inject: ['tools', 'skills', 'systemPrompt'], async apply(inner) {
        const scope = createScope(inner, key)
        mounts.push(scope)
        await scope.ctx.plugin({ name: 'scoped-douyin', inject: ['tools', 'skills', 'systemPrompt'], async apply(scoped) {
          registerDouyin(scoped, { url: fixture.url, serverName: 'scoped_douyin', toolCallTimeoutMs: 10000 })
        } })
      } })
    }
    assert.equal(ctx.tools.schemas().length, 0)
    const pending = await call(ctx, 'scoped_douyin_connect', {}, first)
    await fixture.authorize(pending.authorization_url)
    const ready = await waitFor(() => call(ctx, 'scoped_douyin_status', {}, first), 'connected')
    assert.equal(ready.tool_count, 24)
    assert.equal(ctx.tools.schemas(first).length, 27)
    assert.equal((await call(ctx, 'scoped_douyin_status', {}, second)).tool_count, 24)
    assert.equal((await ctx.skills.list({ scope: first })).length, 1)
    assert.equal((await ctx.skills.list({ scope: second })).length, 1)
    assert.equal(ctx.tools.schemas().length, 0)
    await mounts[0].dispose()
    assert.equal(ctx.tools.schemas(first).length, 0)
    assert.equal(ctx.tools.schemas(second).length, 27)
    await call(ctx, 'scoped_douyin_disconnect', {}, second)
    assert.equal(ctx.tools.schemas(second).length, 3)
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

test('service request failures mark the connection unavailable and explicit retry re-discovers', async () => {
  const fixture = await douyinFixture()
  let offline = false, transport, connections = 0
  const oauth = createDouyinOAuth({ url: fixture.url,
    fetchFn: (url, init) => { if (offline) throw new Error('Synthetic service down'); return fetch(url, init) },
    onAuthorized: async value => { transport = value; await transport(fixture.url, { method: 'GET' }); connections++ },
  })
  try {
    const pending = await oauth.begin()
    await fixture.authorize(pending.authorization_url)
    await waitFor(() => oauth.status(), 'connected')
    offline = true
    await assert.rejects(transport(fixture.url, { method: 'GET' }), /service request failed/)
    assert.equal(oauth.status().state, 'unavailable')
    offline = false
    assert.equal((await oauth.begin()).state, 'connected')
    assert.equal(connections, 2)
  } finally { await oauth.dispose(); await fixture.close() }
})

test('OAuth metadata cannot redirect registration to a different origin', async () => {
  const fixture = await douyinFixture()
  fixture.state.registrationEndpoint = 'http://127.0.0.1:1/register'
  const visited = []
  const oauth = createDouyinOAuth({ url: fixture.url, onAuthorized: async () => assert.fail('must not connect'), fetchFn: (url, init) => { visited.push(url.href); return fetch(url, init) } })
  try {
    assert.equal((await oauth.begin()).state, 'unavailable')
    assert.ok(visited.every(url => new URL(url).origin === new URL(fixture.url).origin))
  } finally { await oauth.dispose(); await fixture.close() }
})
