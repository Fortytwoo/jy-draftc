import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const baseline = JSON.parse(await readFile(join(root, 'desktop/upstream.json'), 'utf8'))
const checkout = join(root, baseline.directory), patchPath = join(root, baseline.patch)
async function git(args, cwd = checkout) {
  return (await exec('git', args, { cwd, windowsHide: true, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })).stdout
}
const mode = process.argv[2]
if (mode === 'snapshot') {
  if ((await git(['rev-parse', 'HEAD'])).trim() !== baseline.commit) throw new Error('Unexpected upstream HEAD')
  let patch = await git(['diff', '--binary', '--no-ext-diff', 'HEAD'])
  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean).sort()
  for (const name of untracked) {
    if (!/^(src\/|\.agents\/notes\/proposed\/architecture\/2026-10-26-yoyoking)/.test(name)) throw new Error(`Unclassified source file: ${name}`)
    const data = await readFile(join(checkout, name), 'utf8')
    const lines = data.replaceAll('\r\n', '\n').replace(/\n$/, '').split('\n')
    patch += `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,${lines.length} @@\n` + lines.map(line => '+' + line).join('\n') + '\n'
  }
  await mkdir(dirname(patchPath), { recursive: true })
  await writeFile(patchPath, patch, 'utf8')
  await writeFile(join(root, 'desktop/source-receipt.json'), JSON.stringify({ upstream: baseline.commit, patchSha256: createHash('sha256').update(patch).digest('hex'), newFiles: untracked }, null, 2) + '\n', 'utf8')
  console.log(`Saved reproducible source overlay: ${patchPath}`)
} else if (mode === 'prepare') {
  try { await readFile(join(checkout, 'package.json')) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await git(['clone', '--no-checkout', '--filter=blob:none', baseline.repository, checkout], root)
    await git(['checkout', '--detach', baseline.commit])
  }
  if ((await git(['rev-parse', 'HEAD'])).trim() !== baseline.commit) throw new Error('Existing checkout has a different HEAD; preserve it and choose a separate directory')
  const receipt = JSON.parse(await readFile(join(root, 'desktop/source-receipt.json'), 'utf8'))
  const bytes = await readFile(patchPath)
  if (createHash('sha256').update(bytes).digest('hex') !== receipt.patchSha256) throw new Error('Source patch checksum mismatch')
  const applied = await git(['apply', '--reverse', '--check', patchPath]).then(() => true, () => false)
  if (!applied) { await git(['apply', '--check', patchPath]); await git(['apply', patchPath]) }
  console.log(`Source prepared at ${checkout}`)
} else throw new Error('Usage: node scripts/cherry-source.mjs prepare|snapshot')
