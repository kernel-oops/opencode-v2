export * as LocationActivity from "./location-activity.js"

import { Clock, Context, Duration, Effect, Layer, Option, RcMap, Schema } from "effect"
import { Bus } from "./bus.js"
import { Location } from "./location.js"
import { LocationServiceMap } from "./location-service-map.js"
import { Pty } from "./pty.js"
import { SessionEvent } from "./session/event.js"
import { SessionExecution } from "./session/execution.js"
import { SessionStore } from "./session/store.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"

const isSessionEvent = Schema.is(SessionEvent.Durable)

export class Service extends Context.Service<Service, {}>()("@opencode/LocationActivity") {}

export const TimeToLiveVariable = "OPENCODE_EXPERIMENTAL_INSTANCE_IDLE_TIMEOUT_MS"
export const DefaultTimeToLive = Duration.minutes(60)
export const MinimumTimeToLive = Duration.hours(1)

/** Operator override for the idle deadline; the default retains upstream behaviour. */
export function timeToLiveFromEnvironment(value: string | undefined): {
  readonly timeToLive?: Duration.Duration
  readonly warning?: string
} {
  if (value === undefined || value.trim() === "") return {}
  const millis = Number(value)
  if (Number.isInteger(millis) && millis >= Duration.toMillis(MinimumTimeToLive))
    return { timeToLive: Duration.millis(millis) }
  return {
    warning: `ignoring ${TimeToLiveVariable}: expected an integer of at least ${Duration.toMillis(MinimumTimeToLive)} ms`,
  }
}

export function layer(options: { readonly timeToLive?: Duration.Input; readonly sweepInterval?: Duration.Input } = {}) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const clock = yield* Clock.Clock
      const bus = yield* Bus.Service
      const locations = yield* LocationServiceMap.Service
      const execution = yield* SessionExecution.Service
      const sessions = yield* SessionStore.Service
      const timeToLive = Duration.toMillis(options.timeToLive ?? DefaultTimeToLive)
      const entries = new Map<string, { readonly ref: Location.Ref; expiresAt: number }>()
      const key = (ref: Location.Ref) => `${LocationServiceMap.canonical(ref).directory}\0${ref.workspaceID ?? ""}`
      const touch = (ref: Location.Ref) =>
        Effect.sync(() => {
          entries.set(key(ref), { ref, expiresAt: clock.currentTimeMillisUnsafe() + timeToLive })
        })

      // A running terminal is live work even when no session event has been published for a while.
      const runningPty = (ref: Location.Ref) =>
        locations.contextEffectOption(ref).pipe(
          Effect.flatMap((context) => {
            if (Option.isNone(context)) return Effect.succeed(false)
            const pty = Context.getOption(context.value, Pty.Service)
            if (Option.isNone(pty)) return Effect.succeed(false)
            return pty.value.list().pipe(Effect.map((list) => list.some((info) => info.status === "running")))
          }),
          Effect.scoped,
          Effect.catchCause(() => Effect.succeed(false)),
        )

      const unsubscribe = yield* bus.listen((event) => {
        if (!isSessionEvent(event)) return Effect.void
        const location = event.location
        if (!location) return Effect.void
        return RcMap.has(locations.rcMap, location).pipe(
          Effect.flatMap((active) => (active ? touch(location) : Effect.void)),
        )
      })
      yield* Effect.addFinalizer(() => unsubscribe)
      yield* Effect.gen(function* () {
        yield* Effect.sleep(options.sweepInterval ?? "1 minute")
        const refs = Array.from(yield* RcMap.keys(locations.rcMap))
        const cached = new Set(refs.map(key))
        yield* Effect.forEach(refs, (ref) => (entries.has(key(ref)) ? Effect.void : touch(ref)), { discard: true })
        for (const id of entries.keys()) {
          if (!cached.has(id)) entries.delete(id)
        }
        const now = clock.currentTimeMillisUnsafe()
        const expired = Array.from(entries.values()).filter((entry) => entry.expiresAt <= now)
        if (expired.length === 0) return
        const active = yield* Effect.forEach(yield* execution.active, (sessionID) => sessions.get(sessionID))
        yield* Effect.forEach(
          expired,
          (entry) =>
            Effect.gen(function* () {
              if (yield* runningPty(entry.ref)) {
                yield* touch(entry.ref)
                return
              }
              const owners = active.flatMap((session) =>
                session && key(session.location) === key(entry.ref) ? [session] : [],
              )
              // Invalidation only detaches the cache entry; borrowers retain the old
              // graph. Stop its executions and settle tool cleanup before detaching it.
              yield* Effect.forEach(
                owners,
                (session) => execution.interrupt(session.id, { reason: "inactivity", awaitSettlement: true }),
                {
                  discard: true,
                  concurrency: "unbounded",
                },
              )
              const remaining = yield* Effect.forEach(yield* execution.active, (sessionID) => sessions.get(sessionID))
              // New work admitted during cleanup may now own the cached graph.
              if (remaining.some((session) => session && key(session.location) === key(entry.ref))) {
                yield* touch(entry.ref)
                return
              }
              entries.delete(key(entry.ref))
              yield* Effect.logInfo("location services evicted", {
                directory: entry.ref.directory,
                workspaceID: entry.ref.workspaceID,
              }).pipe(Effect.andThen(locations.invalidate(entry.ref)))
            }),
          { discard: true, concurrency: "unbounded" },
        )
      }).pipe(Effect.forever, Effect.forkScoped)

      return Service.of({})
    }),
  )
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.unwrap(
    Effect.gen(function* () {
      const configured = timeToLiveFromEnvironment(process.env[TimeToLiveVariable])
      if (configured.warning) yield* Effect.logWarning(configured.warning)
      if (configured.timeToLive)
        yield* Effect.logInfo("location idle eviction configured", {
          timeToLive: Duration.toMillis(configured.timeToLive),
        })
      return layer(configured.timeToLive ? { timeToLive: configured.timeToLive } : {})
    }),
  ),
  deps: [Bus.node, LocationServiceMap.node, SessionExecution.node, SessionStore.node],
})
