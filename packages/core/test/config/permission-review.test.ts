import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Info } from "@opencode/schema/config"
import { ConfigNormalize } from "@opencode/core/config/normalize"

const decodeOptions = { errors: "all", onExcessProperty: "ignore", propertyOrder: "original" } as const
const decode = Schema.decodeUnknownSync(Info, decodeOptions)

// The exact shape of the central overlay in config/opencode/central-config-content.json.
const central = {
  permission_reviewer: {
    mode: "enforce",
    model: "openai/gpt-5.6-luna",
    policy: "exceptional-risk-only-v1",
    automatic_allow: "policy-gated",
    automatic_rewrite: "once-per-turn",
    temporary_read_allow: true,
  },
  bash_permission_evaluator: {
    mode: "permit-only",
    executable: "/opt/approve-bash",
    policy: "/opt/policy.yaml",
    executable_sha256: "9407c0999deb2bdb98477a6fbd8b77c639b670b24815e599f66d7194e2238134",
    policy_sha256: "7b6e89068d6fc6a8d0e52e182651843663806830bb44e824d97dd137dbfcf27c",
    expected: {
      implementation: "approve-bash",
      version: "1.0.0-opencode.1",
      commit: "240bdc518d7cb59774c9f5fbacf657b7b7a7358e",
      protocol: "opencode-bash-approve",
      platform: "linux",
    },
    timeout_seconds: 2,
    capacity: 4,
    max_input_bytes: 262144,
    max_output_bytes: 4096,
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
    expect(info.bash_permission_evaluator).toMatchObject({ mode: "permit-only", capacity: 4, timeout_seconds: 2 })
  })

  test("applies reviewer and evaluator defaults", () => {
    const info = decode({
      permission_reviewer: { mode: "audit-only", model: "openai/gpt-5.6-luna" },
      bash_permission_evaluator: {
        mode: "enforce",
        executable: "/opt/approve-bash",
        policy: "/opt/policy.yaml",
        executable_sha256: "a".repeat(64),
        policy_sha256: "b".repeat(64),
        expected: central.bash_permission_evaluator.expected,
      },
    })
    expect(info.permission_reviewer).toMatchObject({ policy: "conservative-v1", automatic_allow: "never" })
    expect(info.bash_permission_evaluator).toMatchObject({
      timeout_seconds: 2,
      capacity: 4,
      max_input_bytes: 256 * 1024,
      max_output_bytes: 4 * 1024,
    })
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

  test("rejects malformed evaluator pins", () => {
    // A relative/non-canonical executable or policy path is no longer rejected at decode time for
    // the same codegen-portability reason; see "rejects a non-absolute or non-canonical configured
    // executable or policy path" in permission/bash-evaluator.test.ts.
    expect(() =>
      decode({ bash_permission_evaluator: { ...central.bash_permission_evaluator, executable_sha256: "nope" } }),
    ).toThrow()
    expect(() =>
      decode({ bash_permission_evaluator: { ...central.bash_permission_evaluator, timeout_seconds: 60 } }),
    ).toThrow()
    expect(decode({ bash_permission_evaluator: { mode: "disabled" } }).bash_permission_evaluator).toEqual({
      mode: "disabled",
    })
  })
})
