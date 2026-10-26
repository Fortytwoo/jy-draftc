import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { createDouyinHost, acquireDouyinHost } from '../douyin-host.js'
import { createDouyinHandler } from '../douyin-api.js'
import { douyinFixture } from './fixtures/douyin-http.mjs'

async function until(check) {
  for (let i = 0; i < 250; i++) { if (check()) return; await delay(10) }
  assert.fail('Managed service did not settle')
}

test('managed SDK starts automatically, shares one login, restarts on crash and stays running after logout', async () => {
  const fixture = await douyinFixture()
  const children = []
  const host = createDouyinHost({}, { restartDelays: [10], startProcess: async () => {
    let exit
    const child = { ready: Promise.resolve(fixture.url), done: new Promise(resolve => { exit = resolve }), stop: async () => exit({ code: 0 }), crash: () => exit({ code: 1 }) }
    children.push(child)
    return child
  } })
  try {
    await until(() => host.status().service_state === 'running')
    assert.equal(children.length, 1)
    assert.equal(fixture.state.requests, 0)
    let first = 0, second = 0
    const offFirst = host.subscribe(() => { if (host.connection()) first++ })
    const offSecond = host.subscribe(() => { if (host.connection()) second++ })
    const login = await host.login()
    await fixture.authorize(login.authorization_url)
    await until(() => host.status().state === 'connected')
    assert.ok(first >= 1 && second >= 1)
    assert.equal((await host.login()).state, 'connected')
    assert.equal(children.length, 1)
    offFirst(); offSecond()
    await host.logout()
    assert.equal(host.status().service_state, 'running')
    assert.equal(host.connection(), null)
    assert.equal(children.length, 2)
    children[1].crash()
    await until(() => children.length === 3 && host.status().service_state === 'running')
    assert.equal(host.status().state, 'disconnected')
    assert.equal(fixture.state.businessCalls, 0)
  } finally { await host.dispose(); await fixture.close() }
  assert.equal(host.status().service_state, 'stopped')
})

test('Host ownership outlives chat owners and only the final disposal closes login', async () => {
  const fixture = await douyinFixture()
  const ctx = new Context()
  const config = { url: fixture.url, workspaceDirectory: 'synthetic-workspace', sdkDirectory: 'synthetic-sdk' }
  let hostEntry, chatEntry
  try {
    const hostOwner = await ctx.plugin({ name: 'host-owner', async apply(scope) { hostEntry = acquireDouyinHost(scope, config) } })
    const chatOwner = await ctx.plugin({ name: 'chat-owner', async apply(scope) { chatEntry = acquireDouyinHost(scope, config) } })
    assert.equal(hostEntry, chatEntry)
    const login = await hostEntry.host.login()
    await fixture.authorize(login.authorization_url)
    await until(() => hostEntry.host.status().state === 'connected')
    await chatOwner.dispose()
    assert.equal(hostEntry.host.status().state, 'connected')
    await hostOwner.dispose()
    assert.equal(hostEntry.host.status().service_state, 'stopped')
  } finally { await ctx.fiber.dispose(); await fixture.close() }
})

test('browser login API does not start login on GET and rejects cross-site simple POSTs', async () => {
  let logins = 0, logouts = 0
  const id = 'a'.repeat(20)
  const handler = createDouyinHandler(new Map([[id, { entry: { id, host: {
    status: () => ({ state: 'disconnected', service_state: 'running' }),
    login: async () => { logins++; return { state: 'awaiting_authorization' } },
    logout: async () => { logouts++; return { state: 'disconnected' } },
  } } }]]))
  const url = 'http://local/api/yoyoking.douyin'
  assert.equal((await (await handler(new Request(url))).json()).accounts[0].id, id)
  assert.equal(logins, 0)
  for (const headers of [{}, { 'content-type': 'application/json' }, { 'content-type': 'text/plain', 'x-yoyoking-action': '1' }]) {
    assert.equal((await handler(new Request(url, { method: 'POST', headers, body: JSON.stringify({ id, action: 'login' }) }))).status, 400)
  }
  const post = action => handler(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-yoyoking-action': '1' }, body: JSON.stringify({ id, action }) }))
  assert.equal((await post('login')).status, 200)
  assert.equal(logins, 1)
  assert.equal((await post('logout')).status, 200)
  assert.equal(logouts, 1)
  assert.equal((await post('execute')).status, 400)
})

test('missing SDK reports failure without an unhandled rejection or a login prompt', async () => {
  const host = createDouyinHost({}, { startProcess: async () => { throw new Error('Missing SDK') } })
  try {
    await until(() => host.status().service_state === 'failed')
    assert.equal((await host.login()).service_state, 'failed')
    assert.equal(host.status().authorization_url, undefined)
  } finally { await host.dispose() }
})
