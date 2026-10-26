/** Authenticated native-window ownership for the Harness right sidebar. */
import { spawn, execFile } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, accessSync } from 'node:fs'
import { join, resolve, basename, relative, isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import { selectEditor, replacementEditor, viewport } from './selection.js'
import { readCurrentProject } from './current-project.js'
import { registerCurrentProjectTool } from './project-tool.js'

export const name = 'jianying-window-poc'
export const inject = ['connection', 'profileContext']

/** Install a scoped route; unmount waits for native restoration. */
export function apply(ctx, config) {
  if (process.platform !== 'win32' || ctx.profileContext.name !== 'desktop') throw new Error('Windows desktop profile required')
  for (const key of ['helper', 'evidenceDirectory', 'expectedHost', 'jianyingExecutable']) if (typeof config[key] !== 'string' || !config[key]) throw new Error(`Missing ${key}`)
  if (basename(config.jianyingExecutable).toLowerCase() !== 'jianyingpro.exe' || !Number.isInteger(config.leaseSeconds) || config.leaseSeconds < 60 || config.leaseSeconds > 3600) throw new Error('Invalid native POC configuration')
  accessSync(config.helper); accessSync(config.jianyingExecutable)
  mkdirSync(config.evidenceDirectory, { recursive: true })
  let remembered
  try {
    const previous=JSON.parse(readFileSync(join(config.evidenceDirectory,'latest.json'),'utf8'))
    const child=relative(resolve(config.evidenceDirectory),resolve(previous.run))
    if(child && !child.startsWith('..') && !isAbsolute(child)) { const prior=JSON.parse(readFileSync(join(previous.run,'report.json'),'utf8'));remembered=prior.target??prior.rememberedTarget }
  } catch(error) { if(error.code!=='ENOENT') ctx.logger?.warn('Previous native selection could not be read: %s',error.message) }
  const run = join(config.evidenceDirectory, new Date().toISOString().replace(/[:.]/g, '-'))
  mkdirSync(run)
  const exec = promisify(execFile), normalize = path => resolve(path).toLowerCase()
  const native = async (...args) => {
    const { stdout } = await exec(config.helper, args, { windowsHide: true, encoding: 'utf8', timeout: 4000 })
    return stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  }
  let helper, controller, stopTask, pendingFocus, stopped = false, queue = Promise.resolve(), lastHeartbeat = 0, lastDiscovery = 0, lastLaunch = 0, lastFamilyScan = 0
  const clientLeaseMs = (config.clientLeaseSeconds ?? 120) * 1000
  const scanIntervalMs = config.windowScanIntervalMs ?? 750
  if (!Number.isFinite(clientLeaseMs) || clientLeaseMs < 30000 || !Number.isInteger(scanIntervalMs) || scanIntervalMs < 100) throw new Error('Invalid window lifecycle timing')
  const state = { kind: 'harness-right-sidebar-jianying', version: '0.4.1', run, profile: ctx.profileContext.name, hostPid: process.pid,
    active: false, status: 'route_ready', candidates: [], rememberedTarget: remembered, events: [], gates: { harnessWindowOwner: 'awaiting_attach', playback: 'not_tested', agentEditing: 'not_tested', saveReopen: 'not_tested' } }
  const view = () => ({ version: state.version, active: state.active, status: state.status, currentProject: state.currentProject, keyboard: state.keyboard, presentation: state.presentation, candidates: state.candidates, target: state.target, host: state.host, panel: state.panel, run, gates: state.gates })
  const record = event => {
    state.events.push({ time: new Date().toISOString(), ...event })
    writeFileSync(join(run, 'report.json'), JSON.stringify(state, null, 2) + '\n')
    writeFileSync(join(config.evidenceDirectory, 'latest.json'), JSON.stringify({ run, active: state.active, status: state.status, hostPid: process.pid }) + '\n')
  }
  async function inspectProject(args = {}, signal) {
    if (!config.currentProject) throw new Error('current_project_not_configured')
    const result = await readCurrentProject(config.currentProject, view, native, args, signal)
    state.currentProject = { ...result.project, saved_at: result.evidence.saved_at, draft_path: result.draft_path }
    record({ event: 'current_project_read', project: state.currentProject, evidence: result.evidence })
    return result
  }
  if (config.currentProject) {
    for (const key of ['userDataDirectory', 'snapshotDirectory', 'draftConverter', 'converterRuntime']) if (typeof config.currentProject[key] !== 'string' || !isAbsolute(config.currentProject[key])) throw new Error(`Invalid currentProject.${key}`)
    ctx.inject(['tools', 'systemPrompt'], async scope => {
      const { defineTool } = await import('@deepseek-ai/dsh-tools')
      registerCurrentProjectTool(scope, inspectProject, defineTool)
      record({ event: 'current_project_tool_ready', tool: 'jianying_get_current_project' })
    })
  }
  async function discover(requestedHwnd) {
    const result = selectEditor(await native('list'), requestedHwnd)
    state.candidates = result.candidates
    const status = result.status === 'not_running' && lastLaunch > 0 ? (Date.now() - lastLaunch < 30000 ? 'starting' : 'launch_timeout') : result.status
    if (state.status !== status) { state.status = status; record({ event: 'discovery', status, windows: result.candidates.map(window => ({ hwnd: window.hwnd, pid: window.pid })) }) }
    lastDiscovery = Date.now()
    return result.selected
  }
  async function detach(reason, handoff = false) {
    if (stopTask) return stopTask
    const child = helper
    if (!child || child.exitCode !== null) return view()
    stopTask = new Promise((resolveStop, reject) => {
      const timer = setTimeout(() => reject(new Error('restore_timeout')), 8000)
      child.once('exit', code => { clearTimeout(timer); (code === 0 && state.restore?.ok) || code === 70 ? resolveStop(view()) : reject(new Error('restore_failed')) })
      record({ event: 'detach_requested', reason })
      child.stdin.end(handoff ? 'handoff\n' : 'detach\n')
    })
    try { return await stopTask } finally { stopTask = undefined }
  }
  function place(input) {
    lastHeartbeat = Date.now()
    if (input.visible === false) {
      if (state.status !== 'paused') { helper.stdin.write('hide\n'); state.status = 'paused'; record({ event: 'tab_hidden' }) }
    } else {
      helper.stdin.write(`viewport ${viewport(input)}\n`)
      if (state.status === 'paused') { state.status = 'resuming'; record({ event: 'tab_visible' }) }
    }
  }
  async function attach(input, selected) {
    viewport(input)
    if(selected.visible===false){const shown=await native('show',String(selected.hwnd));selected=shown[0];if(!selected?.visible)throw new Error('window_restore_failed')}
    state.status = 'locating_host'; record({ event: 'locating_host' })
    const hosts = (await native('list-harness')).filter(window => normalize(window.path) === normalize(config.expectedHost) && window.parent === 0 && window.title.endsWith('DeepSeek Harness'))
    if (hosts.length !== 1) throw new Error('harness_window_unavailable')
    remembered=selected;state.rememberedTarget=selected;
    state.host = hosts[0]; state.target = selected; state.restore = undefined; state.bounds = undefined; state.presentation = undefined; state.keyboard = undefined; state.currentProject = undefined; controller = input.owner
    lastFamilyScan = Date.now()
    state.status = 'attaching'; record({ event: 'selected_fresh_window', hwnd: selected.hwnd, pid: selected.pid })
    const child = spawn(config.helper, ['panel', String(selected.hwnd), String(state.host.hwnd), String(config.leaseSeconds)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    helper = child; lastHeartbeat = Date.now()
    const ready = new Promise((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('attach_timeout')), 8000)
      child.once('error', error => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error('editor_closed_during_attach')) })
      let pending = ''
      child.stdout.on('data', data => {
        if (helper !== child) return
        pending += data.toString('utf8')
        let end
        while ((end = pending.indexOf('\n')) !== -1) {
          const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1)
          if (!line) continue
          let event
          try { event = JSON.parse(line) } catch (error) { record({ event: 'parse_error', message: error.message }); continue }
          if (event.event === 'bounds') { state.bounds = event; continue }
          if (event.event === 'keyboard_state') state.keyboard = event
          if (event.event === 'keyboard_focus' && event.reason === 'explicit' && pendingFocus?.child === child) pendingFocus.resolve(event)
          if (event.event === 'presentation') { state.presentation = event; state.status = event.visible ? 'attached' : 'waiting_for_window' }
          if (event.event === 'target_hidden') state.status = 'waiting_for_window'
          if (event.event === 'native_panel') {
            state.panel = event.panel
            state.gates.harnessWindowOwner = event.electronOwner.hwnd === state.host.hwnd && normalize(event.electronOwner.path) === normalize(config.expectedHost) ? 'passed_native_owner_readback' : 'failed'
          }
          if (event.event === 'attached') { state.active = true; state.status = 'attached'; clearTimeout(timer); resolveReady() }
          if (event.event === 'restored') state.restore = event
          record(event)
          if (['rejected', 'attach_failed'].includes(event.event)) { clearTimeout(timer); reject(new Error(event.reason || event.event)) }
        }
      })
    })
    child.stdin.on('error', error => record({ event: 'stdin_error', message: error.message }))
    child.stderr.on('data', data => record({ event: 'native_stderr', message: data.toString('utf8').slice(0, 4000) }))
    child.on('exit', (code, signal) => {
      if (helper !== child) return
      if (pendingFocus?.child === child) pendingFocus.resolve({ ok: false, error: 'native_exited' })
      state.active = false; controller = undefined
      state.status = code === 70 ? 'not_running' : code === 0 ? 'restored' : 'native_exited'
      lastDiscovery = 0; record({ event: 'native_exit', code, signal })
    })
    try { await ready; place(input) }
    catch (error) { await detach('attach_failed').catch(cleanup => record({ event: 'cleanup_failed', message: cleanup.message })); throw error }
    return view()
  }
  async function reconcile(input) {
    if (Date.now() - lastFamilyScan < scanIntervalMs && input.action !== 'refresh') return false
    lastFamilyScan = Date.now()
    const windows = await native('family', String(state.target.pid))
    const replacement = replacementEditor(windows, state.target, input.targetHwnd)
    if (replacement.selected) {
      state.status = 'switching_window'; record({ event: 'window_transition', from: state.target.hwnd, to: replacement.selected.hwnd })
      await detach('window_transition', true)
      await attach(input, replacement.selected)
      return true
    }
    if (replacement.status === 'choose_window') { state.candidates = replacement.candidates; state.status = 'choose_window'; return true }
    const current = windows.find(window => window.hwnd === state.target.hwnd)
    if (current) state.target = current
    return false
  }
  async function handle(input) {
    if (stopped) throw new Error('plugin_stopping')
    if (input?.action === 'client-ready') { record({ event: 'client_ready', surface: 'sidebar.right.pane.tab', registeredKind: input.registeredKind, title: String(input.title).slice(0, 240) }); return view() }
    if (!input || typeof input.owner !== 'string' || !/^[a-f0-9-]{36}$/.test(input.owner)) throw new Error('invalid_owner')
    if (state.active && controller !== input.owner) {
      if (input.action === 'detach') return view()
      return { ...view(), status: 'another_tab_active', active: false }
    }
    if (input.action === 'detach') return detach('tab_closed_or_disconnected')
    if (input.action === 'checkpoint') { if (state.active) record({ event: 'manual_checkpoint', source: 'human' }); return view() }
    if (input.action === 'inspect-project') { await inspectProject(); return view() }
    if (input.action === 'focus') {
      if (!state.active || input.visible !== true || state.status === 'paused') throw new Error('focus_denied')
      let timer
      try {
        const result = await new Promise((resolveFocus, reject) => {
          pendingFocus = { child: helper, resolve: resolveFocus }
          timer = setTimeout(() => reject(new Error('focus_timeout')), 2000)
          helper.stdin.write('focus\n')
        })
        if (!result.ok) throw new Error(result.error || 'focus_denied')
        return view()
      } finally { clearTimeout(timer); pendingFocus = undefined }
    }
    if (!['sync', 'connect', 'launch', 'refresh'].includes(input.action)) throw new Error('unknown_action')
    if (state.active) {
      lastHeartbeat = Date.now()
      if (input.visible !== false && await reconcile(input)) return view()
      place(input); return view()
    }
    if (input.visible === false) return view()
    if (input.action === 'sync' && Date.now() - lastDiscovery < 1200) return view()
    let selected = await discover(input.targetHwnd)
    if(!selected && input.action==='launch' && state.status==='windows_hidden') {
      selected=state.candidates.find(window=>window.hwnd===remembered?.hwnd && window.pid===remembered?.pid)
      if(!selected && state.candidates.length===1)selected=state.candidates[0]
    }
    if (selected && input.connect === true) return attach(input, selected)
    if (!selected && state.candidates.length === 0 && input.action === 'launch') {
      if (Date.now() - lastLaunch < 5000) return { ...view(), status: 'starting' }
      lastLaunch = Date.now()
      const launched = spawn(config.jianyingExecutable, [], { windowsHide: false, detached: true, stdio: 'ignore', cwd: resolve(config.jianyingExecutable, '..') })
      launched.once('error', error => { state.status = 'launch_failed'; record({ event: 'launch_failed', message: error.message }) })
      launched.unref(); state.status = 'starting'; record({ event: 'launch_requested', path: config.jianyingExecutable })
    }
    return view()
  }
  ctx.effect(() => {
    const dispose = ctx.connection.fetch.register({
      path: '/api/jianying-window-poc', methods: ['GET', 'POST'], requestBody: 'buffered',
      async fetch(request) {
        const headers = { 'Cache-Control': 'no-store' }
        if (request.method === 'GET') return Response.json(view(), { headers })
        if (!request.headers.get('content-type')?.startsWith('application/json')) return Response.json({ error: 'json_required' }, { status: 415, headers })
        let input
        try { const body = await request.text(); if (body.length > 4096) throw new Error('request_too_large'); input = JSON.parse(body) } catch (error) { return Response.json({ error: 'invalid_json' }, { status: 400, headers }) }
        const task = queue.then(() => handle(input)); queue = task.catch(() => {})
        try { return Response.json(await task, { headers }) } catch (error) { record({ event: 'request_failed', message: error.message }); return Response.json({ error: error.code || error.message }, { status: 409, headers }) }
      },
    })
    const timer = setInterval(() => {
      if (state.active && Date.now() - lastHeartbeat > clientLeaseMs) {
        const task = queue.then(() => {
          if (state.active && state.status !== 'paused') { helper.stdin.write('hide\n'); state.status = 'paused'; record({ event: 'client_suspended' }) }
        }); queue = task.catch(error => record({ event: 'restore_error', message: error.message }))
      }
    }, 1000)
    return async () => { stopped = true; clearInterval(timer); await dispose(); await queue; await detach('plugin_unloaded') }
  })
  record({ event: 'route_ready', path: '/api/jianying-window-poc' })
}
