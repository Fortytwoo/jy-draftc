import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pluginModule } from './plugin-target.mjs'
const { buildDouyinService } = await pluginModule('douyin-service.js')
const { createDouyinOAuth } = await pluginModule('douyin-oauth.js')

const sdk = process.env.YOYOKING_TEST_DOUYIN_SDK

test('managed SDK chooses its own port, completes startup and exits when Harness closes its pipe', { skip: !sdk, timeout: 180000 }, async () => {
  const { startDouyinProcess } = await pluginModule('douyin-process.js')
  const { buildDouyinConfig } = await pluginModule('config.js')
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-managed-sdk-'))
  const config = buildDouyinConfig({ workspaceDirectory: root, mediaRoots: [root] })
  assert.equal(config.url, '')
  assert.equal(config.sdkDirectory.replaceAll('\\', '/'), sdk.replaceAll('\\', '/'))
  const process = await startDouyinProcess(config)
  let endpoint
  try {
    endpoint = await process.ready
    assert.equal(new URL(endpoint).hostname, '127.0.0.1')
    const metadata = await fetch(new URL('/.well-known/oauth-authorization-server', endpoint))
    assert.equal(metadata.status, 200)
    const oauth = createDouyinOAuth({ url: endpoint, onAuthorized: async () => assert.fail('No real login in smoke test') })
    try { assert.equal((await oauth.begin()).state, 'awaiting_authorization') }
    finally { await oauth.dispose() }
  } finally { await process.stop() }
  await process.done
  await assert.rejects(fetch(endpoint))
})

test('Host plugin automatically serves login UI API before any chat and shuts down its SDK on disposal', { skip: !sdk, timeout: 180000 }, async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Tools } = await import('@deepseek-ai/dsh-tools')
  const { default: Skills } = await import('@deepseek-ai/dsh-skill')
  const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
  const { HostConnectionService } = await import('@deepseek-ai/dsh-client-connection')
  const Yoyoking = await pluginModule('index.js')
  const { mkdtemp } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-host-login-'))
  const ctx = new Context()
  let endpoint
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Skills)
    await ctx.plugin(scope => { new HostConnectionService(scope, [], {}) })
    const fiber = await ctx.plugin(Yoyoking, { hostServicesOnly: true, workspaceDirectory: root, mediaRoots: [root] })
    const api = ctx.connection.createSharedFetchHandler('/api')
    let account
    for (let attempt = 0; attempt < 1200; attempt++) {
      const response = await api.fetch(new Request('http://local/api/yoyoking.douyin'), ctx.connection.browserPeer)
      if (response.ok) {
        account = (await response.json()).accounts[0]
        if (account.service_state === 'running') break
        assert.notEqual(account.service_state, 'failed', JSON.stringify(account))
      }
      await delay(100)
    }
    assert.equal(account.service_state, 'running')
    assert.equal(account.state, 'disconnected')
    endpoint = account.endpoint
    assert.deepEqual(ctx.tools.schemas(), [])
    assert.deepEqual(await ctx.skills.list(), [])
    const login = await api.fetch(new Request('http://local/api/yoyoking.douyin', { method: 'POST', headers: { 'content-type': 'application/json', 'x-yoyoking-action': '1' }, body: JSON.stringify({ id: account.id, action: 'login' }) }), ctx.connection.browserPeer)
    assert.equal((await login.json()).state, 'awaiting_authorization')
    await fiber.dispose()
    assert.equal((await api.fetch(new Request('http://local/api/yoyoking.douyin'), ctx.connection.browserPeer)).status, 404)
    await assert.rejects(fetch(endpoint))
  } finally { await ctx.fiber.dispose() }
})

test('installed SDK accepts real OAuth discovery and client registration without account login', { skip: !sdk, timeout: 30000 }, async () => {
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = reservation.address().port
  await new Promise(resolve => reservation.close(resolve))
  const launch = buildDouyinService({ sdkDirectory: sdk, workspaceDirectory: join(tmpdir(), `yoyoking-sdk-smoke-${port}`), port })
  delete launch.env.UV_PROJECT_ENVIRONMENT
  const python = join(sdk, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const child = spawn(python, ['-B', '-m', 'douyin_creator_mcp.oauth_server'], { cwd: sdk, env: launch.env, stdio: 'ignore' })
  const ended = once(child, 'exit')
  const url = `http://127.0.0.1:${port}/mcp`
  const oauth = createDouyinOAuth({ url, onAuthorized: async () => assert.fail('No account authorization is performed in this smoke test') })
  try {
    let ready = false
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null) assert.fail('SDK process exited before metadata was available')
      try {
        const response = await fetch(`http://127.0.0.1:${port}/.well-known/oauth-authorization-server`, { signal: AbortSignal.timeout(500) })
        if (response.ok) { ready = true; break }
      } catch {}
      await delay(100)
    }
    assert.equal(ready, true)
    const state = await oauth.begin()
    assert.equal(state.state, 'awaiting_authorization', JSON.stringify(state))
    const authorization = new URL(state.authorization_url)
    assert.equal(authorization.origin, new URL(url).origin)
    assert.equal(authorization.searchParams.get('scope'), 'douyin.credentials')
    assert.equal(authorization.searchParams.get('resource'), url)
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256')
    assert.equal(new URL(authorization.searchParams.get('redirect_uri')).hostname, '127.0.0.1')
  } finally {
    await oauth.dispose()
    child.kill()
    await ended
  }
})
