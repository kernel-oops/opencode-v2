import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { Document, Info } from "@opencode/schema/config"
import { Location } from "@opencode/core/location"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { SessionMessage } from "@opencode/core/session/message"
import { BashPermissionEvaluator } from "@opencode/core/permission/bash-evaluator"
import { PermissionReviewer } from "@opencode/core/permission/reviewer"
import { ConfigBashPermissionEvaluatorPlugin } from "@opencode/core/config/plugin/bash-permission-evaluator"
import { ConfigPermissionReviewerPlugin } from "@opencode/core/config/plugin/permission-reviewer"
import { location } from "../fixture/location"
import { host } from "../plugin/host"
import { testEffect } from "../lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      Agent.node,
      PluginHooks.node,
      Permission.node,
    ]),
    [Location.node.replace(current)],
  ),
)

const sessionID = Session.ID.make("ses_review_test")
const decode = Schema.decodeUnknownSync(Info, { onExcessProperty: "ignore" })
const document = (info: Record<string, unknown>) => new Document({ type: "document", info: decode(info) })
const configLayer = (info: Record<string, unknown>) =>
  Layer.mock(Config.Service)({ entries: () => Effect.succeed([document(info)]) })

const evaluatorConfig = {
  executable: "/opt/approve-bash",
  policy: "/opt/policy.yaml",
  executable_sha256: "a".repeat(64),
  policy_sha256: "b".repeat(64),
  expected: { implementation: "x", version: "1", commit: "c", protocol: "p", platform: "linux" },
}
const reviewerConfig = {
  mode: "enforce",
  model: "openai/gpt-5.6-luna",
  policy: "exceptional-risk-only-v1",
  automatic_allow: "policy-gated",
  automatic_rewrite: "once-per-turn",
  temporary_read_allow: true,
}

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
      agent: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  const agents = yield* Agent.Service
  yield* agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )
})

const context = Effect.gen(function* () {
  const hooks = yield* PluginHooks.Service
  return host({
    location: new Location.Info({
      directory: AbsolutePath.make("/project"),
      project: {
        id: Project.ID.global,
        directory: AbsolutePath.make("/project"),
        canonical: AbsolutePath.make("/project"),
      },
    }),
    permission: {
      hook: (name, callback) => hooks.register("permission", name, callback),
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
    },
  })
})

const run = <T>(items: T[]) => {
  const queue = [...items]
  const calls: number[] = []
  return {
    calls,
    layerResult: () =>
      Effect.sync(() => {
        calls.push(Date.now())
        const next = queue.shift()
        if (next === undefined) throw new Error("no queued result")
        return next
      }),
  }
}

const source = (messageID = "msg_turn_1") => ({
  type: "tool" as const,
  messageID: SessionMessage.ID.make(messageID),
  id: "call_1",
})

describe("Bash permission evaluator plugin", () => {
  const evaluator = (results: BashPermissionEvaluator.Result[]) => {
    const queue = run(results)
    return {
      queue,
      layer: Layer.mock(BashPermissionEvaluator.Service)({
        prepare: () =>
          Effect.succeed({
            admitted: true,
            result: queue.layerResult(),
            settled: Effect.void,
            abort: () => {},
            isSettled: () => true,
          }),
      }),
    }
  }

  const install = (mode: string, results: BashPermissionEvaluator.Result[]) =>
    Effect.gen(function* () {
      yield* setup
      const fake = evaluator(results)
      const ctx = yield* context
      yield* ConfigBashPermissionEvaluatorPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(
          Layer.mergeAll(configLayer({ bash_permission_evaluator: { mode, ...evaluatorConfig } }), fake.layer),
        ),
      )
      return fake.queue
    })

  const shell = (command = "rm -rf build", cwd = "/project") => ({
    sessionID,
    action: "shell",
    resources: [command],
    metadata: { command, cwd },
    source: source(),
  })

  it.effect("permit-only turns an ask into allow but never denies", () =>
    Effect.gen(function* () {
      const queue = yield* install("permit-only", [{ decision: "allow" }, { decision: "deny" }, { decision: "noop" }])
      const permission = yield* Permission.Service
      expect((yield* permission.ask(shell())).effect).toBe("allow")
      expect((yield* permission.ask(shell())).effect).toBe("ask")
      expect((yield* permission.ask(shell())).effect).toBe("ask")
      expect(queue.calls.length).toBe(3)
    }),
  )

  it.effect("enforce may deny with a reason and failures fall back to a human", () =>
    Effect.gen(function* () {
      yield* install("enforce", [{ decision: "deny" }, { failure: "timeout" }, { decision: "allow" }])
      const permission = yield* Permission.Service
      const denied = yield* permission.assert(shell()).pipe(Effect.flip)
      expect(denied).toBeInstanceOf(Permission.BlockedError)
      expect(String(denied.message)).toContain("Bash permission evaluator")
      expect((yield* permission.ask(shell())).effect).toBe("ask")
      expect((yield* permission.ask(shell())).effect).toBe("allow")
    }),
  )

  it.effect("ignores non-shell actions, static denies and static allows", () =>
    Effect.gen(function* () {
      const queue = yield* install("enforce", [{ decision: "allow" }])
      const permission = yield* Permission.Service
      expect((yield* permission.ask({ ...shell(), action: "read", resources: ["x"] })).effect).toBe("ask")
      const agents = yield* Agent.Service
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "shell", resource: "*", effect: "deny" }]
        }),
      )
      expect((yield* permission.ask(shell())).effect).toBe("deny")
      yield* agents.transform((editor) =>
        editor.update(Agent.ID.make("test"), (agent) => {
          agent.permissions = [{ action: "shell", resource: "*", effect: "allow" }]
        }),
      )
      expect((yield* permission.ask(shell())).effect).toBe("allow")
      expect(queue.calls.length).toBe(0)
    }),
  )

  it.effect("does nothing when the invocation metadata is missing", () =>
    Effect.gen(function* () {
      const queue = yield* install("permit-only", [{ decision: "allow" }])
      const permission = yield* Permission.Service
      expect((yield* permission.ask({ ...shell(), metadata: undefined })).effect).toBe("ask")
      expect(queue.calls.length).toBe(0)
    }),
  )
})

describe("Permission reviewer plugin", () => {
  const reviewer = (results: PermissionReviewer.AssessmentResult[]) => {
    const queue = run(results)
    return {
      queue,
      layer: Layer.mock(PermissionReviewer.Service)({
        assess: () => queue.layerResult(),
      }),
    }
  }
  const sessions = (messages: unknown[] = []) =>
    Layer.mock(Session.Service)({ messages: () => Effect.succeed(messages as never), revert: {} as never })

  const install = (
    config: Record<string, unknown>,
    results: PermissionReviewer.AssessmentResult[],
    messages: unknown[] = [],
  ) =>
    Effect.gen(function* () {
      yield* setup
      const fake = reviewer(results)
      const ctx = yield* context
      yield* ConfigPermissionReviewerPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(Layer.mergeAll(configLayer({ permission_reviewer: config }), fake.layer, sessions(messages))),
      )
      return fake.queue
    })

  const request = (messageID = "msg_turn_1") => ({
    sessionID,
    action: "shell",
    resources: ["git push"],
    metadata: { command: "git push", cwd: "/project" },
    source: source(messageID),
  })

  const allow = { assessment: { outcome: "allow", reason_code: "routine_or_low_impact", safer_alternative: "none" } }
  const rewrite = {
    assessment: { outcome: "rewrite", reason_code: "destructive_or_irreversible", safer_alternative: "use_dry_run" },
  }
  const human = {
    assessment: {
      outcome: "human_review",
      reason_code: "financial_transaction",
      safer_alternative: "request_specific_authorisation",
    },
  }

  it.effect("policy-gated allow, human review and failures", () =>
    Effect.gen(function* () {
      yield* install(reviewerConfig, [allow, human, { failure: "timeout" }] as never)
      const permission = yield* Permission.Service
      expect((yield* permission.ask(request())).effect).toBe("allow")
      expect((yield* permission.ask(request())).effect).toBe("ask")
      expect((yield* permission.ask(request())).effect).toBe("ask")
    }),
  )

  it.effect("rewrites once per turn with feedback, then asks", () =>
    Effect.gen(function* () {
      yield* install(reviewerConfig, [rewrite, rewrite, rewrite] as never)
      const permission = yield* Permission.Service
      const corrected = yield* permission.assert(request()).pipe(Effect.flip)
      expect(corrected).toBeInstanceOf(Permission.BlockedError)
      expect(String(corrected.message)).toContain("dry-run")
      expect((yield* permission.ask(request())).effect).toBe("ask")
      const second = yield* permission.assert(request("msg_turn_2")).pipe(Effect.flip)
      expect(second).toBeInstanceOf(Permission.BlockedError)
    }),
  )

  it.effect("never allows automatically outside policy-gated mode or conservative policy", () =>
    Effect.gen(function* () {
      yield* install({ ...reviewerConfig, automatic_allow: "never", automatic_rewrite: "never" }, [
        allow,
        rewrite,
      ] as never)
      const permission = yield* Permission.Service
      expect((yield* permission.ask(request())).effect).toBe("ask")
      expect((yield* permission.ask(request())).effect).toBe("ask")
    }),
  )

  it.effect("conservative policy only denies", () =>
    Effect.gen(function* () {
      const conservative = {
        assessment: { risk_level: "low", user_authorization: "explicit", outcome: "allow" },
      }
      const deny = { assessment: { risk_level: "critical", user_authorization: "none", outcome: "deny" } }
      yield* install({ mode: "enforce", model: "openai/gpt-5.6-luna" }, [conservative, deny] as never)
      const permission = yield* Permission.Service
      expect((yield* permission.ask(request())).effect).toBe("ask")
      expect((yield* permission.ask(request())).effect).toBe("deny")
    }),
  )

  it.effect("audit-only never changes the outcome", () =>
    Effect.gen(function* () {
      yield* install({ mode: "audit-only", model: "openai/gpt-5.6-luna", policy: "exceptional-risk-only-v1" }, [
        allow,
      ] as never)
      const permission = yield* Permission.Service
      expect((yield* permission.ask(request())).effect).toBe("ask")
    }),
  )

  it.effect("passes trusted human and untrusted assistant evidence to the reviewer", () =>
    Effect.gen(function* () {
      const seen: unknown[] = []
      yield* setup
      const ctx = yield* context
      const fake = Layer.mock(PermissionReviewer.Service)({
        assess: (input) => Effect.sync(() => (seen.push(input.snapshot), allow as never)),
      })
      const messages = [
        { type: "user", text: "please push the branch" },
        { type: "assistant", content: [{ type: "text", text: "pushing now token=abc123" }] },
      ]
      yield* ConfigPermissionReviewerPlugin.Plugin.effect(ctx).pipe(
        Effect.provide(Layer.mergeAll(configLayer({ permission_reviewer: reviewerConfig }), fake, sessions(messages))),
      )
      const permission = yield* Permission.Service
      expect((yield* permission.ask(request())).effect).toBe("allow")
      const snapshot = seen[0] as { trusted: { items: unknown[] }; untrusted: { items: unknown[] }; action: unknown }
      expect(snapshot.trusted.items).toEqual([{ source: "human", trusted: true, text: "please push the branch" }])
      expect(snapshot.untrusted.items).toEqual([
        { source: "assistant", trusted: false, text: "pushing now token=[REDACTED]" },
      ])
      expect(snapshot.action).toMatchObject({ identity: "shell", origin: "tool", cwd: "/project", complete: true })
    }),
  )

  it.live("allows canonical /tmp reads deterministically without consulting the reviewer", () =>
    Effect.gen(function* () {
      const queue = yield* install(reviewerConfig, [human, human, human] as never)
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => fs.mkdtemp("/tmp/opencode-temporary-read-")),
        (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
      )
      const file = path.join(directory, "note.txt")
      yield* Effect.promise(() => fs.writeFile(file, "hello"))
      const permission = yield* Permission.Service
      const read = (action: string, resources: string[]) =>
        permission.ask({ sessionID, action, resources, source: source() })
      expect((yield* read("external_directory", [`${directory}/*`])).effect).toBe("allow")
      expect((yield* read("read", [file])).effect).toBe("allow")
      expect((yield* read("edit", [file])).effect).toBe("ask")
      expect((yield* read("read", [`${directory}/../escape`])).effect).toBe("ask")
      expect((yield* read("read", ["/etc/passwd"])).effect).toBe("ask")
      expect(queue.calls.length).toBe(3)
    }),
  )
})
