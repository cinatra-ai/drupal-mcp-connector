import "server-only";

import type { Metadata } from "next";
import { revalidatePath } from "next/cache";

import { Button } from "./components/ui/button";
import { LinkIcon } from "lucide-react";
import { Input } from "./components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./components/ui/input-group";
import { Field, FieldDescription, FieldLabel } from "./components/ui/field";
import { Label } from "./components/ui/label";
import { Badge } from "./components/ui/badge";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Main, PageHeader, PageContent } from "@cinatra-ai/sdk-ui/marketplace";
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { requireExtensionAction } from "@cinatra-ai/sdk-extensions";
import {
  deleteDrupalInstance,
  listDrupalInstances,
  saveDrupalInstance,
} from "@/lib/drupal-api";
import { getDrupalMcpInstanceStatuses } from "@/lib/drupal-mcp-connection";

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
  await saveDrupalInstance({ id, name, siteUrl, mcpApiKey });
  revalidatePath("/connectors/drupal");
}

async function deleteInstanceAction(formData: FormData): Promise<void> {
  "use server";
  await requireExtensionAction("@cinatra-ai/drupal-mcp-connector", "manage");
  const id = (formData.get("id") as string) ?? "";
  if (!id) return;
  await deleteDrupalInstance(id);
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
      <Main className="min-h-screen">
        <PageHeader title="Drupal" description="Connect Drupal sites for AI agents and the editing widget." />
        <PageContent className="flex flex-col gap-6 pb-8">
          <Alert variant="warning" className="rounded-control">
            <AlertDescription>
              Nango is not configured — the Drupal connector is disabled. Configure it at <a className="underline" href="/configuration/llm/nango">/configuration/llm/nango</a> first.
            </AlertDescription>
          </Alert>
        </PageContent>
      </Main>
    );
  }
  const instances = await listDrupalInstances();
  const statuses = await getDrupalMcpInstanceStatuses();
  const statusById = new Map(statuses.map((s) => [s.id, s] as const));

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Drupal"
        description="Connect Drupal sites for AI agents and the editing widget."
      />
      <PageContent className="flex flex-col gap-6 pb-8">
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
                      <input type="hidden" name="id" value={instance.id} />
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
      </PageContent>
    </Main>
  );
}
