/** Select from a fresh native inventory; HWNDs never survive application restarts. */
export function selectEditor(windows, requestedHwnd) {
  const eligible = windows.filter(window => /[\\/]JianyingPro\.exe$/i.test(window.path)
    && window.parent === 0 && window.title === '剪映专业版' && !(window.style & 0x40000000))
  const candidates = eligible.filter(window => window.visible !== false)
  if (requestedHwnd !== undefined) {
    const selected = eligible.find(window => window.hwnd === requestedHwnd)
    return { candidates: candidates.length ? candidates : eligible, selected, status: selected ? 'available' : 'selection_expired' }
  }
  if (!candidates.length && eligible.length) return { candidates: eligible, selected: undefined, status: 'windows_hidden' }
  return { candidates, selected: candidates.length === 1 ? candidates[0] : undefined,
    status: candidates.length === 0 ? 'not_running' : candidates.length === 1 ? 'available' : 'choose_window' }
}

/** Only follow replacement main windows belonging to the currently authorized process. */
export function replacementEditor(windows, current, requestedHwnd) {
  return selectEditor(windows.filter(window => window.pid === current.pid && window.hwnd !== current.hwnd), requestedHwnd)
}

/** Validate a DOM viewport before changing a native window. */
export function viewport(input) {
  const keys = ['x', 'y', 'width', 'height', 'viewportWidth', 'viewportHeight']
  if (!keys.every(key => Number.isSafeInteger(input[key]) && input[key] >= 0 && input[key] <= 10000)
    || input.width < 100 || input.height < 100 || input.viewportWidth < input.x + input.width || input.viewportHeight < input.y + input.height) throw new Error('invalid_bounds')
  return keys.map(key => input[key]).join(' ')
}
