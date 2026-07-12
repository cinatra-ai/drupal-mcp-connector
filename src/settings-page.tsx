import "server-only";

import type { Metadata } from "next";
import { revalidatePath } from "next/cache";

import Link from "next/link";
import { Button } from "./components/ui/button";
import { LinkIcon } from "lucide-react";
import { Input } from "./components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/ui/input-group";
import { Field, FieldDescription, FieldLabel } from "./components/ui/field";
import { Label } from "./components/ui/label";
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription } from "./components/ui/alert";
// `ConnectorSetupPage` — the canonical connector setup-page shell
// (app-connectors.html §II): pins BOTH the header and the content to the
// single centered Wide column (max-w-3xl · 768px) so their left edges always
// coincide, instead of the marketplace default (max-w-7xl). Ships only from
// its own `/connector-setup-page` subpath (never the `.`/`/marketplace`
// barrels — route-graph no-new-rot ratchet).
import { ConnectorSetupPage } from "@cinatra-ai/sdk-ui/connector-setup-page";
// Shared, connector-agnostic Tabs primitive (cinatra-ai/cinatra#1103) — ships
// only from its own `/tabs` subpath (see the sdk-ui source comment); NO local
// `tabs.tsx` is vendored into this extension. `TabsListRow` pairs the tablist
// with the etched section rule (design spec §Tabs / app-connectors.html §II),
// so the header below renders with `divider={false}` — the rule is never
// stacked twice.
import { Tabs, TabsListRow, TabsTrigger, TabsContent } from "@cinatra-ai/sdk-ui/tabs";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
// Instance save/delete/list + per-instance MCP statuses resolve via the deps
// slot (cinatra#172 Stage H2): `@/lib/drupal-api` / `@/lib/drupal-mcp-connection`
// stay host-side, adapted by register(ctx) from `@cinatra-ai/host:drupal-mcp`.
// The "use server" actions CANNOT close over the render-time ctx prop, so the
// globalThis deps slot is the only seam that reaches them.
import { getDrupalDeps, listMcpInstancesSorted } from "./deps";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Drupal | Cinatra" };

// ---------------------------------------------------------------------------
// Server actions
// ---------------------------------------------------------------------------

async function saveInstanceAction(formData: FormData): Promise<void> {
  "use server";
  await requireExtensionAction("@cinatra-ai/drupal-mcp-connector", "manage");
  const id = (formData.get("id") as string | null) || undefined;
  const name = (formData.get("name") as string) ?? "";
  const siteUrl = (formData.get("siteUrl") as string) ?? "";
  const mcpApiKey = (formData.get("mcpApiKey") as string) ?? "";
  await getDrupalDeps().saveInstance({ id, name, siteUrl, mcpApiKey });
  revalidatePath("/connectors/drupal");
}

async function deleteInstanceAction(formData: FormData): Promise<void> {
  "use server";
  await requireExtensionAction("@cinatra-ai/drupal-mcp-connector", "manage");
  const id = (formData.get("id") as string) ?? "";
  if (!id) return;
  await getDrupalDeps().deleteInstance(id);
  revalidatePath("/connectors/drupal");
}

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

export async function DrupalSettingsPage({ ctx }: { ctx: ExtensionHostContext }) {
  await requireExtensionAction("@cinatra-ai/drupal-mcp-connector", "read");
  // Nango readiness comes from the injected host port (host-port inversion); the
  // connector carries no `@cinatra-ai/nango-connector` code import.
  const nangoReady = await ctx.nango.isConfigured();
  // Fail closed loudly when Nango is unconfigured. Save +
  // build paths throw / return [] server-side; render an explanatory banner
  // so admins don't mistake the disabled connector for a bug.
  if (!nangoReady) {
    return (
      <ConnectorSetupPage
        title="Drupal"
        description="Connect Drupal sites for AI agents and the editing widget."
        className="flex flex-col gap-6 pb-8"
      >
        <Alert variant="warning" className="rounded-control">
          <AlertDescription>
            Nango is not configured — the Drupal connector is disabled. Configure it at{" "}
            <Button
              asChild
              variant="link"
              className="h-auto p-0 align-baseline underline"
            >
              <Link href="/configuration/llm/nango">/configuration/llm/nango</Link>
            </Button>{" "}
            first.
          </AlertDescription>
        </Alert>
      </ConnectorSetupPage>
    );
  }
  const instances = listMcpInstancesSorted();
  const statuses = await getDrupalDeps().listInstanceStatuses();
  const statusById = new Map(statuses.map((s) => [s.id, s] as const));

  return (
    // `divider={false}` — the tab row's TabsListRow below owns the etched
    // section rule beneath the header (spec §Dividers: never stack two).
    // `ConnectorSetupPage` pins the header + content to the single Wide
    // column (max-w-3xl · 768px, §II) so their left edges coincide.
    <ConnectorSetupPage
      title="Drupal"
      description="Connect Drupal sites for AI agents and the editing widget."
      divider={false}
      className="pb-8"
    >
      {/*
       * Tabbed setup page (app-connectors.html §II, extended: tabbed setup
       * page with a config how-to in a Help tab always last). This
       * connector holds many connections (one per configured Drupal site)
       * with no separate connect/disconnect flow of its own, so the
       * existing add-instance + configured-instances content is kept as a
       * single "Setup" tab; "Help" is reserved and always LAST, per the
       * spec's "a connector that only needs to explain itself may carry
       * Help and no other tab; then Help is what introduces the tablist"
       * allowance extended to a one-content-tab connector.
       */}
      <Tabs defaultValue="setup" className="gap-6">
        <TabsListRow>
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="help">Help</TabsTrigger>
        </TabsListRow>

        {/* `forceMount` + `data-[state=inactive]:hidden` keeps the Setup
            panel mounted (merely hidden, not unmounted) while the user reads
            Help, so a partially-typed "Add Drupal instance" form (name / site
            URL / MCP API key) survives a tab switch instead of Radix
            discarding the uncontrolled inputs' state on unmount — the same
            pattern already shipped on the sibling connectors in this
            rollout (e.g. github-connector, wordpress-mcp-connector). */}
        <TabsContent
          value="setup"
          forceMount
          className="flex flex-col gap-6 data-[state=inactive]:hidden"
        >
          {/* Add instance form */}
            <section className="soft-panel flex flex-col gap-4 p-6">
              <h2 className="text-base font-semibold text-foreground">Add Drupal instance</h2>
              <form action={saveInstanceAction} className="flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="drupal-name">Instance name</Label>
                  <Input
                    id="drupal-name"
                    name="name"
                    placeholder="My Drupal site"
                    required
                  />
                </div>
                <Field>
                  <FieldLabel htmlFor="drupal-url">Site URL</FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <LinkIcon aria-hidden="true" />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="drupal-url"
                      name="siteUrl"
                      type="url"
                      placeholder="https://example.com"
                      required
                    />
                  </InputGroup>
                </Field>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="drupal-key">MCP API key</Label>
                  <Input
                    id="drupal-key"
                    name="mcpApiKey"
                    type="password"
                    autoComplete="off"
                    placeholder="Bearer key from drush mcp-tools:remote-key-create"
                    required
                  />
                  <p className="text-xs text-muted-foreground">
                    Generate with: <code className="rounded-chip bg-surface-strong px-1 py-0.5">drush mcp-tools:remote-key-create</code> on your Drupal site (drush is the Drupal CLI). Store it immediately — it cannot be shown again.
                  </p>
                </div>
                <div>
                  <Button type="submit">Save instance</Button>
                </div>
              </form>
            </section>

            {/* Configured instances list */}
            <section className="soft-panel flex flex-col gap-3 p-6">
              <h2 className="text-base font-semibold text-foreground">Configured instances</h2>
              {instances.length === 0 ? (
                <div className="flex flex-col gap-1">
                  <p className="text-sm font-medium text-foreground">No Drupal instances yet</p>
                  <p className="text-sm text-muted-foreground">
                    Add a Drupal site to enable agent edits via drupal/mcp_tools.
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {instances.map((instance) => {
                    const status = statusById.get(instance.id);
                    const badgeVariant: "default" | "outline" | "secondary" =
                      status?.isPrivate
                        ? "outline"
                        : status?.status === "registered"
                          ? "default"
                          : "secondary";
                    const badgeLabel =
                      status?.isPrivate
                        ? "Local only"
                        : status?.status === "registered"
                          ? "Registered"
                          : "Not detected";
                    return (
                      <div
                        key={instance.id}
                        className="rounded-card flex items-center justify-between gap-3 border border-line p-3"
                      >
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">
                              {instance.name}
                            </span>
                            <Badge variant={badgeVariant}>{badgeLabel}</Badge>
                          </div>
                          <span className="truncate text-xs text-muted-foreground">
                            {instance.siteUrl}
                          </span>
                          <span className="font-mono text-xs text-muted-foreground">
                            ID: {instance.id}
                          </span>
                        </div>
                        <form action={deleteInstanceAction}>
                          <Input type="hidden" name="id" value={instance.id} />
                          <Button type="submit" variant="outline" size="sm">
                            Delete
                          </Button>
                        </form>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </TabsContent>

        {/* Help — reserved, always LAST. Read-only setup how-to; no form,
            no Save. Content narrows to the design system's Narrow column
            (max-w-xl · 576px, app-connectors.html §II "Additional
            configuration tabs"), flush-left beneath the Wide tab row.
            `forceMount` for the same mount-stability reason as Setup above
            (kept consistent — Help has no inputs to lose, but this avoids an
            unmount/remount flash on every tab switch either direction). */}
        <TabsContent
          value="help"
          forceMount
          className="max-w-xl data-[state=inactive]:hidden"
        >
          <div className="flex flex-col gap-4">
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-foreground">Prerequisites</h2>
                <p className="text-sm text-muted-foreground">
                  Each Drupal site needs the <code className="rounded-chip bg-surface-strong px-1 py-0.5">mcp_tools</code> module
                  installed and enabled, and this Cinatra deployment needs Nango
                  configured — otherwise this connector stays disabled.
                </p>
              </section>
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-foreground">1. Generate an MCP API key</h2>
                <p className="text-sm text-muted-foreground">
                  On the Drupal site, run{" "}
                  <code className="rounded-chip bg-surface-strong px-1 py-0.5">drush mcp-tools:remote-key-create</code> (drush
                  is the Drupal CLI). Copy the key immediately — it cannot be
                  shown again once generated.
                </p>
              </section>
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-foreground">2. Add the instance</h2>
                <p className="text-sm text-muted-foreground">
                  On the <b className="font-medium text-foreground">Setup</b> tab, give the
                  site a name, its base URL, and the key from step 1, then
                  save. You can add as many Drupal sites as you need — each
                  one is a separate instance.
                </p>
              </section>
              <section className="flex flex-col gap-2">
                <h2 className="text-base font-semibold text-foreground">Instance status</h2>
                <p className="text-sm text-muted-foreground">
                  Each configured instance shows{" "}
                  <b className="font-medium text-foreground">Registered</b> once Cinatra can
                  reach its MCP endpoint, <b className="font-medium text-foreground">Not
                  detected</b> if it can&apos;t yet, or <b className="font-medium text-foreground">Local
                  only</b> for a site that is not publicly reachable.
                </p>
              </section>
            </div>
          </TabsContent>
        </Tabs>
    </ConnectorSetupPage>
  );
}
