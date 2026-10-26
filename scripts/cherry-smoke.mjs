import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = fileURLToPath(new URL('../cherry-studio/', import.meta.url))
const require = createRequire(join(checkout, 'package.json'))
const playwright = createRequire(require.resolve('@playwright/test/package.json'))('playwright')
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9) || join(tmpdir(), `yoyoking-smoke-${Date.now()}`)
await mkdir(output, { recursive: true })
const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(key)))
Object.assign(env, { CS_DEV_PROFILE_ROOT: join(output, 'profile') })
const app = await playwright._electron.launch({ executablePath: require('electron'), args: [resolve(checkout)], cwd: checkout, env, timeout: 30000 })
const errors = []
const receipts = []
app.process().stderr.on('data', data => { if (/Error|failed|exception/i.test(data.toString())) errors.push(data.toString().slice(0, 2000)) })
try {
  const page = await app.firstWindow({ timeout: 60000 })
  const rpc = async (route, input) => {
    const result = await page.evaluate(async ({ route, input }) => window.api.ipcApi.request(route, input), { route, input })
    if (!result.ok) throw new Error(`${route}: ${JSON.stringify(result.error)}`)
    return result.data
  }
  const call = async (name, args = {}, allowError = false) => {
    const result = await rpc('yoyoking.tool.call', { name, args })
    const data = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text)
    receipts.push({ name, args, result: data })
    if (data.ok === false && !allowError) throw new Error(`${name}: ${JSON.stringify(data.error)}`)
    return data
  }
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForFunction(() => !!window.api?.preference, { timeout: 60000 })
  await page.evaluate(async () => {
    await window.api.preference.set('app.onboarding.provider_setup.status', 'skipped')
    await window.api.preference.set('app.privacy.policy_version', '20260820')
  })
  await page.waitForTimeout(1500)
  console.log(JSON.stringify({ stage: 'first-screen', title: await page.title(), url: page.url(), body: (await page.locator('body').innerText()).slice(0, 4000) }))
  await page.screenshot({ path: join(output, 'first-screen.png') })
  const status = await page.evaluate(() => window.api.ipcApi.request('yoyoking.status'))
  await writeFile(join(output, 'initial-status.json'), JSON.stringify(status, null, 2) + '\n', 'utf8')
  console.log(JSON.stringify({ stage: 'initial-status', result: status, output }))
  if (process.argv.includes('--exercise') || process.argv.includes('--edit') || process.argv.includes('--native')) {
    const navigation = page.getByText(/剪辑工作台|Editing workbench/, { exact: true }).first()
    await navigation.click({ timeout: 10000 })
    await page.getByTestId('yoyoking-workbench').waitFor()
    await page.screenshot({ path: join(output, 'workbench.png') })
    console.log(JSON.stringify({ stage: 'workbench', body: (await page.getByTestId('yoyoking-workbench').innerText()).slice(0, 3000) }))
  }
  if (process.argv.includes('--native')) {
    const fixture = spawn(join(checkout, '../build/jianying-window-poc/fixture/JianyingPro.exe'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] })
    let buffer = ''
    const handles = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out')), 5000)
      fixture.once('error', reject)
      fixture.stdout.on('data', bytes => {
        buffer += bytes.toString('utf8')
        const index = buffer.indexOf('\n')
        if (index >= 0) { clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, index))); buffer = buffer.slice(index + 1) }
      })
    })
    try {
      await page.getByRole('tab', { name: /剪映窗口|Jianying window/ }).click()
      await page.getByRole('button', { name: /^(刷新|Refresh)$/ }).click()
      await page.getByRole('button').filter({ hasText: `HWND ${handles.target}` }).click()
      await page.getByRole('button', { name: /^(接入窗口|Attach window)$/ }).click()
      await page.waitForFunction(() => document.querySelector('pre')?.textContent.includes('"active": true'))
      const attached = JSON.parse(await page.locator('pre').innerText())
      const another = await rpc('yoyoking.native.detach', { ownerId: crypto.randomUUID() })
      if (another.status !== 'another_tab_active') throw new Error('Native tab ownership was not isolated')
      const { stdout } = await promisify(execFile)(join(checkout, '../build/jianying-window-poc/window-host.exe'), ['family', String(handles.pid)], { windowsHide: true })
      const family = stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
      if (family.find(item => item.hwnd === handles.target)?.parent !== attached.panel.hwnd) throw new Error('Native parent binding mismatch')
      await page.screenshot({ path: join(output, 'native-fixture.png') })
      await page.getByRole('button', { name: /^(恢复独立窗口|Restore window)$/ }).click()
      await page.waitForFunction(() => document.querySelector('pre')?.textContent.includes('"ok": true'))
      const restored = JSON.parse(await page.locator('pre').innerText())
      await writeFile(join(output, 'native-receipts.json'), JSON.stringify({ handles, attached, another, restored }, null, 2) + '\n', 'utf8')
      console.log(JSON.stringify({ stage: 'native-fixture-accepted', attached: attached.active, restored: restored.restoration?.ok }))
    } finally {
      fixture.stdin.end('quit\n')
      await new Promise(resolve => fixture.once('exit', resolve))
    }
  }
  if (process.argv.includes('--host')) {
    let state
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      state = await rpc('yoyoking.status')
      if (state.douyin.service_state === 'running') break
      await page.waitForTimeout(1000)
    }
    await writeFile(join(output, 'douyin-service.json'), JSON.stringify(state.douyin, null, 2) + '\n', 'utf8')
    if (state.douyin.service_state !== 'running') throw new Error('Managed Douyin SDK did not become ready')
    const endpoint = new URL(state.douyin.endpoint)
    const metadata = await fetch(`${endpoint.origin}/.well-known/oauth-authorization-server`).then(response => response.json())
    await writeFile(join(output, 'douyin-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify({ stage: 'douyin-service-accepted', state: state.douyin.state, service: state.douyin.service_state }))
  }
  if (process.argv.includes('--edit')) {
    const mediaRoot = join(output, 'media'), source = join(mediaRoot, 'sample.mp4')
    await mkdir(mediaRoot, { recursive: true })
    await promisify(execFile)('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { windowsHide: true })
    const originalHash = createHash('sha256').update(await readFile(source)).digest('hex')
    const jy = join(process.env.LOCALAPPDATA, 'JianyingPro/Apps/11.6.0.14552')
    await page.locator('summary').filter({ hasText: /设置|Settings/ }).click()
    await page.locator('#yoyoking-roots').fill(mediaRoot)
    await page.locator('#yoyoking-jianyingRuntime').fill(jy)
    await page.locator('#yoyoking-jianyingExecutable').fill(join(jy, 'JianyingPro.exe'))
    await page.getByRole('button', { name: /^(保存|Save)$/ }).click()
    await page.getByRole('button', { name: /准备剪辑环境|Prepare editing/ }).click()
    await page.waitForFunction(async () => {
      const result = await window.api.ipcApi.request('yoyoking.status')
      return result.ok && result.data.toolNames.length > 0
    }, { timeout: 120000 })
    const ready = await rpc('yoyoking.setup')
    const installation = await page.evaluate(() => window.api.preference.get('feature.yoyoking.installation'))
    await rpc('mcp.server.refresh_tools', { serverId: installation.hostServerId })
    const hostCatalog = await page.evaluate(async id => (await window.api.cache.getAllShared())[`mcp.tools.${id}`], installation.hostServerId)
    const hostToolNames = (hostCatalog?.value ?? []).map(tool => tool.name)
    if (!hostToolNames.some(name => name.includes('yoyoking_current_project')) || hostToolNames.length !== 5) throw new Error(`Host MCP discovery failed: ${JSON.stringify(hostCatalog)}`)
    console.log(JSON.stringify({ stage: 'editing-ready', count: ready.toolNames.length, skills: ready.skillNames, agentId: ready.agentId }))
    await call('get_capabilities', { check_native: true })
    const project = await call('create_project', { name: 'Cherry integration synthetic acceptance', width: 320, height: 180, fps: 30 })
    const track = await call('add_track', { project_id: project.project_id, kind: 'video', name: 'Video', expected_revision: project.revision })
    const clip = await call('add_video_clip', { project_id: project.project_id, track_id: track.track_id, path: source, source_duration: 3, expected_revision: track.revision })
    const conflict = await call('add_track', { project_id: project.project_id, kind: 'audio', name: 'Stale revision', expected_revision: 0 }, true)
    if (conflict.ok !== false || conflict.error?.code !== 'REVISION_CONFLICT') throw new Error('Revision protection failed')
    const audioTrack = await call('add_track', { project_id: project.project_id, kind: 'audio', name: 'Audio', expected_revision: clip.revision })
    const audio = await call('add_audio_clip', { project_id: project.project_id, track_id: audioTrack.track_id, path: source, source_duration: 3, expected_revision: audioTrack.revision })
    const snapshot = await call('save_draft', { project_id: project.project_id, expected_revision: audio.revision })
    const job = await call('export_video', { draft_id: snapshot.draft_id, timeout: 120 })
    let terminal
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      terminal = await call('get_job', { job_id: job.job_id })
      if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(terminal.status)) break
      await page.waitForTimeout(1000)
    }
    if (terminal?.status !== 'succeeded') throw new Error(`Export did not succeed: ${JSON.stringify(terminal)}`)
    const validated = await call('validate_output', { job_id: job.job_id })
    if (!validated.passed || !validated.decoded) throw new Error('Output validation failed')
    if (createHash('sha256').update(await readFile(source)).digest('hex') !== originalHash) throw new Error('Synthetic source changed')
    const rendered = join(ready.workspace, 'jobs', job.job_id, 'output.mp4')
    await page.getByRole('tab', { name: /视频预览|Video preview/ }).click()
    await page.locator('summary').filter({ hasText: /设置|Settings/ }).click()
    await page.locator('#yoyoking-video-path').fill(rendered)
    await page.getByRole('button', { name: /^(打开|Open)$/ }).click()
    await page.locator('video').waitFor()
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2)
    const video = page.locator('video')
    await video.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(output, 'preview-before-play.png') })
    const box = await video.boundingBox()
    await page.mouse.click(box.x + 25, box.y + box.height - 48)
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0.1)
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height - 22)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.65, box.y + box.height - 22, { steps: 8 })
    await page.mouse.up()
    await page.screenshot({ path: join(output, 'export-preview.png') })
    const playback = await video.evaluate(element => ({ currentTime: element.currentTime, duration: element.duration, paused: element.paused, width: element.videoWidth, height: element.videoHeight }))
    const agent = ready.agentId ? await page.evaluate(async id => window.api.dataApi.request({ id: 'acceptance-agent', method: 'GET', path: `/agents/${id}` }), ready.agentId) : null
    await writeFile(join(output, 'editing-receipts.json'), JSON.stringify({ ready, hostToolNames, receipts, validated, originalHash, playback, agent }, null, 2) + '\n', 'utf8')
    console.log(JSON.stringify({ stage: 'editing-accepted', project: project.project_id, draft: snapshot.draft_id, job: job.job_id, validated, playback, output }))
  }
  await writeFile(join(output, 'errors.json'), JSON.stringify(errors, null, 2) + '\n', 'utf8')
} finally {
  await writeFile(join(output, 'partial-receipts.json'), JSON.stringify({ receipts, errors }, null, 2) + '\n', 'utf8')
  if (!process.argv.includes('--keep-open')) await app.close()
}
