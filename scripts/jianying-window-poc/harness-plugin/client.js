/** A native Jianying viewport contributed to the existing right-sidebar tab system. */
window.__ModuleLoader__.load({ id: '@local/dsh-jianying-window-poc', factory: require => {
  const { createElement: h, useState, useEffect, useRef, Component } = require('react')
  const id = '@local/dsh-jianying-window-poc', namespace = 'jianyingSidebar'
  const version = '0.4.1'
  let runtimeReady
  const zh = {
    title: '剪映', description: '在右侧操作真实剪映，观察 Agent 的修改', launch: '启动剪映', connect: '重新接入', refresh: '刷新窗口', disconnect: '恢复为独立窗口', checkpoint: '记录检查点', choose: '选择剪映窗口',
    route_ready: '正在检查剪映窗口…', not_running: '剪映未运行或主窗口已关闭。点击“启动剪映”，也可以自行打开剪映，工作区会重新识别。',
    starting: '正在启动剪映，等待主窗口…', available: '发现剪映窗口，准备接入…', attached: '已接入真实剪映，可在此操作。', paused: '页签已隐藏，剪映暂停显示。',
    restored: '剪映已恢复为独立窗口。点击“重新接入”继续。', choose_window: '检测到多个剪映窗口，请选择要接入的窗口。', selection_expired: '所选窗口已关闭，请刷新后重新选择。',
    another_tab_active: '剪映正在其他页签中使用，请先在该页签恢复为独立窗口。', native_exited: '窗口连接已中断，正在重新检测。',
    invalid_bounds: '请拉宽或展开右侧栏后重试。', harness_window_unavailable: '未找到唯一的 DeepSeek Harness 主窗口。', editor_closed_during_attach: '剪映窗口已变化，正在重新检测。',
    attach_timeout: '接入超时，请刷新窗口重试。', restore_timeout: '窗口恢复尚未完成，请稍后重试。', restore_failed: '窗口恢复失败，请保留当前应用以便排查。',
    launch_failed: '剪映启动失败，请手动打开后重试。', saved: '检查点已记录。请在对话中说明操作结果。', error: '连接失败，请刷新窗口重试。',
    waiting: '剪映将在此处显示。关闭页签会恢复独立窗口；切换页签会暂停显示。', loading: '处理中…', pid: '进程', window: '窗口', narrow: '请展开或拉宽右侧栏。',
    checking: '正在连接剪映工作区服务…', detecting: '正在扫描当前剪映窗口…', attaching: '发现窗口，正在接入工作区…', locating_host: '正在定位 Harness 窗口…',
    elapsed: '已等待', seconds: '秒', retry: '重试', request_timeout: '工作区服务响应超时，请重试。', launch_timeout: '启动已超过 30 秒，尚未发现剪映主窗口。可以重试或手动启动。',
    runtime_mismatch: '插件界面已更新，后台仍是旧版本。请使用“应用 → 退出”完全退出 DeepSeek Harness 后重开；仅关闭窗口不会退出后台。',
    render_failed: '剪映页签加载失败，请重试。', preparing_view: '剪映页签正在准备界面…', failed_detail: '错误详情', ready_time: '接入用时',
    switching_window: '检测到窗口变化，正在切换到当前剪映窗口…', resuming: '正在恢复剪映画面…', waiting_for_window: '当前窗口已隐藏，正在检测剪映的新窗口…',
    windows_hidden: '剪映仍在运行，但主窗口已隐藏。点击“启动剪映”恢复上次窗口，或在列表中选择。', window_restore_failed: '未能恢复隐藏窗口，请从剪映托盘打开后重试。',
    focus: '聚焦剪映', focus_denied: '未能将键盘交给剪映，请点击剪映时间线后重试。', focus_timeout: '键盘焦点交接超时，请点击剪映时间线后重试。',
    keyboard_jianying: '键盘：剪映', keyboard_harness: '键盘：Harness', keyboard_other: '键盘：其他应用', keyboard_unknown: '键盘：等待点击剪映',
    inspect_project: '读取项目', project_snapshot: '最近保存快照',
    NO_OPEN_DRAFT: '未找到当前工程锁，请先在剪映内打开工程。', AMBIGUOUS_OPEN_DRAFT: '剪映进程打开了多个工程，暂时无法唯一确认当前项目。',
    EDITOR_CHANGED: '剪映窗口或工程已变化，请重新读取。', DRAFT_CHANGED_RETRY: '剪映正在自动保存，请重新读取项目。',
    current_project_not_configured: '当前项目读取服务尚未配置。', JIANYING_NOT_ATTACHED: '请先接入剪映，再读取当前项目。',
  }
  async function call(input) {
    // Validate through GET before allowing a new UI to mutate an old Host.
    if (!runtimeReady) runtimeReady = (async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
      try {
        const response = await fetch('api/jianying-window-poc', { method: 'GET', credentials: 'same-origin', signal: controller.signal })
        if (!response.ok || (await response.json()).version !== version) throw new Error('runtime_mismatch')
      } catch (error) { throw new Error(controller.signal.aborted ? 'request_timeout' : error.message) }
      finally { clearTimeout(timer) }
    })()
    await runtimeReady
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10000)
    try {
      const response = await fetch('api/jianying-window-poc', { method: 'POST', credentials: 'same-origin', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
      const value = await response.json()
      if (response.ok && value.version !== version) throw new Error('runtime_mismatch')
      if (!response.ok) throw new Error(value.error)
      return value
    } catch (error) { throw new Error(controller.signal.aborted ? 'request_timeout' : error.message) }
    finally { clearTimeout(timer) }
  }
  class ViewBoundary extends Component {
    constructor(props) { super(props); this.state = { error: null, attempt: 0 } }
    static getDerivedStateFromError(error) { return { error } }
    componentDidCatch(error) { void call({ action: 'client-ready', title: `render_failed: ${error.message}` }).catch(failure => console.warn('Jianying diagnostic unavailable', failure)) }
    render() {
      if (!this.state.error) return h(Workspace, { ...this.props, key: this.state.attempt })
      return h('div', { className: 'jyh-failure', role: 'alert' }, h('p', null, zh.render_failed), h('pre', null, this.state.error.message),
        h('button', { type: 'button', onClick: () => this.setState(state => ({ error: null, attempt: state.attempt + 1 })) }, zh.retry))
    }
  }
  function RuntimeNotice() {
    const [message, setMessage] = useState('')
    useEffect(() => {
      let disposed = false
      void call({ action: 'client-ready', title: document.title }).catch(error => { if (!disposed) setMessage(Object.hasOwn(zh, error.message) ? zh[error.message] : zh.error) })
      return () => { disposed = true }
    }, [])
    return message ? h('aside', { className: 'jyh-runtime-notice', role: 'alert' }, message) : null
  }
  function Icon({ size = 24 }) {
    return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true }, h('path', { d: 'M4 6h16v12H4zM7 3l3 3M13 3l3 3M9 10l6 3-6 3z', stroke: 'currentColor', strokeWidth: 1.5, strokeLinejoin: 'round' }))
  }
  function Workspace({ useTabInfo, t }) {
    const { tab } = useTabInfo()
    const [owner] = useState(() => crypto.randomUUID()), [state, setState] = useState({ status: 'route_ready', active: false, candidates: [] })
    const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [elapsed, setElapsed] = useState(0)
    const started = useRef(Date.now()), readyTime = useRef(null)
    const area = useRef(null), desired = useRef(true), selected = useRef(undefined), mounted = useRef(false), pending = useRef(false)
    const geometry = () => {
      const rect = area.current?.getBoundingClientRect()
      if (!rect) return null
      const x = Math.max(0, Math.ceil(rect.x)), y = Math.max(0, Math.ceil(rect.y))
      const width = Math.min(window.innerWidth, Math.floor(rect.right)) - x, height = Math.min(window.innerHeight, Math.floor(rect.bottom)) - y
      return width >= 100 && height >= 100 ? { x, y, width, height, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight } : null
    }
    const receive = result => {
      if (!mounted.current) return
      if (result.active && readyTime.current === null) readyTime.current = (Date.now() - started.current) / 1000
      // A selected HWND is only a one-time choice, never a durable identifier.
      if (result.active || result.status === 'selection_expired') selected.current = undefined
      setState(previous => JSON.stringify([previous.active, previous.status, previous.candidates, previous.target?.hwnd, previous.keyboard?.destination, previous.currentProject]) === JSON.stringify([result.active, result.status, result.candidates, result.target?.hwnd, result.keyboard?.destination, result.currentProject]) ? previous : result)
    }
    useEffect(() => {
      mounted.current = true
      const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started.current) / 1000)), 1000)
      void call({ action: 'client-ready', title: `body_mounted: ${document.title}` }).catch(error => { if (mounted.current) setNotice(error.message) })
      return () => { mounted.current = false; clearInterval(timer); void call({ action: 'detach', owner }).catch(error => console.warn('Jianying restore failed', error)) }
    }, [owner])
    useEffect(() => {
      let disposed = false
      const sync = async () => {
        if (disposed || pending.current) return
        const bounds = tab.visible ? geometry() : null
        if (tab.visible && !bounds) { setNotice('invalid_bounds'); return }
        pending.current = true
        try {
          const result = await call({ action: 'sync', owner, visible: tab.visible, connect: desired.current, targetHwnd: selected.current, ...bounds })
          if (!disposed) { receive(result); setNotice('') }
        } catch (error) { if (!disposed && mounted.current) setNotice(error.message) }
        finally { pending.current = false }
      }
      void sync(); const timer = setInterval(sync, 500)
      const observer = new ResizeObserver(sync)
      if (area.current) observer.observe(area.current)
      window.addEventListener('resize', sync)
      window.addEventListener('focus', sync)
      window.addEventListener('pageshow', sync)
      document.addEventListener('visibilitychange', sync)
      return () => { disposed = true; clearInterval(timer); observer.disconnect(); window.removeEventListener('resize', sync); window.removeEventListener('focus', sync); window.removeEventListener('pageshow', sync); document.removeEventListener('visibilitychange', sync) }
    }, [owner, tab.visible])
    const perform = async action => {
      setBusy(true); setNotice('')
      if (['connect', 'launch'].includes(action)) { started.current = Date.now(); readyTime.current = null; setElapsed(0) }
      if (['launch', 'connect', 'refresh'].includes(action)) setNotice(action === 'launch' ? 'starting' : 'detecting')
      if (action === 'detach') desired.current = false
      if (['connect', 'launch'].includes(action)) desired.current = true
      const bounds = geometry()
      try {
        if (action !== 'detach' && !bounds) throw new Error('invalid_bounds')
        receive(await call({ action, owner, visible: tab.visible, connect: desired.current, targetHwnd: selected.current, ...bounds }))
        if (action === 'checkpoint') setNotice('saved')
      } catch (error) { if (mounted.current) setNotice(error.message) }
      finally { if (mounted.current) setBusy(false) }
    }
    const label = key => Object.hasOwn(zh, key) ? t(key) : t('error')
    return h('section', { className: 'jyh-tab', 'data-jianying-sidebar': '', 'aria-label': t('title') },
      h('div', { className: 'jyh-toolbar' },
        h('button', { type: 'button', disabled: busy || state.active, onClick: () => perform(['not_running', 'route_ready', 'launch_timeout', 'launch_failed','windows_hidden'].includes(state.status) ? 'launch' : 'connect') }, t(['not_running', 'route_ready', 'launch_timeout', 'launch_failed','windows_hidden'].includes(state.status) ? 'launch' : 'connect')),
        h('button', { type: 'button', disabled: busy, onClick: () => { selected.current = undefined; void perform('refresh') } }, t('refresh')),
        h('button', { type: 'button', disabled: busy || !state.active, onClick: () => perform('focus') }, t('focus')),
        h('button', { type: 'button', disabled: busy || !state.active, onClick: () => perform('inspect-project') }, t('inspect_project')),
        h('button', { type: 'button', disabled: busy || !state.active, onClick: () => perform('checkpoint') }, t('checkpoint')),
        h('button', { type: 'button', disabled: busy || !state.active, onClick: () => perform('detach') }, t('disconnect'))),
      state.candidates.length > 1 && (!state.active || state.status === 'choose_window') ? h('select', { className: 'jyh-select', 'aria-label': t('choose'), value: selected.current ?? '', onChange: event => { selected.current = event.target.value ? Number(event.target.value) : undefined; void perform('connect') } },
        h('option', { value: '' }, t('choose')), state.candidates.map(window => h('option', { key: window.hwnd, value: window.hwnd }, `${window.title} · ${t('pid')} ${window.pid} · ${t('window')} ${window.hwnd}`))) : null,
      h('div', { className: 'jyh-status', role: notice && !['saved','starting','detecting'].includes(notice) ? 'alert' : 'status', 'aria-live': 'polite' },
        h('span', null, label(notice || state.status)),
        !state.active ? h('span', { className: 'jyh-elapsed' }, ` · ${t('elapsed')} ${elapsed} ${t('seconds')}`) : h('span', { className: 'jyh-elapsed' }, ` · ${t('ready_time')} ${readyTime.current?.toFixed(1) ?? '0'} ${t('seconds')} · ${label('keyboard_' + (state.keyboard?.destination ?? 'unknown'))}`)),
      state.active && state.currentProject ? h('div', { className: 'jyh-status', role: 'status' }, `${state.currentProject.name} · ${state.currentProject.clip_count} 个片段 · ${state.currentProject.material_count} 个素材 · ${t('project_snapshot')}`) : null,
      h('div', { ref: area, className: 'jyh-native' }, !state.active ? h('p', null, t('waiting')) : null))
  }
  return { inject: ['slots', 'locale', 'sidebarRightTabs'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(namespace, { zh, en: zh }))
    const t = ctx.locale.bind(namespace)
    ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'jianying', multiple: false, keepMounted: true, priority: 'extension', title: () => t('title'),
      guide: [{ id: 'open', order: 40, title: () => t('title'), description: () => t('description'), icon: Icon }] }))
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, locale: namespace }, ViewBoundary)))
    ctx.effect(() => ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'jianying-runtime-notice' }, RuntimeNotice)))
    ctx.effect(() => {
      const style = document.createElement('style')
      style.textContent = '.jyh-tab{height:100%;min-height:160px;flex:1;display:flex;flex-direction:column;overflow:hidden;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-settings-card-fill)}.jyh-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px;flex-shrink:0}.jyh-toolbar button,.jyh-select{font:inherit;font-size:12px;color:inherit;background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:6px 8px}.jyh-toolbar button{cursor:pointer}.jyh-toolbar button:disabled{opacity:.45;cursor:default}.jyh-toolbar button:focus-visible,.jyh-select:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.jyh-status{margin:0;padding:0 8px 8px;font-size:12px;flex-shrink:0;overflow-wrap:anywhere;min-height:24px}.jyh-select{margin:0 8px 8px}.jyh-native{flex:1;min-height:100px;position:relative;overflow:hidden}.jyh-native p{padding:16px;font-size:13px;color:var(--dsw-alias-label-secondary)}.jyh-failure{padding:16px;color:var(--dsw-alias-label-primary);font-size:13px}.jyh-runtime-notice{position:fixed;right:24px;bottom:24px;max-width:420px;z-index:1000;pointer-events:auto;background:var(--dsw-alias-settings-card-fill,#252525);color:var(--dsw-alias-label-primary,#fff);border:1px solid var(--dsw-alias-border-l3,#666);border-radius:8px;padding:14px;font-size:13px}.jyh-elapsed{opacity:.65}'
      document.head.append(style); return () => style.remove()
    })
    void call({ action: 'client-ready', title: document.title, registeredKind: ctx.sidebarRightTabs.guide().find(entry => entry.providerId === id)?.kind }).catch(error => console.warn('Jianying sidebar readiness failed', error))
  } }
} })
