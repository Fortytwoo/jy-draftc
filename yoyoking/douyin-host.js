/** One SDK process and one in-memory login shared by a Harness host's yoyoking sessions. */
import { createHash } from 'node:crypto'
import { createDouyinOAuth } from './douyin-oauth.js'
import { startDouyinProcess } from './douyin-process.js'

const hosts = new WeakMap()

export function createDouyinHost(config, { startProcess = startDouyinProcess, oauthFactory = createDouyinOAuth, restartDelays = [1000, 3000, 10000] } = {}) {
  let process, oauth, url, authenticatedFetch, generation = 0
  let serviceState = 'starting', message = '正在准备抖音登录服务…'
  let closed = false, starting, commands = Promise.resolve(), restartTimer, failures = 0
  const listeners = new Set()
  const notify = () => Promise.allSettled([...listeners].map(listener => Promise.resolve().then(listener)))
  const status = () => ({
    service_state: serviceState, message, ...(oauth?.status() || { state: 'disconnected' }),
    managed: !config.url, generation,
  })
  const clearLogin = async () => {
    authenticatedFetch = undefined
    generation++
    const previous = oauth
    oauth = undefined
    const notified = notify()
    await previous?.dispose()
    await notified
  }
  async function boot() {
    serviceState = 'starting'; message = '正在准备抖音登录服务…'
    try {
      await clearLogin()
      if (closed) return
      if (config.url) url = config.url
      else {
        const child = await startProcess(config)
        process = child
        if (closed) { await child.stop(); return }
        void child.done.then(async () => {
          if (closed || process !== child) return
          process = undefined
          await clearLogin()
          if (closed) return
          serviceState = 'failed'; message = '抖音服务已退出，正在尝试恢复。'
          if (failures < restartDelays.length) {
            restartTimer = setTimeout(() => { void start() }, restartDelays[failures++])
            restartTimer.unref()
          } else message = '抖音服务启动失败，请点击重新连接。剪辑功能不受影响。'
        })
        url = await child.ready
        if (process !== child || closed) return
      }
      oauth = oauthFactory({ url, onAuthorized: async fetch => {
        if (closed) throw new Error('Host disposed')
        authenticatedFetch = fetch
        generation++
        await notify()
      } })
      serviceState = 'running'; message = '抖音服务已就绪，点击登录并在官方窗口确认。'
      await notify()
    } catch {
      serviceState = 'failed'
      message = '无法启动抖音服务。请确认本机 Documents/DouyinCreatorSDK 和 uv 可用；无需填写端口或凭据。'
      const child = process
      process = undefined
      await child?.stop()
    }
  }
  const start = () => starting ??= boot().finally(() => { starting = undefined })
  const exclusive = action => {
    const next = commands.then(() => { if (closed) throw new Error('Host disposed'); return action() })
    commands = next.catch(() => {})
    return next
  }
  const host = {
    config,
    status,
    connection: () => authenticatedFetch ? { fetch: authenticatedFetch, url, generation } : null,
    subscribe(listener) {
      listeners.add(listener)
      void Promise.resolve().then(listener).catch(() => {})
      return () => listeners.delete(listener)
    },
    login: () => exclusive(async () => {
      clearTimeout(restartTimer)
      if (starting) await starting
      if (serviceState !== 'running') { failures = 0; await start() }
      if (oauth) await oauth.begin()
      return status()
    }),
    logout: () => exclusive(async () => {
      clearTimeout(restartTimer)
      if (starting) await starting
      await clearLogin()
      const child = process
      process = undefined
      await child?.stop()
      if (!closed) await start()
      return status()
    }),
    async dispose() {
      if (closed) return
      closed = true
      clearTimeout(restartTimer)
      await clearLogin()
      const child = process
      process = undefined
      await child?.stop()
      await starting
      await commands
      serviceState = 'stopped'
      message = 'Harness 已关闭抖音服务。'
      listeners.clear()
    },
  }
  void start()
  return host
}

export function acquireDouyinHost(ctx, config) {
  let entries = hosts.get(ctx.root)
  if (!entries) hosts.set(ctx.root, entries = new Map())
  const key = JSON.stringify([config.workspaceDirectory, config.sdkDirectory, config.url, config.uvCommand, config.pythonVersion])
  let entry = entries.get(key)
  if (!entry) {
    entry = { host: createDouyinHost(config), users: 0, id: createHash('sha256').update(key).digest('hex').slice(0, 20) }
    entries.set(key, entry)
  }
  entry.users++
  ctx.effect(() => async () => {
    if (--entry.users) return
    entries.delete(key)
    if (!entries.size) hosts.delete(ctx.root)
    await entry.host.dispose()
  })
  return entry
}
