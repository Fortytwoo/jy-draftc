import test from 'node:test'
import assert from 'node:assert/strict'
import { selectEditor, replacementEditor, viewport } from './selection.js'

const editor = (hwnd, pid = 100) => ({ hwnd, pid, path: 'C:/JianyingPro.exe', parent: 0, style: 0, title: '剪映专业版' })
test('close and reopen resolves the new PID/HWND without reusing the old selection', () => {
  assert.equal(selectEditor([editor(10)]).selected.hwnd, 10)
  assert.equal(selectEditor([]).status, 'not_running')
  assert.equal(selectEditor([editor(20, 200)]).selected.hwnd, 20)
  assert.equal(selectEditor([editor(20, 200)], 10).status, 'selection_expired')
})
test('multiple windows require a live choice and another container cannot be taken over', () => {
  assert.equal(selectEditor([editor(10), editor(20)]).status, 'choose_window')
  assert.equal(selectEditor([editor(10), editor(20)], 20).selected.hwnd, 20)
  assert.equal(selectEditor([{ ...editor(10), parent: 50 }, { ...editor(20), style: 0x40000000 }]).candidates.length, 0)
  assert.equal(selectEditor([{ ...editor(10), path: 'C:/Other.exe' }]).status, 'not_running')
})
test('native positioning rejects panes outside the viewport before attachment', () => {
  const input = { x: 500, y: 100, width: 700, height: 800, viewportWidth: 1200, viewportHeight: 900 }
  assert.equal(viewport(input), '500 100 700 800 1200 900')
  assert.throws(() => viewport({ ...input, width: 701 }), /invalid_bounds/)
  assert.throws(() => viewport({ ...input, x: -1 }), /invalid_bounds/)
})
test('home/editor transition follows a visible replacement in the authorized process only', () => {
  const current=editor(10,100)
  assert.equal(replacementEditor([{...current,parent:200,visible:false},editor(11,100),editor(12,900)],current).selected.hwnd,11)
  assert.equal(replacementEditor([{...editor(11,100),visible:false},editor(12,900)],current).status,'windows_hidden')
  assert.equal(selectEditor([{...editor(10),visible:false}],10).selected.hwnd,10)
})
