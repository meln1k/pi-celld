import { awaitWithContext } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Env } from "../../env.ts";
import { userCell } from "../user/cell.ts";

const threadId = Type.String({ format: "uuid" });
const message = Type.String({ minLength: 1, maxLength: 16_000, pattern: "\\S" });
const submissionId = Type.String({ pattern: "^[1-9][0-9]*$" });
const result = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export function ThreadTools(env: Env, parentCellId: string) {
  const child = async (id: string) => {
    await userCell(env).childSession(parentCellId, id);
    return env.AGENT_SESSIONS.getByName(id);
  };
  return defineExtension({
    name: "ThreadTools",
    tools: [
      defineTool({
        name: "create_thread",
        description:
          "Create an independent child session and start its task. It has no parent history or files and cannot create threads. Returns threadId and submissionId; creation is replay-safe.",
        parameters: Type.Object({
          title: Type.String({ minLength: 1, maxLength: 100, pattern: "\\S" }),
          prompt: message,
        }),
        replay: "safe",
        async execute(args, api, context) {
          const id = await api.memo("threadId", crypto.randomUUID(), context);
          const requestId = await api.memo("requestId", crypto.randomUUID(), context);
          // Commit the relation before activating the child so it never offers creation tools.
          await userCell(env).registerChild(parentCellId, id, args.title);
          const session = await child(id);
          await session.init();
          return result({ threadId: id, ...(await session.submitMessage(args.prompt, requestId)) });
        },
      }),
      defineTool({
        name: "send_thread_message",
        description:
          "Send a follow-up to your child session. Busy children queue it for a later turn. Returns a submissionId to wait for; retries do not duplicate input.",
        parameters: Type.Object({ threadId, message }),
        replay: "safe",
        async execute(args, api, context) {
          const requestId = await api.memo("requestId", crypto.randomUUID(), context);
          const session = await child(args.threadId);
          return result({
            threadId: args.threadId,
            ...(await session.submitMessage(args.message, requestId)),
          });
        },
      }),
      defineTool({
        name: "get_thread_status",
        description:
          "Inspect a child’s activity and optionally one submission. done means answered; unanswered is terminal failure or cancellation, not success.",
        parameters: Type.Object({ threadId, submissionId: Type.Optional(submissionId) }),
        replay: "safe",
        async execute(args) {
          return result(await (await child(args.threadId)).threadStatus(args.submissionId));
        },
      }),
      defineTool({
        name: "read_thread",
        description:
          "Read the last messages from your child. Includes user input and assistant replies, not tool output or private reasoning. Older messages and long text are truncated explicitly.",
        parameters: Type.Object({
          threadId,
          limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
        }),
        replay: "safe",
        async execute(args) {
          return result(await (await child(args.threadId)).readThread(args.limit ?? 20));
        },
      }),
      defineTool({
        name: "wait_for_threads",
        description:
          "Wait until ALL specified child submissions are done or unanswered, or the timeout expires. Returns per-submission status and replies. Parent cancellation stops this wait, not the children.",
        parameters: Type.Object({
          threads: Type.Array(Type.Object({ threadId, submissionId }), {
            minItems: 1,
            maxItems: 10,
          }),
          timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 120 })),
        }),
        replay: "safe",
        async execute(args, _api, context) {
          const sessions = await awaitWithContext(
            Promise.all(args.threads.map(({ threadId }) => child(threadId))),
            context,
          );
          const deadline = Date.now() + (args.timeoutSeconds ?? 60) * 1000;
          while (true) {
            context.abortSignal?.throwIfAborted();
            const statuses = await awaitWithContext(
              Promise.all(
                sessions.map(async (session, i) => ({
                  ...args.threads[i],
                  ...(await session.threadStatus(args.threads[i].submissionId)),
                })),
              ),
              context,
            );
            const settled = statuses.every(
              ({ submission }) =>
                submission?.status === "done" || submission?.status === "unanswered",
            );
            if (settled || Date.now() >= deadline)
              return result({ timedOut: !settled, threads: statuses });
            await new Promise<void>((resolve, reject) => {
              const signal = context.abortSignal;
              const abort = () => {
                clearTimeout(timer);
                reject(signal?.reason ?? new Error("Wait cancelled"));
              };
              const timer = setTimeout(
                () => {
                  signal?.removeEventListener("abort", abort);
                  resolve();
                },
                Math.min(500, deadline - Date.now()),
              );
              if (signal?.aborted) abort();
              else signal?.addEventListener("abort", abort, { once: true });
            });
          }
        },
      }),
    ],
  });
}
