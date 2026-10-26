// Standalone Electron experiment. Does not load or modify a Harness profile.
const { app, BrowserWindow, desktopCapturer, screen, ipcMain } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const executable = path.join(root, 'build/jianying-window-poc/window-host.exe');
const mode = process.argv.includes('--inspect') ? 'inspect' : 'test';
const nativeMode = process.argv.includes('--panel') ? 'panel' : 'attach';
const interactive = process.argv.includes('--interactive');
const leaseSeconds = interactive ? 1800 : 300;
const targetArgument = process.argv.find(value => value.startsWith('--target-hwnd='));
const selectedHandle = targetArgument ? Number(targetArgument.split('=')[1]) : undefined;
if (selectedHandle !== undefined && (!Number.isSafeInteger(selectedHandle) || selectedHandle <= 0)) throw new Error('Invalid target window handle');
const run = path.join(root, 'build/jianying-window-poc', `${new Date().toISOString().replace(/[:.]/g, '-')}-${mode}`);
fs.mkdirSync(run, { recursive: true });
app.setPath('userData', path.join(run, 'electron-profile'));
app.setAppUserModelId('local.jianying.window-poc');
const report = { kind: 'standalone-window-host-poc', run, mode, nativeMode, events: [], gates: {
  harnessIntegration: 'not_tested', editing: 'blocked_computer_use_native_pipe_os_error_2',
  saveReopen: 'not_tested', humanTakeover: 'not_tested', multiMonitorDpi: 'not_tested'
}};
const record = event => { report.events.push({ time: new Date().toISOString(), ...event }); fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let host, helper, closing = false;
const waiters = [];
function onEvent(event) {
  record(event);
  for (const waiter of [...waiters]) if (waiter.predicate(event)) { clearTimeout(waiter.timer); waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(event); }
  if (host && !host.isDestroyed()) host.webContents.send('event', event);
  if (event.event === 'restored') report.gates.restore = event.ok ? 'passed' : 'failed';
}
function waitFor(predicate, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const waiter = { predicate, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error('Native event timeout')); }, timeout) };
    waiters.push(waiter);
  });
}
async function capture(handle, name) {
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 2300, height: 1500 } });
  const source = sources.find(source => source.id.split(':')[1] === String(handle));
  if (!source || source.thumbnail.isEmpty()) throw new Error(`Capture source missing for ${handle}`);
  const file = path.join(run, `${name}.png`);
  fs.writeFileSync(file, source.thumbnail.toPNG());
  record({ event: 'capture', name, file, sourceId: source.id, size: source.thumbnail.getSize() });
}
async function captureComposite(name) {
  const own = Number(host.getNativeWindowHandle().readBigUInt64LE());
  const panel = report.events.find(event => event.event === 'native_panel')?.panel.hwnd;
  const foreground = () => JSON.parse(spawnSync(executable, ['foreground'], { encoding: 'utf8', windowsHide: true }).stdout);
  const isOwn = value => [own, panel].includes(value.hwnd) || [own, panel].includes(value.root);
  if (!isOwn(foreground())) { record({ event: 'composite_capture_skipped', name, reason: 'poc_not_foreground' }); return null; }
  const rectangle = host.getBounds();
  const display = screen.getDisplayMatching(rectangle);
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.round(display.bounds.width*display.scaleFactor), height: Math.round(display.bounds.height*display.scaleFactor) } });
  const source = sources.find(value => value.display_id === String(display.id));
  if (!source || source.thumbnail.isEmpty()) throw new Error('Display capture unavailable');
  const pixels = source.thumbnail.getSize();
  const sx = pixels.width / display.bounds.width, sy = pixels.height / display.bounds.height;
  const region = { x: Math.max(0, Math.round((rectangle.x-display.bounds.x)*sx)), y: Math.max(0, Math.round((rectangle.y-display.bounds.y)*sy)), width: Math.round(rectangle.width*sx), height: Math.round(rectangle.height*sy) };
  region.width = Math.min(region.width, pixels.width-region.x); region.height = Math.min(region.height, pixels.height-region.y);
  if (!isOwn(foreground())) { record({ event: 'composite_capture_skipped', name, reason: 'foreground_changed_during_capture' }); return null; }
  const file = path.join(run, `${name}.png`);
  fs.writeFileSync(file, source.thumbnail.crop(region).toPNG());
  record({ event: 'capture', name, file, sourceId: source.id, mode: 'display_crop_of_poc_window', region });
  return file;
}
function bounds() {
  if (!helper || helper.exitCode !== null || !host || host.isDestroyed()) return;
  const [width, height] = host.getContentSize();
  const factor = screen.getDisplayMatching(host.getBounds()).scaleFactor;
  helper.stdin.write(`bounds ${Math.round(320*factor)} ${Math.round(60*factor)} ${Math.round((width-332)*factor)} ${Math.round((height-72)*factor)}\n`);
}
async function detach() {
  if (!helper || helper.exitCode !== null) return;
  const restored = waitFor(event => ['restored', 'attach_failed', 'rejected', 'target_closed'].includes(event.event), 8000);
  helper.stdin.write('detach\n'); helper.stdin.end();
  await restored;
}
async function close() {
  if (closing) return;
  closing = true;
  try { await detach(); } catch (error) { record({ event: 'cleanup_error', message: error.message }); closing = false; return; }
  if (host && !host.isDestroyed()) host.destroy();
  app.quit();
}
app.on('window-all-closed', () => { if (!helper || helper.exitCode !== null) app.quit(); });
app.whenReady().then(async () => {
  const listed = spawnSync(executable, ['list'], { encoding: 'utf8', windowsHide: true });
  if (listed.status !== 0) throw new Error(`Native list failed: ${listed.stderr}`);
  const windows = listed.stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  record({ event: 'inventory', windows, electron: process.versions.electron, displays: screen.getAllDisplays().map(d => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor })) });
  const candidates = windows.filter(window => window.parent === 0 && (selectedHandle !== undefined ? window.hwnd === selectedHandle : window.title === '剪映专业版'));
  if (candidates.length !== 1) throw new Error(`Expected exactly one visible Jianying main window, got ${candidates.length}`);
  const target = candidates[0]; report.target = target;
  try { await capture(target.hwnd, '01-before'); }
  catch (error) { record({ event: 'baseline_capture_unavailable', message: error.message }); }
  if (mode === 'inspect') { record({ event: 'inspection_complete' }); app.quit(); return; }
  const area = screen.getPrimaryDisplay().workArea;
  host = new BrowserWindow({ x: area.x+20, y: area.y+20, width: Math.min(1800, area.width-40), height: Math.min(1080, area.height-40), minWidth: 1100, minHeight: 720, title: '剪映窗口承载 · 独立 POC', autoHideMenuBar: true, backgroundColor: '#18191c', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  host.on('close', event => { event.preventDefault(); void close(); });
  host.on('resize', bounds);
  host.on('move', bounds);
  ipcMain.handle('close-poc', () => close());
  let checkpointNumber = 0, checkpointBusy = false;
  ipcMain.handle('checkpoint-poc', async event => {
    if (event.sender !== host.webContents || event.senderFrame !== host.webContents.mainFrame) throw new Error('Rejected checkpoint sender');
    if (!interactive || checkpointBusy || closing || helper?.exitCode !== null) return { saved: false, reason: 'busy' };
    checkpointBusy = true;
    try {
      const index = ++checkpointNumber;
      const file = await captureComposite(`manual-${String(index).padStart(3,'0')}`);
      record({ event: 'manual_checkpoint', index, file, editingSource: 'human', outcome: 'not_yet_reviewed' });
      return { saved: Boolean(file), index };
    } catch (error) { record({ event: 'checkpoint_error', message: error.message }); return { saved: false, reason: 'capture_failed' }; }
    finally { checkpointBusy = false; }
  });
  await host.loadFile(path.join(__dirname, 'host.html'), { query: { manual: interactive ? '1' : '0' } });
  host.show();
  host.moveTop();
  const handleBuffer = host.getNativeWindowHandle();
  const handle = Number(handleBuffer.length === 8 ? handleBuffer.readBigUInt64LE() : handleBuffer.readUInt32LE());
  record({ event: 'host', hwnd: handle, bounds: host.getBounds(), contentBounds: host.getContentBounds() });
  const attached = waitFor(event => ['attached', 'rejected', 'attach_failed'].includes(event.event));
  helper = spawn(executable, [nativeMode, String(target.hwnd), String(handle), String(leaseSeconds)], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
  let pending = '';
  helper.stdout.on('data', data => {
    pending += data.toString('utf8');
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0,end).trim(); pending = pending.slice(end+1);
      if (line) { try { onEvent(JSON.parse(line)); } catch (error) { record({ event: 'native_parse_error', message: error.message, line }); } }
    }
  });
  helper.stderr.on('data', data => record({ event: 'native_stderr', message: data.toString('utf8') }));
  helper.on('error', error => record({ event: 'native_error', message: error.message }));
  helper.on('exit', (code, signal) => record({ event: 'native_exit', code, signal }));
  const result = await attached;
  if (result.event !== 'attached') { report.gates.embedding = 'failed'; record({ event: 'test_stopped' }); await delay(1000); await close(); return; }
  report.gates.embedding = 'native_parent_confirmed';
  let resized = waitFor(event => event.event === 'bounds'); bounds(); await resized;
  if (interactive) {
    report.gates.manualEditing = 'awaiting_user';
    record({ event: 'interactive_ready', leaseSeconds, editingAutomated: false });
    // Capture this actual POC window only if it remains in front.
    setTimeout(() => { if (!closing && host && !host.isDestroyed()) void captureComposite('interactive-initial').catch(error => record({ event: 'initial_capture_error', message: error.message })); }, 1500);
    // The native helper restores the original window after its bounded lease.
    helper.once('exit', () => { if (host && !host.isDestroyed()) host.destroy(); app.quit(); });
    return;
  }
  await delay(4500); await capture(handle, '02-embedded-large');
  const panelEvent = report.events.find(event => event.event === 'native_panel');
  if (panelEvent) {
    try { await capture(panelEvent.panel.hwnd, '02-native-panel'); } catch (error) { record({ event: 'panel_capture_unavailable', message: error.message }); }
  }
  await captureComposite('02-visible-composite');
  // Native child windows are absent from Chromium capturePage; use OS window capture above.
  const large = host.getSize();
  resized = waitFor(event => event.event === 'bounds');
  host.setSize(Math.max(1100, large[0]-160), Math.max(720, large[1]-100));
  await resized; await delay(2500); await capture(handle, '03-embedded-resized');
  await captureComposite('03-visible-composite-resized');
  resized = waitFor(event => event.event === 'bounds'); host.setSize(...large); await resized;
  await delay(2000);
  await detach();
  report.gates.restore = report.events.some(event => event.event === 'restored' && event.ok) ? 'passed' : 'failed';
  const boundsEvents = report.events.filter(event => event.event === 'bounds');
  report.gates.resize = boundsEvents.length >= 3 && boundsEvents.every(event => event.ok && event.target.rect.width === event.requested.width && event.target.rect.height === event.requested.height) ? 'passed_native_dimensions' : 'failed';
  await delay(1500);
  try { await capture(target.hwnd, '04-restored'); }
  catch (error) { record({ event: 'restored_capture_unavailable', expectedWhenMinimized: target.minimized, message: error.message }); }
  record({ event: 'test_complete' });
  await close();
}).catch(async error => {
  report.error = { message: error.message, stack: error.stack };
  record({ event: 'error', message: error.message });
  if (helper && helper.exitCode === null) { try { await detach(); } catch (cleanup) { record({ event: 'cleanup_error', message: cleanup.message }); return; } }
  if (host && !host.isDestroyed()) host.destroy();
  app.exit(1);
});
