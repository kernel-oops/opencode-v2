/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal } from "solid-js"
import {
  createTaskPager,
  emergencyStopReady,
  nativeTaskStatus,
  pausedMessage,
  stopAllAvailable,
  taskControlClient,
  taskRunOptions,
  TaskControls,
  type TaskControlSnapshot,
} from "../../../src/component/task-controls"
import { emptyThemeSource, tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const snapshot = (input: Partial<TaskControlSnapshot> = {}): TaskControlSnapshot => ({
  revision: "r1",
  mode: "active",
  running: 0,
  cancelling: 0,
  paused: false,
  draining: false,
  stopped: false,
  hasMore: false,
  runs: [],
  ...input,
})

test("stop-all availability considers background work, not only the response", () => {
  expect(stopAllAvailable("idle")).toBe(false)
  expect(stopAllAvailable("running")).toBe(true)
  expect(stopAllAvailable("idle", snapshot({ running: 1 }))).toBe(true)
  expect(stopAllAvailable("idle", snapshot({ cancelling: 1 }))).toBe(true)
  expect(emergencyStopReady(1)).toBe(false)
  expect(emergencyStopReady(2)).toBe(true)
})

test("dispatch receipts never become execution status", () => {
  expect(nativeTaskStatus(undefined)).toBeUndefined()
  expect(nativeTaskStatus("run-1")).toBe("unobserved")
  const run = { id: "run-2", childID: "child", status: "completed", background: true, delivery: "handled" } as const
  expect(nativeTaskStatus("run-1", run)).toBe("unobserved")
  expect(nativeTaskStatus("run-2", run)).toBe("completed")
  expect(pausedMessage(1)).toContain("1 background task ")
  expect(pausedMessage(2)).toContain("2 background tasks ")
})

test("run options offer cancellation only for running tasks", () => {
  const calls: string[] = []
  const options = taskRunOptions(
    [
      { id: "a", childID: "child-a", status: "running", background: true, delivery: "pending" },
      { id: "b", childID: "child-b", status: "completed", background: true, delivery: "handled" },
    ],
    { result: (id) => calls.push(`result:${id}`), cancel: (id) => calls.push(`cancel:${id}`) },
  )
  expect(options.map((option) => option.value)).toEqual(["a:result", "a:cancel", "b:result"])
  options[1]!.onSelect()
  options[2]!.onSelect()
  expect(calls).toEqual(["cancel:a", "result:b"])
})

test("client detection requires every task-control endpoint", () => {
  expect(taskControlClient(undefined)).toBeUndefined()
  expect(taskControlClient({ session: { interrupt: async () => ({}) } })).toBeUndefined()
  const complete = Object.fromEntries(
    ["taskControl", "stopResponse", "resumeController", "cancelTask", "taskResult", "abort"].map((name) => [
      name,
      async () => ({ response: { status: 200 } }),
    ]),
  )
  expect(taskControlClient({ session: complete })).toBeDefined()
})

test("pager pages forward and back, and recovers from a stale cursor", async () => {
  const requests: { mode?: string; cursor?: string }[] = []
  const pages: Record<string, TaskControlSnapshot> = {
    first: snapshot({ nextCursor: "c2" }),
    c2: snapshot({ nextCursor: "c3" }),
    c3: snapshot(),
  }
  let stale = false
  const client = {
    taskControl: async (input: { mode?: "active" | "history"; cursor?: string }) => {
      requests.push({ mode: input.mode, cursor: input.cursor })
      if (stale && input.cursor) {
        stale = false
        return { response: { status: 409 } }
      }
      return { data: pages[input.cursor ?? "first"], response: { status: 200 } }
    },
  }
  const published: TaskControlSnapshot[] = []
  const [sessionID] = createSignal("session-1")
  const pager = createTaskPager(client as never, () => ({ sessionID: sessionID() }), (value) => published.push(value))
  await pager.refresh()
  await pager.navigate("next")
  await pager.navigate("next")
  expect(requests.map((request) => request.cursor)).toEqual([undefined, "c2", "c3"])
  expect(pager.canPrevious()).toBe(true)
  await pager.navigate("previous")
  expect(requests.at(-1)?.cursor).toBe("c2")
  stale = true
  await pager.navigate("next")
  expect(requests.slice(-2).map((request) => request.cursor)).toEqual(["c3", undefined])
  expect(pager.canPrevious()).toBe(false)
  await pager.navigate("history")
  expect(requests.at(-1)).toEqual({ mode: "history", cursor: undefined })
  expect(published.length).toBe(requests.length - 1)
})

test("controls render the paused warning and resume action from a snapshot", async () => {
  await using tmp = await tmpdir()
  const root = tmp.path
  const state = path.join(root, "state")
  await mkdir(state, { recursive: true })
  const config = createTuiResolvedConfig()
  const [{ ConfigProvider }, { ThemeProvider }] = await Promise.all([
    import("../../../src/config"),
    import("../../../src/context/theme"),
  ])
  const [current, setCurrent] = createSignal<TaskControlSnapshot | undefined>(
    snapshot({ paused: true, running: 2, nextCursor: "c2" }),
  )
  const calls: string[] = []
  const controls = {
    snapshot: current,
    stop: async () => void calls.push("stop"),
    resume: async () => void calls.push("resume"),
    all: async () => void calls.push("all"),
    tasks: () => void calls.push("tasks"),
    navigate: async (action: string) => void calls.push(`navigate:${action}`),
    canPrevious: () => false,
  }
  const app = await testRender(
    () => (
      <TestTuiContexts directory={root} paths={{ home: root, state, worktree: root }}>
        <ConfigProvider config={config}>
          <ThemeProvider mode="dark" source={emptyThemeSource}>
            <TaskControls controls={controls} />
          </ThemeProvider>
        </ConfigProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 12 },
  )
  try {
    await app.waitForFrame((frame) => frame.includes("Resume controller"))
    const frame = app.captureCharFrame()
    expect(frame).toContain(pausedMessage(2))
    expect(frame).toContain("Stop all work")
    expect(frame).toContain("Stop response only")
    expect(frame).toContain("Tasks (2 running, 0 cancelling)")
    expect(frame).toContain("Next page")
    expect(frame).not.toContain("Previous page")
    setCurrent(snapshot({ paused: true, draining: true, running: 2 }))
    await app.waitForFrame((frame) => frame.includes("Stopping response. Automatic continuation paused."))
    expect(app.captureCharFrame()).not.toContain("Resume controller")
    setCurrent(undefined)
    await app.waitForFrame((frame) => !frame.includes("Stop all work"))
  } finally {
    app.renderer.destroy()
  }
})
