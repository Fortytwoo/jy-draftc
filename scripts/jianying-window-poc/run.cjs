const { spawn } = require('node:child_process');
const path = require('node:path');
const electron = process.env.POC_ELECTRON || 'C:/Users/fortytwo/Documents/deepseek-harness/apps/desktop/node_modules/electron/dist/electron.exe';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.NODE_OPTIONS;
const child = spawn(electron, [path.join(__dirname, 'host.cjs'), ...process.argv.slice(2)], { env, stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
