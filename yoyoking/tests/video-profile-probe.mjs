/** Keyless browser acceptance inside an isolated official dsh Web profile. */
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'

export const inject = ['loader', 'agents', 'agentPresets', 'tools', 'connection', 'webServer', 'workspaceRegistry']

export function apply(ctx, config) {
  ctx.effect(() => {
    const timer = setTimeout(() => {
      run(ctx, config).catch(async error => {
        await writeFile(join(config.directory, 'browser-result.json'), JSON.stringify({ passed: false, error: error.stack?.replace(/token=[^\s"&]+/g, 'token=[redacted]') }, null, 2), 'utf8')
        ctx.logger.error(error); process.exitCode = 1
      }).finally(() => process.emit('SIGTERM'))
    }, 0)
    return () => clearTimeout(timer)
  })
}

async function run(ctx, config) {
  await ctx.loader.await()
  const require = createRequire(join(config.harness, 'apps/web/package.json'))
  const { chromium } = require('playwright')
  const source = config.sourcePath ? resolve(config.sourcePath) : join(config.directory, '页面素材.mp4')
  const workspace = await ctx.workspaceRegistry.create(config.directory, 'yoyoking 自动预览工作区')
  if (!config.sourcePath) execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=24:d=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', source], { windowsHide: true })
  const sourceHash = createHash('sha256').update(await readFile(source)).digest('hex')
  const handle = await ctx.agents.create({
    sessionId: `yoyoking-video-${crypto.randomUUID()}`, meta: { cwd: config.directory, agentPreset: 'yoyoking' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'yoyoking') },
  })
  let browser, page
  try {
    const agent = handle.agent
    await workspace.attachSession(agent.id)
    // Optional Connection injection registers after the preset's own async startup.
    for (let n = 0; !ctx.tools.schemas(agent).some(tool => tool.name === 'yoyoking_preview_video'); n++) {
      assert.ok(n < 100, 'Preview tool not available in preset'); await new Promise(resolve => setTimeout(resolve, 20))
    }
    const session = agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'yoyoking 回复内视频验收' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createAssistantMessage({ content: [{ type: 'text', text: `## 交付回执\n\n| 项 | 结果 |\n| --- | --- |\n| MP4 | \`${source}\` |\n\n可以在下方直接预览。` }], source: { provider: 'local-acceptance', model: 'no-model-request' } }) }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
    await page.emulateMedia({ colorScheme: 'dark' })
    const errors = [], statuses = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
    page.on('response', response => { if (/\/api\/yoyoking\.video\.[a-f0-9]{24}\?/.test(response.url())) statuses.push(response.status()) })
    const baseUrl = `http://127.0.0.1:${ctx.webServer.port}`
    const unauth = await fetch(new URL(`api/yoyoking.video.info?path=${encodeURIComponent(source)}`, baseUrl))
    assert.equal(unauth.status, 401, 'Media route must require native browser authentication')
    await page.goto(ctx.connection.authenticatedUrl(baseUrl), { waitUntil: 'domcontentloaded' })
    const notice = page.getByRole('button', { name: '继续', exact: true })
    await notice.waitFor({ timeout: 5000 }).catch(() => {})
    if (await notice.isVisible()) await notice.click()
    const skipKey = page.getByRole('button', { name: '稍后配置', exact: true })
    await skipKey.waitFor({ timeout: 5000 }).catch(() => {})
    if (await skipKey.isVisible()) await skipKey.click()
    await page.getByText('yoyoking 自动预览工作区', { exact: true }).click()
    await page.screenshot({ path: join(config.directory, '01-home.png') })
    await writeFile(join(config.directory, 'home.html'), await page.content(), 'utf8')
    await page.getByText('yoyoking 回复内视频验收', { exact: true }).first().click()
    const video = page.locator('.yoyoking-reply-videos video')
    await video.waitFor({ timeout: 30000 })
    assert.ok((await page.locator('.yoyoking-reply-videos').innerText()).includes(source))
    await video.scrollIntoViewIfNeeded()
    await video.evaluate(async element => { await Promise.race([element.play(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Video play timed out: ' + JSON.stringify({ readyState: element.readyState, networkState: element.networkState, error: element.error?.message, src: element.currentSrc }))), 10000))]) })
    await page.waitForFunction(() => document.querySelector('.yoyoking-video video')?.currentTime > 0.8)
    await video.evaluate(element => { element.pause(); element.currentTime = 3.5 })
    await page.waitForFunction(() => { const v = document.querySelector('.yoyoking-video video'); return v && !v.seeking && v.currentTime >= 3.4 })
    assert.ok(await video.evaluate(element => {
      const box = element.getBoundingClientRect()
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        if (['hidden', 'clip', 'auto', 'scroll'].includes(getComputedStyle(parent).overflowY) && box.bottom > parent.getBoundingClientRect().bottom + 1) return false
      }
      return true
    }), 'Video controls are clipped by the tool process area')
    await page.screenshot({ path: join(config.directory, '02-playing-desktop.png') })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await video.waitFor(); await video.evaluate(async element => { await Promise.race([element.play(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Replay video play timed out')), 10000))]); element.pause() })
    await page.getByRole('button', { name: '收起视频预览', exact: true }).click()
    assert.equal(await video.isVisible(), false)
    await page.getByRole('button', { name: '展开视频预览', exact: true }).click()
    assert.equal(await video.isVisible(), true)
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(config.directory, '03-mobile.png') })
    assert.ok(await video.evaluate(element => element.getBoundingClientRect().width <= window.innerWidth))
    assert.ok(statuses.includes(206), JSON.stringify(statuses))
    assert.deepEqual(errors, [])
    const mediaPattern = /\/api\/yoyoking\.video\.[a-f0-9]{24}\?/
    await page.route(mediaPattern, route => route.fulfill({ status: 404, body: 'Synthetic unavailable media' }))
    await video.evaluate(element => element.load())
    await page.getByRole('button', { name: '重新加载', exact: true }).waitFor()
    await page.screenshot({ path: join(config.directory, '04-unavailable.png') })
    await page.unroute(mediaPattern)
    const recoveredResponse = page.waitForResponse(response => mediaPattern.test(response.url()) && response.status() === 206, { timeout: 10000 })
    await page.getByRole('button', { name: '重新加载', exact: true }).click()
    await recoveredResponse
    await page.waitForFunction(() => document.querySelector('.yoyoking-video video')?.readyState >= 2)
    await video.evaluate(async element => { await Promise.race([element.play(), new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Recovered video play timed out')), 10000))]) })
    await page.waitForFunction(() => document.querySelector('.yoyoking-video video')?.currentTime > 0.8)
    assert.equal(await page.locator('.yoyoking-video [role="alert"]').count(), 0)
    const events = session.snapshotEvents()
    assert.equal(events.filter(event => event.type === 'tool/call').length, 0)
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), sourceHash)
    await writeFile(join(config.directory, 'browser-result.json'), JSON.stringify({ passed: true, automaticReplyPreview: true, previewToolCalls: 0, processExpansionRequired: false, pageTitle: await page.title(), browser: 'Chromium', browserPlugin: 'Browser plugin not available', nativeProfile: true, modelRequestSent: false, unauthenticatedStatus: unauth.status, mediaStatuses: statuses, playback: true, seek: true, reload: true, collapseAndExpand: true, errorAndRetry: true, controlsUnclipped: true, desktopViewport: [1440, 1000], mobileViewport: [390, 844], consoleErrors: [], expectedNegativeCaseErrors: errors, source, sourceHash, sourceUnchanged: true, sessionId: agent.id }, null, 2), 'utf8')
  } catch (error) {
    if (page) {
      await page.screenshot({ path: join(config.directory, 'failed-page.png'), timeout: 5000 }).catch(() => {})
      await writeFile(join(config.directory, 'failed-page.html'), await page.content(), 'utf8').catch(() => {})
    }
    throw error
  } finally { await browser?.close(); await handle.dispose() }
}
