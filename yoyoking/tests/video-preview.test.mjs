/** Real Harness route/tool lifetimes and byte-accurate media delivery. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Skills from '@deepseek-ai/dsh-skill'
import * as Yoyoking from '../index.js'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection'
import { byteRange, createVideoHandler, resolveVideo, registerVideoPreview } from '../video-preview.js'

const toolsRequire = createRequire(import.meta.resolve('@deepseek-ai/dsh-tools'))
const { createScope } = toolsRequire('@deepseek-ai/dsh-scope')

function ownerApi(ctx) {
  const api = ctx.connection.createSharedFetchHandler('/api')
  return { fetch: request => api.fetch(request, ctx.connection.browserPeer) }
}

test('single byte ranges retain suffix, open-ended, clamped and unsatisfiable semantics', () => {
  for (const [header, expected] of [[null, null], ['bytes=0-0', [0, 0]], ['bytes=3-', [3, 9]], ['bytes=-3', [7, 9]], ['bytes=-99', [0, 9]], ['bytes=3-99', [3, 9]], ['bytes=10-', false], ['bytes=2-1', false], ['bytes=-0', false], ['bytes=-', false], ['bytes=0-1,3-4', false], ['bytes=9007199254740992-', false]]) assert.deepEqual(byteRange(header, 10), expected)
  assert.equal(byteRange('bytes=0-', 0), false)
})

test('GET/HEAD and ranges serve exact bytes while traversal, junctions and non-video paths fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-video-http-'))
  const media = join(root, '素材'), outside = join(root, 'outside')
  await mkdir(media); await mkdir(outside)
  const file = join(media, '镜头 #1 &测试.MP4')
  await writeFile(file, '0123456789'); await writeFile(join(media, 'secret.txt'), 'private')
  await writeFile(join(outside, 'private.mp4'), 'outside')
  await symlink(outside, join(media, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  const fetch = createVideoHandler([media])
  const request = (path, options) => fetch(new Request(`http://local/api/video?path=${encodeURIComponent(path)}`, options))
  let response = await request(file)
  assert.equal(response.status, 200); assert.equal(await response.text(), '0123456789')
  assert.equal(response.headers.get('content-type'), 'video/mp4')
  assert.equal(response.headers.get('cache-control'), 'private, no-store')
  for (const [range, text, contentRange] of [['bytes=3-5', '345', 'bytes 3-5/10'], ['bytes=-2', '89', 'bytes 8-9/10'], ['bytes=8-', '89', 'bytes 8-9/10']]) {
    response = await request(file, { headers: { range } })
    assert.equal(response.status, 206); assert.equal(await response.text(), text)
    assert.equal(response.headers.get('content-range'), contentRange)
    assert.equal(response.headers.get('content-length'), String(text.length))
  }
  response = await request(file, { method: 'HEAD' })
  assert.equal(response.status, 200); assert.equal(await response.text(), '')
  assert.equal(response.headers.get('content-length'), '10')
  response = await request(file, { headers: { range: 'bytes=10-' } })
  assert.equal(response.status, 416); assert.equal(response.headers.get('content-range'), 'bytes */10')
  for (const path of ['../outside/private.mp4', join(media, 'escape', 'private.mp4'), join(media, 'secret.txt'), join(media, 'missing.mp4'), '']) assert.equal((await request(path)).status, 404)
  assert.equal(await resolveVideo('镜头 #1 &测试.MP4', [media]), file)
  assert.equal(await resolveVideo(file, [join(root, 'disconnected-drive'), media]), file)
  const fallback = await createVideoHandler([join(root, 'disconnected-drive'), media])(new Request(`http://local/api/video?path=${encodeURIComponent(file)}`))
  assert.equal(fallback.status, 200); assert.equal(await fallback.text(), '0123456789')
  assert.equal((await request(file, { method: 'POST' })).status, 405)
})

test('metadata tries active probe configurations and releases each probe with its owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-video-probes-'))
  const inner = join(root, 'input'); await mkdir(inner)
  const source = join(inner, 'source.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-c:v', 'libx264', source], { windowsHide: true })
  for (const goodRoots of [[root], [inner]]) {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
      await ctx.plugin(scope => { new HostConnectionService(scope, [], {}) })
      const launch = ffprobe => ({ serverName: 'yoyoking', env: { JY_EDIT_MEDIA_ROOTS: JSON.stringify([root]), JY_EDIT_WORKSPACE: join(root, 'workspace'), JY_EDIT_FFPROBE: ffprobe } })
      const broken = await ctx.plugin(async scope => { await registerVideoPreview(scope, launch(join(root, 'missing-ffprobe.exe')), { registerTool: false }) })
      const goodLaunch = launch('ffprobe'); goodLaunch.env.JY_EDIT_MEDIA_ROOTS = JSON.stringify(goodRoots)
      const working = await ctx.plugin(async scope => { await registerVideoPreview(scope, goodLaunch, { registerTool: false }) })
      const fetch = ownerApi(ctx).fetch
      const infoUrl = `http://local/api/yoyoking.video.info?path=${encodeURIComponent(source)}`
      const response = await fetch(new Request(infoUrl))
      assert.equal(response.status, 200)
      const { src } = await response.json()
      assert.equal((await fetch(new Request(`http://local/${src}`, { method: 'HEAD' }))).status, 200)
      await working.dispose()
      assert.equal((await fetch(new Request(infoUrl))).status, 404, 'A disposed owner must not leave its successful probe active')
      await broken.dispose()
      assert.equal((await fetch(new Request(infoUrl))).status, 404)
    } finally { await ctx.fiber.dispose() }
  }
})

test('native tool probes real video; sessions share a stable route with final-owner cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-video-host-'))
  const source = join(root, '真实素材.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=24:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { windowsHide: true })
  const bytes = await readFile(source)
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
    await ctx.plugin(scope => { new HostConnectionService(scope, [], {}) })
    const launch = { serverName: 'yoyoking', env: { JY_EDIT_MEDIA_ROOTS: JSON.stringify([root]), JY_EDIT_WORKSPACE: join(root, 'workspace'), JY_EDIT_FFPROBE: 'ffprobe' } }
    const mount = await ctx.plugin(async scope => { await registerVideoPreview(scope, launch) })
    const execute = args => ctx.tools.execute({ name: 'yoyoking_preview_video', arguments: args, callId: crypto.randomUUID(), signal: AbortSignal.timeout(10000) })
    const result = await execute({ path: source, title: '素材播放', start: 0.25 })
    assert.equal(result.isError, false, JSON.stringify(result))
    const video = result.value
    assert.equal(video.kind, 'yoyoking.video'); assert.equal(video.width, 320)
    assert.equal(video.codec, 'h264'); assert.equal(video.hasAudio, false)
    assert.equal((await execute({ path: source, start: 2 })).isError, true)
    const shared = ownerApi(ctx)
    const infoUrl = `http://local/api/yoyoking.video.info?path=${encodeURIComponent(source)}`
    const info = await shared.fetch(new Request(infoUrl))
    assert.equal(info.status, 200)
    assert.equal((await info.json()).src, video.src)
    assert.equal((await shared.fetch(new Request('http://local/api/yoyoking.video.info?path=C:/outside.mp4'))).status, 404)
    const url = `http://local/${video.src}`
    let response = await shared.fetch(new Request(url, { headers: { range: 'bytes=0-31' } }))
    assert.equal(response.status, 206); assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(0, 32))
    const session = await ctx.plugin(async scope => { await registerVideoPreview(createScope(scope, {}).ctx, launch) })
    await mount.dispose()
    response = await shared.fetch(new Request(url, { method: 'HEAD' }))
    assert.equal(response.status, 200)
    await session.dispose()
    assert.equal((await shared.fetch(new Request(url))).status, 404)
    assert.equal((await shared.fetch(new Request(infoUrl))).status, 404)
  } finally { await ctx.fiber.dispose() }
})

test('Desktop host visualization mode serves media without starting MCP or leaking editing tools and skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'yoyoking-video-host-only-'))
  const source = join(root, 'source.mp4')
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1', '-c:v', 'libx264', source], { windowsHide: true })
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools); await ctx.plugin(Skills)
    await ctx.plugin(scope => { new HostConnectionService(scope, [], {}) })
    const mount = await ctx.plugin(Yoyoking, { visualizationOnly: true, douyinEnabled: true, douyinServerUrl: 'must-not-connect', workspaceDirectory: join(root, 'workspace'), mediaRoots: [root], uvCommand: join(root, 'must-not-start.exe') })
    const shared = ownerApi(ctx)
    const url = `http://local/api/yoyoking.video.info?path=${encodeURIComponent(source)}`
    let response
    for (let attempt = 0; attempt < 100; attempt++) {
      response = await shared.fetch(new Request(url))
      if (response.status === 200) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.equal(response.status, 200)
    assert.deepEqual(ctx.tools.schemas(), [])
    assert.deepEqual(await ctx.skills.list(), [])
    await mount.dispose()
    assert.equal((await shared.fetch(new Request(url))).status, 404)
  } finally { await ctx.fiber.dispose() }
})
