// Drupal CMS content-review TRIGGER — a dependency-light LEAF module (the seam
// TYPES from `../deps` + this package's own pointer-identity leaf only; NO SDK
// value imports, NO `@/` host imports), the drupal-mcp-connector's half of
// lifecycle S7 (cinatra#2045, epic #2037).
//
// The CORE half (cinatra#2082 + the `@cinatra-ai/host:cms-review` capability
// published by #2084, both on cinatra main) is CONTENT-AGNOSTIC: it takes a
// pointer + a flat `{path: value}` field serialization + a scope manifest and
// writes — in ONE atomic transaction — the snapshot substrate + the
// `ArtifactProduced` event (whose `external_publish` destination fires the review
// checkpoint) + the `cms_snapshot_targets` apply binding; `recordApplyVerification`
// reads that stored binding back after the apply and records `verified` /
// `drifted` / `unmet`. Nothing in it is WordPress-shaped, so S7 needs NO core
// change — only this adapter-side trigger.
//
// THIS leaf is the TRIGGER the connector places at its staged content-write seams
// (`drupal_node_update` and `drupal_node_publish`): BEFORE the externally-visible
// Drupal change, when the review fence is ON, it reads the current node (the CAS
// base), captures the PROPOSED node state as the review target, and HOLDS the
// effect — the write never reaches Drupal until a reviewer approves. The gate then
// releases the apply (an idempotent re-drive on the same `operationId`), and the
// post-apply read-back verifies the change was faithful.
//
// FENCE-OFF BYTE-IDENTITY: with no seam bound (pre-S5 / standalone host) or the
// fence OFF, `evaluateStagedNodeWrite` returns `{ action: "pass" }` WITHOUT
// reading the node, capturing, or any side effect — the caller applies the write
// exactly as it did before S7. The extra current-read + capture happen ONLY on the
// fence-ON path.
//
// ---------------------------------------------------------------------------
// WHERE DRUPAL GENUINELY DIVERGES FROM THE WORDPRESS TRIGGER (wordpress-mcp-connector#84)
//
// 1. OPEN field map, not four fixed paths. `drupal_node_update` takes
//    `fields: Record<string, unknown>` (title, body, and any declared `field_*`
//    region), so the reviewable path set is DERIVED per node instead of being the
//    WordPress `["title","content","excerpt","status"]` enum. The serialization is
//    therefore key-SORTED (WordPress could rely on a fixed path order).
// 2. Typed field values. Drupal field values arrive as `unknown` (string, bool,
//    int, array) while the core snapshot is a flat string map, so every value goes
//    through ONE canonicalizer used at BOTH capture and read-back — an asymmetric
//    projection would read as phantom drift.
// 3. `status` is a SEPARATE primitive. WordPress publishes through the same
//    `wordpress_post_update` call (`status` is just another field); Drupal's
//    publish effect is its own `mcp_publish_content` primitive, so the trigger is
//    placed at BOTH seams — otherwise "no remote mutation of published content
//    before approval" (the issue AC) would have a hole the WordPress connector
//    does not have.
// 4. Fail-CLOSED on a degraded read. `drupal_node_get` may fall back to a summary
//    row WITHOUT `body` (#1214 S2); capturing a review base from that row would
//    review a body the reviewer never saw and make every apply read as drift. The
//    review path therefore requires the full-field MCP read and refuses the write
//    when it is unavailable. (WordPress has a single read path and no such gate.)
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import type {
  CmsReviewCaptureInput,
  CmsReviewGateRef,
  CmsReviewScopeManifest,
  CmsReviewSeam,
} from "../deps";
import { DRUPAL_CONNECTOR_ID, drupalNodeExternalId } from "./pointer-writer-core";

/** The MIME the CMS-field snapshot serialization is stored under — the SAME
 * content-agnostic serialization the core read-back parses
 * (`readCmsSnapshotProposedFields`), so a Drupal snapshot and a WordPress
 * snapshot are the same record class to core. */
export const CMS_REVIEW_SNAPSHOT_MIME = "application/vnd.cinatra.cms-fields+json";

/** The always-reviewed Drupal content paths (when present on the node). `status`
 * is the publish effect — reviewed alongside the content it publishes. */
export const DRUPAL_CORE_CONTENT_PATHS = ["title", "body", "summary", "status"] as const;

/** Node keys that are IDENTITY or VOLATILE metadata, never review content. They
 * are excluded from the reviewable set so a legitimate save (which always bumps
 * `changed` / the revision ids) can never read as out-of-scope drift. */
export const DRUPAL_SYSTEM_FIELD_PATHS: readonly string[] = [
  "id",
  "nid",
  "uuid",
  "vid",
  "bundle",
  "type",
  "langcode",
  "default_langcode",
  "content_translation_source",
  "content_translation_outdated",
  "revision_translation_affected",
  "revision_timestamp",
  "revision_uid",
  "revision_log",
  "revision_default",
  "changed",
  "created",
  "uid",
  "path",
  "url_alias",
  "metatag",
];

const SYSTEM = new Set(DRUPAL_SYSTEM_FIELD_PATHS);

/** The canonical publish-status values a Drupal snapshot stores. Drupal's MCP
 * surface reports `status` as a bool, `1`/`0`, or a string, so BOTH the capture
 * and the read-back normalize it to one vocabulary. */
export const DRUPAL_STATUS_PUBLISHED = "published";
export const DRUPAL_STATUS_UNPUBLISHED = "unpublished";

/** A flat, canonicalized Drupal field map (the review's field projection). */
export type DrupalFieldMap = Record<string, string>;

/** A raw (MCP-shaped) Drupal node: the flattened entity `drupal_node_get`
 * returns — arbitrary keys, arbitrary value types. */
export type DrupalRawNode = Record<string, unknown>;

const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Normalize Drupal's several publish-status spellings to one vocabulary. PURE.
 * Unrecognized values pass through as their trimmed string form (never silently
 * mapped to a publish state).
 */
export function canonicalizeStatus(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "boolean") return value ? DRUPAL_STATUS_PUBLISHED : DRUPAL_STATUS_UNPUBLISHED;
  if (typeof value === "number") return value === 0 ? DRUPAL_STATUS_UNPUBLISHED : DRUPAL_STATUS_PUBLISHED;
  const s = String(value).trim();
  const lower = s.toLowerCase();
  if (["1", "true", "published", "publish"].includes(lower)) return DRUPAL_STATUS_PUBLISHED;
  if (["0", "false", "unpublished", "unpublish", "draft"].includes(lower)) return DRUPAL_STATUS_UNPUBLISHED;
  return s;
}

/**
 * Canonicalize ONE Drupal field value to the flat string form the core snapshot
 * stores. Used at BOTH capture and post-apply read-back so the two projections
 * are byte-symmetric (an asymmetric projection reads as phantom drift). PURE.
 *
 * `undefined` means "not present" — the caller omits the path entirely rather
 * than storing an empty string (the core verifier's strict presence-AND-equality
 * check treats a missing path as unfaithful, which is the fail-closed direction).
 */
export function canonicalizeFieldValue(path: string, value: unknown): string | undefined {
  if (path === "status") return canonicalizeStatus(value);
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Derive the REVIEWABLE path set for a staged write: the core content paths
 * present on the node, every declared `field_*` region present on the node, and
 * every path the proposal touches — minus the identity/volatile system keys.
 * Sorted, so the serialization is deterministic. PURE.
 *
 * This is the adapter-declared scope boundary the issue asks for ("title, body,
 * declared field regions"): the snapshot carries exactly these, so drift is
 * detected across the editable surface and NEVER across a revision timestamp.
 */
export function resolveReviewablePaths(
  current: DrupalRawNode,
  proposed: DrupalRawNode,
): string[] {
  const paths = new Set<string>();
  for (const p of DRUPAL_CORE_CONTENT_PATHS) {
    if (Object.prototype.hasOwnProperty.call(current, p)) paths.add(p);
  }
  for (const k of Object.keys(current)) {
    if (k.startsWith("field_")) paths.add(k);
  }
  for (const k of Object.keys(proposed)) paths.add(k);
  for (const sys of SYSTEM) paths.delete(sys);
  return [...paths].sort();
}

/**
 * Project a raw Drupal node onto a canonicalized field map over `paths`. Absent
 * / uncanonicalizable values are OMITTED (never coerced to ""). PURE — the same
 * function projects the capture base, the proposal, and the post-apply re-read.
 */
export function projectNodeFields(node: DrupalRawNode, paths: readonly string[]): DrupalFieldMap {
  const out: DrupalFieldMap = {};
  for (const path of paths) {
    const v = canonicalizeFieldValue(path, node[path]);
    if (typeof v === "string") out[path] = v;
  }
  return out;
}

/**
 * Serialize a canonicalized field map to its snapshot bytes — key-SORTED (the
 * Drupal path set is open, so order must be derived, not declared), so the
 * snapshot and the post-apply re-read hash and project identically. PURE.
 */
export function serializeCmsFields(fields: DrupalFieldMap): string {
  const ordered: Record<string, string> = {};
  for (const path of Object.keys(fields).sort()) ordered[path] = fields[path];
  return JSON.stringify(ordered);
}

/**
 * Derive the full PROPOSED node state (proposal over current, canonicalized) and
 * the set of paths the proposal actually CHANGES. The snapshot carries the whole
 * reviewable state (so a reviewer sees the node, and out-of-scope drift is
 * detectable); the scope manifest carries only the changed paths (so the apply
 * can never widen what review authorized). PURE.
 */
export function resolveProposedState(
  current: DrupalRawNode,
  proposed: DrupalRawNode,
): { paths: string[]; currentState: DrupalFieldMap; proposedState: DrupalFieldMap; changedPaths: string[] } {
  const paths = resolveReviewablePaths(current, proposed);
  const currentState = projectNodeFields(current, paths);
  const proposedState: DrupalFieldMap = { ...currentState };
  const changedPaths: string[] = [];
  for (const path of paths) {
    if (!Object.prototype.hasOwnProperty.call(proposed, path)) continue;
    const next = canonicalizeFieldValue(path, proposed[path]);
    if (typeof next !== "string") continue;
    proposedState[path] = next;
    if (next !== currentState[path]) changedPaths.push(path);
  }
  return { paths, currentState, proposedState, changedPaths: changedPaths.sort() };
}

/** Build the closed scope manifest from the changed paths. PURE. */
export function buildCmsScopeManifest(changedPaths: readonly string[]): CmsReviewScopeManifest {
  return { paths: [...changedPaths] };
}

/**
 * Derive the operation-idempotency key. DETERMINISTIC on (instance, resource
 * type, node id, PROPOSED serialization): the same proposal to the same node maps
 * to the same `cms_snapshot_targets` row — a re-drive (the approved apply, a
 * retried tool call) reuses the capture instead of minting a second gate, and two
 * distinct proposals never collide. PURE.
 */
export function deriveCmsOperationId(input: {
  instanceId: string;
  resourceType: string;
  cmsResourceId: string;
  proposedSerialization: string;
}): string {
  return sha256Hex(
    [
      input.instanceId,
      input.resourceType,
      input.cmsResourceId,
      sha256Hex(input.proposedSerialization),
    ].join(" "),
  );
}

/** The absolute node URL the snapshot pointer opens. Drupal's MCP read carries no
 * canonical link, so it is composed from the instance site URL. PURE. */
export function drupalNodeUrl(siteUrl: string, nodeId: number | string): string {
  return `${String(siteUrl).replace(/\/+$/, "")}/node/${String(nodeId)}`;
}

/**
 * Compose the host capture input from the resolved staged-write facts. PURE — no
 * I/O, no seam call — so the manifest/operation/serialization wiring is
 * unit-provable.
 */
export function buildStagedWriteCapture(input: {
  instanceId: string;
  resourceType: string;
  nodeId: number | string;
  siteUrl: string;
  currentState: DrupalFieldMap;
  proposedState: DrupalFieldMap;
  changedPaths: readonly string[];
  capturedAt: string;
  connectorId?: string;
}): CmsReviewCaptureInput {
  const proposedSerialization = serializeCmsFields(input.proposedState);
  const currentSerialization = serializeCmsFields(input.currentState);
  const cmsResourceId = String(input.nodeId);
  const operationId = deriveCmsOperationId({
    instanceId: input.instanceId,
    resourceType: input.resourceType,
    cmsResourceId,
    proposedSerialization,
  });
  const title = input.proposedState.title ?? input.currentState.title;
  return {
    pointer: {
      url: drupalNodeUrl(input.siteUrl, cmsResourceId),
      connectorId: input.connectorId ?? DRUPAL_CONNECTOR_ID,
      externalId: drupalNodeExternalId(input.instanceId, cmsResourceId),
      resolvedMimeType: CMS_REVIEW_SNAPSHOT_MIME,
      state: "linked",
      ...(title ? { title } : {}),
    },
    resolved: {
      mime: CMS_REVIEW_SNAPSHOT_MIME,
      text: proposedSerialization,
      sizeBytes: Buffer.byteLength(proposedSerialization, "utf8"),
      ...(title ? { title } : {}),
    },
    capturedAt: input.capturedAt,
    scopeManifest: buildCmsScopeManifest(input.changedPaths),
    connectorInstance: input.instanceId,
    resourceType: input.resourceType,
    cmsResourceId,
    // CAS anchor over the CURRENT remote node — lets the apply/rebase path detect
    // a third-party edit between capture and apply (the staging-saga follow-up
    // reads it).
    baseRemoteRevisionRef: sha256Hex(currentSerialization),
    operationId,
    ...(title ? { title } : {}),
  };
}

/** The held (pending-review) result returned to the agent when a staged write is
 * captured and held — the effect is NOT applied to Drupal. */
export type DrupalPendingReviewResult = {
  status: "pending_review";
  applied: false;
  operationId: string;
  snapshotArtifactId: string;
  snapshotRevisionId: string;
  gate: CmsReviewGateRef;
  nodeId: string;
  resourceType: string;
  reviewedPaths: string[];
  url: string;
  message: string;
};

/** The trigger's decision the handler acts on. */
export type StagedNodeWriteDecision =
  /** Fence off / seam unbound / nothing to review / org-ungated: apply the write
   * exactly as pre-S7 (byte-identical on the fence-off path). */
  | { action: "pass" }
  /** Captured + held pending review — the write must NOT reach Drupal. */
  | { action: "hold"; pending: DrupalPendingReviewResult }
  /** An approved gate released the effect — apply the write, then read back over
   * `snapshotPaths` (the EXACT key set the snapshot carries, so the verdict's
   * base/repaired maps are comparable). */
  | { action: "apply"; operationId: string; gate: { gateId: string; runId: string }; snapshotPaths: string[] }
  /** A rejected gate tombstoned the effect — refuse the write. */
  | { action: "reject"; operationId: string; reason: string };

/**
 * Evaluate a staged Drupal node write against the review seam. The single entry
 * point the `drupal_node_update` / `drupal_node_publish` handlers call before
 * writing.
 *
 * ORDER (the S0 staged-write ordering): fence check → (fence ON) read current →
 * capture proposed snapshot (one Tx: substrate + produced event + apply binding)
 * → disposition. The disposition drives the return:
 *   - `held`     → HOLD (D1): the effect is held, Drupal unchanged;
 *   - `approved` → APPLY (D3): the effect is released, the handler writes + reads back;
 *   - `rejected` → REFUSE: a tombstoned effect never writes;
 *   - `ungated`  → PASS: the org lattice permitted the effect (no gate);
 *   - `unknown`  → REFUSE fail-closed.
 *
 * FENCE-OFF: with no seam or an inactive fence this returns `{ action: "pass" }`
 * BEFORE any read/capture — the caller's write is byte-identical to pre-S7.
 */
export async function evaluateStagedNodeWrite(args: {
  seam: CmsReviewSeam | undefined;
  connectorId?: string;
  instanceId: string;
  siteUrl: string;
  nodeId: number | string;
  /** The proposed field changes (the handler's already-sanitized field map, or
   * `{status: true}` for the publish primitive). */
  proposed: DrupalRawNode;
  /** Lazily read the current node — invoked ONLY on the fence-ON path (so the
   * fence-off path adds no Drupal round-trip). MUST be the full-field read: a
   * degraded summary row has no `body`, so it can never be a review base. */
  fetchCurrent: () => Promise<DrupalRawNode | null>;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}): Promise<StagedNodeWriteDecision> {
  const { seam } = args;
  // Fence OFF / unbound seam → byte-identical pass-through, no read, no capture.
  if (!seam || !seam.isReviewActive()) return { action: "pass" };

  const current = await args.fetchCurrent();
  // FAIL-CLOSED (a Drupal-specific divergence): no full-field read ⇒ no reviewable
  // base ⇒ refuse rather than review a body the reviewer never saw.
  if (!current) {
    return {
      action: "reject",
      operationId: "",
      reason:
        `the full-field MCP read for node ${String(args.nodeId)} is unavailable — refusing a ` +
        "review-gated write fail-closed (a summary row carries no body, so it cannot be a review base)",
    };
  }

  const resourceType = typeof current.bundle === "string" && current.bundle.length > 0
    ? String(current.bundle)
    : "node";
  const { currentState, proposedState, changedPaths } = resolveProposedState(current, args.proposed);
  // Nothing the review reasons over actually changes → let the write proceed (it
  // will no-op or the writer's own guard rejects it) — no empty gate.
  if (changedPaths.length === 0) return { action: "pass" };

  const captureInput = buildStagedWriteCapture({
    instanceId: args.instanceId,
    resourceType,
    nodeId: args.nodeId,
    siteUrl: args.siteUrl,
    currentState,
    proposedState,
    changedPaths,
    capturedAt: (args.now ? args.now() : new Date()).toISOString(),
    ...(args.connectorId ? { connectorId: args.connectorId } : {}),
  });

  const capture = await seam.captureStagedWrite(captureInput);
  const { disposition, gate } = await seam.resolveDisposition({
    artifactId: capture.artifactId,
    snapshotRevisionId: capture.snapshotRevisionId,
  });

  switch (disposition) {
    case "held":
      return {
        action: "hold",
        pending: {
          status: "pending_review",
          applied: false,
          operationId: captureInput.operationId,
          snapshotArtifactId: capture.artifactId,
          snapshotRevisionId: capture.snapshotRevisionId,
          gate,
          nodeId: String(args.nodeId),
          resourceType,
          reviewedPaths: [...changedPaths],
          url: captureInput.pointer.url,
          message:
            "This content edit is staged for human review and has NOT been saved to Drupal. " +
            "It will be applied only after a reviewer approves the change.",
        },
      };
    case "approved":
      if (!gate) return { action: "pass" };
      // The read-back projects EXACTLY the key set the snapshot stored (the
      // verdict compares base↔repaired path-by-path, so a wider or narrower
      // projection would manufacture drift).
      return {
        action: "apply",
        operationId: captureInput.operationId,
        gate,
        snapshotPaths: Object.keys(proposedState).sort(),
      };
    case "ungated":
      return { action: "pass" };
    case "rejected":
      return {
        action: "reject",
        operationId: captureInput.operationId,
        reason: "the review gate for this content edit was rejected — the change was not applied",
      };
    default:
      return {
        action: "reject",
        operationId: captureInput.operationId,
        reason: "indeterminate review disposition — refusing the write fail-closed",
      };
  }
}
