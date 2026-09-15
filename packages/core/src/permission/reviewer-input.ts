export * as PermissionReviewerInput from "./reviewer-input.js"

import { PermissionReview, type PermissionReviewValue } from "./review.js"

const TRUSTED_BUDGET = 40 * 1024
const UNTRUSTED_BUDGET = 24 * 1024
const EVIDENCE_ITEM_BUDGET = 8 * 1024
const ACTION_BUDGET = 32 * 1024
const MAX_INPUT_BYTES = 96 * 1024
const TRUNCATED = "[TRUNCATED]"

export type EvidenceSource = "human" | "assistant" | "tool" | "synthetic" | "summary"

export interface Evidence {
  readonly source: EvidenceSource
  readonly text: string
}

export interface Selection {
  items: Array<Evidence & { trusted: boolean }>
  complete: boolean
  omitted_items: number
  omitted_bytes: number
}

export interface Snapshot {
  version: "1"
  context_safe_for_gate: boolean
  action: {
    identity: string
    permission: string
    origin: "tool" | "unknown"
    cwd?: string
    cwd_status: "exact" | "unknown"
    resources: PermissionReviewValue
    metadata: PermissionReviewValue
    complete: boolean
    omitted_items: number
    omitted_bytes: number
  }
  trusted: Selection
  untrusted: Selection
  complete: boolean
}

export interface Input {
  readonly permission: string
  readonly origin: "tool" | "unknown"
  readonly resources: ReadonlyArray<string>
  readonly metadata?: unknown
  readonly cwd?: string
  readonly trusted: ReadonlyArray<Evidence>
  readonly untrusted: ReadonlyArray<Evidence>
  readonly trustedComplete?: boolean
  readonly untrustedComplete?: boolean
}

export type Failure = "size" | "serialization"
export type Serialised = { data: string } | { failure: Failure }

const bytes = (value: string) => Buffer.byteLength(value, "utf8")

/** Keeps the most recent evidence within budget; older items are omitted first. */
function select(items: ReadonlyArray<Evidence>, trusted: boolean, budget: number, complete: boolean): Selection {
  let remaining = budget
  let omittedItems = 0
  let omittedBytes = 0
  const selected: Selection["items"] = []
  for (const item of [...items].reverse()) {
    const text = PermissionReview.safeReviewValue(item.text)
    const value = typeof text === "string" ? text : String(text)
    const size = bytes(value)
    if (size > EVIDENCE_ITEM_BUDGET || size > remaining) {
      omittedItems += 1
      omittedBytes += size
      complete = false
      continue
    }
    remaining -= size
    selected.push({ source: item.source, trusted, text: value })
  }
  selected.reverse()
  return { items: selected, complete, omitted_items: omittedItems, omitted_bytes: omittedBytes }
}

export function build(input: Input): Snapshot {
  const resources = PermissionReview.safeReviewValue([...input.resources])
  const metadata = PermissionReview.safeReviewValue(input.metadata ?? {})
  const trusted = select(input.trusted, true, TRUSTED_BUDGET, input.trustedComplete ?? true)
  const untrusted = select(input.untrusted, false, UNTRUSTED_BUDGET, input.untrustedComplete ?? true)
  const lossy = (value: PermissionReviewValue): boolean =>
    typeof value === "string"
      ? value.endsWith(TRUNCATED) || value.startsWith("[UNSUPPORTED") || value === "[UNREADABLE]"
      : Array.isArray(value)
        ? value.some(lossy)
        : value !== null && typeof value === "object"
          ? Object.values(value).some(lossy)
          : false
  const actionComplete = !lossy(resources) && !lossy(metadata)
  const snapshot: Snapshot = {
    version: "1",
    context_safe_for_gate: trusted.complete,
    action: {
      identity: input.permission,
      permission: input.permission,
      origin: input.origin,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      cwd_status: input.cwd ? "exact" : "unknown",
      resources,
      metadata,
      complete: actionComplete,
      omitted_items: 0,
      omitted_bytes: 0,
    },
    trusted,
    untrusted,
    complete: actionComplete && trusted.complete && untrusted.complete,
  }
  if (bytes(JSON.stringify(snapshot.action)) > ACTION_BUDGET) {
    snapshot.action.complete = false
    snapshot.complete = false
    for (const key of ["metadata", "resources"] as const) {
      const before = bytes(JSON.stringify(snapshot.action[key]))
      snapshot.action[key] = "[OMITTED]"
      snapshot.action.omitted_items++
      snapshot.action.omitted_bytes += Math.max(0, before - bytes(JSON.stringify(snapshot.action[key])))
      if (bytes(JSON.stringify(snapshot.action)) <= ACTION_BUDGET) break
    }
  }
  return snapshot
}

export function serialise(snapshot: Snapshot): Serialised {
  try {
    const data = JSON.stringify(snapshot)
    if (bytes(data) > MAX_INPUT_BYTES) return { failure: "size" }
    return { data }
  } catch {
    return { failure: "serialization" }
  }
}
