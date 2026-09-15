import { expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import type { ConfigBashPermissionEvaluator } from "@opencode/schema/config/bash-permission-evaluator"
import { createHash } from "node:crypto"
import path from "node:path"
import { chmod, mkdir, rename, symlink } from "node:fs/promises"
import { Effect } from "effect"
import { BashPermissionEvaluator } from "@opencode/core/permission/bash-evaluator"
import { testEffect } from "../lib/effect"
import { tmpdirScoped } from "../fixture/tmpdir"

const env = AppNodeBuilder.build(LayerNode.group([BashPermissionEvaluator.node]))
const it = testEffect(env)
const identity = {
  implementation: "test-evaluator",
  version: "1.2.3",
  commit: "0123456789abcdef",
  protocol: "opencode-bash-approve",
  platform: process.platform,
}
const executable = (code: string) => `#!/bin/bash
exec /usr/bin/env -u PWD -u SHLVL ${process.execPath} -e '${code.replaceAll("'", "'\\''")}' -- "$@"
`
const checker = `
const args = process.argv.slice(1)
const policyDescriptor = "/proc/self/fd/4"
const policyText = await Bun.file(policyDescriptor).text()
const policy = JSON.parse(policyText)
if (args.length === 1 && args[0] === "--version-json") {
  process.stdout.write(JSON.stringify(${JSON.stringify(identity)}))
  process.exit(0)
}
const configIndex = args.indexOf("--config")
if (args[configIndex + 1] !== policyDescriptor) process.exit(91)
const input = await Bun.stdin.text()
if (policy.capture) await Bun.write(policy.capture, JSON.stringify({ args, env: process.env, input, cwd: process.cwd() }))
if (policy.delay) await Bun.sleep(policy.delay)
if (policy.stderr) process.stderr.write(policy.stderr)
if (policy.raw !== undefined) process.stdout.write(policy.raw)
else process.stdout.write(JSON.stringify({ decision: policy.decision ?? "allow", reason: policy.reason ?? "fixed" }))
process.exit(policy.exit ?? 0)
`
const source = executable(checker)
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

const fixture = (policyValue: Record<string, unknown> = {}, executableSource = source) =>
  Effect.gen(function* () {
    const { path: directory } = yield* tmpdirScoped()
    const parent = path.join(directory, "checker")
    const executable = path.join(parent, "evaluator")
    const policy = path.join(parent, "policy.json")
    const policyText = JSON.stringify(policyValue)
    yield* Effect.promise(async () => {
      await mkdir(parent)
      await Bun.write(executable, executableSource)
      await chmod(executable, 0o700)
      await Bun.write(policy, policyText)
    })
    return {
      directory,
      executable,
      policy,
      parent,
      config: {
        mode: "enforce",
        executable,
        policy,
        executable_sha256: digest(executableSource),
        policy_sha256: digest(policyText),
        expected: identity,
        timeout_seconds: 2,
        capacity: 4,
        max_input_bytes: 256 * 1024,
        max_output_bytes: 4 * 1024,
      } satisfies ConfigBashPermissionEvaluator.Active,
    }
  })

const action = (cwd: string, command = "git status") => ({ command, cwd })

it.live("invokes the exact argv with a minimal environment and canonical payload", () =>
  Effect.gen(function* () {
    const { path: directory } = yield* tmpdirScoped()
    const capture = path.join(directory, "capture.json")
    const test = yield* fixture({ capture, decision: "allow" })
    const evaluator = yield* BashPermissionEvaluator.Service
    const run = yield* evaluator.prepare({ config: test.config, action: action(directory) })
    expect(run.admitted).toBe(true)
    expect(yield* run.result).toEqual({ decision: "allow" })
    const observed = yield* Effect.promise(() => Bun.file(capture).json())
    expect(observed.args).toEqual(["--opencode", "--config", "/proc/self/fd/4", "--no-telemetry"])
    expect(observed.input).toBe(JSON.stringify({ tool: "bash", command: "git status", cwd: directory }))
    expect(observed.cwd).toBe("/")
    expect(observed.env).toEqual({ HOME: "/nonexistent", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" })
  }),
)

it.live("returns each decision and treats noisy or malformed output as protocol failure", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const decision of ["allow", "ask", "deny", "noop"] as const) {
      const test = yield* fixture({ decision })
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      expect(yield* run.result).toEqual({ decision })
    }
    for (const policy of [
      { raw: "not json" },
      { raw: JSON.stringify({ decision: "maybe", reason: "x" }) },
      { raw: JSON.stringify({ decision: "allow" }) },
      { raw: JSON.stringify({ decision: "allow", reason: "x", extra: "y" }) },
      { decision: "allow", stderr: "diagnostic" },
      { decision: "allow", exit: 3 },
    ]) {
      const test = yield* fixture(policy)
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      const result = yield* run.result
      expect("failure" in result).toBe(true)
    }
  }),
)

it.live("fails closed for missing or non-canonical actions", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const invalid of [undefined, action("relative"), action(`${test.directory}/../x`)]) {
      const run = yield* evaluator.prepare({ config: test.config, action: invalid })
      expect(run.admitted).toBe(false)
      expect(yield* run.result).toEqual({ failure: "input" })
    }
  }),
)

it.live("checks file hashes and exact executable identity before evaluation", () =>
  Effect.gen(function* () {
    const test = yield* fixture()
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const config of [
      { ...test.config, executable_sha256: "0".repeat(64) },
      { ...test.config, policy_sha256: "0".repeat(64) },
      ...Object.keys(identity).map((field) => ({ ...test.config, expected: { ...identity, [field]: "wrong" } })),
    ]) {
      const run = yield* evaluator.prepare({ config, action: action(test.directory) })
      expect("failure" in (yield* run.result)).toBe(true)
    }
  }),
)

it.live("rejects symlinked executable, policy or parent directory", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    for (const field of ["executable", "policy"] as const) {
      const test = yield* fixture()
      const target = `${test[field]}.regular`
      yield* Effect.promise(async () => {
        await rename(test[field], target)
        await symlink(target, test[field])
      })
      const run = yield* evaluator.prepare({ config: test.config, action: action(test.directory) })
      expect(yield* run.result).toEqual({ failure: "integrity" })
    }
    const parent = yield* fixture()
    yield* Effect.promise(async () => {
      await rename(parent.parent, `${parent.parent}.regular`)
      await symlink(`${parent.parent}.regular`, parent.parent)
    })
    const run = yield* evaluator.prepare({ config: parent.config, action: action(parent.directory) })
    expect(yield* run.result).toEqual({ failure: "integrity" })
  }),
)

it.live("times out slow evaluators and reports capacity exhaustion", () =>
  Effect.gen(function* () {
    const evaluator = yield* BashPermissionEvaluator.Service
    const slow = yield* fixture({ delay: 5_000 })
    const run = yield* evaluator.prepare({
      config: { ...slow.config, timeout_seconds: 0.5 },
      action: action(slow.directory),
    })
    expect(yield* run.result).toEqual({ failure: "timeout" })
    yield* run.settled

    const busy = yield* fixture({ delay: 1_000 })
    const runs = []
    for (let index = 0; index < 4; index++) {
      runs.push(yield* evaluator.prepare({ config: { ...busy.config, capacity: 4 }, action: action(busy.directory) }))
    }
    const extra = yield* evaluator.prepare({ config: { ...busy.config, capacity: 4 }, action: action(busy.directory) })
    expect(extra.admitted).toBe(false)
    expect(yield* extra.result).toEqual({ failure: "capacity" })
    for (const item of runs) item.abort()
    for (const item of runs) yield* item.settled
  }),
)
