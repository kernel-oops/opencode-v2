import { describe, expect } from "bun:test"
import { Context, Deferred, Duration, Effect, Fiber, Layer, LayerMap, RcMap, Schema } from "effect"
import { TestClock } from "effect/testing"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Form } from "@opencode/core/form"
import { Location } from "@opencode/core/location"
import { LocationActivity } from "@opencode/core/location-activity"
import { LocationServiceMap, type LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { Pty } from "@opencode/core/pty"
import { PtyID } from "@opencode/core/pty/schema"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Workspace } from "@opencode/core/workspace"
import { testEffect } from "./lib/effect"

// Terminals reported by the fixture Pty service for every location.
let ptys: Pty.Info[] = []
const unavailable = () => Effect.die(new Error("not used by this fixture"))
const ptyFixture = Layer.succeed(
  Pty.Service,
  Pty.Service.of({
    list: () => Effect.sync(() => ptys),
    get: unavailable,
    create: unavailable,
    update: unavailable,
    remove: unavailable,
    write: unavailable,
    attach: unavailable,
  }),
)

// Keep real execution ownership, location caching, forms, and eviction. The fixture
// runner waits on a form instead of making a model request before asking a question.
const locations = Layer.effect(
  LocationServiceMap.Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const map = yield* LayerMap.make(
      (ref: Location.Ref) =>
        // The fixture only exercises these three Location services.
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        Layer.merge(
          Layer.succeed(
            Location.Service,
            Location.Service.of({
              directory: ref.directory,
              workspaceID: ref.workspaceID,
              project: { id: Project.ID.global, directory: ref.directory, canonical: ref.directory },
            }),
          ),
          Layer.effect(
            SessionRunner.Service,
            Effect.gen(function* () {
              const forms = yield* Form.Service
              return SessionRunner.Service.of({
                drain: ({ sessionID }) =>
                  forms
                    .ask({
                      sessionID,
                      title: "Questions",
                      fields: [{ key: "runtime", type: "string" }],
                    })
                    .pipe(
                      Effect.orDie,
                      Effect.as(SessionRunner.DrainResult.Complete()),
                      Effect.onInterrupt(() => Effect.sleep("5 minutes")),
                    ),
              })
            }),
          ),
        ).pipe(
          Layer.merge(ptyFixture),
          Layer.provideMerge(Form.layer),
          Layer.provide(Layer.succeed(Bus.Service, bus)),
          Layer.fresh,
        ) as unknown as Layer.Layer<LocationServices>,
      { idleTimeToLive: Duration.infinity },
    )
    return {
      ...map,
      get: (ref: Location.Ref) => map.get(LocationServiceMap.canonical(ref)),
      contextEffect: (ref: Location.Ref) => map.contextEffect(LocationServiceMap.canonical(ref)),
      contextEffectOption: (ref: Location.Ref) => map.contextEffectOption(LocationServiceMap.canonical(ref)),
      invalidate: (ref: Location.Ref) => map.invalidate(LocationServiceMap.canonical(ref)),
    }
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      LocationServiceMap.node,
      SessionExecution.node,
      LocationActivity.node,
    ]),
    [
      LocationServiceMap.node.replace(
        makeGlobalNode({
          service: LocationServiceMap.Service,
          layer: locations,
          deps: [Bus.node],
        }),
      ),
    ],
  ),
)

describe("LocationActivity eviction", () => {
  for (const [count, admission] of [
    [1, "none"],
    [2, "none"],
    [1, "other"],
    [1, "same"],
  ] as const) {
    const newWork = admission !== "none"
    it.effect(
      `interrupts ${count} waiting executions before eviction (${admission} session admitted during cleanup)`,
      () =>
        Effect.gen(function* () {
          const db = (yield* Database.Service).db
          const bus = yield* Bus.Service
          const map = yield* LocationServiceMap.Service
          const execution = yield* SessionExecution.Service
          const store = yield* SessionStore.Service
          const sessionIDs = Array.from({ length: count }, (_, index) =>
            Session.ID.make(`ses_waiting_question_${index}`),
          )
          const newcomer = admission === "same" ? sessionIDs[0] : Session.ID.make("ses_new_question")
          const ref = LocationServiceMap.canonical({ directory: AbsolutePath.make("/project") })
          const idle = Location.Ref.make({ directory: ref.directory, workspaceID: Workspace.ID.make("wrk_idle") })
          yield* db
            .insert(ProjectTable)
            .values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] })
            .run()
            .pipe(Effect.orDie)
          yield* db
            .insert(SessionTable)
            .values(
              Array.from(new Set([...sessionIDs, newcomer]), (sessionID) => ({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "question",
                directory: ref.directory,
                title: "Waiting question",
                version: "test",
              })),
            )
            .run()
            .pipe(Effect.orDie)

          const created = yield* Deferred.make<void>()
          const newCreated = yield* Deferred.make<void>()
          const pending: Form.Info[] = []
          const interrupted: SessionEvent.Execution.Interrupted["data"][] = []
          const unsubscribe = yield* bus.listen((event) =>
            Effect.gen(function* () {
              if (event.type === SessionEvent.Execution.Interrupted.type) {
                interrupted.push(Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted.data)(event.data))
              }
              if (event.type !== Form.Event.Created.type) return
              pending.push(Schema.decodeUnknownSync(Form.Event.Created.data)(event.data).form)
              if (pending.length === count) yield* Deferred.succeed(created, undefined)
              if (pending.length > count) yield* Deferred.succeed(newCreated, undefined)
            }),
          )
          yield* Effect.addFinalizer(() => unsubscribe)
          const running = yield* Effect.forEach(sessionIDs, (sessionID) =>
            execution.resume(sessionID).pipe(Effect.exit, Effect.forkScoped),
          )
          yield* Effect.addFinalizer(() =>
            Effect.forEach([...sessionIDs, newcomer], (sessionID) => execution.interrupt(sessionID)).pipe(
              Effect.andThen(TestClock.adjust("5 minutes")),
            ),
          )
          yield* Deferred.await(created)
          const context = yield* map.contextEffect(ref).pipe(Effect.scoped)
          const forms = Context.get(context, Form.Service)
          expect((yield* store.listSuspended()).toSorted()).toEqual(sessionIDs.toSorted())
          yield* Location.Service.pipe(Effect.provide(map.get(idle)), Effect.scoped)

          // Human input produces no durable activity while the question is pending.
          yield* TestClock.adjust("1 minute")
          yield* TestClock.adjust("62 minutes")
          // Interruption has cancelled each question, but slow cleanup still owns the graph.
          expect(Array.from(yield* execution.active).toSorted()).toEqual(sessionIDs.toSorted())
          expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])
          expect(yield* forms.list()).toEqual([])
          for (const form of pending) expect(yield* forms.state(form.id)).toEqual({ status: "cancelled" })

          if (newWork) {
            yield* execution.wake(newcomer)
            if (admission === "other") yield* Deferred.await(newCreated)
          }
          yield* TestClock.adjust("5 minutes")
          if (newWork) yield* Deferred.await(newCreated)
          const results = yield* Effect.forEach(running, Fiber.join)
          expect(results.every((exit) => exit._tag === "Failure")).toBe(true)
          expect(Array.from(yield* execution.active)).toEqual(newWork ? [newcomer] : [])
          expect(yield* store.listSuspended()).toEqual(newWork ? [newcomer] : [])
          expect(interrupted.toSorted((a, b) => a.sessionID.localeCompare(b.sessionID))).toEqual(
            sessionIDs.map((sessionID) => ({ sessionID, reason: "inactivity" })),
          )
          expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual(newWork ? [ref] : [])
          if (newWork) {
            expect(yield* forms.list({ sessionID: newcomer })).toEqual([pending[count]])
            if (admission === "same") {
              const later = LocationServiceMap.canonical({ directory: AbsolutePath.make("/later") })
              yield* Location.Service.pipe(Effect.provide(map.get(later)), Effect.scoped)
              yield* TestClock.adjust("30 minutes")
              // Keep fresh work active while a different graph reaches its own deadline.
              yield* bus.publish(SessionEvent.Execution.Started, { sessionID: newcomer }, { location: ref })
              yield* TestClock.adjust("32 minutes")
              expect(Array.from(yield* execution.active)).toEqual([newcomer])
              expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])
            }
            yield* execution.interrupt(newcomer)
            yield* TestClock.adjust("5 minutes")
            yield* execution.awaitIdle(newcomer)
            yield* TestClock.adjust("62 minutes")
            expect(yield* store.listSuspended()).toEqual([])
            expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([])
          }
        }),
    )
  }
})

describe("LocationActivity time to live", () => {
  it.effect("keeps the upstream default without the environment override", () =>
    Effect.sync(() => {
      expect(LocationActivity.timeToLiveFromEnvironment(undefined)).toEqual({})
      expect(LocationActivity.timeToLiveFromEnvironment("")).toEqual({})
    }),
  )

  it.effect("accepts an integer of at least one hour", () =>
    Effect.sync(() => {
      expect(LocationActivity.timeToLiveFromEnvironment("7200000")).toEqual({ timeToLive: Duration.millis(7_200_000) })
      expect(LocationActivity.timeToLiveFromEnvironment("3600000")).toEqual({ timeToLive: Duration.hours(1) })
    }),
  )

  for (const value of ["59000", "0", "-1", "abc", "1.5", "3599999"]) {
    it.effect(`warns and ignores ${JSON.stringify(value)}`, () =>
      Effect.sync(() => {
        const result = LocationActivity.timeToLiveFromEnvironment(value)
        expect(result.timeToLive).toBeUndefined()
        expect(result.warning).toContain(LocationActivity.TimeToLiveVariable)
      }),
    )
  }
})

describe("LocationActivity running terminals", () => {
  it.effect("retains a location with a running terminal until it exits", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const bus = yield* Bus.Service
      const map = yield* LocationServiceMap.Service
      const execution = yield* SessionExecution.Service
      const sessionID = Session.ID.make("ses_terminal_question")
      const ref = LocationServiceMap.canonical({ directory: AbsolutePath.make("/terminal") })
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: ref.directory, sandboxes: [] })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Project.ID.global,
          slug: "terminal",
          directory: ref.directory,
          title: "Waiting question",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)

      const created = yield* Deferred.make<void>()
      const interrupted: SessionEvent.Execution.Interrupted["data"][] = []
      const unsubscribe = yield* bus.listen((event) =>
        Effect.gen(function* () {
          if (event.type === SessionEvent.Execution.Interrupted.type) {
            interrupted.push(Schema.decodeUnknownSync(SessionEvent.Execution.Interrupted.data)(event.data))
          }
          if (event.type === Form.Event.Created.type) yield* Deferred.succeed(created, undefined)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)
      const terminal: Pty.Info = {
        id: PtyID.make("pty_fixture"),
        title: "shell",
        command: "sh",
        args: [],
        cwd: ref.directory,
        status: "running",
        pid: 1,
      }
      ptys = [terminal]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          ptys = []
        }).pipe(Effect.andThen(execution.interrupt(sessionID)), Effect.andThen(TestClock.adjust("5 minutes"))),
      )
      const running = yield* execution.resume(sessionID).pipe(Effect.exit, Effect.forkScoped)
      yield* Deferred.await(created)

      yield* TestClock.adjust("1 minute")
      yield* TestClock.adjust("62 minutes")
      // The terminal keeps the graph alive; nothing is interrupted or evicted.
      expect(interrupted).toEqual([])
      expect(Array.from(yield* execution.active)).toEqual([sessionID])
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([ref])

      ptys = [{ ...terminal, status: "exited", exitCode: 0 }]
      yield* TestClock.adjust("30 minutes")
      expect(interrupted).toEqual([])
      yield* TestClock.adjust("32 minutes")
      yield* TestClock.adjust("5 minutes")
      const exit = yield* Fiber.join(running)
      expect(exit._tag).toBe("Failure")
      expect(interrupted).toEqual([{ sessionID, reason: "inactivity" }])
      expect(Array.from(yield* execution.active)).toEqual([])
      expect(Array.from(yield* RcMap.keys(map.rcMap))).toEqual([])
    }),
  )
})
