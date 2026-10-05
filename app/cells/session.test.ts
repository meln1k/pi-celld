import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { it } from "node:test";
import type { DurableObjectState } from "@cloudflare/workers-types";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { AgentSession, migratePiTables } from "./session/cell.ts";
import type { Env } from "../env.ts";
import { migrateUserDatabase, User } from "./user/cell.ts";
import { tryAsync } from "../result.ts";
import { mockNamespace } from "./mock-namespace.ts";

function fixture(cellId = "test-cell") {
  const db = new DatabaseSync(":memory:");
  const ctx = {
    id: { name: cellId, toString: () => cellId },
    storage: {
      sql: {
        exec(
          sql: string,
          ...params: (string | number | Uint8Array | ArrayBuffer | null)[]
        ) {
          assert.doesNotMatch(
            sql,
            /^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i,
          );
          const statement = db.prepare(sql);
          let rows: object[];
          if (!params.length && !statement.columns().length) {
            db.exec(sql);
            rows = [];
          } else {
            rows = statement.all(
              ...params.map((param) =>
                param instanceof ArrayBuffer ? new Uint8Array(param) : param
              ),
            );
          }
          for (const row of rows) {
            const record = row as Record<string, unknown>;
            for (const key of Object.keys(record)) {
              const value = record[key];
              if (value instanceof Uint8Array) {
                record[key] = value.buffer.slice(
                  value.byteOffset,
                  value.byteOffset + value.byteLength,
                );
              }
            }
          }
          const iterator = rows[Symbol.iterator]();
          return {
            toArray: () => rows,
            next: () => iterator.next(),
            [Symbol.iterator]: () => rows[Symbol.iterator](),
          };
        },
      },
      async transaction<T>(callback: () => Promise<T>) {
        db.exec("BEGIN");
        const [result, error] = await tryAsync(
          (async () => {
            const result = await callback();
            db.exec("COMMIT");
            return result;
          })(),
          (cause) => ({ cause }),
        );
        if (error !== undefined) {
          db.exec("ROLLBACK");
          throw error.cause;
        }
        return result;
      },
      async sync() {},
      async deleteAlarm() {},
      async setAlarm() {},
    },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    waitUntil() {},
  } as unknown as DurableObjectState;
  const cells = mockNamespace<AgentSession>(
    () => ({
      init: async () => ({ conversationId: "test" }),
      state: async () => {
        throw new Error("Unexpected state call");
      },
      stop: async () => ({ stopped: true }),
      messages: async () => new Response(null, { status: 202 }),
      fetch: async () => new Response(null),
      submitMessage: async () => {
        throw new Error("Unexpected submit");
      },
      threadStatus: async () => {
        throw new Error("Unexpected status");
      },
      readThread: async () => {
        throw new Error("Unexpected read");
      },
    }),
    ((id: string) => ({ toString: () => `cell:${id}` })) as Env[
      "AGENT_SESSIONS"
    ]["idFromName"],
  );
  const users = mockNamespace<User>(() => ({
    profile: async () => ({
      sessions: [],
      hasApiKey: false,
      keyStorageAvailable: false,
    }),
    registerSession: async () => {},
    reportActivity: async () => {},
    sessionIdentity: async () => null,
    registerChild: async () => {
      throw new Error("Unexpected child creation");
    },
    childSession: async () => {
      throw new Error("Unexpected child lookup");
    },
    credentials: async () => null,
    saveKey: async () => new Response(null, { status: 204 }),
    fetch: async () => new Response(null),
  }), cells.idFromName);
  return {
    ctx,
    db,
    env: {
      AGENT_MODEL: "deepseek-v4.1-flash",
      AGENT_SESSIONS: cells,
      USERS: users,
    },
  };
}

it("User setup adopts existing tables and journals the migration only once", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const id = "12345678-1234-4234-8234-123456789abc";
  f.db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE credentials (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO credentials VALUES ('opencode', '');
  `);
  f.db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(
    id,
    "Existing session",
    123,
  );
  for (let i = 0; i < 2; i++) {
    const user = new User(f.ctx, f.env);
    const profile = await user.profile();
    assert.deepEqual(profile.sessions, [{
      id,
      title: "Existing session",
      createdAt: 123,
      busy: false,
      parentId: null,
    }]);
    assert.deepEqual(
      f.db.prepare("SELECT id, name FROM data_table_migrations").all().map((
        row,
      ) => ({ ...row })),
      [
        { id: "0001", name: "create_user_tables" },
        { id: "0002", name: "session_activity" },
        { id: "0003", name: "session_children" },
      ],
    );
    // Keep the checksum of the originally shipped inline SQL when moving it to a file.
    assert.equal(
      f.db.prepare("SELECT checksum FROM data_table_migrations").get()
        ?.checksum,
      "6f06667058adbf62d05dbb4f3972539e6857947b06070ec8f4d312578b9481b7",
    );
    assert.equal(
      f.db.prepare("SELECT value FROM credentials").get()?.value,
      "",
    );
  }
});

it("cell transactions roll back migration scripts and journals together, and detect drift", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  let syncs = 0;
  f.ctx.storage.sync = async () => {
    assert.equal(f.db.isTransaction, false);
    syncs++;
  };
  const initial = {
    id: "0001",
    name: "initial",
    up: "CREATE TABLE existing (id INTEGER)",
  };
  await migrateUserDatabase(f.ctx.storage, [initial]);
  assert.equal(syncs, 1, "new migrations sync after commit");
  const pending = {
    id: "0002",
    name: "pending",
    up: "CREATE TABLE pending (id INTEGER); INSERT INTO pending VALUES (7);",
  };
  const bad = {
    id: "0003",
    name: "later",
    up: "INSERT INTO missing VALUES (1)",
  };
  await assert.rejects(
    migrateUserDatabase(f.ctx.storage, [initial, pending, bad]),
    /missing/,
  );
  assert.equal(syncs, 1, "failed migrations do not sync");
  assert.equal(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending'").get(),
    undefined,
  );
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM data_table_migrations").get()?.n,
    1,
  );
  const fixed = { ...bad, up: "INSERT INTO pending VALUES (9)" };
  const result = await migrateUserDatabase(f.ctx.storage, [
    initial,
    pending,
    fixed,
  ]);
  assert.deepEqual(result.applied.map((migration) => migration.id), [
    "0002",
    "0003",
  ]);
  assert.deepEqual(
    f.db.prepare("SELECT id FROM pending ORDER BY id").all().map((row) =>
      row.id
    ),
    [7, 9],
  );
  assert.equal(syncs, 2);
  assert.deepEqual(
    (await migrateUserDatabase(f.ctx.storage, [initial, pending, fixed]))
      .applied,
    [],
  );
  assert.equal(syncs, 2, "already-applied migrations do not sync");
  await assert.rejects(
    migrateUserDatabase(f.ctx.storage, [
      { ...initial, up: initial.up + "; CREATE TABLE drifted (id INTEGER)" },
      pending,
      fixed,
    ]),
    /checksum drift/,
  );
  assert.equal(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'drifted'").get(),
    undefined,
  );
});

it("credentials stay encrypted and private; replacement and removal survive reopening", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  const env: Env = {
    ...f.env,
    USER_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    OPENCODE_API_KEY: "bootstrap-secret",
  };
  let user = new User(f.ctx, env);
  const profile = () => user.profile();
  const credentials = () => user.credentials();
  const save = (values: Record<string, string>) =>
    user.saveKey(
      new Request("https://user/key", {
        method: "POST",
        body: new URLSearchParams(values),
      }),
    );
  const register = (id: string) => user.registerSession(id);
  await assert.rejects(register("invalid"), /Invalid session ID/);
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  await register(sessionId);
  await register(sessionId);
  const state = await profile();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].id, sessionId);
  assert.equal(state.sessions[0].title, "Session 12345678");
  assert.equal(state.keyStorageAvailable, true);
  assert.equal(await credentials(), "bootstrap-secret");
  assert.doesNotMatch(JSON.stringify(await profile()), /bootstrap-secret/);
  assert.doesNotMatch(
    String(f.db.prepare("SELECT value FROM credentials").get()?.value),
    /bootstrap-secret/,
  );
  assert.equal((await save({ apiKey: "replacement-secret" })).status, 204);
  user = new User(f.ctx, env);
  assert.equal(await credentials(), "replacement-secret");
  assert.equal((await save({ intent: "remove" })).status, 204);
  user = new User(f.ctx, env);
  assert.equal(await credentials(), null);
  assert.equal((await profile()).hasApiKey, false);
});

it("child relations survive reopening and reject grandchildren, reparenting, and unrelated access", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  let user = new User(f.ctx, f.env);
  const parent = crypto.randomUUID();
  const other = crypto.randomUUID();
  const child = crypto.randomUUID();
  await user.registerSession(parent);
  await user.registerSession(other);
  await user.registerChild(`cell:${parent}`, child, "Review parser");
  await user.registerChild(
    `cell:${parent}`,
    child,
    "Replay must preserve the title",
  );
  await user.registerSession(child); // A direct browser creation retry cannot promote a child.
  user = new User(f.ctx, f.env);
  assert.equal((await user.profile()).sessions.length, 3);
  assert.equal(
    (await user.childSession(`cell:${parent}`, child)).title,
    "Review parser",
  );
  assert.equal((await user.sessionIdentity(`cell:${child}`))?.parentId, parent);
  await assert.rejects(
    user.registerChild(`cell:${child}`, crypto.randomUUID(), "Grandchild"),
    /Only root/,
  );
  await assert.rejects(
    user.registerChild("unknown", crypto.randomUUID(), "Orphan"),
    /Only root/,
  );
  await assert.rejects(
    user.registerChild(`cell:${other}`, child, "Stolen"),
    /another parent/,
  );
  for (
    const [caller, target] of [
      [other, child],
      [parent, other],
      [child, parent],
      [child, child],
    ]
  ) {
    await assert.rejects(
      user.childSession(`cell:${caller}`, target),
      /not a child/,
    );
  }
  const childFixture = fixture(`cell:${child}`);
  t.after(() => childFixture.db.close());
  for (let i = 0; i < 2; i++) {
    const childCell = new AgentSession(childFixture.ctx, {
      ...f.env,
      USERS: mockNamespace<User>(() => user, f.env.USERS.idFromName),
    });
    const { harness, conversation } = await childCell["runtime"];
    const agent = await conversation.agent(context);
    assert.deepEqual(agent.tools.map((tool) => tool.name).sort(), [
      "bash",
      "edit",
      "read",
      "write",
    ]);
    assert.match(agent.instructions!, /cannot create threads/);
    await harness.close(context);
  }
});

it("Pi's adapter adopts SDK stores without resetting transcripts or submission IDs", async (t) => {
  const f = fixture();
  t.after(() => f.db.close());
  // Seed the original unprefixed Pi schema through its public storage API.
  const database = new DurableObjectSqliteDatabase(f.ctx.storage);
  const storage = await SqliteStorage.open(database);
  const harness = await Harness.open(storage, {
    models: createModels(),
    registry: createRegistry(),
  }, context);
  const conversation = await harness.root(context);
  await conversation.commit((tx) =>
    tx.appendEntry(conversation.id, {
      kind: "history",
      model: [{ role: "user", content: "Existing user work", timestamp: 1 }],
    }), context);
  const submission = await conversation.submit(
    { type: "input", content: "No model configured", requestId: "old-request" },
    context,
  );
  const settled = await submission.wait(context);
  assert.equal(settled.status, "unanswered");
  await harness.close(context);
  const before = f.db.prepare("SELECT * FROM entries ORDER BY id").all();
  // Reproduce the former SDK/local adapter namespace before switching to Pi directly.
  for (
    const { name } of f.db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all()
  ) {
    f.db.exec(`ALTER TABLE ${name} RENAME TO pi_${name}`);
  }
  const exec = f.ctx.storage.sql.exec;
  f.ctx.storage.sql.exec = (
    sql: string,
    ...params: (string | number | ArrayBuffer | null)[]
  ) => {
    if (sql.startsWith("ALTER TABLE pi_entries")) {
      throw new Error("Interrupted migration");
    }
    return exec(sql, ...params);
  };
  await assert.rejects(migratePiTables(f.ctx.storage), /Interrupted migration/);
  f.ctx.storage.sql.exec = exec;
  assert.deepEqual(
    f.db.prepare("SELECT * FROM pi_entries ORDER BY id").all(),
    before,
  );
  assert.equal(
    f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'durable_schema'")
      .get(),
    undefined,
  );
  for (let i = 0; i < 2; i++) {
    const cell = new AgentSession(f.ctx, f.env);
    await cell.init();
    assert.deepEqual(
      f.db.prepare("SELECT * FROM entries ORDER BY id").all(),
      before,
    );
    assert.equal((await cell.state()).messages[0].text, "Existing user work");
    assert.equal(
      (await cell.threadStatus(String(submission.id))).submission?.status,
      "unanswered",
    );
    const adopted = await (await SqliteStorage.open(
      new DurableObjectSqliteDatabase(f.ctx.storage),
    ))
      .submissionByRequest(conversation.id, "old-request", context);
    assert.equal(adopted?.id, submission.id);
    assert.equal(
      f.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pi_entries'")
        .get(),
      undefined,
    );
    await (await cell["runtime"]).harness.close(context);
  }
  // Refuse two stores rather than silently choosing or overwriting one.
  f.db.exec(
    "CREATE TABLE pi_durable_schema (singleton INTEGER, version INTEGER)",
  );
  await assert.rejects(migratePiTables(f.ctx.storage), /Both legacy and SDK/);
  assert.deepEqual(
    f.db.prepare("SELECT * FROM entries ORDER BY id").all(),
    before,
  );
});
