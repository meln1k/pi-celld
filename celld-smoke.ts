import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionState } from "./app/actions/sessions/public/session-state.ts";

const origin = process.env.CELLD_ORIGIN ?? "http://127.0.0.1:9876";

test("celld RPC and SSE work without a model call", async () => {
  const id = crypto.randomUUID();
  const path = `/sessions/${id}`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(origin + "/sessions", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({ sessionId: id }),
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), path);
  }
  const page = await fetch(origin + path);
  assert.equal(page.status, 200);
  const html = await page.text();
  for (const asset of [
    "/assets/app/actions/public/entry.js",
    "/assets/app/actions/public/session-list.js",
    "/assets/app/actions/sessions/public/chat.js",
  ]) {
    assert.ok(html.includes(asset), `SSR must reference ${asset}`);
    const response = await fetch(origin + asset);
    assert.equal(response.status, 200, `Missing browser bundle: ${asset}`);
    assert.match(response.headers.get("content-type") ?? "", /javascript/);
  }
  const state = await fetch(origin + path + "/state");
  assert.equal(state.status, 200);
  assert.deepEqual((await state.json() as SessionState).messages, []);
  const stop = await fetch(origin + path + "/stop", {
    method: "POST",
    headers: { Origin: origin },
  });
  assert.equal(stop.status, 200);
  assert.deepEqual(await stop.json(), { stopped: true });
  for (const endpoint of ["/sessions/events", path + "/events"]) {
    const response = await fetch(origin + endpoint, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    try {
      const frame = new TextDecoder().decode((await reader.read()).value);
      const snapshot = JSON.parse(frame.slice(6).trim());
      if (endpoint === "/sessions/events")
        assert.equal(snapshot.filter((session: { id: string }) => session.id === id).length, 1);
      else assert.equal(snapshot[0][0], "r");
    } finally {
      await reader.cancel();
    }
  }
  const invalidKey = await fetch(origin + "/settings", {
    method: "POST",
    headers: { Origin: origin },
    body: new URLSearchParams({ apiKey: "" }),
  });
  assert.equal(invalidKey.status, 400);
  assert.equal(await invalidKey.text(), "Provide an API key (up to 2,048 characters)");
});

test("celld indexes a session, deduplicates a real OpenCode turn, and reopens its transcript", async () => {
  const id = crypto.randomUUID();
  const path = `/sessions/${id}`;
  for (let i = 0; i < 2; i++) {
    const response = await fetch(origin + "/sessions", {
      method: "POST",
      headers: { Origin: origin },
      body: new URLSearchParams({ sessionId: id }),
      redirect: "manual",
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), path);
  }
  const state = async (): Promise<SessionState> => {
    const response = await fetch(origin + path + "/state");
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.deepEqual((await state()).messages, []);
  const body = new FormData();
  body.set("content", "Reply with exactly GO_E2E_OK and nothing else.");
  body.set("requestId", "smoke");
  const send = () =>
    fetch(origin + path + "/messages", {
      method: "POST",
      headers: { Origin: origin },
      body,
    });
  const first = await send();
  assert.equal(first.status, 202);
  const retry = await send();
  assert.equal(retry.status, 202);
  assert.deepEqual(await retry.json(), await first.json());
  let snapshot = await state();
  const deadline = Date.now() + 60_000;
  while (snapshot.busy || snapshot.messages.length < 2) {
    assert.ok(Date.now() < deadline, "Model turn did not settle");
    await new Promise((resolve) => setTimeout(resolve, 100));
    snapshot = await state();
  }
  assert.equal(snapshot.messages.length, 2);
  assert.equal(snapshot.messages[1].error, undefined);
  assert.equal(snapshot.messages[1].text.trim(), "GO_E2E_OK");
  assert.deepEqual(await state(), snapshot);
  const html = await (await fetch(origin + path)).text();
  assert.match(html, /GO_E2E_OK/);
  assert.equal(Array.from(html.matchAll(new RegExp(`href="${path}"`, "g"))).length, 1);
});
