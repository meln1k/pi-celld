# Pi Celld Agent Guide

This app was scaffolded with `remix new`. Use these conventions when continuing to build it out.

## Commands

```sh
deno install --frozen
deno task celld
deno task test
deno task test:celld
deno task generate-types
deno task typecheck
```

Re-run `deno task celld` after source changes. The native smoke test requires a saved OpenCode key and makes one paid model call.

Dependencies, compiler settings, and tasks live in `deno.json`; commit `deno.lock`. Build commands use Deno tasks and their cross-platform shell builtins. Tests use `node:test` and typecheck before execution. `deno check` checks the app and tests. Do not add a separate TypeScript config or dependency.

Pi Durable and its SQLite adapter use the published npm package, pinned in `deno.json` and `deno.lock`; there is no vendor tree or duplicated path config. Sessions call `openDurableObjectSqliteStorage(ctx.storage)` directly; their one-time table adoption lives in the Session cell, and Remix migrations belong to the User cell. Do not add a local Pi adapter wrapper.

`deno task typecheck` builds the Worker and regenerates `worker-configuration.d.ts` with the standard Wrangler CLI. Deno maps its extensionless Worker type import to source; `app/env.ts` inherits generated bindings and only makes secrets optional. Plain async namespace mocks belong in tests. Do not edit generated bindings; non-secret configuration belongs in `wrangler.jsonc` vars, secrets in ignored `.dev.vars` or deployment injection.

The `build` task cleans output, copies static files, and runs `build.ts` with Deno. Remix's `app/assets.ts` discovers browser assets; esbuild bundles them and the Worker. An esbuild plugin injects Worker asset metadata without copying or modifying application sources. Keep `render({ assets })`, document script metadata, and `clientEntry(import.meta.url, ...)` connected to that integration. Dependencies use ordinary npm package resolution; no resolver plugin is needed. Register new User migrations in `app/cells/user/migrations.ts` using SQL text imports; keep applied SQL bytes unchanged.

## Building Features

Refer to ./.agents/skills/remix/SKILL.md for the Remix mental model and how to find guides and API READMEs through `node_modules/remix/INDEX.md`.

## Starter Layout

- `app/routes.ts` defines the shared route contract used by server and browser modules for type-safe hrefs
- `app/router.ts` owns context typing, middleware, and route-to-controller mappings
- `worker.ts` is the celld entry point and passes per-request bindings to the shared router as typed `context.env`
- `app/actions/home/`, `settings/`, and `sessions/` colocate route actions in `controller.tsx` and UI in `page.tsx`
- `app/cells/session/cell.ts` and `user/cell.ts` own the stateful cells and named RPC methods; cell `fetch()` handlers carry SSE only. Remix routers stay in the Worker. User migrations live in `app/cells/user/migrations/`
- `app/actions/sessions/public/` contains the hydrated chat and shared state types
- `app/actions/document.tsx` and `workspace.tsx` provide shared page composition
- `app/actions/public/entry.ts` is the shared browser runtime entry
- `app/assets.ts` owns Remix's build-time asset server and document script entry
- `build.ts` bundles browser assets and the Worker with esbuild; celld serves the built static assets
- Root `public/` contains static files served unchanged from the app root

This starter intentionally begins small; add directories like `app/data/`, `app/middleware/`, `app/ui/`, and `test/` only when you need them.
