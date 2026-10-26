/** OAuth PKCE via the MCP SDK. The shared Host grant remains memory-only. */
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { auth } from '@modelcontextprotocol/client'

export function validateDouyinUrl(value) {
  const url = new URL(value)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash || !/^\/mcp\/?$/.test(url.pathname)) {
    throw new Error('douyinServerUrl must be http://127.0.0.1:PORT/mcp without credentials, query or fragment')
  }
  url.pathname = '/mcp'
  return url.href
}

export function createDouyinOAuth({ url, onAuthorized, fetchFn = fetch, authorizationTimeoutMs = 300000 }) {
  const endpoint = new URL(validateDouyinUrl(url))
  const lifetime = new AbortController()
  let phase = 'disconnected'
  let notice = 'Use the connect tool to begin explicit browser authorization.'
  let clientInformation, tokens, verifier, discovery, redirectUrl, state, authorizationUrl
  let callback, deadline, starting, finishing, refreshing
  let interactive = false

  const status = () => ({
    state: phase, endpoint: endpoint.href, message: notice,
    ...(phase === 'awaiting_authorization' ? { authorization_url: authorizationUrl } : {}),
  })
  const checkOrigin = (value) => {
    const target = new URL(value)
    if (target.origin !== endpoint.origin || target.username || target.password || target.hash) throw new Error('OAuth endpoint must remain on the configured loopback origin')
    return target
  }
  const localFetch = async (input, init = {}) => {
    const target = checkOrigin(input instanceof Request ? input.url : input.toString())
    const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : []), ...(target.pathname === endpoint.pathname ? [] : [AbortSignal.timeout(30000)])])
    const response = await fetchFn(target, { ...init, signal, redirect: 'error' })
    // The MCP SDK logs OAuth error descriptions when recovering an invalid grant.
    if (target.pathname !== endpoint.pathname && !response.ok) {
      const allowed = new Set(['invalid_client', 'invalid_grant', 'unauthorized_client', 'invalid_request', 'invalid_scope', 'access_denied'])
      const body = await response.json().catch(() => ({}))
      return Response.json({ error: allowed.has(body.error) ? body.error : 'server_error', error_description: 'Local OAuth request failed' }, { status: response.status })
    }
    return response
  }
  const provider = {
    get redirectUrl() { return redirectUrl },
    get clientMetadata() { return { client_name: 'yoyoking', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'douyin.credentials' } },
    state: () => state,
    clientInformation: () => clientInformation,
    saveClientInformation: value => { clientInformation = value },
    tokens: () => tokens,
    saveTokens: value => { lifetime.signal.throwIfAborted(); tokens = value },
    saveCodeVerifier: value => { verifier = value },
    codeVerifier: () => verifier,
    discoveryState: () => discovery,
    saveDiscoveryState: value => { discovery = value },
    redirectToAuthorization: value => {
      checkOrigin(value)
      if (!interactive) throw new Error('Explicit browser authorization is required')
      authorizationUrl = value.href
    },
    invalidateCredentials: scope => {
      if (scope === 'all' || scope === 'client') clientInformation = undefined
      if (scope === 'all' || scope === 'tokens') tokens = undefined
      if (scope === 'all' || scope === 'verifier') verifier = undefined
      if (scope === 'all' || scope === 'discovery') discovery = undefined
    },
  }
  const stopCallback = () => {
    clearTimeout(deadline)
    if (callback) { callback.close(); callback.closeAllConnections(); callback = undefined }
  }
  const unavailable = () => {
    if (lifetime.signal.aborted) return
    phase = 'unavailable'
    notice = 'Local SDK connection failed. Check the OAuth service and use connect to retry; editing remains available.'
  }
  const connectTools = async () => {
    phase = 'connecting'
    notice = 'Discovering the authenticated SDK tools.'
    await onAuthorized(authenticatedFetch)
    lifetime.signal.throwIfAborted()
    phase = 'connected'
    notice = 'SDK tools are connected. This does not verify any real-account business request.'
  }
  const complete = async (code, iss) => {
    clearTimeout(deadline)
    interactive = false
    phase = 'connecting'
    try {
      const result = await auth(provider, { serverUrl: endpoint, authorizationCode: code, iss, scope: 'douyin.credentials', fetchFn: localFetch })
      if (result !== 'AUTHORIZED') throw new Error('Authorization did not complete')
      await connectTools()
    } catch { unavailable() }
    finally { stopCallback(); verifier = undefined; authorizationUrl = undefined }
  }
  async function beginAttempt() {
    lifetime.signal.throwIfAborted()
    if (['connected', 'awaiting_authorization', 'connecting'].includes(phase)) return status()
    if (tokens && phase === 'unavailable') {
      try { await connectTools() } catch { unavailable() }
      return status()
    }
    stopCallback()
    clientInformation = tokens = verifier = discovery = undefined
    state = randomBytes(32).toString('base64url')
    interactive = true
    callback = createServer((request, response) => {
      let target
      try { target = new URL(request.url, redirectUrl) } catch { response.writeHead(400); response.end('Invalid authorization callback.'); return }
      const expectedHost = new URL(redirectUrl).host
      response.setHeader('Cache-Control', 'no-store')
      response.setHeader('Content-Type', 'text/plain; charset=utf-8')
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'")
      response.setHeader('Referrer-Policy', 'no-referrer')
      const valid = request.method === 'GET' && request.headers.host === expectedHost && target.origin === new URL(redirectUrl).origin && target.pathname === '/oauth/callback' && phase === 'awaiting_authorization' && target.searchParams.getAll('state').length === 1 && target.searchParams.get('state') === state
      if (!valid) { response.writeHead(400); response.end('Invalid authorization callback.'); return }
      if (target.searchParams.has('error')) {
        phase = 'disconnected'; notice = 'Authorization was declined. No SDK tools were connected.'
        response.end('Authorization cancelled. You may close this page.')
        response.once('finish', stopCallback)
        return
      }
      const code = target.searchParams.get('code')
      if (!code || code.length > 4096 || target.searchParams.getAll('code').length !== 1 || target.searchParams.getAll('iss').length > 1) {
        response.writeHead(400); response.end('Invalid authorization callback.'); return
      }
      response.end('Authorization received. Return to yoyoking and check connection status. You may close this page.')
      finishing = complete(code, target.searchParams.get('iss') ?? undefined)
    })
    try {
      await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(0, '127.0.0.1', resolve) })
      redirectUrl = `http://127.0.0.1:${callback.address().port}/oauth/callback`
      const result = await auth(provider, { serverUrl: endpoint, scope: 'douyin.credentials', fetchFn: localFetch })
      lifetime.signal.throwIfAborted()
      if (result !== 'REDIRECT' || !authorizationUrl) throw new Error('Missing authorization URL')
      phase = 'awaiting_authorization'
      notice = 'Open authorization_url yourself and confirm login in the official browser. Do not paste credentials into chat.'
      deadline = setTimeout(() => { stopCallback(); phase = 'disconnected'; notice = 'Authorization timed out. Use connect to start a new attempt.'; verifier = authorizationUrl = undefined }, authorizationTimeoutMs)
      deadline.unref()
    } catch { stopCallback(); unavailable() }
    finally { interactive = false }
    return status()
  }
  async function authenticatedFetch(input, init = {}) {
    lifetime.signal.throwIfAborted()
    const target = checkOrigin(input instanceof Request ? input.url : input.toString())
    if (target.pathname !== endpoint.pathname || !tokens) throw new Error('Douyin authorization required; use the connect tool')
    const send = async () => {
      try {
        const response = await localFetch(target, { ...init, headers: new Headers({ ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${tokens.access_token}` }) })
        if (response.status >= 500) unavailable()
        return response
      } catch {
        if (!init.signal?.aborted) unavailable()
        throw new Error('Douyin local service request failed; check status and reconnect')
      }
    }
    const attemptedToken = tokens.access_token
    let response = await send()
    if (response.status !== 401) return response
    await response.body?.cancel()
    try {
      if (tokens && tokens.access_token !== attemptedToken) {
        response = await send()
        if (response.status !== 401) return response
        await response.body?.cancel()
      }
      // One refresh per instance, even when the MCP GET and POST fail together.
      refreshing ??= auth(provider, { serverUrl: endpoint, scope: 'douyin.credentials', fetchFn: localFetch }).finally(() => { refreshing = undefined })
      if (await refreshing !== 'AUTHORIZED') throw new Error('Authorization required')
      response = await send()
      if (response.status === 401) { await response.body?.cancel(); throw new Error('Authorization required') }
      return response
    } catch {
      tokens = undefined
      phase = 'authorization_required'
      notice = 'Authorization expired or was rejected. Use connect and confirm login again.'
      throw new Error('Douyin authorization required; use the connect tool')
    }
  }
  return {
    status,
    begin() {
      starting ??= beginAttempt().finally(() => { starting = undefined })
      return starting
    },
    async dispose() {
      lifetime.abort()
      stopCallback()
      await Promise.allSettled([starting, finishing, refreshing].filter(Boolean))
      tokens = clientInformation = verifier = discovery = authorizationUrl = state = undefined
      phase = 'disconnected'
      notice = 'Local connection and in-memory authorization cleared.'
    },
  }
}
