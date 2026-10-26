import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'

export async function douyinFixture() {
  const catalog = JSON.parse(await readFile(new URL('../../douyin/tools.json', import.meta.url), 'utf8'))
  const state = { requests: 0, refreshes: 0, businessCalls: 0, discoveryFails: false, version: 1, partial: false, rpcMethods: [] }
  let origin, registration, challenge
  const json = (response, status, value, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', ...headers }); response.end(JSON.stringify(value)) }
  const server = createServer(async (request, response) => {
    state.requests++
    const url = new URL(request.url, origin)
    let body = ''
    for await (const chunk of request) body += chunk
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ['douyin.credentials'] }); return
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      json(response, 200, { issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: state.registrationEndpoint || `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: ['douyin.credentials'] }); return
    }
    if (url.pathname === '/register') {
      registration = JSON.parse(body)
      assert.equal(registration.scope, 'douyin.credentials')
      json(response, 201, { ...registration, client_id: 'synthetic-yoyoking-client' }); return
    }
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('resource'), `${origin}/mcp`)
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
      challenge = url.searchParams.get('code_challenge')
      const callback = new URL(registration.redirect_uris[0])
      callback.searchParams.set('code', 'synthetic-authorization-code')
      callback.searchParams.set('state', url.searchParams.get('state'))
      callback.searchParams.set('iss', origin)
      response.writeHead(302, { Location: callback.href }); response.end(); return
    }
    if (url.pathname === '/token') {
      const params = new URLSearchParams(body)
      assert.equal(params.get('resource'), `${origin}/mcp`)
      if (params.get('grant_type') === 'authorization_code') {
        assert.equal(params.get('code'), 'synthetic-authorization-code')
        assert.equal(createHash('sha256').update(params.get('code_verifier')).digest('base64url'), challenge)
      } else {
        assert.equal(params.get('grant_type'), 'refresh_token')
        assert.equal(params.get('refresh_token'), 'synthetic-refresh-token')
        state.refreshes++
        if (state.rejectRefresh) { json(response, 400, { error: 'invalid_grant', error_description: 'synthetic-sensitive-oauth-diagnostic' }); return }
      }
      json(response, 200, { access_token: `synthetic-access-${state.version}`, token_type: 'Bearer', refresh_token: 'synthetic-refresh-token', expires_in: 3600, scope: 'douyin.credentials' }); return
    }
    if (url.pathname !== '/mcp') { json(response, 404, { error: 'not_found' }); return }
    if (request.headers.authorization !== `Bearer synthetic-access-${state.version}`) {
      json(response, 401, { error: 'unauthorized' }, { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="douyin.credentials"` }); return
    }
    if (request.method === 'GET') { response.writeHead(405); response.end(); return }
    if (request.method === 'DELETE') { response.writeHead(200); response.end(); return }
    const message = JSON.parse(body)
    state.rpcMethods.push(message.method)
    if (message.id === undefined) { response.writeHead(202); response.end(); return }
    let result
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'Douyin SDK synthetic fixture', version: catalog.version } }
    else if (message.method === 'tools/list') {
      if (state.discoveryFails) { json(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'Synthetic discovery failure' } }); return }
      const offset = Number(message.params?.cursor ?? 0)
      const end = offset + (state.pageSize || catalog.tools.length)
      result = { tools: catalog.tools.slice(offset, end), ...(end < catalog.tools.length ? { nextCursor: String(end) } : {}) }
    } else if (message.method === 'tools/call') {
      state.businessCalls++
      const data = { status: 'success', data_status: state.partial ? 'partial' : 'complete', operation: message.params.name, result: { items: [], page: { has_more: state.partial } }, diagnostics: {} }
      result = { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false }
    } else if (message.method === 'ping') result = {}
    else { json(response, 200, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unknown fixture method' } }); return }
    json(response, 200, { jsonrpc: '2.0', id: message.id, result })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${server.address().port}`
  return { state, catalog, url: `${origin}/mcp`, authorize: url => fetch(url), async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}
