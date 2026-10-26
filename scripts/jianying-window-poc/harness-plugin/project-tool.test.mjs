import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { registerCurrentProjectTool } from './project-tool.js'
const require = createRequire('G:/project/jy-draftc/yoyoking/package.json')
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')))
const { default: Tools, defineTool } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tools')))
const { default: SystemPrompt } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-system-prompt')))
const toolsRequire=createRequire(require.resolve('@deepseek-ai/dsh-tools'))
const { createScope } = toolsRequire('@deepseek-ai/dsh-scope')
test('native tool is visible to agent scopes, returns actual data/errors and unregisters with the plugin', async () => {
  const ctx = new Context(); let failure = false
  try {
    await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
    const mount = await ctx.plugin(Object.assign(scope => registerCurrentProjectTool(scope, async (args, signal) => {
      signal.throwIfAborted()
      if(failure)throw Object.assign(new Error('No open draft'),{code:'NO_OPEN_DRAFT'})
      return {ok:true, project:{name:'当前工程'}, source_path:'C:/Videos/actual.mp4', limit:args.limit ?? 50}
    }, defineTool),{inject:['tools','systemPrompt']}))
    let agent
    await ctx.plugin(Object.assign(scope=>{agent=createScope(scope,{}).ctx},{inject:['tools','systemPrompt']}))
    assert.ok(agent.tools.schemas().some(tool=>tool.name==='jianying_get_current_project'))
    const execute = args => agent.tools.execute({name:'jianying_get_current_project',arguments:args,callId:crypto.randomUUID(),signal:AbortSignal.timeout(5000)})
    const result = await execute({limit:1}); assert.equal(result.isError,false,JSON.stringify(result)); assert.equal(result.value.project.name,'当前工程')
    failure=true; const missing=await execute({});assert.equal(missing.value.ok,false);assert.equal(missing.value.error.code,'NO_OPEN_DRAFT')
    await mount.dispose();assert.ok(!ctx.tools.schemas().some(tool=>tool.name==='jianying_get_current_project'))
  } finally { await ctx.fiber.dispose() }
})
