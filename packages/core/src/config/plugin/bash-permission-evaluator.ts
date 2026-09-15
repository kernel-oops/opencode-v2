export * as ConfigBashPermissionEvaluatorPlugin from "./bash-permission-evaluator.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Effect, Scope } from "effect"
import { Config } from "../../config.js"
import { BashPermissionEvaluator } from "../../permission/bash-evaluator.js"
import { ConfigEntryObserver } from "./entry-observer.js"

const DENIED = "Denied by the configured Bash permission evaluator."

export const Plugin = define({
  id: "opencode.config.bash-permission-evaluator",
  effect: Effect.fn(function* (ctx) {
    const config = yield* Config.Service
    const evaluator = yield* BashPermissionEvaluator.Service
    const scope = yield* Scope.Scope
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, Effect.void)

    yield* ctx.permission.hook("evaluate", (event) =>
      Effect.gen(function* () {
        const configured = Config.latest(loaded.entries, "bash_permission_evaluator")
        if (!configured || configured.mode === "disabled") return
        // The evaluator only ever narrows a pending human question; static denies stay authoritative.
        if (event.action !== "shell" || event.effect !== "ask") return
        const command = event.metadata?.command
        const cwd = event.metadata?.cwd
        if (typeof command !== "string" || typeof cwd !== "string") return

        const evaluate = Effect.gen(function* () {
          const started = Date.now()
          const run = yield* evaluator.prepare({ config: configured, action: { command, cwd } })
          const result = yield* run.result
          const decision = "decision" in result ? result.decision : undefined
          yield* Effect.logInfo("bash permission evaluation", {
            sessionID: event.sessionID,
            mode: configured.mode,
            admitted: run.admitted,
            settled: run.isSettled(),
            result: "decision" in result ? result.decision : result.failure,
            latencyMs: Date.now() - started,
          })
          return { decision, settled: run.isSettled() }
        })

        if (configured.mode === "audit-only") {
          yield* evaluate.pipe(Effect.forkIn(scope))
          return
        }
        const { decision, settled } = yield* evaluate
        if (!settled) return
        if (decision === "allow") {
          event.effect = "allow"
          return
        }
        if (configured.mode === "enforce" && decision === "deny") {
          event.effect = "deny"
          event.message = DENIED
        }
      }),
    )
  }),
})
