/** Login controls use Harness's authenticated API; browsers never handle account credentials. */
const routes = new WeakMap()

export function createDouyinHandler(entries) {
  return async request => {
    const headers = { 'Cache-Control': 'private, no-store' }
    if (request.method === 'GET') return Response.json({ accounts: [...entries.values()].map(({ entry }) => ({ id: entry.id, ...entry.host.status() })) }, { headers })
    if (request.method !== 'POST' || request.headers.get('x-yoyoking-action') !== '1' || request.headers.get('content-type') !== 'application/json') return Response.json({ error: 'INVALID_REQUEST' }, { status: 400, headers })
    try {
      const body = await request.text()
      if (body.length > 1024) throw new Error('Too large')
      const { id, action } = JSON.parse(body)
      const entry = entries.get(id)?.entry
      if (!entry || !['login', 'logout'].includes(action)) throw new Error('Unknown action')
      return Response.json({ id, ...await entry.host[action]() }, { headers })
    } catch { return Response.json({ error: 'LOGIN_ACTION_FAILED' }, { status: 400, headers }) }
  }
}

export function registerDouyinApi(ctx, entry) {
  return ctx.inject(['connection'], scope => {
    let registry = routes.get(scope.root)
    if (!registry) {
      const entries = new Map()
      const dispose = scope.root.get('connection').fetch.register({
        path: '/api/yoyoking.douyin', methods: ['GET', 'POST'], requestBody: 'buffered', fetch: createDouyinHandler(entries),
      })
      routes.set(scope.root, registry = { entries, dispose })
    }
    let registered = registry.entries.get(entry.id)
    if (!registered) registry.entries.set(entry.id, registered = { entry, users: 0 })
    registered.users++
    scope.effect(() => async () => {
      if (--registered.users) return
      registry.entries.delete(entry.id)
      if (!registry.entries.size) { routes.delete(scope.root); await registry.dispose() }
    })
  })
}
