export * as ConfigExperimental from "./experimental.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"
import { ConfigPolicy } from "./policy.js"

export class Info extends Schema.Class<Info>("ConfigExperimental.Info")({
  portable_shell_scanner: Schema.Boolean.pipe(optional).annotate({
    description: "Enable the experimental portable shell permission scanner. Defaults to false.",
  }),
  subagent_depth: NonNegativeInt.pipe(optional).annotate({
    description: "Maximum subagent nesting depth. Defaults to 1.",
  }),
  policies: ConfigPolicy.Info.pipe(Schema.Array, optional).annotate({
    description: "Ordered policies controlling access to configured resources",
  }),
  task_continuation_agents: Schema.Array(Schema.String).pipe(optional).annotate({
    description:
      "Root agents whose turns triggered by a subagent completion keep their tools. Every entry must also appear in `task_continuation_eligible` (default: just `build`); any entry outside that set disables continuation for every agent. Default: subagent completion turns are report-only with no tools.",
  }),
  task_continuation_eligible: Schema.Array(Schema.String).pipe(optional).annotate({
    description:
      "Agent names that may be granted continuation via `task_continuation_agents`. Defaults to `[\"build\"]`. This is a fail-closed guard: listing a custom root agent here, then in `task_continuation_agents`, is how you opt it in.",
  }),
}) {}
