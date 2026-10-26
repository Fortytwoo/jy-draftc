/** An owned SDK child: readiness comes from its pipe, never from an unrelated port. */
import { spawn, execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { buildManagedDouyinService } from './douyin-service.js'
import { validateDouyinUrl } from './douyin-oauth.js'

export async function startDouyinProcess(config, { launch: override, startupTimeoutMs = 120000 } = {}) {
  const launch = override || buildManagedDouyinService(config)
  if (!override) await mkdir(launch.env.DOUYIN_CREATOR_DOWNLOAD_DIR, { recursive: true })
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd, env: launch.env, shell: false, windowsHide: true,
    detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'],
  })
  let settled = false, buffer = '', stopping
  let resolveReady, rejectReady
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  const fail = () => {
    if (!settled) { settled = true; rejectReady(new Error('Douyin SDK could not start. Check the installed SDK and uv; no account credentials were read.')) }
  }
  child.on('error', fail)
  child.stdin.on('error', () => {})
  child.stdout.on('data', bytes => {
    if (settled) return
    buffer += bytes.toString('utf8')
    if (buffer.length > 4096) { fail(); void stop(); return }
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    try {
      const message = JSON.parse(buffer.slice(0, newline))
      if (message.kind !== 'yoyoking.douyin.ready') throw new Error('Invalid readiness')
      const url = validateDouyinUrl(message.url)
      settled = true
      clearTimeout(timer)
      resolveReady(url)
    } catch { fail(); void stop() }
    buffer = ''
  })
  const timer = setTimeout(() => { fail(); void stop() }, startupTimeoutMs)
  timer.unref()
  void done.then(() => { clearTimeout(timer); fail() })
  const wait = milliseconds => new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false), milliseconds)
    void done.then(() => { clearTimeout(timeout); resolve(true) })
  })
  function stop() {
    return stopping ??= (async () => {
      clearTimeout(timer)
      child.stdin.end()
      if (await wait(5000)) return
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        if (process.platform === 'win32') {
          await new Promise(resolve => execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve()))
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') throw error }
        }
      }
      if (!await wait(5000)) throw new Error('Douyin SDK process did not confirm shutdown')
    })()
  }
  return { ready, done, stop }
}
