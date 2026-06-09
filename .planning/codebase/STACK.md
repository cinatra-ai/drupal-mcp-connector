# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- TypeScript — all source in `src/`, targeting ES2023, compiled via `tsconfig.json`

**Secondary:**
- TSX — React components in `src/components/ui/` and page files (`src/settings-page.tsx`, `src/setup-page.tsx`)

## Runtime

**Environment:**
- Node.js (ESM modules; `"type": "module"` in `package.json`)
- Browser (React UI components target DOM via `tsconfig.json` `lib: ["ES2023", "DOM", "DOM.Iterable"]`)

**Package Manager:**
- npm (`.npmrc` present with `auto-install-peers=false`)
- Lockfile: not detected in repo (extracted from monorepo)

## Frameworks

**Core:**
- React 19 (peer dependency `^19.2.3`) — UI components and page rendering

**Testing:**
- Vitest — test runner; config at `vitest.config.ts`; tests in `src/__tests__/`

**Build/Dev:**
- TypeScript compiler (`tsc`) — outputs to `dist/`, configured in `tsconfig.json`
- ESNext module resolution with `moduleResolution: bundler`

## Key Dependencies

**Critical:**
- `@modelcontextprotocol/sdk` — MCP client (`Client`, `StreamableHTTPClientTransport`) used in `src/lib/drupal-mcp-client.ts` to connect to the Drupal MCP server endpoint
- `zod` — schema validation for all MCP tool input schemas in `src/mcp/handlers.ts` and `src/mcp/registry.ts`
- `@cinatra-ai/sdk-extensions` (peer, optional) — `ExtensionPrimitiveRequest`, `ExtensionMcpToolServer`, `ExtensionMcpToolResult` types used throughout `src/mcp/`
- `@cinatra-ai/sdk-ui` (peer, optional) — UI SDK peer dependency

**Infrastructure:**
- `class-variance-authority ^0.7.1` — variant styling for UI components in `src/components/ui/`
- `clsx ^2.1.1` — className utility used in `src/lib/utils.ts`
- `radix-ui ^1.4.3` — headless UI primitives backing components in `src/components/ui/`
- `tailwind-merge ^3.5.0` — Tailwind class merging in `src/lib/utils.ts`

## Configuration

**Environment:**
- `DRUPAL_CONTENT_EDITOR_A2A_URL` — A2A agent endpoint URL; defaults to `http://localhost:3020` (read in `src/mcp/handlers.ts`)
- No `.env` file in this package; env vars are host-injected

**Build:**
- `tsconfig.json` — strict TypeScript, ESNext modules, JSX react-jsx, outputs `dist/`
- `vitest.config.ts` — test aliases stub `server-only`, `@cinatra-ai/a2a`, and map package sub-path exports to real source files

## Platform Requirements

**Development:**
- Node.js (version not pinned; no `.nvmrc` or `.node-version` detected)
- Access to monorepo stubs at `tests/__stubs__/` for unit tests (vitest.config.ts resolves them via repo-root relative paths)

**Production:**
- Deployed as a Cinatra connector plugin; `cinatra/plugin.json` defines connector metadata
- `package.json` `cinatra` manifest specifies `kind: connector`, `requestedHostPorts: ["nango"]`
- Host application binds runtime deps via `registerDrupalConnector(deps)` at boot (`src/deps.ts`)

---

*Stack analysis: 2026-06-09*
