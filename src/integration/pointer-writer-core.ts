// Drupal external-pointer write CORE — a dependency-light LEAF module
// (SDK TYPE imports only; NO SDK value imports), the drupal-mcp-connector's
// half of the `drupal:node` pointer lifecycle (cinatra#1465, epic #1448,
// connectorRef substrate #1451).
//
// A `@cinatra-ai/drupal:node` row is an EXTERNAL POINTER: the canonical node
// lives in Drupal; the row keeps only bare identity (url + connector/external
// ids + reference state + light title/excerpt), never the node body — the body
// is read on demand through the connector facade. This leaf holds the pure
// mechanism the host trigger paths compose:
//   - the pointer `objects.data` builder (the connectorRef artifact envelope the
//     host `@cinatra-ai/drupal:node` registrar's schema validates — the host
//     owns the TYPE registrar; this connector only WRITES rows for it);
//   - the reference-state map (probe outcome → linked | stale | dangling),
//     mirroring the host substrate's `connectorRefStateForOutcome` (the connector
//     cannot import the host-internal `@cinatra-ai/objects/connector-ref`, so it
//     restates the 3-way map — the same posture the webhook/tool contracts use);
//   - the synthetic pointer ACTOR (org/user → objects_save actor), the
//     twenty-pointer-writer precedent (byte-mirrors the wordpress writer, #1464).
//
// Shared by the host-resolved `drupal-pointer-writer` capability (register.ts)
// and its tests. Kept OFF the package index (React re-exports must stay out of a
// server graph); the writer is reached through the capability registry.

import type { ObjectsProvider } from "@cinatra-ai/sdk-extensions";

/** The host-registered external-pointer type id this connector writes rows for
 * (registered host-side in packages/objects/.../register-types.ts, #1815). */
export const DRUPAL_NODE_TYPE_ID = "@cinatra-ai/drupal:node";

/** This connector's package id — the `connectorRef.connectorId` provenance
 * every pointer row carries (soft correlation, never an FK). */
export const DRUPAL_CONNECTOR_ID = "@cinatra-ai/drupal-mcp-connector";

/** The connectorRef artifact-data discriminants (mirror the host substrate's
 * `CONNECTOR_REF_ARTIFACT_TYPE` / the `external_link` origin kind — restated
 * here so this leaf takes no host-internal import). */
const CONNECTOR_REF_ARTIFACT_TYPE = "connector-ref" as const;
const EXTERNAL_LINK_ORIGIN_KIND = "external_link" as const;

/** A Drupal node resolves to rendered HTML. */
const DRUPAL_NODE_MIME = "text/html" as const;

/**
 * The reference state a pointer takes relative to its upstream Drupal node
 * (mirrors the host substrate's `ConnectorRefState`).
 */
export type DrupalNodePointerState = "linked" | "stale" | "dangling";

/**
 * What a connector sync/verification probe observed about the upstream node
 * (mirrors the host substrate's `ConnectorRefProbeOutcome`):
 *   - `present`  — the node resolves, unchanged since the last sync → `linked`
 *   - `modified` — the node resolves but changed in Drupal          → `stale`
 *   - `absent`   — the node no longer resolves (deleted / unpublished) → `dangling`
 */
export type DrupalNodePointerProbeOutcome = "present" | "modified" | "absent";

/**
 * Map a probe outcome to the reference state. A PURE, total function (the
 * outcomes are mutually exclusive per probe), so a re-created node reports
 * `present` and returns to `linked`, and a deleted node reports `absent` and
 * moves to `dangling` — never a silent tombstone (the row persists; the host
 * flags dangling). Restates `connectorRefStateForOutcome` (the connector cannot
 * import the host-internal substrate).
 */
export function drupalNodeReferenceState(
  outcome: DrupalNodePointerProbeOutcome,
): DrupalNodePointerState {
  switch (outcome) {
    case "present":
      return "linked";
    case "modified":
      return "stale";
    case "absent":
      return "dangling";
  }
}

/**
 * The site-scoped Drupal node identity a pointer row is keyed to. A Drupal node
 * id is unique only WITHIN a site, so the pointer's `externalId` composes the
 * instance (connected-site id) with the node id — the host registrar's
 * identityKey (`<connectorId>:<externalId>`) is then keyed to instance + node.
 * Rejects a separator-bearing instanceId so the composite stays reversible.
 */
export function drupalNodeExternalId(instanceId: string, nodeId: number | string): string {
  const inst = String(instanceId).trim();
  const nid = String(nodeId).trim();
  if (inst.length === 0 || nid.length === 0 || inst.includes(":")) {
    throw new Error(
      "[drupal-pointer] externalId requires a non-empty, colon-free instanceId and a non-empty nodeId",
    );
  }
  return `${inst}:${nid}`;
}

export type DrupalNodePointerInput = {
  /** The connected-site (instance) id — the Drupal node id is site-scoped. */
  instanceId: string;
  /** The Drupal node id (unique within the site). */
  nodeId: number | string;
  /** Absolute http(s) URL that opens the node in Drupal. */
  url: string;
  /** Reference state at write time (defaults `linked` — a sync just materialized it). */
  state?: DrupalNodePointerState;
  /** Light display title (safe to project; NOT the body). */
  title?: string;
  /** Light display excerpt (safe to project; NOT the body). */
  excerpt?: string;
  /** Opaque upstream version (Drupal node `changed`) — lets the next probe
   * classify `present` vs `modified` without re-fetching the body. */
  remoteVersion?: string;
  /** ISO timestamp of the sync that materialized/verified this pointer. */
  verifiedAt?: string;
};

/** The connectorRef external-pointer `objects.data` envelope (the shape the host
 * `@cinatra-ai/drupal:node` registrar schema validates). Bare identity only —
 * heavy fields (the node body/HTML) are NEVER written here. */
export type DrupalNodePointerData = {
  artifactType: typeof CONNECTOR_REF_ARTIFACT_TYPE;
  originKind: typeof EXTERNAL_LINK_ORIGIN_KIND;
  mime: string;
  title?: string;
  excerpt?: string;
  connectorRef: {
    url: string;
    connectorId: string;
    externalId: string;
    resolvedMimeType: string;
    state: DrupalNodePointerState;
    lastVerifiedAt?: string;
    remoteVersion?: string;
    title?: string;
    excerpt?: string;
  };
};

/**
 * Build the `objects.data` payload for a `drupal:node` external pointer.
 * Validates the url is an absolute http(s) URL (fail-closed — an unopenable /
 * unsafe href is never persisted), composes the site-scoped `externalId`, and
 * starts `linked` unless a sync passes a later state. PURE — no I/O.
 */
export function buildDrupalNodePointerData(
  input: DrupalNodePointerInput,
): DrupalNodePointerData {
  const url = safeHttpUrl(input.url);
  if (url == null) {
    throw new Error(
      `[drupal-pointer] pointer url must be an absolute http(s) URL, got ${JSON.stringify(input.url)}`,
    );
  }
  const externalId = drupalNodeExternalId(input.instanceId, input.nodeId);
  const state = input.state ?? "linked";
  return {
    artifactType: CONNECTOR_REF_ARTIFACT_TYPE,
    originKind: EXTERNAL_LINK_ORIGIN_KIND,
    mime: DRUPAL_NODE_MIME,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    connectorRef: {
      url,
      connectorId: DRUPAL_CONNECTOR_ID,
      externalId,
      resolvedMimeType: DRUPAL_NODE_MIME,
      state,
      ...(input.verifiedAt !== undefined ? { lastVerifiedAt: input.verifiedAt } : {}),
      ...(input.remoteVersion !== undefined ? { remoteVersion: input.remoteVersion } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    },
  };
}

/** Only absolute http:/https: URLs pass; returns the canonical parsed href
 * (`javascript:`, `data:`, relative, and malformed shapes return null). Mirrors
 * the host substrate's `safeHttpUrl` so the connector never writes a pointer the
 * host read/deeplink path would reject. */
function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/**
 * Build a synthetic pointer actor from explicit orgId/userId — the
 * twenty-pointer-writer precedent (byte-mirrors the wordpress writer, #1464).
 * The host sync/webhook trigger runs outside an MCP request frame, so it
 * captures org+user and this leaf rehydrates an equivalent actor. The actor MUST
 * stamp `roles: ["member"]` so a userless caller lifts to `orgRole: "member"`
 * (not the object.create-less ServiceAccount); the pointer write is a
 * server-internal data-shadow of a node the caller already proved instance/org
 * access to, so `member` does not escalate across orgs (the kernel's cross-org
 * guard still requires the row's org_id to match the actor's organizationId).
 * `orgId` is REQUIRED (objects_save rejects a null-org actor on entry).
 */
export function buildDrupalPointerActor(input: {
  orgId: string;
  userId?: string | null;
}): Record<string, unknown> {
  const actor: Record<string, unknown> = {
    actorType: "model",
    source: "agent",
    roles: ["member"],
    orgId: input.orgId,
    organizationId: input.orgId,
  };
  if (input.userId) actor.userId = input.userId;
  return actor;
}

/**
 * Write (upsert-by-identity) a single `drupal:node` pointer row through the
 * GIVEN objects provider with the GIVEN actor. The host `@cinatra-ai/drupal:node`
 * TYPE registrar (register-types.ts) must already be registered (it is, at boot,
 * #1815) so `objects_save`'s classifier resolves the typeHint to the static
 * entry and the identityKey upserts by instance + node id rather than minting a
 * duplicate on every sync. Returns the objects_save result (the caller records
 * the object id for its bookkeeping).
 */
export async function writeDrupalNodePointerWith(
  provider: ObjectsProvider,
  input: DrupalNodePointerInput,
  actor: Record<string, unknown>,
): Promise<{ objectId: string; isNew: boolean }> {
  const data = buildDrupalNodePointerData(input);
  const result = await provider.saveObject({
    typeHint: DRUPAL_NODE_TYPE_ID,
    rawData: data as unknown as Record<string, unknown>,
    actor,
    mode: "agentic",
  });
  return { objectId: result.objectId, isNew: result.isNew };
}
