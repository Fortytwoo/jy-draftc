/** Read the saved draft held open by the attached process. Never guess from modification times. */
import { readFile, stat, readdir, realpath, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile), sha = data => createHash('sha256').update(data).digest('hex')
const fail = (code, message, details = {}) => { throw Object.assign(new Error(message), { code, details }) }
const within = (root, path) => { const child = relative(root, path); return child && child !== '..' && !child.startsWith('..' + sep) && !isAbsolute(child) }
async function bounded(path, limit = 64 * 1024 * 1024) {
  if ((await stat(path)).size > limit) fail('DRAFT_TOO_LARGE', 'Draft exceeds the read limit.')
  const data = await readFile(path)
  if (data.length > limit) fail('DRAFT_TOO_LARGE', 'Draft exceeds the read limit.')
  return data
}
async function checkedFile(directory, name) {
  const path = await realpath(join(directory, name))
  if (!within(directory, path)) fail('DRAFT_PATH_ESCAPE', 'A draft file resolves outside its project directory.')
  return path
}
export async function draftRoots(config) {
  if (config.draftRoots?.length) return [...new Set(await Promise.all(config.draftRoots.map(path => realpath(path))))]
  let custom
  try {
    const settings = (await bounded(join(config.userDataDirectory, 'Config', 'globalSetting'), 1024 * 1024)).toString('utf8')
    custom = /^currentCustomDraftPath=(.+)$/m.exec(settings)?.[1].trim().replaceAll('\\\\', '\\')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const path = custom || join(config.userDataDirectory, 'Projects', 'com.lveditor.draft')
  if (!isAbsolute(path)) fail('INVALID_DRAFT_ROOT', 'Draft root must be absolute.')
  return [await realpath(path)]
}

export function summarizeDraft(content, meta, args = {}) {
  if (!Array.isArray(content.tracks) || !content.materials || typeof content.materials !== 'object') fail('UNSUPPORTED_DRAFT', 'Expected native draft tracks and materials.')
  const limit = args.limit ?? 50, clipOffset = args.clip_offset ?? 0, materialOffset = args.material_offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 200 || ![clipOffset, materialOffset].every(value => Number.isInteger(value) && value >= 0)) fail('INVALID_PAGINATION', 'Use non-negative offsets and limit 1..200.')
  const materials = [], byId = new Map(), clips = [], tracks = []
  for (const group of ['videos', 'audios', 'images']) for (const item of content.materials[group] ?? []) {
    const material = { material_id: item.id ?? null, type: item.type ?? group, name: item.material_name || basename(item.path || ''),
      source_path: item.path || null, duration_us: item.duration ?? null, width: item.width ?? null, height: item.height ?? null }
    materials.push(material); byId.set(item.id, material)
  }
  for (const group of meta?.draft_materials ?? []) for (const item of group.value ?? []) {
    const source = item.file_Path || item.path
    if (!source) continue
    let material = materials.find(existing => existing.source_path && resolve(existing.source_path).toLowerCase() === resolve(source).toLowerCase())
    if (!material) {
      material = { material_id: null, type: item.metetype ?? null, name: item.extra_info || basename(source), source_path: source,
        duration_us: item.duration ?? null, width: item.width ?? null, height: item.height ?? null }
      materials.push(material)
    }
    material.bin_material_id = item.id ?? null; material.in_media_bin = true
  }
  for (const track of content.tracks) {
    tracks.push({ track_id: track.id ?? null, type: track.type ?? null, name: track.name ?? null, clip_count: track.segments?.length ?? 0 })
    for (const segment of track.segments ?? []) clips.push({ clip_id: segment.id ?? null, track_id: track.id ?? null, track_type: track.type ?? null,
      material_id: segment.material_id ?? null, source_path: byId.get(segment.material_id)?.source_path ?? null,
      timeline_start_us: segment.target_timerange?.start ?? 0, timeline_duration_us: segment.target_timerange?.duration ?? 0,
      source_in_us: segment.source_timerange?.start ?? 0, source_duration_us: segment.source_timerange?.duration ?? null,
      speed: segment.speed ?? null })
  }
  const referenced = new Set(clips.map(clip => clip.source_path).filter(Boolean))
  for (const material of materials) material.on_timeline = referenced.has(material.source_path)
  return { project: { draft_id: meta?.draft_id || content.id || null, content_id: content.id || null, name: meta?.draft_name || null,
    duration_us: content.duration ?? null, width: content.canvas_config?.width ?? null, height: content.canvas_config?.height ?? null,
    fps: content.fps ?? null, track_count: tracks.length, clip_count: clips.length, material_count: materials.length },
    time_unit: 'microseconds', tracks, clips: clips.slice(clipOffset, clipOffset + limit), materials: materials.slice(materialOffset, materialOffset + limit),
    next_clip_offset: clipOffset + limit < clips.length ? clipOffset + limit : null,
    next_material_offset: materialOffset + limit < materials.length ? materialOffset + limit : null }
}

export async function readCurrentProject(config, getBinding, native, args = {}, signal = new AbortController().signal) {
  signal.throwIfAborted()
  const binding = getBinding()
  if (!binding?.active || !binding.target || !binding.panel) fail('JIANYING_NOT_ATTACHED', 'Connect the Jianying sidebar before reading its current project.')
  const verify = async () => {
    signal.throwIfAborted()
    const latest = getBinding()
    if (!latest?.active || latest.target.hwnd !== binding.target.hwnd || latest.target.pid !== binding.target.pid || latest.panel.hwnd !== binding.panel.hwnd) fail('EDITOR_CHANGED', 'The attached editor changed; read again.')
    const windows = await native('family', String(binding.target.pid))
    if (!windows.some(window => window.hwnd === binding.target.hwnd && window.pid === binding.target.pid && window.parent === binding.panel.hwnd && resolve(window.path).toLowerCase() === resolve(binding.target.path).toLowerCase())) fail('EDITOR_CHANGED', 'The selected native editor no longer belongs to its sidebar panel.')
  }
  await verify()
  const candidates = []
  for (const root of await draftRoots(config)) {
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length > 3000) fail('DRAFT_SCAN_LIMIT', 'Draft root has too many entries; configure a narrower root.')
    for (const entry of entries) {
      signal.throwIfAborted()
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const directory = await realpath(join(root, entry.name))
      if (!within(root, directory)) continue
      let lock
      try { lock = await checkedFile(directory, '.locked') } catch (error) { if (error.code === 'ENOENT') continue; throw error }
      const users = await native('file-users', lock)
      const holder = users.find(process => process.pid === binding.target.pid && resolve(process.path).toLowerCase() === resolve(binding.target.path).toLowerCase())
      if (holder) candidates.push({ directory, lock, holder })
    }
  }
  if (!candidates.length) fail('NO_OPEN_DRAFT', 'No project lock is held by the attached editor. Open an existing draft in Jianying first.')
  if (candidates.length !== 1) fail('AMBIGUOUS_OPEN_DRAFT', 'The attached process holds multiple draft locks; current project cannot be uniquely identified.', { candidates: candidates.map(item => ({ name: basename(item.directory), draft_path: item.directory })) })
  const selected = candidates[0]
  let contentDirectory = selected.directory, timelineIndex, timelineIndexPath
  try {
    timelineIndexPath = await checkedFile(selected.directory, 'Timelines/project.json')
    timelineIndex = await bounded(timelineIndexPath, 1024 * 1024)
    const index = JSON.parse(timelineIndex.toString('utf8'))
    if ((index.timelines ?? []).filter(item => !item.is_marked_delete).length > 1) fail('AMBIGUOUS_TIMELINE', 'Multiple timelines cannot be uniquely identified by the current selector.')
    if (typeof index.main_timeline_id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(index.main_timeline_id)) fail('INVALID_TIMELINE_INDEX', 'Invalid main timeline ID.')
    contentDirectory = await realpath(join(selected.directory, 'Timelines', index.main_timeline_id))
    if (!within(selected.directory, contentDirectory)) fail('DRAFT_PATH_ESCAPE', 'Main timeline resolves outside its project.')
  } catch (error) { if (error.code !== 'ENOENT') throw error; if (timelineIndex) throw error }
  const contentPath = await checkedFile(contentDirectory, 'draft_content.json')
  const metaPath = await checkedFile(selected.directory, 'draft_meta_info.json')
  const original = await bounded(contentPath), metaOriginal = await bounded(metaPath, 16 * 1024 * 1024), sourceStat = await stat(contentPath)
  signal.throwIfAborted()
  await mkdir(config.snapshotDirectory, { recursive: true })
  const snapshot = await mkdtemp(join(config.snapshotDirectory, 'current-'))
  async function decode(data, name) {
    const output = join(snapshot, name)
    try {
      const value = JSON.parse(data.toString('utf8').replace(/^\uFEFF/, ''))
      await writeFile(output, data, { flag: 'wx' }); return value
    } catch (error) { if (!(error instanceof SyntaxError)) throw error }
    if (!config.draftConverter || !config.converterRuntime) fail('DRAFT_DECRYPTION_REQUIRED', 'This saved draft is encrypted; configure the local draft converter.')
    const input = join(snapshot, name + '.encrypted')
    await writeFile(input, data, { flag: 'wx' })
    await exec(config.draftConverter, ['--decrypt', input, '-o', output, '--jy-dir', config.converterRuntime, '-q'], { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024, signal })
    return JSON.parse((await bounded(output)).toString('utf8').replace(/^\uFEFF/, ''))
  }
  const content = await decode(original, 'draft_content.json'), meta = await decode(metaOriginal, 'draft_meta_info.json')
  // Recheck the lock, binding and exact saved bytes after decryption; an autosave cannot silently mix versions.
  const holders = await native('file-users', selected.lock)
  if (!holders.some(item => item.pid === selected.holder.pid && item.processStartFileTime === selected.holder.processStartFileTime)) fail('EDITOR_CHANGED', 'The project lock owner changed while reading.')
  await verify()
  if (sha(original) !== sha(await bounded(contentPath)) || sha(metaOriginal) !== sha(await bounded(metaPath, 16 * 1024 * 1024))) fail('DRAFT_CHANGED_RETRY', 'Jianying saved a new version during the read; retry.')
  if (timelineIndex && sha(timelineIndex) !== sha(await bounded(timelineIndexPath, 1024 * 1024))) fail('DRAFT_CHANGED_RETRY', 'Main timeline changed during reading; retry.')
  const result = summarizeDraft(content, meta, args)
  result.project.name ||= basename(selected.directory)
  for (const material of result.materials) material.source_exists = material.source_path ? await stat(material.source_path).then(value => value.isFile(), () => false) : false
  return { ok: true, ...result, native_ref: 'local://' + basename(selected.directory), draft_path: selected.directory, native_content_path: contentPath,
    timeline_source: timelineIndex ? 'main_timeline' : 'root_draft', plain_content_path: join(snapshot, 'draft_content.json'), snapshot_path: snapshot,
    evidence: { method: 'attached_pid_holds_project_lock', pid: binding.target.pid, editor_hwnd: binding.target.hwnd,
      process_start_filetime: selected.holder.processStartFileTime, content_sha256: sha(original), saved_at: sourceStat.mtime.toISOString(), read_at: new Date().toISOString() },
    state_source: 'last_saved_disk_snapshot', unsaved_changes: 'unknown',
    guidance: 'This is the user-opened native draft, not a service project_id. Use native_ref with MCP get_native_draft/split_native_clip for native copy-on-write splitting; never pass draft_id to service get_project/split_clip. Paths are actual source paths; existing MCP media-root rules still apply. Unsaved in-memory edits, selection and playhead position are not observed.' }
}
