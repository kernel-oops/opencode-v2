import type { McpApi } from "@opencode/client/effect/api"
import type { Mcp } from "@opencode/schema/mcp"
import type { Effect, Types } from "effect"
import type { Transform } from "./registration.js"

export interface MCPEditor {
  list(): readonly [string, Types.DeepMutable<Mcp.ServerConfig>][]
  get(name: string): Types.DeepMutable<Mcp.ServerConfig> | undefined
  set(name: string, config: Mcp.ServerConfig): void
  update(name: string, update: (config: Types.DeepMutable<Mcp.ServerConfig>) => void): void
  remove(name: string): void
}

export interface MCPTool {
  readonly server: string
  readonly name: string
  readonly description?: string
  readonly inputSchema: unknown
}

export interface MCPToolResult {
  readonly server: string
  readonly tool: string
  readonly isError: boolean
  readonly structured?: unknown
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "media"; readonly data: string; readonly mimeType: string }
  >
}

export interface MCPDomain extends Pick<McpApi<unknown>, "list"> {
  readonly transform: Transform<MCPEditor>
  readonly reload: () => Effect.Effect<void>
  readonly tools: () => Effect.Effect<ReadonlyArray<MCPTool>>
  readonly callTool: (input: {
    readonly server: string
    readonly name: string
    readonly args?: Record<string, unknown>
  }) => Effect.Effect<MCPToolResult, Error>
}
