import { Plugin } from "@opencode/plugin/tui"
import type { SlotMap } from "@opencode/plugin/tui/context"
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import { createStore } from "solid-js/store"

// Mirrors config-v2/opencode/plugins/native-claude-delegate/rpc.ts. Duplicated because that module
// lives outside the compiled TUI (see tui-plugins/native-claude-delegate/tui.js's own note) and
// cannot be imported here - keep this literal in step with the config-side source by hand.
const nativeClaudeDelegateRpc = {
  id: "native-claude-delegate",
  methods: {},
  events: {
    chunk: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          callID: { type: "string" },
          seq: { type: "integer", minimum: 0 },
          text: { type: "string" },
          label: { type: "string" },
        },
        required: ["sessionID", "callID", "seq", "text"],
        additionalProperties: false,
      },
    },
    done: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          callID: { type: "string" },
          seq: { type: "integer", minimum: 0 },
          status: { type: "string", enum: ["completed", "error"] },
          message: { type: "string" },
          label: { type: "string" },
        },
        required: ["sessionID", "callID", "seq", "status", "message"],
        additionalProperties: false,
      },
    },
  },
} as const

const PANEL_NAME = "claude-transcript"
// Bound retained text per run so a long-lived delegate can't grow memory without limit.
const MAX_CHARS = 48 * 1024

type RunStatus = "running" | "completed" | "error"

interface RunState {
  readonly callID: string
  readonly sessionID: string
  readonly label: string
  readonly text: string
  readonly status: RunStatus
  readonly message?: string
  readonly lastSeq: number
}

interface ChunkData {
  readonly sessionID: string
  readonly callID: string
  readonly seq: number
  readonly text: string
  readonly label?: string
}

interface DoneData {
  readonly sessionID: string
  readonly callID: string
  readonly seq: number
  readonly status: RunStatus
  readonly message: string
  readonly label?: string
}

function asChunk(data: Readonly<Record<string, unknown>>): ChunkData | undefined {
  if (typeof data.sessionID !== "string" || typeof data.callID !== "string") return
  if (typeof data.seq !== "number" || typeof data.text !== "string") return
  return { sessionID: data.sessionID, callID: data.callID, seq: data.seq, text: data.text, label: labelOf(data) }
}

function asDone(data: Readonly<Record<string, unknown>>): DoneData | undefined {
  if (typeof data.sessionID !== "string" || typeof data.callID !== "string") return
  if (typeof data.seq !== "number" || typeof data.message !== "string") return
  if (data.status !== "completed" && data.status !== "error") return
  return {
    sessionID: data.sessionID,
    callID: data.callID,
    seq: data.seq,
    status: data.status,
    message: data.message,
    label: labelOf(data),
  }
}

function labelOf(data: Readonly<Record<string, unknown>>): string | undefined {
  return typeof data.label === "string" ? data.label : undefined
}

function defaultLabel(sessionID: string) {
  return `Claude (${sessionID || "unknown"})`
}

function clamp(text: string) {
  return text.length > MAX_CHARS ? text.slice(text.length - MAX_CHARS) : text
}

function statusColor(theme: Plugin.Context["theme"], run: RunState) {
  if (run.status === "error") return theme.text.feedback.error.default
  if (run.status === "completed") return theme.text.feedback.success.default
  return theme.text.feedback.warning.default
}

function statusLabel(run: RunState) {
  if (run.status === "error") return "failed"
  if (run.status === "completed") return "done"
  return "running"
}

function TranscriptPanel(props: {
  context: Plugin.Context
  input: SlotMap["session.panel"]
  runs: readonly RunState[]
}) {
  const theme = props.context.theme
  const sessionRuns = createMemo(() => props.runs.filter((run) => run.sessionID === props.input.sessionID))
  let scroll: ScrollBoxRenderable | undefined

  // Gated by the panel's own interactivity scope (PanelHost wraps this in an
  // InteractivityProvider keyed on focus), so this never steals keys while unfocused.
  props.context.keymap.layer(() => ({
    commands: [{ bind: "escape", title: "Close transcript", group: "Claude", run: props.input.close }],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} padding={1} gap={1}>
      <box flexDirection="row" gap={2}>
        <text fg={theme.text.default} attributes={TextAttributes.BOLD} flexGrow={1}>
          Claude
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => props.input.close()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => (scroll = value)}
        flexGrow={1}
        minHeight={0}
        stickyScroll
        stickyStart="bottom"
        scrollbarOptions={{ visible: false }}
      >
        <Show
          when={sessionRuns().length > 0}
          fallback={<text fg={theme.text.subdued}>No delegated Claude output yet.</text>}
        >
          <box flexDirection="column" gap={1}>
            <For each={sessionRuns()}>
              {(run) => (
                <box flexDirection="column">
                  <box flexDirection="row" gap={1}>
                    <text fg={theme.text.default}>
                      <b>{run.label}</b>
                    </text>
                    <text fg={statusColor(theme, run)}>{statusLabel(run)}</text>
                  </box>
                  <text fg={theme.text.default} wrapMode="word">
                    {run.text || "…"}
                  </text>
                  <Show when={run.status === "error" && run.message}>
                    <text fg={theme.text.feedback.error.default}>{run.message}</text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        </Show>
      </scrollbox>
    </box>
  )
}

export default Plugin.define({
  id: "opencode.session.claude-transcript",
  setup(context) {
    const rpc = context.client.rpc(nativeClaudeDelegateRpc)
    const [runs, setRuns] = createStore<RunState[]>([])
    // First-chunk-only gate: avoids re-fighting a user who deliberately closed the panel.
    const autoOpened = new Set<string>()

    function indexOf(callID: string) {
      return runs.findIndex((run) => run.callID === callID)
    }

    function maybeAutoOpen(sessionID: string, callID: string) {
      if (autoOpened.has(callID)) return
      autoOpened.add(callID)
      // ui.panel.open only targets the currently routed session, so a delegate running in a
      // session the user isn't looking at is buffered but not surfaced until they navigate there.
      const route = context.ui.router.current()
      if (route.type !== "session" || route.sessionID !== sessionID) return
      context.ui.panel.open(PANEL_NAME)
    }

    const offChunk = rpc.events.on("chunk", (event) => {
      const data = asChunk(event.data)
      if (!data || !data.text) return
      const idx = indexOf(data.callID)
      if (idx === -1) {
        setRuns(runs.length, {
          callID: data.callID,
          sessionID: data.sessionID,
          label: data.label ?? defaultLabel(data.sessionID),
          text: clamp(data.text),
          status: "running",
          lastSeq: data.seq,
        })
        maybeAutoOpen(data.sessionID, data.callID)
        return
      }
      const run = runs[idx]
      if (run.status !== "running" || data.seq <= run.lastSeq) return
      setRuns(idx, (previous) => ({
        ...previous,
        text: clamp(previous.text + data.text),
        lastSeq: data.seq,
        label: data.label ?? previous.label,
      }))
    })

    const offDone = rpc.events.on("done", (event) => {
      const data = asDone(event.data)
      if (!data) return
      const idx = indexOf(data.callID)
      if (idx === -1) {
        setRuns(runs.length, {
          callID: data.callID,
          sessionID: data.sessionID,
          label: data.label ?? defaultLabel(data.sessionID),
          text: data.message,
          status: data.status,
          message: data.message,
          lastSeq: data.seq,
        })
        return
      }
      setRuns(idx, (run) => ({
        ...run,
        label: data.label ?? run.label,
        status: data.status,
        message: data.message,
        text: run.text || data.message,
        lastSeq: Math.max(run.lastSeq, data.seq),
      }))
    })

    const offSlot = context.ui.slot({
      append: "session.panel",
      render: (input) => (
        <Show when={input.name === PANEL_NAME}>
          <TranscriptPanel context={context} input={input} runs={runs} />
        </Show>
      ),
    })

    return () => {
      offChunk()
      offDone()
      offSlot()
      autoOpened.clear()
    }
  },
})
