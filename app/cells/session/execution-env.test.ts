import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { it } from "node:test";
import { JustBashEnv } from "./execution-env.ts";

it("Pi default tools share the virtual workspace across environment lookups", async (t) => {
  const env = new JustBashEnv("session-test");
  const registry = createRegistry();
  registry.install(CodingTools);
  const faux = fauxProvider({ models: [{ id: "demo" }], tokensPerSecond: 100_000 });
  const tool = (name: string, args: Parameters<typeof fauxToolCall>[1]) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  faux.setResponses([
    tool("write", { path: "notes.txt", content: "αlpha\nβeta\nlast" }),
    tool("edit", { path: "notes.txt", edits: [{ oldText: "βeta", newText: "changed" }] }),
    tool("bash", { command: 'cat notes.txt | grep changed > result.txt; printf "shell-output"' }),
    tool("read", { path: "notes.txt", offset: 2, limit: 1 }),
    (transcript) => {
      const results = transcript.messages.filter((message) => message.role === "toolResult");
      assert.equal(results.length, 4);
      for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
      assert.match(JSON.stringify(results[2]), /shell-output/);
      assert.match(JSON.stringify(results[3]), /changed/);
      assert.doesNotMatch(JSON.stringify(results[3]), /αlpha/);
      return fauxAssistantMessage("done");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models,
      registry,
      env: ({ cwd }) => env.withCwd(cwd ?? "/workspace"),
      settings: { retry: { enabled: false } },
    },
    context,
  );
  t.after(() => harness.close(context));
  const conversation = await harness.root(context, {
    agent: {
      model: { provider: "faux", modelId: "demo" },
      cwd: "/workspace",
      extensions: [CodingTools],
    },
  });
  await conversation.submit({ type: "input", content: "Use the tools" }, context);
  await harness.waitForIdle(context);
  const watch = await conversation.watch(context);
  await watch.stop();
  assert.equal(faux.state.callCount, 5, JSON.stringify(watch.value));
  assert.match(JSON.stringify(watch.value.entries.at(-1)), /"text":"done"/);
  assert.equal(getOrThrow(await env.readTextFile("result.txt", context)), "changed\n");
  assert.equal(
    getOrThrow(await new JustBashEnv("other-session").exists("result.txt", context)),
    false,
  );
});

it("just-bash preserves bytes and argv, spills output, and honors cancellation and limits", async () => {
  const env = new JustBashEnv("adapter-test");
  getOrThrow(await env.writeFile("bytes", new Uint8Array([0, 255, 10, 65]), context));
  const reader = getOrThrow(await env.openBinaryReader("bytes", undefined, context));
  getOrThrow(await env.renameFile("bytes", "renamed", context));
  assert.deepEqual(getOrThrow(await reader.read(1, 2, context)), new Uint8Array([255, 10]));
  getOrThrow(await env.truncateFile("renamed", 6, context));
  assert.deepEqual(
    getOrThrow(await env.readBinaryFile("renamed", context)),
    new Uint8Array([0, 255, 10, 65, 0, 0]),
  );
  const missing = await env.readTextFile("missing", context);
  assert.equal(missing.ok ? undefined : missing.error.code, "not_found");
  const directory = await env.openBinaryReader("/workspace", undefined, context);
  assert.equal(directory.ok ? undefined : directory.error.code, "is_directory");

  let output = "";
  const argv = ["printf", "%s", "a'b $HOME; touch injected"];
  const result = getOrThrow(
    await env.exec(
      argv,
      {
        onOutput: (text) => {
          output += text;
        },
        spill: { afterBytes: 8, afterLines: 10 },
      },
      context,
    ),
  );
  assert.equal(result.exitCode, 0);
  assert.equal(output, argv[2]);
  assert.equal(getOrThrow(await env.readTextFile(result.spillPath!, context)), output);
  assert.equal(getOrThrow(await env.exists("injected", context)), false);
  const callbackError = await env.exec(
    "echo callback",
    {
      onOutput: () => {
        throw undefined;
      },
    },
    context,
  );
  assert.equal(callbackError.ok ? undefined : callbackError.error.code, "callback_error");
  const aborted = await env.exec(
    "touch aborted",
    undefined,
    withAbortSignal(AbortSignal.abort(), context),
  );
  assert.equal(aborted.ok ? undefined : aborted.error.code, "aborted");
  assert.equal(getOrThrow(await env.exists("aborted", context)), false);
  const timeout = await env.exec("sleep 1", { timeout: 0.01 }, context);
  assert.equal(timeout.ok ? undefined : timeout.error.code, "timeout");
  const running = env.withCwd("/tmp").exec("sleep 1", undefined, context);
  await env.cleanup();
  const stopped = await running;
  assert.equal(stopped.ok ? undefined : stopped.error.code, "aborted");
  const blocked = getOrThrow(await env.exec("curl https://example.com", undefined, context));
  assert.equal(blocked.exitCode, 127);
  const precision = getOrThrow(await env.exec("printf '%.999999999f' 1", undefined, context));
  assert.equal(precision.exitCode, 126);
  const bounded = getOrThrow(await env.exec("while true; do :; done", undefined, context));
  assert.equal(bounded.exitCode, 126);
});
