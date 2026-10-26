/** Harness preset plugin: native MCP transport, packaged skills, and scoped guidance. */
import { fileURLToPath } from 'node:url'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import * as SkillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import { buildLaunch, buildDouyinConfig } from './config.js'
import { registerDouyin } from './douyin.js'
import { acquireDouyinHost } from './douyin-host.js'
import { registerDouyinApi } from './douyin-api.js'
import { registerVideoPreview } from './video-preview.js'

export { Config } from './config.js'
export const name = 'yoyoking'
export const inject = ['tools', 'skills', 'systemPrompt']

/** Register only after successful MCP discovery; Cordis owns teardown of every effect. */
export async function apply(ctx, config) {
  const launch = buildLaunch(config)
  const douyin = buildDouyinConfig(config)
  // Released Desktop isolates preset services; a host entry supplies the browser/media half.
  if (config.visualizationOnly || config.hostServicesOnly) {
    registerVideoPreview(ctx, launch, { registerTool: false })
    if (config.hostServicesOnly && douyin) registerDouyinApi(ctx, acquireDouyinHost(ctx, douyin))
    return
  }
  await McpClient.apply(ctx, McpClient.Config(launch))
  registerDouyin(ctx, douyin)
  registerVideoPreview(ctx, launch)
  await ctx.plugin(SkillFilesystem, {
    providerName: `yoyoking-${launch.serverName}`,
    includeDefaultRoots: false,
    bundledSkillDir: fileURLToPath(new URL('./skills/', import.meta.url)),
    watch: false,
  })
  ctx.effect(() => ctx.systemPrompt.section({
    name: `yoyoking:${launch.serverName}`,
    order: 20,
    interpolate: false,
    text: `You have the yoyoking video editing plugin. Load the matching yoyoking skill before editing. Skill instructions use raw MCP tool names; invoke each as mcp__${launch.serverName}__<name>. When delivering a completed export or discussing a known source video, include its actual absolute local path in inline code or a Markdown link in the final reply. Harness automatically adds a playable preview below that reply, including historical replies. Do not ask the user to request opening it or call another tool just to make this preview appear. The optional native yoyoking_preview_video tool (without an MCP prefix) remains available for explicitly selected source times. Page playback is for the user; use extract_frame for model visual inspection. Tools supply composable editing functions; choose and sequence them for the user's request. Tool time arguments are seconds; fields ending in _us are microseconds. Read current project IDs and revision, preserve source files, and distinguish saved draft, completed native export, visual review, and Jianying UI acceptance. Consult get_capabilities for actual environment limits. Never claim media content you have not observed or an export that has not reached succeeded.`,
  }))
}
