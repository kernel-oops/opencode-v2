/** @jsxImportSource @opentui/solid */
import type { OpenCodeClient, SessionTaskBackground, SessionTaskStatus } from "@opencode/client"
import { createEffect, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { Keymap } from "../context/keymap"
import { useClient } from "../context/client"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"

export type TaskControlSnapshot = SessionTaskStatus
export type TaskBackground = SessionTaskBackground

// Latest status per parent session, shared between the prompt controls and the
// Subagent rows in the session view. Bounded observation only: a stale or absent
// entry never implies completion.
const [statuses, setStatuses] = createStore<Record<string, TaskControlSnapshot | undefined>>({})
export const taskStatus = (sessionID: string | undefined) => (sessionID ? statuses[sessionID] : undefined)
export const taskBackground = (parentID: string | undefined, childID: string | undefined) =>
  childID ? taskStatus(parentID)?.background.find((task) => task.sessionID === childID) : undefined
// A continued subagent reuses its session, and the parent's background entry follows the latest call on it:
// a Subagent card owns the entry only when it is the call the entry describes.
export const cardTask = <T extends { description?: string }>(task: T | undefined, description: string | undefined) =>
  task && task.description === description ? task : undefined
/**
 * The child session a Subagent card opens. Tool metadata carries it once reported, but a running call's
 * progress metadata is not stored, so a TUI that reconnected mid-run has none: a continuation names its
 * session in its input, and a new call is matched to the parent's one task with the same description.
 */
export const cardSession = (
  parentID: string | undefined,
  reported: string | undefined,
  continued: string | undefined,
  description: string | undefined,
) => {
  if (reported ?? continued) return reported ?? continued
  const matches = taskStatus(parentID)?.background.filter((task) => task.description === description) ?? []
  return matches.length === 1 ? matches[0].sessionID : undefined
}
export const publishTaskStatus = (sessionID: string, value: TaskControlSnapshot | undefined) =>
  setStatuses(sessionID, value ? reconcile(value) : undefined)

export const runningTasks = (snapshot?: TaskControlSnapshot) =>
  snapshot?.background.filter((task) => task.status === "running").length ?? 0
export const stopAllAvailable = (status: string, snapshot?: TaskControlSnapshot) =>
  status !== "idle" || snapshot?.active === true || runningTasks(snapshot) > 0
export const emergencyStopReady = (presses: number) => presses >= 2

export const taskStatusLabel = (status: string) =>
  ({ running: "Running", completed: "Completed", error: "Failed", cancelled: "Cancelled" })[status] ?? status

/** Badge text for a Subagent row; a running background task is labelled as such, terminal states by outcome. */
export const taskBadge = (task?: TaskBackground) =>
  task ? (task.status === "running" ? "Background" : taskStatusLabel(task.status)) : undefined

export const pausedMessage = (count: number) =>
  `Response stopped. ${count} background ${count === 1 ? "task" : "tasks"} still running. Automatic continuation paused.`

export function taskOptions(tasks: readonly TaskBackground[], open: (sessionID: string) => void) {
  return tasks.map((task) => ({
    title: `${taskStatusLabel(task.status)} — ${task.agent}: ${task.description}`,
    value: task.sessionID,
    onSelect: () => open(task.sessionID),
  }))
}

type TaskApi = OpenCodeClient["session"]["task"]

export const taskApi = (api: OpenCodeClient): TaskApi | undefined =>
  typeof (api as { session?: { task?: Partial<TaskApi> } }).session?.task?.status === "function"
    ? api.session.task
    : undefined

export type TaskControlsActions = {
  snapshot: () => TaskControlSnapshot | undefined
  stop: () => Promise<void>
  resume: () => Promise<void>
  all: () => Promise<void>
  tasks: () => void
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
        enabled: !!snapshot() && !snapshot()?.paused,
        run: () => void actions.stop(),
      },
      {
        id: "session.resume-controller",
        title: "Resume controller",
        group: "Session",
        palette: true,
        bind: false,
        enabled: !!snapshot()?.paused,
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

const POLL_MS = 2000
const UNAVAILABLE_MS = 30_000

export function useTaskControls(sessionID: () => string | undefined): TaskControlsActions {
  const client = useClient()
  const dialog = useDialog()
  const { navigate } = useRoute()
  const snapshot = () => taskStatus(sessionID())
  const params = () => ({ sessionID: sessionID()! })
  // A server without the task endpoints answers with an error; back off instead of polling it every tick.
  let unavailableUntil = 0
  let pending: Promise<void> | undefined
  const refresh = () => {
    const id = sessionID()
    const api = taskApi(client.api)
    if (!id || !api || Date.now() < unavailableUntil) return Promise.resolve()
    if (pending) return pending
    pending = api
      .status({ sessionID: id })
      .then((value) => {
        if (sessionID() === id) publishTaskStatus(id, value)
      })
      .catch(() => {
        unavailableUntil = Date.now() + UNAVAILABLE_MS
        publishTaskStatus(id, undefined)
      })
      .finally(() => (pending = undefined))
    return pending
  }
  createEffect(() => {
    sessionID()
    unavailableUntil = 0
    void refresh()
    const timer = setInterval(() => void refresh(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })
  const api = () => {
    const value = taskApi(client.api)
    if (!value) throw new Error("Task controls are not available on this server")
    return value
  }
  const act = async (work: () => Promise<unknown>) => {
    try {
      await work()
      unavailableUntil = 0
      await refresh()
    } catch (error) {
      dialog.replace(() => (
        <DialogAlert title="Task control failed" message={error instanceof Error ? error.message : String(error)} />
      ))
    }
  }
  const stop = () => act(() => api().stopResponse(params()))
  const resume = () => act(() => api().resume(params()))
  const all = () =>
    new Promise<void>((resolve) => {
      dialog.replace(() => (
        <DialogConfirm
          title="Stop all work"
          message="Stop this response and every background task it owns? Results already delivered are kept."
          initial="cancel"
          label={{ confirm: "Stop all work", cancel: "Cancel" }}
          onConfirm={() => void act(() => api().stopAll(params())).finally(resolve)}
          onCancel={resolve}
        />
      ))
    })
  const tasks = () =>
    dialog.replace(() => (
      <DialogSelect
        title={`Background tasks (${runningTasks(snapshot())} running)`}
        emptyView={<text>No background tasks for this session.</text>}
        options={taskOptions(snapshot()?.background ?? [], (id) => {
          dialog.clear()
          navigate({ type: "session", sessionID: id })
        })}
      />
    ))
  useTaskControlBindings(snapshot, { stop, resume, all, tasks })
  return { snapshot, stop, resume, all, tasks }
}

export function TaskControls(props: { controls: TaskControlsActions }) {
  const theme = useTheme()
  const relevant = () => {
    const state = props.controls.snapshot()
    return state && (state.paused || state.active || runningTasks(state) > 0) ? state : undefined
  }
  return (
    <Show when={relevant()}>
      {(state) => (
        <box flexDirection="column" paddingLeft={2}>
          <Show when={state().paused}>
            <text fg={theme.text.feedback.warning.base}>{pausedMessage(runningTasks(state()))}</text>
          </Show>
          <box flexDirection="row" gap={2}>
            <text fg={theme.text.base} onMouseUp={() => void props.controls.all()}>
              Stop all work
            </text>
            <Show when={!state().paused}>
              <text fg={theme.text.base} onMouseUp={() => void props.controls.stop()}>
                Stop response only
              </text>
            </Show>
            <Show when={state().paused}>
              <text fg={theme.text.base} onMouseUp={() => void props.controls.resume()}>
                Resume controller
              </text>
            </Show>
            <text fg={theme.text.muted} onMouseUp={props.controls.tasks}>
              Background tasks ({runningTasks(state())} running)
            </text>
          </box>
        </box>
      )}
    </Show>
  )
}
