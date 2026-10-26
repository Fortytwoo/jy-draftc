/** Narrow HTTP bridge for Harness releases without the Host-owned connect API. */
import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'

// Match Harness's identity hash, including lossy character normalization.
function publicToolName(serverName, rawName) {
  const joined = `mcp__${serverName}__${rawName}`
  const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_')
  if (normalized === joined && normalized.length <= 64) return normalized
  const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12)
  return `${normalized.slice(0, 51)}_${hash}`
}

export async function connectDouyinMcp(ctx, config, runtime, bridge = McpClient) {
  if (typeof bridge.connect === 'function') return bridge.connect(ctx, config, runtime)
  // Never fall back to apply()/config headers: only the shared Host owns credentials.
  if (config.transport !== 'streamable-http' || typeof runtime?.fetch !== 'function' || typeof runtime?.isCurrent !== 'function' || typeof bridge.createMcpToolDefinition !== 'function') {
    throw new Error('Douyin MCP requires the Host-owned HTTP fetch and Harness tool bridge')
  }
  const lifetime = new AbortController()
  let closed = false, stopping, disposers = new Map(), syncing = Promise.resolve()
  const checkCurrent = () => {
    lifetime.signal.throwIfAborted()
    if (!runtime.isCurrent()) throw new Error('Douyin MCP identity changed')
  }
  const unregister = () => {
    for (const dispose of disposers.values()) dispose()
    disposers = new Map()
  }
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    fetch: async (input, init = {}) => {
      checkCurrent()
      const signal = AbortSignal.any([lifetime.signal, ...(init.signal ? [init.signal] : []), ...(input instanceof Request ? [input.signal] : [])])
      const response = await runtime.fetch(input, { ...init, signal })
      try { checkCurrent(); return response }
      catch (error) { await response.body?.cancel().catch(() => {}); throw error }
    },
  })
  const client = new Client({ name: 'yoyoking-douyin', version: '0.0.1' }, {
    capabilities: {}, versionNegotiation: { mode: 'auto' },
    listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged: () => {
      void synchronize().catch(() => {
        if (!closed) ctx.logger.warn('Douyin MCP tool discovery failed; use disconnect/connect to retry')
      })
    } } },
  })
  const dispose = () => stopping ??= (async () => {
    closed = true
    lifetime.abort()
    unregister()
    // During SDK negotiation the probe transport is not yet attached to client.
    try { await client.close() } finally { await transport.close() }
    await syncing
  })()
  client.onclose = () => {
    if (!closed) void dispose().catch(() => {})
  }
  // Cordis can unload while apply is still awaiting discovery. Abort before that wait.
  ctx.on('internal/plugin', fiber => {
    if (fiber === ctx.fiber && fiber.uid === null) return dispose()
  }, { global: true })
  ctx.effect(() => dispose, 'yoyoking-douyin.mcp')

  function synchronize() {
    const next = syncing.then(async () => {
      checkCurrent()
      const response = client.getServerCapabilities()?.tools === undefined ? { tools: [] }
        : await client.listTools(undefined, { cacheMode: 'refresh', signal: lifetime.signal, timeout: config.toolCallTimeoutMs })
      checkCurrent()
      // Build the entire generation before touching live registrations.
      const definitions = new Map()
      for (const tool of response.tools) {
        const name = publicToolName(config.serverName, tool.name)
        if (definitions.has(name)) throw new Error('Douyin MCP returned duplicate tool names')
        definitions.set(name, bridge.createMcpToolDefinition(ctx, {
          name, rawName: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema, taskRequired: tool.execution?.taskSupport === 'required',
          call: async (args, execution) => {
            checkCurrent()
            const signal = AbortSignal.any([lifetime.signal, execution.signal])
            signal.throwIfAborted()
            const result = await client.callTool({ name: tool.name, arguments: args }, {
              signal, timeout: config.toolCallTimeoutMs, toolDefinition: tool,
            })
            signal.throwIfAborted()
            checkCurrent()
            return result
          },
        }))
      }
      checkCurrent()
      unregister()
      try {
        for (const [name, definition] of definitions) disposers.set(name, ctx.tools.register(definition))
      } catch (error) { unregister(); throw error }
    })
    syncing = next.catch(() => {})
    return next
  }
  try {
    checkCurrent()
    await client.connect(transport, { signal: lifetime.signal, timeout: config.toolCallTimeoutMs })
    checkCurrent()
    await synchronize()
    checkCurrent()
  } catch (error) {
    await dispose()
    throw error
  }
}
