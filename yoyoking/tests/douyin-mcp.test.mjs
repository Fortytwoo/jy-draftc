import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { pluginModule } from './plugin-target.mjs'
import { douyinFixture } from './fixtures/douyin-http.mjs'
const { connectDouyinMcp } = await pluginModule('douyin-mcp.js')
const { createDouyinHost } = await pluginModule('douyin-host.js')

// Exact public export shape of the installed 0.2.1-rc.2 runtime (no connect).
const legacy = Object.fromEntries(['Config', 'apply', 'createMcpToolDefinition', 'inject', 'name'].map(key => [key, McpClient[key]]))
const methodOf = init => init?.body ? JSON.parse(init.body).method : undefined
const expectedName = raw => {
  const joined = `mcp__compat_douyin__${raw}`, normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  return normalized === joined && joined.length <= 64 ? joined
    : `${normalized.slice(0, 51)}_${createHash('sha256').update(`compat_douyin\0${raw}`).digest('hex').slice(0, 12)}`
}
async function until(check) {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(10) }
  assert.fail('Synthetic Host did not settle')
}
async function setup() {
  const fixture = await douyinFixture()
  const host = createDouyinHost({ url: fixture.url })
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const config = legacy.Config({ transport: 'streamable-http', url: fixture.url, serverName: 'compat_douyin', headers: {}, toolCallTimeoutMs: 1000, failOnStartupError: true, reconnect: { enabled: false } })
  try {
    const pending = await host.login()
    await fixture.authorize(pending.authorization_url)
    await until(() => host.status().state === 'connected')
  } catch (error) { await ctx.fiber.dispose(); await host.dispose(); await fixture.close(); throw error }
  const desired = host.connection()
  return {
    fixture, host, ctx, config,
    runtime: { fetch: desired.fetch, isCurrent: () => host.connection()?.generation === desired.generation },
    async close() { await ctx.fiber.dispose(); await host.dispose(); await fixture.close() },
  }
}
function mount(ctx, config, runtime, bridge = legacy) {
  return ctx.plugin({ name: 'compat-douyin-test', inject: ['tools'], async apply(scope) {
    await connectDouyinMcp(scope, config, runtime, bridge)
  } })
}
function execute(ctx, name, { agent, signal = AbortSignal.timeout(5000) } = {}) {
  return ctx.tools.execute({ name, arguments: {}, agent, signal, callId: crypto.randomUUID() })
}
function stall(runtime, targetMethod) {
  const entered = Promise.withResolvers()
  return { entered: entered.promise, runtime: { ...runtime, fetch: async (input, init) => {
    if (methodOf(init) === targetMethod) {
      entered.resolve(init.signal)
      await new Promise((resolve, reject) => {
        init.signal.throwIfAborted()
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      })
    }
    return runtime.fetch(input, init)
  } } }
}

test('connection adapter retains the newer Harness connect route and its in-memory runtime hooks', async () => {
  const config = { headers: {}, transport: 'streamable-http' }
  const runtime = { fetch: () => assert.fail('must not fetch here'), isCurrent: () => true }
  const ctx = {}, result = {}
  assert.equal(await connectDouyinMcp(ctx, config, runtime, {
    async connect(actualCtx, actualConfig, actualRuntime) {
      assert.equal(actualCtx, ctx); assert.equal(actualConfig, config); assert.equal(actualRuntime, runtime)
      return result
    },
    createMcpToolDefinition: () => assert.fail('fallback must not run'),
  }), result)
  assert.deepEqual(config, { headers: {}, transport: 'streamable-http' })
})

test('old-runtime fallback refuses missing Host fetch instead of using apply or serializable credentials', async () => {
  assert.equal(legacy.connect, undefined)
  await assert.rejects(connectDouyinMcp({}, { transport: 'streamable-http' }, { isCurrent: () => true }, {
    ...legacy, apply: () => assert.fail('apply cannot accept Host credentials'),
  }), /Host-owned HTTP fetch/)
})

test('old runtime uses SDK discovery/pagination, exact Harness hashing, raw wire names and scoped tools', async () => {
  const env = await setup()
  const { fixture, ctx, config, runtime } = env
  fixture.state.pageSize = 7
  fixture.catalog.tools.push(...['same.name', 'same/name'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })))
  const first = { id: 'compat-first' }, second = { id: 'compat-second' }
  let firstScope, secondScope
  try {
    await ctx.plugin({ name: 'compat-scopes', async apply(scope) {
      firstScope = createScope(scope, first); secondScope = createScope(scope, second)
      await mount(firstScope.ctx, config, runtime)
      await mount(secondScope.ctx, config, runtime)
    } })
    assert.deepEqual(ctx.tools.schemas().map(tool => tool.name), [])
    assert.deepEqual(ctx.tools.schemas(first).map(tool => tool.name).sort(), fixture.catalog.tools.map(tool => expectedName(tool.name)).sort())
    assert.equal(ctx.tools.schemas(second).length, 26)
    assert.equal(fixture.state.rpcMethods.filter(method => method === 'tools/list').length, 8)
    assert.ok(fixture.state.rpcMethods.includes('server/discover'))
    const result = await execute(ctx, expectedName('same.name'), { agent: first })
    assert.equal(result.isError, false)
    assert.equal(result.value.structuredContent.operation, 'same.name')
    assert.equal((await execute(ctx, expectedName('same/name'))).isError, true)
    assert.equal(fixture.state.businessCalls, 1)
    assert.doesNotMatch(JSON.stringify(config), /synthetic-access|synthetic-refresh|Bearer|fetch/)
    await firstScope.dispose()
    assert.equal(ctx.tools.schemas(first).length, 0)
    assert.equal(ctx.tools.schemas(second).length, 26)
    await secondScope.dispose()
    assert.equal(ctx.tools.schemas(second).length, 0)
  } finally { await env.close() }
})

test('old-runtime discovery failure closes the failed generation and a fresh mount can retry', async () => {
  const env = await setup()
  try {
    env.fixture.state.discoveryFails = true
    await assert.rejects(Promise.resolve(mount(env.ctx, env.config, env.runtime)))
    assert.equal(env.ctx.tools.schemas().length, 0)
    assert.equal(env.host.status().state, 'connected')
    env.fixture.state.discoveryFails = false
    const connected = await mount(env.ctx, env.config, env.runtime)
    assert.equal(env.ctx.tools.schemas().length, 24)
    await connected.dispose()
    assert.equal(env.ctx.tools.schemas().length, 0)
    assert.equal(env.fixture.state.businessCalls, 0)
  } finally { await env.close() }
})

test('old-runtime registration conflict rolls back partial tools without removing foreign tools', async () => {
  const env = await setup()
  try {
    const rawName = env.fixture.catalog.tools[1].name
    const foreign = await env.ctx.plugin({ name: 'foreign-registration', inject: ['tools'], apply(scope) {
      scope.tools.register(legacy.createMcpToolDefinition(scope, {
        name: expectedName(rawName), rawName, description: '', inputSchema: { type: 'object' },
        call: async () => ({ content: [{ type: 'text', text: 'foreign' }] }),
      }))
    } })
    await assert.rejects(Promise.resolve(mount(env.ctx, env.config, env.runtime)))
    assert.deepEqual(env.ctx.tools.schemas().map(tool => tool.name), [expectedName(rawName)])
    assert.equal((await execute(env.ctx, expectedName(rawName))).isError, false)
    await foreign.dispose()
    const connected = await mount(env.ctx, env.config, env.runtime)
    assert.equal(env.ctx.tools.schemas().length, 24)
    await connected.dispose()
    assert.equal(env.fixture.state.businessCalls, 0)
  } finally { await env.close() }
})

for (const method of ['server/discover', 'tools/list']) test(`disposing old-runtime startup aborts pending ${method} without leaking tools`, { timeout: 5000 }, async () => {
  const env = await setup()
  try {
    const paused = stall(env.runtime, method)
    const fiber = mount(env.ctx, env.config, paused.runtime)
    const loaded = Promise.resolve(fiber)
    void loaded.catch(() => {})
    const signal = await paused.entered
    await fiber.dispose()
    await assert.rejects(loaded)
    assert.equal(signal.aborted, true)
    assert.equal(env.ctx.tools.schemas().length, 0)
    assert.equal(env.fixture.state.businessCalls, 0)
    assert.equal(env.host.status().state, 'connected')
  } finally { await env.close() }
})

test('old-runtime fallback rejects discovery and tool results from a superseded Host generation', async () => {
  const env = await setup()
  let current = true, blockMethod = 'tools/list'
  let entered = Promise.withResolvers(), release = Promise.withResolvers()
  const runtime = { isCurrent: () => current && env.runtime.isCurrent(), fetch: async (input, init) => {
    const result = await env.runtime.fetch(input, init)
    if (methodOf(init) === blockMethod) { entered.resolve(); await release.promise }
    return result
  } }
  try {
    const loading = Promise.resolve(mount(env.ctx, env.config, runtime))
    void loading.catch(() => {})
    await entered.promise
    current = false; release.resolve()
    await assert.rejects(loading, /identity changed/)
    assert.equal(env.ctx.tools.schemas().length, 0)
    current = true; blockMethod = 'tools/call'
    entered = Promise.withResolvers(); release = Promise.withResolvers()
    const connected = await mount(env.ctx, env.config, runtime)
    const name = expectedName(env.fixture.catalog.tools[0].name)
    const pending = execute(env.ctx, name)
    await entered.promise
    current = false; release.resolve()
    const result = await pending
    assert.equal(result.isError, true)
    assert.doesNotMatch(JSON.stringify(result), /structuredContent|synthetic-access|synthetic-refresh/)
    assert.equal((await execute(env.ctx, name)).isError, true)
    assert.equal(env.fixture.state.businessCalls, 1)
    await connected.dispose()
    assert.equal(env.ctx.tools.schemas().length, 0)
  } finally { release.resolve(); await env.close() }
})

test('disposing an established old-runtime connection cancels active calls without clearing the shared Host login', { timeout: 5000 }, async () => {
  const env = await setup()
  try {
    const paused = stall(env.runtime, 'tools/call')
    const connected = await mount(env.ctx, env.config, paused.runtime)
    const pending = execute(env.ctx, expectedName(env.fixture.catalog.tools[0].name))
    const signal = await paused.entered
    await connected.dispose()
    assert.equal(signal.aborted, true)
    assert.equal((await pending).isError, true)
    assert.equal(env.ctx.tools.schemas().length, 0)
    assert.equal(env.host.status().state, 'connected')
    assert.equal(env.fixture.state.businessCalls, 0)
  } finally { await env.close() }
})

test('old-runtime tool execution forwards cancellation and per-call timeout to the SDK', async () => {
  const env = await setup()
  try {
    const paused = stall(env.runtime, 'tools/call')
    const connected = await mount(env.ctx, env.config, paused.runtime)
    const controller = new AbortController()
    const pending = execute(env.ctx, expectedName(env.fixture.catalog.tools[0].name), { signal: controller.signal })
    const signal = await paused.entered
    controller.abort()
    assert.equal((await pending).isError, true)
    // SDK 2.2 legacy MCP cancels via notification; transport abort belongs to disposal.
    await until(() => env.fixture.state.rpcMethods.includes('notifications/cancelled'))
    await connected.dispose()
    assert.equal(signal.aborted, true)
    const timed = stall(env.runtime, 'tools/call')
    const timedConnection = await mount(env.ctx, { ...env.config, toolCallTimeoutMs: 30 }, timed.runtime)
    const deadline = execute(env.ctx, expectedName(env.fixture.catalog.tools[0].name))
    const timedSignal = await timed.entered
    assert.equal((await deadline).isError, true)
    await until(() => env.fixture.state.rpcMethods.filter(method => method === 'notifications/cancelled').length === 2)
    assert.equal(env.fixture.state.businessCalls, 0)
    await timedConnection.dispose()
    assert.equal(timedSignal.aborted, true)
  } finally { await env.close() }
})
