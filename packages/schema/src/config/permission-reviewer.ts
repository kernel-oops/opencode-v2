export * as ConfigPermissionReviewer from "./permission-reviewer.js"

import { Effect, Schema } from "effect"
import { optional } from "../schema.js"

export const Mode = Schema.Literals(["audit-only", "enforce"])
export type Mode = typeof Mode.Type

export const Policy = Schema.Literals(["conservative-v1", "obvious-risk-only-v1", "exceptional-risk-only-v1"])
export type Policy = typeof Policy.Type

export const Info = Schema.Struct({
  mode: Mode.annotate({
    description: 'Reviewer mode. "audit-only" logs assessments; "enforce" lets assessments change the outcome.',
  }),
  model: Schema.NonEmptyString.annotate({
    description: "Reviewer model reference in provider/model form. The model is called directly without a session.",
  }),
  policy: Policy.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("conservative-v1" as const))).annotate(
    { description: 'Fixed reviewer policy. Defaults to "conservative-v1".' },
  ),
  automatic_allow: Schema.Literals(["never", "policy-gated"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("never" as const)))
    .annotate({ description: 'Local automatic-allow policy. Defaults to "never".' }),
  temporary_read_allow: Schema.Boolean.pipe(optional).annotate({
    description:
      "Opt in to deterministic read, grep and glob permission for canonical Linux /tmp targets. Static denies remain authoritative; no execution or edit permission is granted.",
  }),
  automatic_rewrite: Schema.Literals(["never", "once-per-turn"])
    .pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed("never" as const)))
    .annotate({ description: 'Local automatic-rewrite policy. Defaults to "never".' }),
  retained_authority_fallback: Schema.Boolean.pipe(optional).annotate({
    description: "Accepted for configuration compatibility; retained-authority fallback is not implemented in v2.",
  }),
})
  // Not enforced as a schema-level filter: a custom cross-field filter without portable
  // arbitrary/representation metadata breaks the generated-client codegen (config is returned by
  // GET /api/config). The invariant is enforced at the point of use instead: the reviewer plugin
  // (config/plugin/permission-reviewer.ts) only takes the automatic-allow/rewrite branches when
  // `mode === "enforce"`, so a misconfigured audit-only + policy-gated combination is inert, not unsafe.
  .annotate({
    identifier: "ConfigPermissionReviewer.Info",
    description: "Isolated model-based review of permission requests that would otherwise ask a human.",
  })
export type Info = typeof Info.Type
