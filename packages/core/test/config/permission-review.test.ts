import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Info } from "@opencode/schema/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decode = Schema.decodeUnknownSync(Info, decodeOptions)

// The exact shape of the central overlay in config/opencode/central-config-content.json.
// bash_permission_evaluator was moved out of core into an external plugin (see
// config-v2/opencode/plugins/bash-permission-evaluator); it is no longer a config key here.
const central = {
  permission_reviewer: {
    mode: "enforce",
    model: "openai/gpt-5.6-luna",
    policy: "exceptional-risk-only-v1",
    automatic_allow: "policy-gated",
    automatic_rewrite: "once-per-turn",
    temporary_read_allow: true,
  },
}

describe("permission review configuration", () => {
  test("normalises and decodes the central overlay keys", () => {
    const result = ConfigNormalize.normalize(central)
    expect(result.type).toBe("normalized")
    if (result.type !== "normalized") return
    expect(result.diagnostics).toEqual([])
    const info = decode(result.encoded)
    expect(info.permission_reviewer).toEqual({
      mode: "enforce",
      model: "openai/gpt-5.6-luna",
      policy: "exceptional-risk-only-v1",
      automatic_allow: "policy-gated",
      automatic_rewrite: "once-per-turn",
      temporary_read_allow: true,
    })
  })

  test("applies reviewer defaults", () => {
    const info = decode({
      permission_reviewer: { mode: "audit-only", model: "openai/gpt-5.6-luna" },
    })
    expect(info.permission_reviewer).toMatchObject({ policy: "conservative-v1", automatic_allow: "never" })
  })

  // Decode no longer rejects an automatic-review mode/policy mismatch (a Schema.filter without
  // portable arbitrary/representation metadata breaks the generated-client codegen, since this
  // config is reachable from GET /api/config's response schema). The invariant is enforced at the
  // point of use instead — see "automatic allow stays inert…" in permission/review-plugins.test.ts.
  test("accepts an automatic-review mode/policy mismatch at decode time", () => {
    expect(
      decode({
        permission_reviewer: { mode: "audit-only", model: "openai/gpt-5.6-luna", automatic_allow: "policy-gated" },
      }).permission_reviewer,
    ).toMatchObject({ mode: "audit-only", automatic_allow: "policy-gated" })
    expect(
      decode({
        permission_reviewer: { mode: "enforce", model: "openai/gpt-5.6-luna", automatic_allow: "policy-gated" },
      }).permission_reviewer,
    ).toMatchObject({ mode: "enforce", policy: "conservative-v1", automatic_allow: "policy-gated" })
  })
})
