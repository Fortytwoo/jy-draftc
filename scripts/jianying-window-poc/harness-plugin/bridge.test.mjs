/** Route/native protocol fixture: no user window is changed by this test. */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'

test('route retains ownership through hiding, accepts a new editor after exit, and restores on unload', async () => {
  const hostPath = 'C:/Users/fortytwo/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe'
  const editor = hwnd => ({ hwnd, pid: hwnd * 10, path: 'C:/JianyingPro.exe', title: '剪映专业版', parent: 0, style: 0 })
  let windows = [editor(10)], route, removed = false, launches = 0, focusAllowed = true
  const children = [], effects = [], commands = []
  const execFile = () => { throw new Error('The bridge must use the asynchronous adapter') }
  execFile[Symbol.for('nodejs.util.promisify.custom')] = async (_file, args) => {
    let values=args[0]==='list-harness'?[{ hwnd: 100, path: hostPath, parent: 0, title: 'Test — DeepSeek Harness' }]:windows
    if(args[0]==='show'){const selected=windows.find(window=>window.hwnd===Number(args[1]));selected.visible=true;values=[selected]}
    return {stdout:values.map(value=>JSON.stringify(value)).join('\n'),stderr:''}
  }
  const mocked = mock.module('node:child_process', { exports: {
    execFile,
    spawn(_file, args) {
      if (args.length === 0) { launches++; const app = new EventEmitter(); app.unref = () => {}; return app }
      assert.equal(args[0], 'panel')
      const child = new EventEmitter(); child.exitCode = null; child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter()
      child.stdin.write = line => {
        commands.push(line)
        if(line==='focus\n')queueMicrotask(()=>child.stdout.emit('data',JSON.stringify({event:'keyboard_state',destination:focusAllowed?'jianying':'other'})+'\n'+JSON.stringify({event:'keyboard_focus',reason:'explicit',ok:focusAllowed,error:focusAllowed?'':'focus_denied'})+'\n'))
        return true
      }
      child.stdin.end = line => { child.stdin.write(line); queueMicrotask(() => { child.stdout.emit('data', JSON.stringify({ event: 'restored', ok: true }) + '\n'); child.exitCode = 0; child.emit('exit', 0) }) }
      queueMicrotask(() => child.stdout.emit('data', JSON.stringify({ event: 'native_panel', panel: { hwnd: 200 }, electronOwner: { hwnd: 100, path: hostPath } }) + '\n' + JSON.stringify({ event: 'attached' }) + '\n'))
      children.push(child); return child
    },
  } })
  const directory = mkdtempSync(join(tmpdir(), 'jy-bridge-test-'))
  try {
    const { apply } = await import('./index.js?fixture')
    apply({ profileContext: { name: 'desktop' }, effect(effect) { effects.push(effect()) }, connection: { fetch: { register(value) { route = value; return () => { removed = true } } } } },
      { helper: 'G:/project/jy-draftc/build/jianying-window-poc/window-host.exe', evidenceDirectory: directory, expectedHost: hostPath,
        jianyingExecutable: 'C:/Users/fortytwo/AppData/Local/JianyingPro/Apps/10.6.0.14057/JianyingPro.exe', leaseSeconds: 60 })
    const owner = randomUUID(), bounds = { x: 500, y: 100, width: 600, height: 700, viewportWidth: 1200, viewportHeight: 900 }
    const post = async input => {
      const response = await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ owner, visible: true, connect: true, ...bounds, ...input }) }))
      const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result
    }
    assert.equal((await post({ action: 'connect' })).target.hwnd, 10)
    assert.equal((await post({action:'focus'})).keyboard.destination,'jianying','focus response must wait for native acknowledgement')
    focusAllowed=false
    const denied=await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner,visible:true,action:'focus'})}))
    assert.equal(denied.status,409);assert.equal((await denied.json()).error,'focus_denied')
    const focusCount=commands.filter(line=>line==='focus\n').length
    await post({action:'focus',owner:randomUUID()});assert.equal(commands.filter(line=>line==='focus\n').length,focusCount,'a different tab cannot take keyboard ownership')
    assert.equal((await post({ action: 'sync', visible: false })).status, 'paused')
    const hiddenFocus=await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner,visible:false,action:'focus'})}))
    assert.equal(hiddenFocus.status,409);assert.equal(commands.filter(line=>line==='focus\n').length,focusCount,'hidden tabs cannot request native focus')
    assert.ok(commands.includes('hide\n'))
    assert.equal((await post({ action: 'sync', owner: randomUUID() })).status, 'another_tab_active')
    assert.equal(children.length, 1)
    assert.ok(['attached','resuming'].includes((await post({ action: 'sync' })).status))
    windows = [{...editor(10),parent:200,visible:false},{...editor(11),pid:100}]
    assert.equal((await post({ action: 'refresh' })).target.hwnd,11,'editor navigation should hand off without a manual disconnect')
    assert.ok(commands.includes('handoff\n'))
    children[0].emit('exit',70)
    assert.equal((await post({ action: 'sync' })).active,true,'old helper events must not clear the new attachment')
    children[1].exitCode = 70; windows = [editor(20)]; children[1].emit('exit', 70)
    const reconnected = await post({ action: 'connect' })
    assert.equal(reconnected.target.hwnd, 20); assert.equal(reconnected.gates.harnessWindowOwner, 'passed_native_owner_readback')
    const backgroundNow=Date.now()+121000
    const backgroundClock=mock.method(Date,'now',()=>backgroundNow)
    try {
      await new Promise(resolve=>setTimeout(resolve,1100))
      const paused=await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc'))
      assert.equal((await paused.json()).status,'paused')
      assert.equal(children[2].exitCode,null,'a throttled client should pause rather than detach the editor')
      assert.equal((await post({action:'sync'})).active,true)
    } finally { backgroundClock.mock.restore() }
    await post({ action: 'detach' }); assert.equal(children[2].exitCode, 0)
    windows=[{...editor(20),visible:false},{...editor(30),visible:false}]
    assert.equal((await post({action:'launch'})).target.hwnd,20,'restore the validated previous editor when all main windows are hidden')
    assert.equal(launches,0,'recovering a hidden editor must not start another app')
    await post({action:'detach'})
    windows = []
    let now = Date.now()
    const clock = mock.method(Date, 'now', () => now)
    try {
      assert.equal((await post({ action: 'launch' })).status, 'starting')
      now += 5000
      assert.equal((await post({ action: 'sync' })).status, 'starting', 'polling must preserve startup progress')
      now += 26000
      assert.equal((await post({ action: 'sync' })).status, 'launch_timeout')
      assert.equal(launches, 1, 'polling must not repeatedly launch the app')
    } finally { clock.mock.restore() }
    for (const dispose of effects.splice(0).reverse()) await dispose?.()
    assert.equal(children.at(-1).exitCode, 0); assert.equal(removed, true); assert.ok(commands.includes('detach\n'))
  } finally {
    for (const dispose of effects.reverse()) await dispose?.()
    mocked.restore()
    const child = relative(tmpdir(), directory); assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
    rmSync(directory, { recursive: true })
  }
})
