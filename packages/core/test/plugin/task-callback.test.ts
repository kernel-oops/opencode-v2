import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Config } from "@opencode/core/config"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { TaskCallbackPlugin } from "@opencode/core/plugin/task-callback"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { host } from "./host"

const synthetic = (source?: string) =>
  ({ type: "synthetic", id: SessionMessage.ID.create(), text: "x", metadata: source ? { source } : undefined }) as any
const user = () => ({ type: "user", id: SessionMessage.ID.create(), text: "hello" }) as any
const assistant = () => ({ type: "assistant", id: SessionMessage.ID.create(), content: [] }) as any

describe("TaskCallbackPlugin", () => {
  test("detects a callback turn from the most recent human or completion input", () => {
    expect(TaskCallbackPlugin.isCallbackTurn([synthetic("subagent"), assistant(), user()])).toBe(true)
    expect(TaskCallbackPlugin.isCallbackTurn([synthetic("shell"), synthetic("subagent"), user()])).toBe(true)
    expect(TaskCallbackPlugin.isCallbackTurn([user(), synthetic("subagent")])).toBe(false)
    expect(TaskCallbackPlugin.isCallbackTurn([synthetic("shell"), user()])).toBe(false)
    expect(TaskCallbackPlugin.isCallbackTurn([])).toBe(false)
  })

  test("accepts only entries in the eligible set", () => {
    const eligible = new Set(["build", "custom-root"])
    expect([...TaskCallbackPlugin.continuationAgents(["build", "custom-root"], eligible)]).toEqual([
      "build",
      "custom-root",
    ])
    expect([...TaskCallbackPlugin.continuationAgents([" build "], eligible)]).toEqual(["build"])
    expect(TaskCallbackPlugin.continuationAgents(["build", "Custom-Root"], eligible).size).toBe(0)
    expect(TaskCallbackPlugin.continuationAgents(["*"], eligible).size).toBe(0)
    expect(TaskCallbackPlugin.continuationAgents(["build", ""], eligible).size).toBe(0)
    expect(TaskCallbackPlugin.continuationAgents([], eligible).size).toBe(0)
    expect(TaskCallbackPlugin.continuationAgents(undefined, eligible).size).toBe(0)
    // An entry outside the eligible set disables the whole policy, even alongside a valid one.
    expect(TaskCallbackPlugin.continuationAgents(["build", "not-eligible"], eligible).size).toBe(0)
    expect([
      ...TaskCallbackPlugin.continuationAgents(TaskCallbackPlugin.parseEnvironment("build,custom-root"), eligible),
    ]).toEqual(["build", "custom-root"])
  })

  const run = (input: {
    messages: unknown[]
    parentID?: string
    agent: string
    configured?: string[]
    eligible?: string[]
    env?: string
  }) =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_TASK_CONTINUATION_AGENTS
      if (input.env === undefined) delete process.env.OPENCODE_TASK_CONTINUATION_AGENTS
      else process.env.OPENCODE_TASK_CONTINUATION_AGENTS = input.env
      let hook: ((event: SessionContext) => Effect.Effect<void>) | undefined
      const context = host({
        session: {
          hook: ((name: string, callback: any) =>
            Effect.sync(() => {
              if (name === "context") hook = callback
              return { dispose: Effect.void }
            })) as any,
        },
      })
      yield* TaskCallbackPlugin.Plugin.effect(context).pipe(
        Effect.provideService(
          Session.Service,
          Session.Service.of({
            messages: () => Effect.succeed(input.messages as any),
            get: () => Effect.succeed({ id: "ses_parent", parentID: input.parentID } as any),
          } as unknown as Session.Interface),
        ),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed(
                input.configured
                  ? [
                      {
                        type: "document",
                        info: {
                          experimental: {
                            task_continuation_agents: input.configured,
                            ...(input.eligible ? { task_continuation_eligible: input.eligible } : {}),
                          },
                        },
                      },
                    ]
                  : [],
              ),
          } as unknown as Config.Interface),
        ),
      )
      const event: SessionContext = {
        sessionID: "ses_parent" as any,
        agent: input.agent as any,
        model: { providerID: "test", id: "m" } as any,
        system: [],
        messages: [],
        options: {},
        tools: { read: { description: "read", input: {} }, subagent: { description: "delegate", input: {} } },
      }
      yield* hook!(event)
      if (previous === undefined) delete process.env.OPENCODE_TASK_CONTINUATION_AGENTS
      else process.env.OPENCODE_TASK_CONTINUATION_AGENTS = previous
      return event
    }).pipe(Effect.scoped, Effect.runPromise)

  test("strips every tool and adds guidance on a callback turn", async () => {
    const event = await run({ messages: [synthetic("subagent"), user()], agent: "build" })
    expect(Object.keys(event.tools)).toEqual([])
    expect(event.system).toEqual([{ type: "text", text: TaskCallbackPlugin.REPORT_ONLY_GUIDANCE }])
  })

  test("leaves a human turn untouched", async () => {
    const event = await run({ messages: [user(), synthetic("subagent")], agent: "build" })
    expect(Object.keys(event.tools)).toEqual(["read", "subagent"])
    expect(event.system).toEqual([])
  })

  test("keeps tools for an allowlisted root controller only", async () => {
    const eligible = ["build", "custom-root"]
    const allowed = await run({
      messages: [synthetic("subagent")],
      agent: "build",
      configured: ["build", "custom-root"],
      eligible,
    })
    expect(Object.keys(allowed.tools)).toEqual(["read", "subagent"])
    const other = await run({
      messages: [synthetic("subagent")],
      agent: "plan",
      configured: ["build", "custom-root"],
      eligible,
    })
    expect(Object.keys(other.tools)).toEqual([])
    const nested = await run({
      messages: [synthetic("subagent")],
      agent: "build",
      parentID: "ses_root",
      configured: ["build", "custom-root"],
      eligible,
    })
    expect(Object.keys(nested.tools)).toEqual([])
    const misconfigured = await run({
      messages: [synthetic("subagent")],
      agent: "build",
      configured: ["build", "*"],
      eligible,
    })
    expect(Object.keys(misconfigured.tools)).toEqual([])
    // A configured entry outside the eligible set (here, the default ["build"] since no
    // config document is supplied for the env-var path) disables the whole policy...
    const envDisabled = await run({ messages: [synthetic("subagent")], agent: "custom-root", env: "build,custom-root" })
    expect(Object.keys(envDisabled.tools)).toEqual([])
    // ...while an entry the default eligible set does accept still works via the env var.
    const env = await run({ messages: [synthetic("subagent")], agent: "build", env: "build" })
    expect(Object.keys(env.tools)).toEqual(["read", "subagent"])
  })
})
