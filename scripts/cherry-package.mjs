import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const checkout = fileURLToPath(new URL('../cherry-studio/', import.meta.url))
const require = createRequire(join(checkout, 'package.json'))
const { build, Platform, Arch } = require('electron-builder')
const config = require('yaml').parse(await readFile(join(checkout, 'electron-builder.yml'), 'utf8'))
config.directories.output = resolve(process.argv[2] || join(checkout, '../build/yoyoking-desktop'))
process.chdir(checkout)
config.publish = null
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false'
delete process.env.WIN_SIGN
await build({ projectDir: checkout, targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), config, publish: 'never' })
