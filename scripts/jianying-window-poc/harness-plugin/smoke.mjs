/** Exercise the real route/parser and native inventory without modifying any window. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { randomUUID } from 'node:crypto'
import { apply } from './index.js'

const temporary = mkdtempSync(join(tmpdir(), 'jy-harness-smoke-'))
const effects = []
let route, removed = false
const ctx = {
  profileContext: { name: 'desktop' },
  connection: { fetch: { register(value) { route = value; return () => { removed = true } } } },
  effect(effect) { effects.push(effect()) },
}
try {
  const config = { helper: 'G:/project/jy-draftc/build/jianying-window-poc/window-host.exe', evidenceDirectory: temporary,
    expectedHost: 'C:/Users/fortytwo/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe',
    jianyingExecutable: 'C:/Users/fortytwo/AppData/Local/JianyingPro/Apps/10.6.0.14057/JianyingPro.exe', leaseSeconds: 60 }
  apply(ctx, config)
  const get = await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc'))
  assert.equal((await get.json()).status, 'route_ready')
  const post = value => route.fetch(new Request('https://harness.invalid/api/jianying-window-poc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) }))
  assert.equal((await post({ action: 'connect', owner: 'invalid' })).status, 409)
  const inventory = await post({ action: 'refresh', owner: randomUUID(), visible: true, connect: false })
  assert.equal(inventory.status, 200)
  assert.equal((await inventory.json()).active, false)
  assert.equal((await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc', { method: 'POST', body: '{}' }))).status, 415)
  assert.equal((await route.fetch(new Request('https://harness.invalid/api/jianying-window-poc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }))).status, 400)
  assert.equal((await post({ action: 'client-ready', title: 'smoke' })).status, 200)
  const latest = JSON.parse(readFileSync(join(temporary, 'latest.json')))
  const report = JSON.parse(readFileSync(join(latest.run, 'report.json')))
  assert.equal(report.active, false)
  assert.ok(!report.events.some(event => event.event === 'attached'))
  console.log('PASS: route readiness, request rejection, actual native inventory, read-only evidence')
} finally {
  for (const dispose of effects.reverse()) await dispose?.()
  assert.equal(removed, true)
  const child = relative(resolve(tmpdir()), resolve(temporary))
  assert.ok(child && !child.startsWith('..') && !isAbsolute(child))
  rmSync(temporary, { recursive: true })
}
