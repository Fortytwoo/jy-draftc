import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export function pluginModule(file) {
  const root = process.env.YOYOKING_TEST_PLUGIN_ROOT
  return import(root ? pathToFileURL(join(root, file)).href : new URL(`../${file}`, import.meta.url).href)
}
