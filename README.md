# Pi Celld

Single-user Remix 3 chat prototype for pi-durable on celld. Each session UUID
addresses an `AgentSession` cell with a Harness/root conversation, hosted by
our local Durable Object host on celld SQLite. SSE carries committed
snapshots; request IDs deduplicate retries, Stop cancels work, and native alarms
recover unfinished runs. A shared `User` cell stores the session list and
encrypted OpenCode credentials.

Pi's upstream `DurableObjectSqliteDatabase` adapter normalizes blob bindings/results
and serializes outside statements around native transactions. Sessions use it
directly; celld's output gate protects responses and outbound effects until writes
are durable. The recovery policy does not depend on the Cloudflare Agents SDK.
Wake protection is persisted before
input admission and alarm handling; startup resumes surviving Pi tasks. A single
conversation-scoped idle wait has a ten-minute budget, with a 30-second alarm
heartbeat or a longer alarm for deferred polling/retries. Paused inboxes do not
keep waking. Existing `pi_*` stores migrate transactionally to Pi's native unprefixed
names; unprefixed stores need no renaming. Transcripts, checkpoints, numeric
submission IDs, and User credentials are preserved.

Both cells extend `DurableObject`; the Worker and thread tools call named RPC
methods for ordinary operations. Cell `fetch()` handlers carry SSE only. Remix
routes stay in the Worker; cells have no internal routers or URL contracts.
RPC stubs are not passed across isolates, and stable operation IDs deduplicate
application retries. Credentials have no browser-accessible route.

The sidebar subscribes to one User-cell SSE stream at `/sessions/events` for
new sessions and ready/working indicators across browsers. Session cells report
Pi's committed `pi.live.run` transitions, not individual tokens. Ready means idle,
not that the cell is resident in memory. Reconnects replace the list with a snapshot;
failed activity reports retry on the recovery alarm.

Root sessions can delegate to independent child Session cells using `create_thread`,
`send_thread_message`, `get_thread_status`, `read_thread`, and `wait_for_threads`.
Children appear beneath their parent in the sidebar and can be opened and stopped
like any session. Depth is limited to one: children receive only coding tools, and
the durable User index also rejects grandchildren and cross-parent tool access.
Children start with separate histories and empty workspaces; there is no file sharing.

Creation takes `{ title, prompt }`; messaging takes `{ threadId, message }`. Both
return `{ threadId, submissionId }` and use durable memo IDs to deduplicate replay.
Wait takes `{ threads: [{ threadId, submissionId }], timeoutSeconds? }` (up to 10
submissions, 60 seconds by default, 120 maximum). It waits for all requested inputs,
not merely idle sessions, returning their status and exact replies or a timeout.
`unanswered` is terminal failure/cancellation, not a successful answer. Cancelling
the parent stops its wait, not child execution. Status accepts an optional
`submissionId`; read returns recent messages with explicit truncation markers.

**Keep the server private.** There is no authentication or session ownership
checking. Anyone who can reach it can read sessions and change the shared key.
Pi's default `read`, `write`, `edit`, and `bash` tools use a just-bash virtual
filesystem at `/workspace`, isolated per Session cell, with no host filesystem
or network access. Files are in memory and disappear on cell eviction/restart.
Commands run in the interpreter, not an OS shell; output arrives at completion.
File watchers are unsupported and opened readers snapshot file contents.
Execution is bounded to 10 seconds, 8 MiB of virtual files, and 1 MiB of output.
This is not a hardened security boundary; keep the prototype private.

## Run

Install [Deno](https://deno.com/) 2.9.5 or newer and [celld](https://celld.dev/docs#install), then:

```sh
deno install --frozen
deno task celld
```

The local Worker listens on port 9876. Re-run after source changes: the build task
copies `public/` and runs `build.ts` with Deno. esbuild bundles browser assets;
`deno bundle` builds the SSR Worker into `dist/`, which celld serves.
There is no separate preview or HMR server. Deno manages dependencies in
`deno.json` and `deno.lock`, including npm-registry packages; npm is not required.
`app/assets.ts` uses Remix's asset server for build-time browser asset discovery.
The Worker receives URL metadata instead of the filesystem-backed compiler, so
`render({ assets })`, document script entries, and `clientEntry(import.meta.url, ...)`
use Remix's asset integration. The build prepares that metadata in a temporary
source copy and removes it afterward. Deno resolves the Worker import map and pinned
HTTP imports directly; celld serves the compiled assets.

Pi Durable and its SQLite adapter are imported from source at [this pinned commit](https://github.com/earendil-works/pi/commit/b30a6dd779340f7bc2f3ffa60f4c0a5f914ba9ae).
Deno resolves these imports directly and verifies them against `deno.lock`.
There is no vendor tree or separate TypeScript path mapping.

Save an OpenCode Go key in **Settings**. First generate the encryption secret
once in ignored `.dev.vars` (preserves an existing secret):

```sh
deno eval 'import fs from "node:fs"; import { randomBytes } from "node:crypto"; const text = fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : ""; if (!/^USER_KEY_ENCRYPTION_KEY=/m.test(text)) fs.appendFileSync(".dev.vars", "\nUSER_KEY_ENCRYPTION_KEY=" + randomBytes(32).toString("base64") + "\n", { mode: 0o600 })'
```

Back up this secret separately: losing or changing it makes saved keys
unreadable. Credentials use AES-GCM and never enter browser responses or
transcripts. Optionally set `OPENCODE_API_KEY` in `.dev.vars` to bootstrap once;
explicit removal in Settings prevents reimporting it after restart.

OpenCode Go is the only production provider. Every session uses `deepseek-v4.1-flash`,
overridable with `AGENT_MODEL`. The current model is applied whenever a session opens,
including existing sessions.

The User cell runs bundled Remix migrations during setup, inside one cell-owned
transaction, with an applied-migration journal in its SQLite database. Add new
numbered directories with `up.sql` under `app/cells/user/migrations/` and register
their text imports/descriptors in `migrations.ts`; do not edit SQL already applied.
Deno bundles the SQL text unchanged; cells do not read files at runtime.
Migration `0001` retains its original whitespace to preserve existing checksums.
Pi's session schema remains managed by `SqliteStorage`, not these migrations.

## Checks

```sh
deno task test                  # routing, migration safety, credentials, child access, virtual tools
deno task generate-types        # regenerate worker-configuration.d.ts from wrangler.jsonc
deno task generate-types --check # verify generated bindings are current (CI)
deno task typecheck              # regenerates bindings before checking TypeScript
deno task test:celld             # running celld + saved key; makes one paid model call
deno task test:celld --filter='celld RPC' # running celld; no model call
```

Build tasks and tests execute under Deno. Tests use its `node:test` and
`node:sqlite` compatibility APIs. `deno check` checks the app and tests
using the DOM/Node/Workers types configured in `deno.json`; tests also typecheck
before execution. There is no separate `tsconfig.json` or direct TypeScript dependency.
esbuild is a browser build dependency; Remix and Wrangler also bring tooling transitively.

Binding types use the standard `wrangler types` CLI against `dist/worker.js`.
The Deno import map resolves Wrangler's extensionless `./dist/worker` type import
to `worker.ts`. `app/env.ts` inherits Wrangler-generated bindings; ordinary async
test doubles use a test-only namespace helper. `AGENT_MODEL` comes from `vars` in `wrangler.jsonc`;
the app makes secret bindings optional for running celld without key storage.
Wrangler also infers secret names/types from ignored `.dev.vars`, never their values.
Do not edit `worker-configuration.d.ts` manually.

Tests use Web Requests through the Worker/router boundary, with isolated
in-memory SQLite for cell tests. No browser or Playwright installation is needed.
Session navigation, SSE reconnection and draft behavior require manual browser
checks; server tests do not verify client interactions.

Set `CELLD_ORIGIN` for a different server address. The native smoke checks
creation retries, submission deduplication and the saved/SSR transcript.
It reopens the session URL, not the celld process.
