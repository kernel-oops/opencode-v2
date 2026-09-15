export * as SessionTaskControl from "./task-control.js"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionTask } from "@opencode/schema/session-task"
import { Job } from "../job.js"
import { SessionExecution } from "./execution.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { NotFoundError } from "./error.js"

export const Status = SessionTask.Status
export type Status = typeof Status.Type

export const StopResponseResult = SessionTask.StopResponseResult
export type StopResponseResult = typeof StopResponseResult.Type

export const StopAllResult = SessionTask.StopAllResult
export type StopAllResult = typeof StopAllResult.Type

export const ResumeResult = SessionTask.ResumeResult
export type ResumeResult = typeof ResumeResult.Type

/**
 * Separate response and work controls for a controller Session that owns
 * background subagents. "Stop response" pauses automatic completion delivery
 * and interrupts the current response while accepted background work survives;
 * "resume" releases that pause and rings the Session doorbell; "stop all" also
 * cancels the owned job tree and permanently suppresses its notifications.
 */
export interface Interface {
  readonly status: (sessionID: SessionSchema.ID) => Effect.Effect<Status, NotFoundError>
  readonly stopResponse: (sessionID: SessionSchema.ID) => Effect.Effect<StopResponseResult, NotFoundError>
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<ResumeResult, NotFoundError>
  readonly stopAll: (sessionID: SessionSchema.ID) => Effect.Effect<StopAllResult, NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTaskControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const jobs = yield* Job.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service

    const get = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* new NotFoundError({ sessionID })
      return session
    })

    const children = (parentSessionID: SessionSchema.ID) =>
      jobs.list.pipe(
        Effect.map((all) =>
          all.flatMap((job) =>
            job.recovery?.kind === "subagent" && job.recovery.parentSessionID === parentSessionID
              ? [{ job, recovery: job.recovery }]
              : [],
          ),
        ),
      )

    const status: Interface["status"] = Effect.fn("SessionTaskControl.status")(function* (sessionID) {
      yield* get(sessionID)
      const owned = yield* children(sessionID)
      return Status.make({
        paused: yield* jobs.paused(sessionID),
        active: yield* execution.isActive(sessionID),
        background: owned.map(({ job, recovery }) =>
          SessionTask.Background.make({
            sessionID: recovery.childSessionID,
            agent: recovery.agent,
            description: recovery.description,
            status: job.status,
          }),
        ),
      })
    })

    const stopResponse: Interface["stopResponse"] = Effect.fn("SessionTaskControl.stopResponse")(function* (sessionID) {
      yield* get(sessionID)
      // Pause before interrupting so a completion racing the interruption is retained, not delivered.
      yield* jobs.pause(sessionID)
      const interrupted = yield* execution.interrupt(sessionID, { reason: "user" })
      return StopResponseResult.make({ interrupted, paused: true })
    })

    const resume: Interface["resume"] = Effect.fn("SessionTaskControl.resume")(function* (sessionID) {
      yield* get(sessionID)
      const paused = yield* jobs.paused(sessionID)
      yield* jobs.unpause(sessionID)
      // The doorbell drains retained completions already admitted to the inbox.
      yield* execution.wake(sessionID)
      return ResumeResult.make({ resumed: paused })
    })

    const cancelTree = (parentSessionID: SessionSchema.ID): Effect.Effect<Array<SessionSchema.ID>> =>
      Effect.gen(function* () {
        const owned = yield* children(parentSessionID)
        const cancelled: Array<SessionSchema.ID> = []
        for (const { job, recovery } of owned) {
          // Depth first: descendants are suppressed before their parent's notification could fire.
          cancelled.push(...(yield* cancelTree(recovery.childSessionID)))
          if (job.status !== "running") continue
          yield* execution.interrupt(recovery.childSessionID, { reason: "user" })
          yield* jobs.cancel(job.id, { suppress: true })
          cancelled.push(recovery.childSessionID)
        }
        return cancelled
      })

    const stopAll: Interface["stopAll"] = Effect.fn("SessionTaskControl.stopAll")(function* (sessionID) {
      yield* get(sessionID)
      const cancelled = yield* cancelTree(sessionID)
      const interrupted = yield* execution.interrupt(sessionID, { reason: "user" })
      return StopAllResult.make({ interrupted, cancelled })
    })

    return Service.of({ status, stopResponse, resume, stopAll })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Job.node, SessionExecution.node, SessionStore.node],
})

