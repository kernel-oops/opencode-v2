import { Plugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { runningTasks, taskStatus, taskStatusLabel } from "../../component/task-controls"

function View(props: { context: Plugin.Context; sessionID: string }) {
  const theme = props.context.theme
  // Reads the store useTaskControls already polls for this session's Prompt; no second poll here.
  const snapshot = createMemo(() => taskStatus(props.sessionID))
  const list = createMemo(() => snapshot()?.background ?? [])
  const running = createMemo(() => runningTasks(snapshot()))

  const dot = (status: string) => {
    if (status === "running") return theme.text.feedback.warning.default
    if (status === "error") return theme.text.feedback.error.default
    if (status === "completed") return theme.text.feedback.success.default
    return theme.text.subdued
  }

  return (
    <Show when={list().length > 0}>
      <box>
        <text fg={theme.text.default}>
          <b>Subagents</b>
          <Show when={running() > 0}>
            <span style={{ fg: theme.text.subdued }}> ({running()} running)</span>
          </Show>
        </text>
        <For each={list()}>
          {(task) => (
            <box flexDirection="row" gap={1} minWidth={0}>
              <text flexShrink={0} style={{ fg: dot(task.status) }}>
                •
              </text>
              <text fg={theme.text.default} wrapMode="none" truncate flexGrow={1} flexShrink={1} minWidth={0}>
                <b>{task.agent}</b> {task.description}
              </text>
              <text
                fg={task.status === "error" ? theme.text.feedback.error.default : theme.text.subdued}
                wrapMode="none"
                flexShrink={0}
              >
                {taskStatusLabel(task.status)}
              </text>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.tasks",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <View context={context} sessionID={props.sessionID} />,
    })
  },
})
