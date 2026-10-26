/** Browser module using the Harness-owned React runtime, without a separate build step. */
window.__ModuleLoader__.load({ id: '@local/dsh-yoyoking', factory: require => {
  const { createElement: h, useState, useEffect, useRef } = require('react')
  const copy = {
    zh: { preparing: '正在准备视频…', failed: '视频预览失败，请检查素材路径后重试。', invalid: '视频预览数据不可用，请重新预览素材。', unavailable: '无法播放此视频。请检查文件是否仍在原路径；若浏览器不支持该编码，可导出 H.264 / AAC MP4 后重试。', retry: '重新加载', muted: '无音轨', preview: '视频快速预览', show: '展开视频预览', hide: '收起视频预览' },
    en: { preparing: 'Preparing video…', failed: 'Video preview failed. Check the source path and try again.', invalid: 'Video preview data is unavailable. Preview the source again.', unavailable: 'Unable to play this video. Check that the file still exists; if the codec is unsupported, export H.264 / AAC MP4 and try again.', retry: 'Reload video', muted: 'No audio track', preview: 'Video preview', show: 'Expand video preview', hide: 'Collapse video preview' },
  }
  const douyinCopy = {
    zh: { title: '抖音账号', login: '登录抖音', logout: '退出连接', open: '打开官方登录', retry: '重新连接', loading: '正在检查登录服务…', starting: '正在自动启动抖音服务…', ready: '未登录', connected: '已登录 · 当前 Harness 共享', pending: '请打开官方登录并扫码确认', connecting: '正在完成授权…', failed: '服务暂不可用，可点击重新连接', error: '操作失败，请稍后重试。', unavailable: '当前 Host 未启用抖音服务', note: '无需填写 Cookie、端口或其他参数。关闭 Harness 后清除本次登录。' },
    en: { title: 'Douyin account', login: 'Sign in to Douyin', logout: 'Disconnect', open: 'Open official login', retry: 'Reconnect', loading: 'Checking login service…', starting: 'Starting the managed service…', ready: 'Not signed in', connected: 'Signed in · shared in this Harness', pending: 'Open official login and confirm on your phone', connecting: 'Completing authorization…', failed: 'Service unavailable; reconnect to retry', error: 'The action failed. Please retry.', unavailable: 'Douyin is not enabled in this Host', note: 'No cookies, ports or manual parameters. Closing Harness clears this login.' },
  }
  const styles = `.yoyoking-video{min-width:0;max-width:100%;padding:14px;border:1px solid var(--dsw-alias-border-l3,#d9dee5);border-radius:12px;color:var(--dsw-alias-label-primary,#25323e);background:var(--dsw-alias-settings-card-fill,#fff);font-size:13px;line-height:1.6;overflow-wrap:anywhere}.yoyoking-video h3{margin:0 0 10px;font-size:15px;font-weight:500}.yoyoking-video video{display:block;width:100%;max-height:min(45vh,260px);background:#111;border-radius:8px}.yoyoking-video p{margin:8px 0 0}.yoyoking-video .meta{color:var(--dsw-alias-label-secondary,#607080);font-size:12px}.yoyoking-video button{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l3,#d9dee5);border-radius:6px;padding:6px 12px;margin-top:8px;cursor:pointer}.yoyoking-reply-videos{display:flex;flex-direction:column;gap:16px;margin:16px 0;min-width:0;max-width:100%}.yoyoking-video-inline{padding:0;overflow:hidden}.yoyoking-video-inline>div{padding:0 14px 14px}.yoyoking-video-inline>h3,.yoyoking-video-inline>p{margin:14px}.yoyoking-video-inline video{max-height:min(60vh,560px)}.yoyoking-video .yoyoking-video-toggle{display:block;width:100%;margin:0 0 14px;border:0;border-bottom:1px solid var(--dsw-alias-border-l3,#d9dee5);border-radius:0;padding:14px;text-align:left;font-weight:500;background:var(--dsw-alias-settings-card-fill,#fff)}.yoyoking-video button:focus-visible{outline:2px solid #356d8c;outline-offset:2px}`

  /** Reject remote URLs and malformed replay payloads before creating a media element. */
  function readVideo(block) {
    try {
      const content = block.content
      if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== 'text' || content[0].text.length > 65536) return null
      const v = JSON.parse(content[0].text)
      if (v.kind !== 'yoyoking.video' || v.version !== 1 || typeof v.title !== 'string' || typeof v.path !== 'string'
        || typeof v.src !== 'string' || !/^api\/yoyoking\.video\.[a-f0-9]{24}\?path=[^#&]+$/.test(v.src)
        || decodeURIComponent(v.src.split('?path=')[1]) !== v.path || v.title.length > 240
        || typeof v.codec !== 'string' || typeof v.hasAudio !== 'boolean'
        || ![v.width, v.height].every(n => n === null || (Number.isSafeInteger(n) && n > 0))
        || !Number.isFinite(v.start) || v.start < 0 || (v.duration !== null && (!Number.isFinite(v.duration) || v.duration <= v.start))) return null
      return v
    } catch { return null }
  }

  /** Read only authored local paths, without guessing paths from prose or remote URLs. */
  function replyVideoPaths(text) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) return []
    const result = [], seen = new Set()
    const add = value => {
      const path = value.trim()
      if (!/^(?:[A-Za-z]:[\\/]|\/(?!\/))[^\r\n\0]+\.(?:mp4|m4v|mov|webm|ogv|mkv|avi|mpg|mpeg)$/i.test(path)) return
      const key = /^[A-Za-z]:/.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path
      if (!seen.has(key) && result.length < 3) { result.push(path); seen.add(key) }
    }
    for (const match of text.matchAll(/(?:^|[^`])`([^`\r\n]+)`(?!`)/g)) add(match[1])
    for (const match of text.matchAll(/\[[^\]\r\n]*\]\((?:<([^>\r\n]+)>|([^\)\r\n]+))\)/g)) {
      try { add(decodeURIComponent(match[1] ?? match[2])) } catch { /* An invalid escape cannot identify a file. */ }
    }
    for (const line of text.split('\n')) add(line)
    return result
  }

  function Player({ video, t, inline = false }) {
    const [failed, setFailed] = useState(false)
    const [attempt, setAttempt] = useState(0)
    const [expanded, setExpanded] = useState(true)
    const element = useRef(null)
    return h('section', { className: `yoyoking-video${inline ? ' yoyoking-video-inline' : ''}`, 'aria-label': inline ? `${t('preview')} · ${video.title}` : video.title },
      inline ? h('button', { className: 'yoyoking-video-toggle', type: 'button', 'aria-expanded': expanded, 'aria-label': t(expanded ? 'hide' : 'show'), onClick: () => { if (expanded) element.current?.pause(); setExpanded(!expanded) } }, `${expanded ? '⌃' : '⌄'}  ${t('preview')} · ${video.title}`) : h('h3', null, video.title),
      h('div', { hidden: !expanded },
      h('video', { key: attempt, ref: element, controls: true, playsInline: true, preload: 'metadata', 'aria-label': video.title,
        src: `${video.src}${attempt ? `&reload=${attempt}` : ''}#t=${video.start}`, onError: () => setFailed(true), onLoadedMetadata: () => setFailed(false) }),
      failed && h('div', { role: 'alert' }, h('p', null, t('unavailable')), h('button', { type: 'button', onClick: () => { setFailed(false); setAttempt(attempt + 1) } }, t('retry'))),
      h('p', { className: 'meta' }, [video.width && video.height ? `${video.width} × ${video.height}` : null, video.duration === null ? null : `${video.duration.toFixed(2)} s`, video.codec, !video.hasAudio ? t('muted') : null].filter(Boolean).join(' · ')),
      h('p', { className: 'meta' }, video.path)))
  }

  /** Browser metadata lookup is read-only and never invokes an Agent or a Tool. */
  function ReplyVideo({ path, t }) {
    const [state, setState] = useState({ path, loading: true })
    const [attempt, setAttempt] = useState(0)
    useEffect(() => {
      const controller = new AbortController()
      setState({ path, loading: true })
      fetch(`api/yoyoking.video.info?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', signal: controller.signal })
        .then(async response => {
          if (!response.ok) throw new Error('Video unavailable')
          const video = readVideo({ content: [{ type: 'text', text: JSON.stringify(await response.json()) }] })
          if (!video) throw new Error('Invalid video metadata')
          if (!controller.signal.aborted) setState({ path, video })
        }).catch(() => { if (!controller.signal.aborted) setState({ path, failed: true }) })
      return () => controller.abort()
    }, [path, attempt])
    if (state.path === path && state.video) return h(Player, { key: path, video: state.video, t, inline: true })
    return h('section', { className: 'yoyoking-video yoyoking-video-inline', 'aria-label': t('preview') },
      h('h3', null, t('preview')), h('p', { className: 'meta' }, path),
      state.path !== path || state.loading ? h('p', { role: 'status' }, t('preparing')) : h('div', { role: 'alert' },
        h('p', null, t('unavailable')), h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, t('retry'))))
  }

  /** Completed replies get previews automatically, outside collapsed Tool process groups. */
  function ReplyVideos({ turn, seq, t }) {
    const closing = turn?.data?.get('turn-tail')?.closing
    if (turn?.status !== 'closed' || !closing || closing.finalNode?.seq !== seq) return null
    const text = closing.blocks.filter(block => block.kind === 'text').map(block => block.text).join('\n')
    const paths = replyVideoPaths(text)
    if (!paths.length) return null
    return h('div', { className: 'yoyoking-reply-videos' }, paths.map(path => h(ReplyVideo, { key: path, path, t })))
  }

  /** Render recorded tool content; replay performs no tool or model calls. */
  function VideoCard(props) {
    if (props.phase !== 'result') return h('div', { className: 'yoyoking-video', role: 'status' }, props.t('preparing'))
    if (props.block.isError) return h('div', { className: 'yoyoking-video', role: 'alert' }, props.t('failed'))
    const video = readVideo(props.block)
    if (!video) return h('div', { className: 'yoyoking-video', role: 'alert' }, props.t('invalid'))
    return h(Player, { key: video.src + video.start, video, t: props.t })
  }

  function readDouyinAccount(value) {
    if (!value || !/^[a-f0-9]{20}$/.test(value.id) || typeof value.state !== 'string' || typeof value.service_state !== 'string') return null
    let authorizationUrl
    try {
      if (value.authorization_url) {
        const url = new URL(value.authorization_url)
        const endpoint = new URL(value.endpoint)
        if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.origin === endpoint.origin && url.pathname === '/authorize' && !url.username && !url.password && !url.hash) authorizationUrl = url.href
      }
    } catch {}
    return { id: value.id, state: value.state, service_state: value.service_state, authorizationUrl }
  }

  function DouyinAccount({ t, wide = true }) {
    const [accounts, setAccounts] = useState(null)
    const [busy, setBusy] = useState(false)
    const [failed, setFailed] = useState(false)
    const active = useRef(true)
    useEffect(() => {
      active.current = true
      const controller = new AbortController()
      let timer
      const load = async () => {
        clearTimeout(timer)
        try {
          const response = await fetch('api/yoyoking.douyin', { credentials: 'same-origin', signal: controller.signal })
          if (!response.ok) throw new Error('Unavailable')
          const data = await response.json()
          if (active.current) { setAccounts((Array.isArray(data.accounts) ? data.accounts : []).map(readDouyinAccount).filter(Boolean)); setFailed(false) }
        } catch { if (active.current) setFailed(true) }
        if (active.current) timer = setTimeout(load, 2000)
      }
      void load()
      window.addEventListener('focus', load)
      return () => { active.current = false; controller.abort(); clearTimeout(timer); window.removeEventListener('focus', load) }
    }, [])
    const act = async (id, action) => {
      setBusy(true); setFailed(false)
      try {
        const response = await fetch('api/yoyoking.douyin', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-yoyoking-action': '1' }, body: JSON.stringify({ id, action }) })
        if (!response.ok) throw new Error('Action failed')
        const updated = readDouyinAccount(await response.json())
        if (!updated) throw new Error('Invalid account state')
        if (active.current) setAccounts(previous => previous.map(account => account.id === id ? updated : account))
      } catch { if (active.current) setFailed(true) }
      finally { if (active.current) setBusy(false) }
    }
    const content = h('div', { className: 'yoyoking-douyin-panel' },
      !accounts && h('p', { role: 'status' }, t('loading')),
      accounts?.length === 0 && h('p', null, t('unavailable')),
      accounts?.map(account => {
        const connected = account.state === 'connected'
        const pending = account.state === 'awaiting_authorization'
        const starting = account.service_state === 'starting'
        const unavailable = account.service_state === 'failed' || account.state === 'unavailable'
        const text = starting ? 'starting' : unavailable ? 'failed' : connected ? 'connected' : pending ? 'pending' : account.state === 'connecting' ? 'connecting' : 'ready'
        return h('div', { key: account.id }, h('p', { role: 'status' }, t(text)),
          !connected && !pending && h('button', { type: 'button', disabled: busy || starting || account.state === 'connecting', onClick: () => act(account.id, 'login') }, t(unavailable ? 'retry' : 'login')),
          pending && account.authorizationUrl && h('a', { href: account.authorizationUrl, target: '_blank', rel: 'noopener noreferrer' }, t('open')),
          (connected || pending) && h('button', { type: 'button', disabled: busy, onClick: () => act(account.id, 'logout') }, t('logout')))
      }),
      failed && h('p', { role: 'alert' }, t('error')), h('small', null, t('note')))
    return h('details', { className: `yoyoking-douyin${wide ? '' : ' narrow'}` }, h('summary', { title: t('title'), 'aria-label': t('title') }, wide ? t('title') : '抖'), content)
  }

  return {
    inject: ['slots', 'locale'],
    replyVideoPaths,
    readDouyinAccount,
    apply(ctx) {
      ctx.effect(() => ctx.locale.register('yoyoking.video', copy))
      ctx.effect(() => ctx.locale.register('yoyoking.douyin', douyinCopy))
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = '@local/dsh-yoyoking'; style.textContent = styles + '.yoyoking-douyin{position:relative;color:var(--dsw-alias-label-primary,#25323e);font-size:13px;padding:8px;min-width:0}.yoyoking-douyin summary{cursor:pointer;font-weight:500}.yoyoking-douyin-panel{padding-top:8px;max-width:100%;overflow-wrap:anywhere}.yoyoking-douyin.narrow .yoyoking-douyin-panel{position:absolute;bottom:0;left:48px;width:260px;max-width:calc(100vw - 80px);padding:14px;background:var(--dsw-alias-settings-card-fill,#fff);border:1px solid var(--dsw-alias-border-l3,#d9dee5);border-radius:8px;z-index:30}.yoyoking-douyin button,.yoyoking-douyin a{display:inline-block;margin:4px 8px 8px 0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l3,#d9dee5);border-radius:6px;background:transparent;color:inherit;font:inherit;text-decoration:none;cursor:pointer}.yoyoking-douyin button:disabled{opacity:.5;cursor:wait}.yoyoking-douyin p{margin:4px 0 8px}.yoyoking-douyin small{color:var(--dsw-alias-label-secondary,#607080)}'; document.head.append(style)
        return () => style.remove()
      })
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({ name: 'sidebar.footer.action', id: 'yoyoking-douyin-account', order: 60, locale: 'yoyoking.douyin' }, DouyinAccount))
      ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: 'yoyoking_preview_video', locale: 'yoyoking.video' }, VideoCard))
      ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'yoyoking-video-previews', order: 20, locale: 'yoyoking.video' }, ReplyVideos))
    },
  }
} })
