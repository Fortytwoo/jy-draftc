/** Authenticated, range-capable local video previews for the Harness connection. */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open, realpath, mkdir } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve, sep, basename } from 'node:path'
import { Readable } from 'node:stream'
import { promisify } from 'node:util'
import { defineTool } from '@deepseek-ai/dsh-tools'

const exec = promisify(execFile)
const routes = new WeakMap()
const mediaTypes = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.ts': 'video/mp2t' }

/** Probe a permitted video for either an automatic reply card or the explicit preview tool. */
async function describeVideo(args, roots, route, ffprobe, signal) {
  signal.throwIfAborted()
  const source = await resolveVideo(args.path, roots)
  const { stdout } = await exec(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', source], { signal, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' })
  const info = JSON.parse(stdout)
  const video = info.streams?.find(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)
  if (!video) throw new Error('Source has no video stream')
  const duration = Number(info.format?.duration ?? video.duration)
  const start = args.start ?? 0
  if (!Number.isFinite(start) || start < 0 || (Number.isFinite(duration) && duration > 0 && start >= duration)) throw new Error('Preview start must be before the end of the video')
  return {
    kind: 'yoyoking.video', version: 1, title: (args.title?.trim() || basename(source)).slice(0, 240),
    path: source, src: `${route.slice(1)}?path=${encodeURIComponent(source)}`, start,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    width: Number.isFinite(video.width) ? video.width : null, height: Number.isFinite(video.height) ? video.height : null,
    codec: video.codec_name ?? 'unknown', hasAudio: info.streams.some(stream => stream.codec_type === 'audio'),
  }
}

/** Resolve each read against real directories; symlinks cannot escape configured roots. */
export async function resolveVideo(path, roots) {
  if (typeof path !== 'string' || !path.trim() || path.length > 32768 || path.includes('\0')) throw new Error('Invalid video path')
  const target = await realpath(isAbsolute(path) ? path : resolve(roots[0], path))
  const allowed = await Promise.all(roots.map(root => realpath(root).catch(error => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
    throw error
  })))
  if (!allowed.some(root => {
    if (root === null) return false
    const child = relative(root, target)
    return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  })) throw new Error('Video is outside configured media roots and workspace')
  if (!mediaTypes[extname(target).toLowerCase()]) throw new Error('Unsupported video extension')
  return target
}

/** Return one byte range, null for a full response, or false for an unsatisfiable range. */
export function byteRange(header, size) {
  if (header === null) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!match || (!match[1] && !match[2]) || size === 0) return false
  const first = match[1] ? Number(match[1]) : undefined
  const last = match[2] ? Number(match[2]) : undefined
  if ([first, last].some(value => value !== undefined && !Number.isSafeInteger(value))) return false
  if (first === undefined) return last > 0 ? [Math.max(0, size - last), size - 1] : false
  if (first >= size || (last !== undefined && last < first)) return false
  return [first, Math.min(size - 1, last ?? size - 1)]
}

/** Stream allowed files without buffering the video; disconnects close the descriptor. */
export function createVideoHandler(roots) {
  return async request => {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
    let file
    try {
      const path = await resolveVideo(new URL(request.url).searchParams.get('path'), roots)
      file = await open(path, 'r')
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('Not a video file')
      const headers = {
        'Content-Type': mediaTypes[extname(path).toLowerCase()], 'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/'/g, '%27')}`,
      }
      const range = byteRange(request.headers.get('range'), stat.size)
      if (range === false) {
        await file.close()
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${stat.size}` } })
      }
      const [start, end] = range ?? [0, stat.size - 1]
      headers['Content-Length'] = String(range ? end - start + 1 : stat.size)
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`
      if (request.method === 'HEAD' || stat.size === 0) {
        await file.close()
        return new Response(null, { status: range ? 206 : 200, headers })
      }
      const stream = file.createReadStream({ start, end, autoClose: true, signal: request.signal })
      return new Response(Readable.toWeb(stream), { status: range ? 206 : 200, headers })
    } catch (error) {
      await file?.close().catch(() => {})
      if (request.signal.aborted) throw error
      return new Response('Video unavailable; check the source path and allowed media roots.', { status: 404, headers: { 'Cache-Control': 'no-store' } })
    }
  }
}

/** Share a stable route across session mounts until its final owner unloads. */
export function registerVideoPreview(ctx, launch, { registerTool = true } = {}) {
  return ctx.inject(['connection', 'tools'], async scope => {
    const roots = [...JSON.parse(launch.env.JY_EDIT_MEDIA_ROOTS), launch.env.JY_EDIT_WORKSPACE]
    await mkdir(launch.env.JY_EDIT_WORKSPACE, { recursive: true })
    const key = createHash('sha256').update(JSON.stringify([launch.serverName, roots])).digest('hex').slice(0, 24)
    const path = `/api/yoyoking.video.${key}`
    let state = routes.get(scope.root)
    if (!state) {
      const entries = new Map()
      const dispose = scope.root.get('connection').fetch.register({
        path: '/api/yoyoking.video.info', methods: ['GET'], requestBody: 'buffered',
        async fetch(request) {
          const candidate = new URL(request.url).searchParams.get('path')
          for (const [route, entry] of entries) {
            // Only active configurations may authorize a reply's source path.
            try { await resolveVideo(candidate, entry.roots) } catch { continue }
            for (const ffprobe of entry.ffprobes.keys()) {
              try {
                return Response.json(await describeVideo({ path: candidate }, entry.roots, route, ffprobe, request.signal), { headers: { 'Cache-Control': 'private, no-store' } })
              } catch (error) {
                if (request.signal.aborted) throw error
              }
            }
          }
          return Response.json({ error: 'VIDEO_UNAVAILABLE' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
        },
      })
      routes.set(scope.root, state = { entries, dispose })
    }
    const table = state.entries
    let shared = table.get(path)
    if (!shared) {
      // Root ownership keeps the route alive when the first of several sessions closes.
      const connection = scope.root.get('connection')
      const dispose = connection.fetch.register({ path, methods: ['GET', 'HEAD'], requestBody: 'buffered', fetch: createVideoHandler(roots) })
      table.set(path, shared = { count: 0, dispose, roots, ffprobes: new Map() })
    }
    const ffprobe = launch.env.JY_EDIT_FFPROBE
    shared.ffprobes.set(ffprobe, (shared.ffprobes.get(ffprobe) ?? 0) + 1)
    shared.count++
    scope.effect(() => async () => {
      const remaining = shared.ffprobes.get(ffprobe) - 1
      if (remaining) shared.ffprobes.set(ffprobe, remaining)
      else shared.ffprobes.delete(ffprobe)
      if (--shared.count === 0) {
        table.delete(path); await shared.dispose()
        if (table.size === 0) { routes.delete(scope.root); await state.dispose() }
      }
    })
    if (registerTool) scope.effect(() => scope.tools.register(defineTool({
      name: 'yoyoking_preview_video',
      description: '在 Harness 聊天页面显示本地视频播放器，供用户播放素材或已完成的导出。支持暂停、拖动进度、音量和全屏。path 为允许素材目录或 workspace 内的视频路径；相对路径从第一个素材目录解析。只读，不导出、不转码，也不代表模型已看过视频。',
      parameters: {
        path: { type: 'string', required: true }, title: { type: 'string' },
        start: { type: 'number', description: 'Non-negative initial source time in seconds, before the end of the video.' },
      },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, execution) {
        return describeVideo(args, roots, path, launch.env.JY_EDIT_FFPROBE, execution.signal)
      },
      presentCall: args => ({ card: 'generic', title: args.title || '视频预览' }),
    })))
  })
}
