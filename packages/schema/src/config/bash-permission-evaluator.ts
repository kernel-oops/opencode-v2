export * as ConfigBashPermissionEvaluator from "./bash-permission-evaluator.js"

import { Effect, Schema } from "effect"
import path from "path"
import { PositiveInt } from "../schema.js"

const AbsolutePath = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => path.isAbsolute(value) || "must be an absolute path"),
)
const Sha256 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
const TimeoutSeconds = Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(30))
const InputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(256 * 1024))
const OutputBytes = PositiveInt.check(Schema.isLessThanOrEqualTo(4 * 1024))

export const Expected = Schema.Struct({
  implementation: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  commit: Schema.NonEmptyString,
  protocol: Schema.NonEmptyString,
  platform: Schema.NonEmptyString,
}).annotate({ identifier: "ConfigBashPermissionEvaluator.Expected" })
export type Expected = typeof Expected.Type

export const ActiveMode = Schema.Literals(["audit-only", "permit-only", "enforce"])
export type ActiveMode = typeof ActiveMode.Type

const ActiveFields = {
  executable: AbsolutePath.annotate({ description: "Absolute path of the evaluator executable." }),
  policy: AbsolutePath.annotate({ description: "Absolute path of the evaluator policy file." }),
  executable_sha256: Sha256.annotate({ description: "Expected SHA-256 of the executable bytes." }),
  policy_sha256: Sha256.annotate({ description: "Expected SHA-256 of the policy bytes." }),
  expected: Expected.annotate({ description: "Identity the executable must report from --version-json." }),
  timeout_seconds: TimeoutSeconds.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(2))),
  capacity: PositiveInt.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(4))),
  max_input_bytes: InputBytes.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(256 * 1024))),
  max_output_bytes: OutputBytes.pipe(Schema.optional, Schema.withDecodingDefault(Effect.succeed(4 * 1024))),
}

export const Disabled = Schema.Struct({ mode: Schema.Literal("disabled") }).annotate({
  identifier: "ConfigBashPermissionEvaluator.Disabled",
})
export type Disabled = typeof Disabled.Type

export const Active = Schema.Struct({ mode: ActiveMode, ...ActiveFields }).annotate({
  identifier: "ConfigBashPermissionEvaluator.Active",
})
export type Active = typeof Active.Type

export const Info = Schema.Union([Disabled, Active]).annotate({
  identifier: "ConfigBashPermissionEvaluator.Info",
  description:
    "External, integrity-pinned evaluator consulted for shell commands that would otherwise ask a human. It may permit an ask; in enforce mode it may also deny.",
})
export type Info = typeof Info.Type
