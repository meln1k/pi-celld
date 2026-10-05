import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  BACKGROUND_CONTEXT,
  withAbortSignal,
} from "@earendil-works/chord/context";
import type { JsonValue, Op } from "@earendil-works/chord/delta";
import { createModels } from "@earendil-works/pi-ai/models";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import {
  type Conversation,
  createRegistry,
  type Extension,
  Harness,
  InboxDoc,
  LiveDoc,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { parseSafe, string } from "remix/data-schema";
import { maxLength } from "remix/data-schema/checks";
import { field, object } from "remix/data-schema/form-data";
import {
  MaxTotalSizeExceededError,
  parseFormData,
} from "remix/form-data-parser";

import { tryAsync } from "../../result.ts";
import { userCell } from "../user/cell.ts";
import { present } from "../../actions/sessions/public/session-state.ts";
import { JustBashEnv } from "./execution-env.ts";
import { ThreadTools } from "./thread-tools.ts";
import type { Env } from "../../env.ts";

const context = BACKGROUND_CONTEXT;
const RECOVERY_MS = 30_000;

export async function migratePiTables(storage: DurableObjectState["storage"]) {
  // Adopt the SDK trial's namespace once; all future SQL uses Pi's native names.
  const changed = await storage.transaction(async () => {
    const tables = new Set(
      storage.sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
        .toArray().map(({ name }: { name: string }) => name),
    );
    if (!tables.has("pi_durable_schema")) return false;
    if (tables.has("durable_schema")) {
      throw new Error("Both legacy and SDK Pi stores exist");
    }
    const names = [
      "durable_schema",
      ...SQLITE_MIGRATIONS.flatMap((migration) =>
        migration.statements.flatMap((sql) => {
          const match = /^CREATE TABLE ([a-z_]+)/i.exec(sql);
          return match ? [match[1]] : [];
        })
      ),
    ];
    for (const name of names) {
      storage.sql.exec(`ALTER TABLE pi_${name} RENAME TO ${name}`);
    }
    return true;
  });
  if (changed) await storage.sync();
}

const messageForm = object({
  content: field(
    string()
      .pipe(maxLength(16_000))
      .refine((value) => !!value.trim(), "Message cannot be blank")
      .transform((value) => value.trim()),
  ),
  requestId: field(
    string().refine(
      (value) => /^[a-zA-Z0-9-]{1,100}$/.test(value),
      "Invalid request ID",
    ),
  ),
});

export class AgentSession extends DurableObject<Env> {
  private runtime: ReturnType<AgentSession["open"]>;
  private activityBusy = false;
  private reportedBusy?: boolean;
  private activityReport = Promise.resolve();
  private admitting = 0;
  private idle?: Promise<void>;
  private wakeTail = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.runtime = ctx.blockConcurrencyWhile(() => this.open());
  }

  async init() {
    const { conversation } = await this.runtime;
    return { conversationId: String(conversation.id) };
  }

  async stop() {
    const { conversation } = await this.runtime;
    await conversation.abort(context);
    return { stopped: true };
  }

  async state() {
    const { conversation } = await this.runtime;
    const watch = await conversation.watch(context);
    const state = present(watch.value);
    await watch.stop();
    return state;
  }

  private models() {
    const models = createModels({
      authContext: {
        env: async (
          name,
        ) => (name === "OPENCODE_API_KEY" ? this.apiKey() : undefined),
        fileExists: async () => false,
      },
    });
    models.setProvider(opencodeGoProvider());
    return models;
  }

  private async open() {
    // Protect startup itself, including recovery of a dispatched alarm.
    await this.ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    await migratePiTables(this.ctx.storage);
    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const models = this.models();
    const registry = createRegistry();
    registry.install(CodingTools);
    const identity = await userCell(this.env).sessionIdentity(
      this.ctx.id.toString(),
    );
    const extensions: Extension[] = [CodingTools];
    if (!identity?.parentId) {
      const threads = ThreadTools(this.env, this.ctx.id.toString());
      registry.install(threads);
      extensions.push(threads);
    }
    // ponytail: virtual files live until cell eviction; persist the FS if restart recovery is needed.
    const env = new JustBashEnv(this.ctx.id.toString());
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: ({ cwd }) => env.withCwd(cwd ?? "/workspace"),
      },
      context,
    );
    const model = {
      provider: "opencode-go",
      modelId: this.env.AGENT_MODEL ?? "deepseek-v4.1-flash",
    };
    const conversation = await harness.root(context);
    await conversation.configure(
      {
        model,
        cwd: "/workspace",
        extensions,
        instructions:
          `You are an expert coding assistant operating inside Pi Durable on celld. Help users by reading files, executing available commands, editing code, and writing new files.

Environment:
- Your working directory is /workspace. The coding tools share a session-local, in-memory filesystem, initially containing only /workspace/.keep.
- bash runs the just-bash interpreter, not an operating-system shell. There is no host filesystem, host process execution, or network access through these tools.
- Do not assume this application's source code, a Git repository, dependencies, Node.js, Python, package managers, or other host executables are available. Inspect the workspace and available commands first.
- You cannot install packages, download files, call external APIs, or start servers. When a task needs these capabilities, explain the limitation and provide code or commands for the user to run elsewhere.
- Conversation history is durable, but workspace files disappear on cell eviction or restart. Recheck files before relying on earlier tool results; never claim files are durably saved.
- Commands are limited to 10 seconds, the virtual filesystem to 8 MiB total, and command output to 1 MiB. Tool output may be truncated sooner. Keep commands and output bounded; use targeted searches and read offset/limit for large files.
- Shell output is delivered when the command finishes, not streamed live. File watching is unavailable.

Delegation:
${
            identity?.parentId
              ? "- You are a child session. Complete your assigned task and return your findings in your final answer. You cannot create threads or delegate further."
              : "- Use create_thread for independent subtasks, send_thread_message for follow-ups, get_thread_status for activity, read_thread for recent messages, and wait_for_threads to await specific submission replies. Only your own children are accessible.\n- Children have separate histories and empty workspaces; include all needed context in their prompts. Files are not shared. Children cannot create threads.\n- Creation and messaging return threadId and submissionId. Wait on those exact submissions, not just an idle session. Treat unanswered as failure or cancellation and inspect the reason. Stopping your own turn cancels waiting but does not stop children."
          }

Working rules:
- Read relevant files before editing. Use bash for listing and searching, read for examining files, edit for precise changes, and write for new files or complete rewrites.
- For edit, each edits[].oldText must match exactly and uniquely against the original file. Combine disjoint changes in one call; replacements must not overlap. Keep match text small but unambiguous.
- Make the smallest correct change, preserve unrelated user work, and follow applicable project instructions found in the workspace.
- Verify changes with the tools and commands actually available. Distinguish executed checks from suggested checks; never claim a command ran or tests passed without observing the result.
- Be concise, show file paths clearly, and explain important limitations or unfinished work.`,
      },
      context,
    );
    await this.watchActivity(harness, conversation);
    const runtime = { harness, conversation, model };
    await this.wake(runtime);
    return runtime;
  }

  private async watchActivity(harness: Harness, conversation: Conversation) {
    const events = await watchEvents(harness, conversation.id, context);
    this.activityBusy = !!events.snapshot.run;
    this.reportedBusy = undefined;
    await this.reportActivity();
    events.start((batch) => {
      // A queued follow-up can end one run and start another in the same commit.
      for (const event of batch) {
        if (event.type === "snapshot") this.activityBusy = !!event.run;
        if (event.type === "run_start") this.activityBusy = true;
        if (event.type === "run_end") this.activityBusy = false;
      }
      const report = this.reportActivity();
      this.ctx.waitUntil(report);
      return report;
    });
  }

  private reportActivity() {
    // Serialize alarm retries with watch callbacks; always publish the latest delivered state.
    return (this.activityReport = this.activityReport.then(async () => {
      const busy = this.activityBusy;
      if (busy === this.reportedBusy) return;
      const [, error] = await tryAsync(
        userCell(this.env).reportActivity(this.ctx.id.toString(), busy),
        (cause) => String(cause),
      );
      if (error !== undefined) {
        console.error(error);
        const alarm = this.wakeTail.then(() =>
          this.ctx.storage.setAlarm(Date.now() + RECOVERY_MS)
        );
        this.wakeTail = alarm.then(
          () => {},
          () => {},
        );
        await alarm;
      } else {
        this.reportedBusy = busy;
      }
    }));
  }

  private async apiKey(): Promise<string | undefined> {
    return (await userCell(this.env).credentials()) ?? undefined;
  }

  private wake(
    runtime: { harness: Harness; conversation: Conversation },
  ): Promise<void> {
    // Alarm selection must not race admission or another idle waiter settling.
    const wake = this.wakeTail.then(async () => {
      const { harness, conversation } = runtime;
      const { tasks, scheduling } = await harness.inspect(context);
      if (scheduling === "closing") return;
      const reporting = this.activityBusy !== this.reportedBusy;
      if (!tasks.length && !this.admitting && !reporting) {
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const live = await harness.snapshot(LiveDoc, conversation.id, context);
      const at = live?.generation?.deferred?.pollAt ??
        live?.generation?.retry?.at;
      const sleeping = !this.idle && !this.admitting && !reporting &&
        at !== undefined && at - Date.now() > 60_000;
      await this.ctx.storage.setAlarm(sleeping ? at : Date.now() + RECOVERY_MS);
      if (!tasks.length) return; // A paused inbox is not runnable work.
      harness.resume();
      if (
        sleeping || this.idle || tasks.every((task) => task.record.background)
      ) return;
      // Bound the host wait, not the durable turn. An alarm renews it if needed.
      const budget = new AbortController();
      const timer = setTimeout(() => budget.abort(), 10 * 60_000);
      this.idle = conversation
        .waitForIdle(withAbortSignal(budget.signal, context))
        .catch((error) => {
          if (!budget.signal.aborted) console.error(error);
        })
        .finally(async () => {
          clearTimeout(timer);
          this.idle = undefined;
          await this.wake(runtime);
        });
      this.ctx.waitUntil(this.idle);
    });
    this.wakeTail = wake.catch(() => {});
    return wake;
  }

  async alarm() {
    // Deadman: a crash during alarm handling must leave another wake behind.
    await this.ctx.storage.setAlarm(Date.now() + RECOVERY_MS);
    const runtime = await this.runtime;
    await this.reportActivity();
    await this.wake(runtime);
  }

  async messages(request: Request): Promise<Response> {
    const { conversation, model } = await this.runtime;
    if (model.provider === "opencode-go" && !(await this.apiKey())) {
      return Response.json(
        {
          error: "Set an OpenCode API key in Settings before sending messages.",
        },
        { status: 503 },
      );
    }
    if (Number(request.headers.get("content-length")) > 100_000) {
      return Response.json({ error: "Message too large" }, { status: 413 });
    }
    const [form, failure] = await tryAsync(
      parseFormData(request, {
        maxFiles: 0,
        maxParts: 2,
        maxTotalSize: 100_000,
      }),
      (error) => ({
        error: error instanceof MaxTotalSizeExceededError
          ? "Message too large"
          : "Invalid message form",
        status: error instanceof MaxTotalSizeExceededError ? 413 : 400,
      }),
    );
    if (failure !== undefined) {
      return Response.json({ error: failure.error }, {
        status: failure.status,
      });
    }
    const result = parseSafe(messageForm, form);
    if (!result.success) {
      return Response.json(
        { error: "Provide a message (up to 16,000 characters) and requestId." },
        { status: 400 },
      );
    }
    return Response.json(
      await this.submitMessage(result.value.content, result.value.requestId),
      {
        status: 202,
      },
    );
  }

  async submitMessage(content: string, requestId: string) {
    if (
      typeof content !== "string" ||
      !content.trim() ||
      content.length > 16_000 ||
      typeof requestId !== "string" ||
      !/^[a-zA-Z0-9-]{1,100}$/.test(requestId)
    ) {
      throw new Error("Invalid message or request ID");
    }
    const runtime = await this.runtime;
    const { conversation, model } = runtime;
    if (model.provider === "opencode-go" && !(await this.apiKey())) {
      throw new Error(
        "Set an OpenCode API key in Settings before sending messages.",
      );
    }
    this.admitting++;
    try {
      await this.wake(runtime); // Persist recovery before Pi can accept this input.
      const submission = await conversation.submit(
        {
          type: "input",
          content: content.trim(),
          requestId,
          whenBusy: "followUp",
        },
        context,
      );
      return { submissionId: String(submission.id) };
    } finally {
      this.admitting--;
      await this.wake(runtime);
    }
  }

  async threadStatus(submissionId?: string) {
    const { harness, conversation } = await this.runtime;
    const [live, inbox] = await Promise.all([
      harness.snapshot(LiveDoc, conversation.id, context),
      harness.snapshot(InboxDoc, conversation.id, context),
    ]);
    const activity = { busy: !!live?.run, queued: inbox?.items?.length ?? 0 };
    if (submissionId === undefined) return { ...activity, submission: null };
    if (
      typeof submissionId !== "string" ||
      !/^[1-9][0-9]*$/.test(submissionId) ||
      !Number.isSafeInteger(Number(submissionId))
    ) {
      throw new Error("Invalid submission ID");
    }
    const submission = await harness.submission(
      Number(submissionId) as SubmissionId,
      context,
    );
    if (!submission) throw new Error("Submission not found");
    const record = await submission.status(context);
    if (record.conversationId !== conversation.id || record.type !== "input") {
      throw new Error("Submission not found");
    }
    // Read the exact answer after settlement; an earlier snapshot may precede that commit.
    const entry = record.status === "done"
      ? (
        await conversation.entries(
          { minEntryId: record.answer, maxEntryId: record.answer },
          1,
          undefined,
          context,
        )
      ).items[0]
      : undefined;
    const answer = record.status === "done"
      ? (entry?.model ?? [])
        .flatMap((message) =>
          message.role === "assistant"
            ? message.content.flatMap((
              block,
            ) => (block.type === "text" ? [block.text] : []))
            : []
        )
        .join("\n")
      : "";
    return {
      ...activity,
      submission: {
        status: record.status,
        reason: record.reason ?? null,
        answer: answer.slice(0, 16_000),
        truncated: answer.length > 16_000,
      },
    };
  }

  async readThread(limit = 20) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Invalid message limit");
    }
    const state = await this.state();
    return {
      busy: state.busy,
      queued: state.queued,
      omittedMessages: Math.max(0, state.messages.length - limit),
      messages: state.messages.slice(-limit).map((
        { id, role, text, error },
      ) => ({
        id,
        role,
        text: text.slice(0, 4000),
        truncated: text.length > 4000,
        error: error ?? null,
      })),
    };
  }

  // celld 0.6.1 cannot transfer live streams over RPC; SSE uses the HTTP transport.
  async fetch(request: Request): Promise<Response> {
    const { conversation } = await this.runtime;
    const watch = await conversation.watch(context);
    const encoder = new TextEncoder();
    let cleanup = () => {};
    let resume = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let stopped = false;
        const send = (ops: readonly Op[]) =>
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(ops)}\n\n`),
          );
        send([["r", watch.value as unknown as JsonValue]]);
        watch.start(async (_value, ops) => {
          // Let Pi bound pending frames and replace them with a snapshot on overflow.
          while (!stopped && (controller.desiredSize ?? 0) <= 0) {
            await new Promise<void>((resolve) => {
              resume = resolve;
            });
          }
          if (!stopped) send(ops);
        });
        const heartbeat = setInterval(() => {
          if (!stopped && (controller.desiredSize ?? 0) > 0) {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          }
        }, 15_000);
        cleanup = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(heartbeat);
          resume();
          void watch.stop();
        };
        const abort = () => {
          if (stopped) return;
          cleanup();
          controller.close();
        };
        void watch.closed.then(abort);
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      },
      pull() {
        resume();
      },
      cancel() {
        cleanup();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    });
  }
}
