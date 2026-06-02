// Dispatch-route entry.
import type { ExtensionHostContext } from "@cinatra-ai/sdk-extensions";
import { DrupalSettingsPage } from "./settings-page";

// Nango readiness is read from the injected host port `ctx.nango.*`
// (host-port inversion) inside DrupalSettingsPage; the dispatch route supplies
// `ctx`. No host props beyond the standard setup-page contract.
type ConnectorSetupPageProps = {
  packageId: string;
  slug: string;
  searchParams: Record<string, string | string[] | undefined>;
  ctx: ExtensionHostContext;
};

export default async function DrupalConnectorSetupPage({
  ctx,
}: ConnectorSetupPageProps) {
  return DrupalSettingsPage({ ctx });
}
