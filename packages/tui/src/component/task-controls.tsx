/** @jsxImportSource @opentui/solid */
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"

// Server contract this component expects. OpenCode 2.0.3 does not expose these
// endpoints; the kernel-oops task-control port must add them to the server API and
// regenerate `@opencode/client` (`bun run generate` in packages/client). Until then
// `useTaskControls` detects their absence and renders nothing.
export type TaskRunStatus = "running" | "cancelling" | "cancelled" | "completed" | "failed" | "interrupted"

export type TaskRun = {
  readonly id: string
  readonly childID: string
  readonly status: TaskRunStatus
  readonly background: boolean
  readonly delivery: "pending" | "started" | "handled" | "attention" | "suppressed"
}

export type TaskControlSnapshot = {
  readonly revision: string
  readonly mode: "active" | "history"
  readonly running: number
  readonly cancelling: number
  readonly paused: boolean
  readonly draining: boolean
  readonly stopped: boolean
  readonly hasMore: boolean
  readonly nextCursor?: string
  readonly runs: readonly TaskRun[]
}

type Params = { readonly sessionID: string }
type Result<T> = { data?: T; error?: unknown; response: { status: number } }

export interface TaskControlClient {
  /** GET /session/:id/task-control?mode=&cursor= — bounded page of runs plus controller state. 409 for a stale cursor. */
  taskControl: (input: Params & { mode?: "active" | "history"; cursor?: string }) => Promise<Result<TaskControlSnapshot>>
  /** POST /session/:id/stop-response — pause callbacks, interrupt the response, drain foreground work only. */
  stopResponse: (input: Params) => Promise<Result<unknown>>
  /** POST /session/:id/resume-controller — release the callback pause; `revision` guards a stale view. */
  resumeController: (input: Params & { revision?: string }) => Promise<Result<unknown>>
  /** POST /session/:id/task/:runID/cancel — cancel one background run. */
  cancelTask: (input: Params & { runID: string }) => Promise<Result<unknown>>
  /** GET /session/:id/task/:runID/result — retained output text of a terminal run. */
  taskResult: (input: Params & { runID: string }) => Promise<Result<string>>
  /** POST /session/:id/abort — stop the parent and its owned Task tree (emergency stop). */
  abort: (input: Params) => Promise<Result<unknown>>
}

export function taskControlClient(api: unknown): TaskControlClient | undefined {
  const session = (api as { session?: Record<string, unknown> } | undefined)?.session
  if (!session) return
  const names = ["taskControl", "stopResponse", "resumeController", "cancelTask", "taskResult", "abort"] as const
  if (!names.every((name) => typeof session[name] === "function")) return
  return Object.fromEntries(
    names.map((name) => [name, (input: unknown) => (session[name] as (input: unknown) => Promise<unknown>)(input)]),
  ) as unknown as TaskControlClient
}

export const stopAllAvailable = (status: string, snapshot?: TaskControlSnapshot) =>
  status !== "idle" || (snapshot?.running ?? 0) > 0 || (snapshot?.cancelling ?? 0) > 0
export const emergencyStopReady = (presses: number) => presses >= 2

export const taskStatusLabel = (status: string) =>
  ({
    running: "Running",
    cancelling: "Cancelling",
    cancelled: "Cancelled",
    completed: "Completed",
    failed: "Failed",
    interrupted: "Interrupted — execution state unknown",
    unobserved: "Status not on this page — use active tasks or task history",
  })[status] ?? status

/** A dispatch receipt is not execution status, and a bounded page is not an exhaustive registry. */
export function nativeTaskStatus(runID: unknown, run?: TaskRun) {
  if (typeof runID !== "string") return
  return run?.id === runID ? run.status : "unobserved"
}

export const pausedMessage = (count: number) =>
  `Response stopped. ${count} background ${count === 1 ? "task" : "tasks"} still running. Automatic continuation paused.`

export function taskRunOptions(
  runs: readonly TaskRun[],
  actions: { result: (runID: string) => void; cancel: (runID: string) => void },
) {
  return runs.flatMap((run) => [
    {
      title: `${taskStatusLabel(run.status)} — ${run.childID}`,
      value: `${run.id}:result`,
      onSelect: () => actions.result(run.id),
    },
    ...(run.status === "running"
      ? [{ title: `Cancel task — ${run.childID}`, value: `${run.id}:cancel`, onSelect: () => actions.cancel(run.id) }]
      : []),
  ])
}

export type TaskPageAction = "active" | "history" | "first" | "previous" | "next"

export function createTaskPager(
  client: TaskControlClient,
  params: () => Params,
  publish: (value: TaskControlSnapshot) => void,
) {
  let mode: "active" | "history" = "active"
  let cursor: string | undefined
  const [previous, setPrevious] = createSignal<(string | undefined)[]>([])
  let scope = ""
  let snapshot: TaskControlSnapshot | undefined
  let pending: Promise<void> | undefined
  const reset = (key: string) => {
    scope = key
    mode = "active"
    cursor = undefined
    setPrevious([])
    snapshot = undefined
  }
  const refresh = (): Promise<void> => {
    if (pending) return pending
    const request = params()
    const key = JSON.stringify(request)
    if (scope !== key) reset(key)
    pending = (async () => {
      let result = await client.taskControl({ ...request, mode, cursor })
      if (result.response.status === 409 && cursor) {
        cursor = undefined
        setPrevious([])
        result = await client.taskControl({ ...request, mode })
      }
      if (JSON.stringify(params()) !== key) return
      if (!result.data) throw result.error
      snapshot = result.data
      publish(result.data)
    })().finally(() => {
      pending = undefined
    })
    return pending
  }
  const navigate = async (action: TaskPageAction) => {
    await pending
    const key = JSON.stringify(params())
    if (scope !== key) reset(key)
    if (action === "next") {
      if (!snapshot?.nextCursor) return
      setPrevious((value) => [...value, cursor])
      cursor = snapshot.nextCursor
    } else if (action === "previous") {
      if (!previous().length) return
      cursor = previous().at(-1)
      setPrevious((value) => value.slice(0, -1))
    } else {
      if (action !== "first") mode = action
      cursor = undefined
      setPrevious([])
    }
    await refresh()
  }
  return { refresh, navigate, canPrevious: () => previous().length > 0 }
}

export type TaskControlsActions = {
  snapshot: () => TaskControlSnapshot | undefined
  stop: () => Promise<void>
  resume: () => Promise<void>
  all: () => Promise<void>
  tasks: () => void
  navigate: (action: TaskPageAction) => Promise<void>
  canPrevious: () => boolean
}

/** Shared by the real controller and palette integration tests. No new shortcut or execution authority. */
export function useTaskControlBindings(
  snapshot: () => TaskControlSnapshot | undefined,
  actions: Pick<TaskControlsActions, "stop" | "resume" | "all" | "tasks">,
) {
  Keymap.createLayer(() => ({
    mode: "global",
    commands: [
      {
        id: "session.stop-response",
        title: "Stop response only",
        group: "Session",
        palette: true,
        bind: false,
        enabled: !!snapshot() && !snapshot()?.draining,
        run: () => void actions.stop(),
      },
      {
        id: "session.resume-controller",
        title: "Resume controller",
        group: "Session",
        palette: true,
        bind: false,
        enabled: !!snapshot()?.paused && !snapshot()?.draining && !snapshot()?.stopped,
        run: () => void actions.resume(),
      },
      {
        id: "session.stop-all",
        title: "Stop all work",
        group: "Session",
        palette: true,
        bind: false,
        enabled: !!snapshot(),
        run: () => void actions.all(),
      },
      {
        id: "session.task-controls",
        title: "Background tasks and controller",
        group: "Session",
        palette: true,
        bind: false,
        enabled: !!snapshot(),
        run: actions.tasks,
      },
    ],
  }))
}

export function useTaskControls(sessionID: () => string | undefined): TaskControlsActions {
  const client = useClient()
  const dialog = useDialog()
  const [snapshots, setSnapshots] = createSignal<Record<string, TaskControlSnapshot>>({})
  const snapshot = () => snapshots()[sessionID() ?? ""]
  const params = () => ({ sessionID: sessionID()! })
  const control = () => taskControlClient(client.api)
  const publish = (value: TaskControlSnapshot) =>
    setSnapshots((current) => ({ ...current, [params().sessionID]: value }))
  let pager: ReturnType<typeof createTaskPager> | undefined
  const current = () => {
    const api = control()
    if (!api) return (pager = undefined)
    return (pager ??= createTaskPager(api, params, publish))
  }
  const refresh = () => (!sessionID() ? Promise.resolve() : (current()?.refresh() ?? Promise.resolve()))
  createEffect(() => {
    sessionID()
    void refresh().catch(() => {})
    const timer = setInterval(() => void refresh().catch(() => {}), 2000)
    onCleanup(() => clearInterval(timer))
  })
  const act = async (work: () => Promise<unknown>, refreshAfter = true) => {
    try {
      await work()
      if (refreshAfter) await refresh()
    } catch (error) {
      dialog.replace(() => (
        <DialogAlert title="Task control failed" message={error instanceof Error ? error.message : String(error)} />
      ))
    }
  }
  const call = async <T,>(request: Promise<Result<T>>) => {
    const result = await request
    if (result.error) throw result.error
    return result.data
  }
  const api = () => {
    const value = control()
    if (!value) throw new Error("Task controls are not available on this server")
    return value
  }
  const stop = () => act(() => call(api().stopResponse(params())))
  const resume = () => act(() => call(api().resumeController({ ...params(), revision: snapshot()?.revision })))
  const all = () =>
    new Promise<void>((resolve) => {
      dialog.replace(() => (
        <DialogConfirm
          title="Stop all work"
          message="Stop this response and every background task it owns? Completed results already retained are kept."
          initial="cancel"
          label={{ confirm: "Stop all work", cancel: "Cancel" }}
          onConfirm={() => void act(() => call(api().abort(params()))).finally(resolve)}
          onCancel={resolve}
        />
      ))
    })
  const navigate = (action: TaskPageAction) => act(() => current()?.navigate(action) ?? Promise.resolve(), false)
  const tasks = () =>
    dialog.replace(() => (
      <DialogSelect
        title={
          snapshot()?.mode === "history"
            ? "All task history — up to 100 runs per page"
            : "Active tasks — up to 100 runs per page"
        }
        options={[
          ...(["active", "history", "first", "previous", "next"] as const).map((action) => ({
            title: {
              active: "Active tasks",
              history: "All task history",
              first: "Refresh first page",
              previous: "Previous page",
              next: "Next page",
            }[action],
            value: `page:${action}`,
            disabled:
              (action === "next" && !snapshot()?.nextCursor) || (action === "previous" && !current()?.canPrevious()),
            onSelect: () => void navigate(action),
          })),
          ...taskRunOptions(snapshot()?.runs ?? [], {
            result: (runID) =>
              void act(async () => {
                const result = await call(api().taskResult({ ...params(), runID }))
                dialog.replace(() => <DialogAlert title="Retained Task result" message={result ?? "No output retained"} />)
              }),
            cancel: (runID) => void act(() => call(api().cancelTask({ ...params(), runID }))),
          }),
        ]}
      />
    ))
  useTaskControlBindings(snapshot, { stop, resume, all, tasks })
  return { snapshot, stop, resume, all, tasks, navigate, canPrevious: () => current()?.canPrevious() ?? false }
}

export function TaskControls(props: { controls: TaskControlsActions }) {
  const theme = useTheme()
  return (
    <Show when={props.controls.snapshot()}>
      {(state) => (
        <box flexDirection="column" paddingLeft={2}>
          <Show when={state().paused}>
            <text fg={theme.text.feedback.warning.default}>
              {state().draining ? "Stopping response. Automatic continuation paused." : pausedMessage(state().running)}
            </text>
          </Show>
          <box flexDirection="row" gap={2}>
            <text fg={theme.text.default} onMouseUp={() => void props.controls.all()}>
              Stop all work
            </text>
            <text fg={theme.text.default} onMouseUp={() => void props.controls.stop()}>
              Stop response only
            </text>
            <Show when={state().paused && !state().stopped && !state().draining}>
              <text fg={theme.text.default} onMouseUp={() => void props.controls.resume()}>
                Resume controller
              </text>
            </Show>
          </box>
          <box flexDirection="row" gap={2}>
            <text fg={theme.text.subdued} onMouseUp={props.controls.tasks}>
              Tasks ({state().running} running, {state().cancelling} cancelling)
            </text>
            <text fg={theme.text.subdued} onMouseUp={() => void props.controls.navigate("active")}>
              Active tasks
            </text>
            <text fg={theme.text.subdued} onMouseUp={() => void props.controls.navigate("history")}>
              All task history
            </text>
          </box>
          <box flexDirection="row" gap={2}>
            <text fg={theme.text.subdued} onMouseUp={() => void props.controls.navigate("first")}>
              Refresh first page
            </text>
            <Show when={props.controls.canPrevious()}>
              <text fg={theme.text.subdued} onMouseUp={() => void props.controls.navigate("previous")}>
                Previous page
              </text>
            </Show>
            <Show when={state().nextCursor}>
              <text fg={theme.text.subdued} onMouseUp={() => void props.controls.navigate("next")}>
                Next page
              </text>
            </Show>
          </box>
        </box>
      )}
    </Show>
  )
}
