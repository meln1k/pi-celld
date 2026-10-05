import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { boolean, object, parseSafe, string } from "remix/data-schema";
import { parseFormData } from "remix/form-data-parser";
import { Database, type MigrateResult, type MigrationDescriptor } from "remix/data-table";
import { tryAsync } from "../../result.ts";
import type { Env } from "../../env.ts";
import { userMigrations } from "./migrations.ts";
import type {
  SessionSummary,
  UserState,
} from "../../actions/sessions/public/session-state.ts";

export async function migrateUserDatabase(
  storage: DurableObjectState["storage"],
  migrations: MigrationDescriptor[],
): Promise<MigrateResult> {
  const unsupported = async (): Promise<never> => {
    throw new Error(
      "Cell migration driver only supports raw SQL inside storage.transaction()",
    );
  };
  const db = new Database({
    dialect: "sqlite",
    capabilities: {
      returning: false,
      savepoints: false,
      upsert: false,
      transactionalDdl: false,
      migrationLock: false,
    },
    async execute({ operation }) {
      if (operation.kind !== "raw") return unsupported();
      return {
        rows: storage.sql.exec(
          operation.sql.text,
          ...(operation.sql.values as (string | number | ArrayBuffer | null)[]),
        ).toArray(),
      };
    },
    async executeScript(sql) {
      storage.sql.exec(sql).toArray();
    },
    beginTransaction: unsupported,
    commitTransaction: unsupported,
    rollbackTransaction: unsupported,
    hasTable: unsupported,
    hasColumn: unsupported,
    createSavepoint: unsupported,
    rollbackToSavepoint: unsupported,
    releaseSavepoint: unsupported,
    wipe: unsupported,
    close() {},
  });
  const writeVersion = () =>
    JSON.stringify(
      storage.sql.exec(
        "SELECT total_changes() AS changes, schema_version AS schemaVersion FROM pragma_schema_version",
      ).toArray()[0],
    );
  let changed = false;
  const result = await storage.transaction(async () => {
    const before = writeVersion();
    const result = await db.migrate(
      migrations.map((migration) => ({ ...migration, transaction: "none" })),
    );
    changed = writeVersion() !== before;
    return result;
  });
  if (changed) await storage.sync();
  return result;
}

const activitySchema = object({ cellId: string(), busy: boolean() });

// One shared user cell for this private, single-user prototype.
export function userCell(env: Env) {
  return env.USERS.getByName("local");
}

export async function profile(env: Env): Promise<UserState> {
  return userCell(env).profile();
}

export function isSessionId(id: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    .test(id);
}

export class User extends DurableObject<Env> {
  private ready: Promise<CryptoKey | undefined>;
  private listeners = new Set<(sessions: SessionSummary[]) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(() => this.open());
  }

  async profile(): Promise<UserState> {
    const key = await this.ready;
    return {
      sessions: this.sessions(),
      hasApiKey: !!this.credential(),
      keyStorageAvailable: !!key,
    };
  }

  async registerSession(id: string): Promise<void> {
    await this.ready;
    if (typeof id !== "string" || !isSessionId(id)) {
      throw new Error("Invalid session ID");
    }
    const inserted = this.ctx.storage.sql
      .exec(
        "INSERT INTO sessions (id, title, createdAt, cellId) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id",
        id,
        `Session ${id.slice(0, 8)}`,
        Date.now(),
        this.env.AGENT_SESSIONS.idFromName(id).toString(),
      )
      .toArray();
    await this.ctx.storage.sync();
    if (inserted.length) this.broadcast();
  }

  async sessionIdentity(cellId: string): Promise<SessionSummary | null> {
    await this.ready;
    const session = this.ctx.storage.sql
      .exec<Omit<SessionSummary, "busy"> & { busy: number }>(
        "SELECT id, title, createdAt, busy, parentId FROM sessions WHERE cellId = ?",
        cellId,
      )
      .toArray()[0];
    return session ? { ...session, busy: !!session.busy } : null;
  }

  async registerChild(
    parentCellId: string,
    id: string,
    title: string,
  ): Promise<void> {
    await this.ready;
    const parent = await this.sessionIdentity(parentCellId);
    if (!parent || parent.parentId) {
      throw new Error("Only root sessions can create threads");
    }
    if (
      typeof id !== "string" ||
      !isSessionId(id) ||
      typeof title !== "string" ||
      !title.trim() ||
      title.length > 100
    ) {
      throw new Error("Invalid child session");
    }
    const existing = this.sessions().find((session) => session.id === id);
    if (existing && existing.parentId !== parent.id) {
      throw new Error("Session belongs to another parent");
    }
    const inserted = this.ctx.storage.sql
      .exec(
        "INSERT INTO sessions (id, title, createdAt, cellId, parentId) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id",
        id,
        title.trim(),
        Date.now(),
        this.env.AGENT_SESSIONS.idFromName(id).toString(),
        parent.id,
      )
      .toArray();
    await this.ctx.storage.sync();
    if (inserted.length) this.broadcast();
  }

  async childSession(
    parentCellId: string,
    id: string,
  ): Promise<SessionSummary> {
    await this.ready;
    const parent = await this.sessionIdentity(parentCellId);
    const child = this.sessions().find((session) => session.id === id);
    if (!parent || parent.parentId || !child || child.parentId !== parent.id) {
      throw new Error("Thread is not a child of this session");
    }
    return child;
  }

  async reportActivity(cellId: string, busy: boolean): Promise<void> {
    await this.ready;
    if (!parseSafe(activitySchema, { cellId, busy }).success) {
      throw new Error("Invalid activity");
    }
    const changed = this.ctx.storage.sql
      .exec(
        "UPDATE sessions SET busy = ? WHERE cellId = ? AND busy != ? RETURNING id",
        Number(busy),
        cellId,
        Number(busy),
      )
      .toArray();
    if (!changed.length) return;
    await this.ctx.storage.sync();
    this.broadcast();
  }

  private async open() {
    await migrateUserDatabase(this.ctx.storage, userMigrations);
    for (
      const { id } of this.ctx.storage.sql
        .exec<{ id: string }>("SELECT id FROM sessions WHERE cellId IS NULL")
        .toArray()
    ) {
      this.ctx.storage.sql.exec(
        "UPDATE sessions SET cellId = ? WHERE id = ?",
        this.env.AGENT_SESSIONS.idFromName(id).toString(),
        id,
      );
    }
    let key: CryptoKey | undefined;
    if (this.env.USER_KEY_ENCRYPTION_KEY) {
      const bytes = Uint8Array.from(
        atob(this.env.USER_KEY_ENCRYPTION_KEY),
        (char) => char.charCodeAt(0),
      );
      if (bytes.length !== 32) {
        throw new Error(
          "USER_KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
        );
      }
      key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, [
        "encrypt",
        "decrypt",
      ]);
    }
    // A blank row marks explicit removal; never resurrect the environment key.
    if (key && this.env.OPENCODE_API_KEY && this.credential() === undefined) {
      await this.storeKey(this.env.OPENCODE_API_KEY, key);
    }
    await this.ctx.storage.sync();
    return key;
  }

  private sessions(): SessionSummary[] {
    return this.ctx.storage.sql
      .exec<Omit<SessionSummary, "busy"> & { busy: number }>(
        "SELECT id, title, createdAt, busy, parentId FROM sessions ORDER BY createdAt DESC, id DESC",
      )
      .toArray()
      .map((session) => ({ ...session, busy: !!session.busy }));
  }

  private broadcast() {
    // ponytail: full-list snapshots; use per-session deltas if large lists make fan-out costly.
    const sessions = this.sessions();
    for (const send of this.listeners) send(sessions);
  }

  // celld 0.6.1 cannot transfer live streams over RPC; SSE uses the HTTP transport.
  async fetch(request: Request): Promise<Response> {
    await this.ready;
    const encoder = new TextEncoder();
    let pending: Uint8Array | undefined;
    let cleanup = () => {};
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const send = (sessions: SessionSummary[]) => {
          const frame = encoder.encode(`data: ${JSON.stringify(sessions)}\n\n`);
          // Full snapshots let a slow reader skip intermediate states without losing updates.
          pending = frame;
          if ((controller.desiredSize ?? 0) > 0) {
            controller.enqueue(pending);
            pending = undefined;
          }
        };
        this.listeners.add(send);
        send(this.sessions());
        const heartbeat = setInterval(() => {
          if ((controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
        }, 15_000);
        const abort = () => {
          cleanup();
          controller.close();
        };
        cleanup = () => {
          this.listeners.delete(send);
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", abort);
        };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      },
      pull: (controller) => {
        if (pending) {
          controller.enqueue(pending);
          pending = undefined;
        }
      },
      cancel: () => cleanup(),
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }

  private credential() {
    return this.ctx.storage.sql
      .exec<{ value: string }>(
        "SELECT value FROM credentials WHERE name = 'opencode'",
      )
      .toArray()[0]?.value;
  }

  private async storeKey(apiKey: string, key: CryptoKey) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(this.ctx.id.toString()),
      },
      key,
      new TextEncoder().encode(apiKey),
    );
    this.ctx.storage.sql.exec(
      "INSERT INTO credentials VALUES ('opencode', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      JSON.stringify({
        iv: Array.from(iv),
        ciphertext: Array.from(new Uint8Array(ciphertext)),
      }),
    );
    await this.ctx.storage.sync();
  }

  async saveKey(request: Request): Promise<Response> {
    const key = await this.ready;
    const [form, error] = await tryAsync(
      parseFormData(request, { maxFiles: 0, maxParts: 2, maxTotalSize: 8192 }),
      () => "Invalid key form",
    );
    if (error !== undefined) return new Response(error, { status: 400 });
    if (form.get("intent") === "remove") {
      this.ctx.storage.sql.exec(
        "INSERT INTO credentials VALUES ('opencode', '') ON CONFLICT(name) DO UPDATE SET value = ''",
      );
      await this.ctx.storage.sync();
    } else {
      const apiKey = form.get("apiKey");
      if (
        typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 2048
      ) {
        return new Response("Provide an API key (up to 2,048 characters)", {
          status: 400,
        });
      }
      if (!key) {
        return new Response(
          "Configure USER_KEY_ENCRYPTION_KEY before saving credentials",
          {
            status: 503,
          },
        );
      }
      await this.storeKey(apiKey.trim(), key);
    }
    return new Response(null, { status: 204 });
  }

  async credentials(): Promise<string | null> {
    const key = await this.ready;
    // Internal cell-to-cell only. There is intentionally no public route for this.
    const stored = this.credential();
    if (!stored) return null;
    if (!key) throw new Error("Credential encryption is not configured");
    const { iv, ciphertext } = JSON.parse(stored) as {
      iv: number[];
      ciphertext: number[];
    };
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: new Uint8Array(iv),
        additionalData: new TextEncoder().encode(this.ctx.id.toString()),
      },
      key,
      new Uint8Array(ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  }
}
