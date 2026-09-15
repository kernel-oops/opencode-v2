export * as PermissionReviewer from "./reviewer.js"

import type { ConfigPermissionReviewer } from "@opencode/schema/config/permission-reviewer"
import { LLMClient } from "@opencode/ai"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { llmClient } from "../effect/app-node-platform.js"
import { Model } from "../model.js"
import { ModelResolver } from "../model-resolver.js"
import { PermissionReviewerAssessment } from "./reviewer-assessment.js"
import { PermissionReviewerInput } from "./reviewer-input.js"

export const REVIEW_TIMEOUT_MS = 30_000
export const REVIEW_MODEL_ID = PermissionReviewerAssessment.REVIEW_MODEL_ID
export const CAPACITY = PermissionReviewerAssessment.CAPACITY

export type AssessmentResult = PermissionReviewerAssessment.AssessmentResult
export type Failure = PermissionReviewerAssessment.Failure

export interface Input {
  readonly config: ConfigPermissionReviewer.Info
  readonly snapshot: PermissionReviewerInput.Snapshot
  readonly timeoutMs?: number
}

export interface Run {
  readonly admitted: boolean
  readonly result: Effect.Effect<AssessmentResult>
  readonly settled: Effect.Effect<void>
  readonly abort: () => void
  readonly isSettled: () => boolean
}

export interface Interface {
  readonly prepare: (input: Input) => Effect.Effect<Run>
  readonly assess: (input: Input) => Effect.Effect<AssessmentResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PermissionReviewer") {}

interface Operation {
  readonly controller: AbortController
  settled: boolean
}

// Process-global: provider work can outlive the location that started it, and the capacity
// guard must count native operations until they actually settle.
const operations = new Set<Operation>()

const unavailable = (failure: Failure): Run => ({
  admitted: false,
  result: Effect.succeed({ failure }),
  settled: Effect.void,
  abort: () => {},
  isSettled: () => true,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resolver = yield* ModelResolver.Service
    const client = yield* LLMClient.Service
    const owned = new Set<Operation>()

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const operation of owned) operation.controller.abort()
        owned.clear()
      }),
    )

    const prepare: Interface["prepare"] = Effect.fn("PermissionReviewer.prepare")(function* (input) {
      const serialised = PermissionReviewerInput.serialise(input.snapshot)
      if (!("data" in serialised)) return unavailable(serialised.failure)
      if (operations.size >= CAPACITY) return unavailable("capacity")

      const controller = new AbortController()
      const operation: Operation = { controller, settled: false }
      operations.add(operation)
      owned.add(operation)

      const execute: Effect.Effect<AssessmentResult> = Effect.gen(function* () {
        const ref = yield* Effect.try(() => Model.Ref.parse(input.config.model)).pipe(Effect.option)
        if (ref._tag === "None") return { failure: "model_config" as const }
        const resolved = yield* resolver.resolve(ref.value).pipe(Effect.exit)
        if (Exit.isFailure(resolved)) {
          if (Cause.hasInterrupts(resolved.cause)) return { failure: "timeout" as const }
          return { failure: "model_lookup" as const }
        }
        if (!resolved.value) return { failure: "model_lookup" as const }
        if (resolved.value.ref.id !== REVIEW_MODEL_ID && resolved.value.model.id !== REVIEW_MODEL_ID)
          return { failure: "model_identity" as const }
        if (controller.signal.aborted) return { failure: "timeout" as const }
        return yield* PermissionReviewerAssessment.assess({
          model: resolved.value.model,
          serialised: serialised.data,
          policy: input.config.policy ?? "conservative-v1",
        }).pipe(Effect.provideService(LLMClient.Service, client))
      })

      // A detached fibre keeps the capacity witness honest: the slot is released only when the
      // provider call actually settles, not when the waiting permission goes away.
      const fibre = yield* execute.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            operation.settled = true
            operations.delete(operation)
            owned.delete(operation)
          }),
        ),
        Effect.forkDetach({ startImmediately: true }),
      )
      const joined = Fiber.await(fibre).pipe(
        Effect.flatMap((exit) => (Exit.isSuccess(exit) ? Effect.succeed(exit.value) : Effect.failCause(exit.cause))),
      )
      const result: Effect.Effect<AssessmentResult> = joined.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("permission reviewer provider failure", { cause: Cause.pretty(cause) }).pipe(
            Effect.as({ failure: "provider" as const }),
          ),
        ),
        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
        Effect.timeoutOrElse({
          duration: input.timeoutMs ?? REVIEW_TIMEOUT_MS,
          orElse: () => Effect.sync(() => controller.abort()).pipe(Effect.as({ failure: "timeout" as const })),
        }),
      )
      return {
        admitted: true,
        result,
        settled: Fiber.await(fibre).pipe(Effect.asVoid),
        abort: () => controller.abort(),
        isSettled: () => operation.settled,
      }
    })

    const assess: Interface["assess"] = Effect.fn("PermissionReviewer.assess")(function* (input) {
      const run = yield* prepare(input)
      return yield* run.result
    })

    return Service.of({ prepare, assess })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [ModelResolver.node, llmClient] })
