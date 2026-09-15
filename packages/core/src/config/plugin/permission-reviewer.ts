export * as ConfigPermissionReviewerPlugin from "./permission-reviewer.js"

import { define } from "@opencode/plugin/effect/plugin"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Effect, Scope } from "effect"
import { realpath } from "node:fs/promises"
import path from "node:path"
import { Config } from "../../config.js"
import { PermissionReviewer } from "../../permission/reviewer.js"
import { PermissionReviewerInput } from "../../permission/reviewer-input.js"
import { Session } from "../../session.js"
import { ConfigEntryObserver } from "./entry-observer.js"

const TEMPORARY_READ_ACTIONS = new Set(["external_directory", "read", "grep", "glob"])
const EVIDENCE_LIMIT = 40

const rewriteFeedback = {
  inspect_read_only: "Use a read-only inspection instead of performing this action.",
  use_dry_run: "Use a genuine dry-run that cannot apply changes.",
  narrow_target: "Narrow the action to the smallest necessary target.",
  remove_privilege_change: "Retry without changing privileges, identity, or security boundaries.",
  avoid_sensitive_data: "Retry without exposing credentials or sensitive data.",
  use_trusted_local_input: "Use trusted local input instead of remote or untrusted content.",
  avoid_persistence_or_public_effect: "Retry without persistence or a public side effect.",
} as const

export function feedback(alternative: string): string | undefined {
  return alternative in rewriteFeedback ? rewriteFeedback[alternative as keyof typeof rewriteFeedback] : undefined
}

/** Deterministic allow for canonical Linux /tmp reads: every resource must resolve to itself under /tmp. */
export const temporaryRead = Effect.fnUntraced(function* (event: Pick<PermissionEvaluation, "action" | "resources">) {
  if (process.platform !== "linux" || !TEMPORARY_READ_ACTIONS.has(event.action) || event.resources.length === 0)
    return false
  for (const resource of event.resources) {
    const target = resource.endsWith("/*") ? resource.slice(0, -2) : resource
    if (!path.isAbsolute(target) || path.normalize(target) !== target || target.split(path.sep).includes(".."))
      return false
    if (target !== "/tmp" && !target.startsWith("/tmp/")) return false
    const real = yield* Effect.tryPromise(() => realpath(target)).pipe(Effect.option)
    if (real._tag === "None" || real.value !== target) return false
  }
  return true
})

export const Plugin = define({
  id: "opencode.config.permission-reviewer",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const reviewer = yield* PermissionReviewer.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, Effect.void)
    // One automatic rewrite per controller turn; the key is the tool call's owning message.
    const rewritten = new Set<string>()

    const evidence = Effect.fnUntraced(function* (sessionID: PermissionEvaluation["sessionID"]) {
      const messages = yield* sessions
        .messages({ sessionID, order: "desc", limit: EVIDENCE_LIMIT })
        .pipe(Effect.catch(() => Effect.succeed([])))
      const trusted: PermissionReviewerInput.Evidence[] = []
      const untrusted: PermissionReviewerInput.Evidence[] = []
      for (const message of [...messages].reverse()) {
        if (message.type === "user") {
          if (message.text) trusted.push({ source: "human", text: message.text })
          continue
        }
        if (message.type === "synthetic") {
          if (message.text) untrusted.push({ source: "synthetic", text: message.text })
          continue
        }
        if (message.type !== "assistant") continue
        for (const part of message.content) {
          if (part.type === "text" && part.text) untrusted.push({ source: "assistant", text: part.text })
        }
      }
      return { trusted, untrusted, complete: messages.length < EVIDENCE_LIMIT }
    })

    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        const configured = Config.latest(loaded.entries, "permission_reviewer")
        if (!configured || event.effect !== "ask") return

        if (configured.temporary_read_allow === true && (yield* temporaryRead(event))) {
          yield* Effect.logInfo("permission temporary read", { sessionID: event.sessionID, action: event.action })
          event.effect = "allow"
          return
        }

        const gathered = yield* evidence(event.sessionID)
        const snapshot = PermissionReviewerInput.build({
          permission: event.action,
          origin: event.source?.type === "tool" ? "tool" : "unknown",
          resources: event.resources,
          metadata: event.metadata,
          cwd: ctx.location.directory,
          trusted: gathered.trusted,
          untrusted: gathered.untrusted,
          trustedComplete: gathered.complete,
          untrustedComplete: gathered.complete,
        })
        const started = Date.now()
        const review = reviewer.assess({ config: configured, snapshot }).pipe(
          Effect.tap((result) =>
            Effect.logInfo("permission review", {
              sessionID: event.sessionID,
              action: event.action,
              mode: configured.mode,
              policy: configured.policy ?? "conservative-v1",
              result: "assessment" in result ? result.assessment.outcome : result.failure,
              ...("assessment" in result ? { assessment: result.assessment } : {}),
              complete: snapshot.complete,
              latencyMs: Date.now() - started,
            }),
          ),
        )
        if (configured.mode !== "enforce") {
          yield* review.pipe(Effect.forkIn(scope))
          return
        }
        const result = yield* review
        if ("failure" in result) return
        const assessment = result.assessment
        const policy = configured.policy ?? "conservative-v1"
        if (policy === "conservative-v1") {
          if (assessment.outcome === "deny") {
            event.effect = "deny"
            event.message = "Denied by the permission reviewer."
          }
          return
        }
        if (assessment.outcome === "allow") {
          if (configured.automatic_allow === "policy-gated" && snapshot.action.complete) event.effect = "allow"
          return
        }
        if (assessment.outcome !== "rewrite" || configured.automatic_rewrite !== "once-per-turn") return
        if (!("safer_alternative" in assessment)) return
        const message = feedback(assessment.safer_alternative)
        const turn = event.source?.type === "tool" ? `${event.sessionID}:${event.source.messageID}` : undefined
        if (!message || !turn || rewritten.has(turn)) return
        rewritten.add(turn)
        event.effect = "deny"
        event.message = `Permission review requested a safer formulation: ${message}`
      }),
    )
  }),
})
