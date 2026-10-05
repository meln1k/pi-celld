import * as assert from "remix/assert";
import { it } from "node:test";
import { createAppRouter } from "../router.ts";
import { routes } from "../routes.ts";
import type { Env } from "../env.ts";
import type { AgentSession } from "../cells/session/cell.ts";
import type { User } from "../cells/user/cell.ts";
import { mockNamespace } from "../cells/mock-namespace.ts";

it("rejects unsafe writes and forwards message forms to the requested session", async () => {
  const origin = "https://app.test";
  let forwarded: Request | undefined;
  const state = {
    model: "test/model",
    messages: [],
    busy: false,
    partial: "",
    reasoning: "",
    queued: 0,
  };
  const cells = mockNamespace<AgentSession>(
    (id) => ({
      init: async () => ({ conversationId: id }),
      state: async () => state,
      stop: async () => ({ stopped: true }),
      fetch: async () => new Response(null),
      submitMessage: async () => ({ submissionId: "1" }),
      threadStatus: async () => ({ busy: false, queued: 0, submission: null }),
      readThread: async () => ({
        busy: false,
        queued: 0,
        omittedMessages: 0,
        messages: [],
      }),
      async messages(request) {
        forwarded = request;
        return Response.json(
          {
            id,
            path: new URL(request.url).pathname,
            method: request.method,
            form: Object.fromEntries(await request.formData()),
          },
          { status: 202 },
        );
      },
    }),
    ((id: string) => ({ toString: () => id })) as Env["AGENT_SESSIONS"][
      "idFromName"
    ],
  );
  const users = mockNamespace<User>(() => ({
    profile: async () => ({
      sessions: [],
      hasApiKey: false,
      keyStorageAvailable: false,
    }),
    registerSession: async () => {},
    reportActivity: async () => {},
    credentials: async () => null,
    sessionIdentity: async () => null,
    registerChild: async () => {},
    childSession: async () => {
      throw new Error("Unexpected child lookup");
    },
    saveKey: async () => new Response(null, { status: 204 }),
    fetch: async () => new Response(null),
  }), cells.idFromName);
  const env: Env = {
    AGENT_MODEL: "deepseek-v4.1-flash",
    AGENT_SESSIONS: cells,
    USERS: users,
  };
  const router = createAppRouter();
  const request = (path: string, init?: RequestInit) =>
    router.fetch(new Request(new URL(path, origin), init), env);
  const first = "11111111-1111-4111-8111-111111111111";
  assert.equal(
    routes.sessions.session.messages.href({ sessionId: first }),
    `/sessions/${first}/messages`,
  );
  assert.deepEqual(
    [
      routes.home,
      routes.settings.index,
      routes.settings.save,
      routes.sessions.create,
      routes.sessions.events,
      routes.sessions.session.index,
      routes.sessions.session.state,
      routes.sessions.session.events,
      routes.sessions.session.messages,
      routes.sessions.session.stop,
    ].map((route) => [route.method, route.pattern.toString()]),
    [
      ["ANY", "/"],
      ["GET", "/settings"],
      ["POST", "/settings"],
      ["POST", "/sessions"],
      ["GET", "/sessions/events"],
      ["GET", "/sessions/:sessionId"],
      ["GET", "/sessions/:sessionId/state"],
      ["GET", "/sessions/:sessionId/events"],
      ["POST", "/sessions/:sessionId/messages"],
      ["POST", "/sessions/:sessionId/stop"],
    ],
  );
  assert.equal(
    (await request(`/sessions/${first}/init`, {
      method: "POST",
      headers: { Origin: origin },
    }))
      .status,
    404,
  );
  assert.equal((await request("/credentials/opencode")).status, 404);
  for (
    const path of [
      routes.sessions.create.href(),
      routes.settings.save.href(),
      routes.sessions.session.messages.href({ sessionId: first }),
      routes.sessions.session.stop.href({ sessionId: first }),
    ]
  ) {
    for (
      const headers of [
        new Headers(),
        new Headers({ Origin: "https://other.test" }),
      ]
    ) {
      assert.equal(
        (await request(path, { method: "POST", headers })).status,
        403,
      );
    }
  }
  for (const sessionId of [first, "22222222-2222-4222-8222-222222222222"]) {
    const body = new FormData();
    body.set("content", "A form message: + % 界");
    body.set("requestId", "retry-id");
    const original = new Request(
      new URL(routes.sessions.session.messages.href({ sessionId }), origin),
      {
        method: "POST",
        headers: { Origin: origin },
        body,
      },
    );
    const response = await router.fetch(original, env);
    assert.equal(forwarded, original);
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      id: sessionId,
      path: `/sessions/${sessionId}/messages`,
      method: "POST",
      form: { content: "A form message: + % 界", requestId: "retry-id" },
    });
  }
  const snapshot = await request(
    routes.sessions.session.state.href({ sessionId: first }),
  );
  assert.equal(snapshot.status, 200);
  assert.deepEqual(await snapshot.json(), state);
  const stopped = await request(
    routes.sessions.session.stop.href({ sessionId: first }),
    {
      method: "POST",
      headers: { Origin: origin },
    },
  );
  assert.equal(stopped.status, 200);
  assert.deepEqual(await stopped.json(), { stopped: true });
  const invalidForm = await request(routes.sessions.create.href(), {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(invalidForm.status, 400);
  assert.equal(await invalidForm.text(), "Invalid session form");
  const inaccessible: Env = {
    ...env,
    AGENT_SESSIONS: mockNamespace<AgentSession>(() => {
      throw new Error("Invalid ID reached a session cell");
    }, cells.idFromName),
    USERS: mockNamespace<User>(() => {
      throw new Error("Invalid ID reached the user cell");
    }, users.idFromName),
  };
  for (const route of Object.values(routes.sessions.session)) {
    const response = await router.fetch(
      new Request(new URL(route.href({ sessionId: "invalid" }), origin), {
        method: route.method,
        headers: { Origin: origin },
      }),
      inaccessible,
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "Not Found");
  }

  // A waits during initialization while B finishes; registration must retain A's bindings.
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const registrations: string[] = [];
  const environment = (name: string): Env => ({
    ...env,
    AGENT_SESSIONS: mockNamespace<AgentSession>((id) => ({
      ...cells.getByName(id),
      async init() {
        if (name === "A") {
          started.resolve();
          await release.promise;
        }
        return cells.getByName(id).init();
      },
    }), cells.idFromName),
    USERS: mockNamespace<User>((id) => ({
      ...users.getByName(id),
      async registerSession(sessionId) {
        registrations.push(name);
        return users.getByName(id).registerSession(sessionId);
      },
    }), users.idFromName),
  });
  const shared = new Request(new URL(routes.sessions.create.href(), origin), {
    method: "POST",
    headers: { Origin: origin },
  });
  const firstResponse = router.fetch(shared, environment("A"));
  await started.promise;
  try {
    assert.equal((await router.fetch(shared, environment("B"))).status, 303);
  } finally {
    release.resolve();
  }
  assert.equal((await firstResponse).status, 303);
  assert.deepEqual(registrations, ["B", "A"]);

  // RPC failures retain the form UUID and can be retried without registering too early.
  const calls: string[] = [];
  let failure: "init" | "register" | undefined = "init";
  const retryEnv: Env = {
    ...env,
    AGENT_SESSIONS: mockNamespace<AgentSession>((id) => ({
      ...cells.getByName(id),
      async init() {
        calls.push(`init:${id}`);
        if (failure === "init") throw new Error("Initialization unavailable");
        return cells.getByName(id).init();
      },
    }), cells.idFromName),
    USERS: mockNamespace<User>((name) => ({
      ...users.getByName(name),
      async registerSession(id) {
        assert.equal(name, "local");
        calls.push(`register:${id}`);
        if (failure === "register") throw new Error("Registration unavailable");
      },
    }), users.idFromName),
  };
  const create = () =>
    router.fetch(
      new Request(new URL(routes.sessions.create.href(), origin), {
        method: "POST",
        headers: { Origin: origin },
        body: new URLSearchParams({ sessionId: first }),
      }),
      retryEnv,
    );
  const failedInit = await create();
  assert.equal(failedInit.status, 502);
  assert.equal(await failedInit.text(), "Session creation failed");
  assert.deepEqual(calls, [`init:${first}`]);
  failure = "register";
  const failedRegistration = await create();
  assert.equal(failedRegistration.status, 502);
  assert.equal(
    await failedRegistration.text(),
    "Session registration failed; retry the form.",
  );
  failure = undefined;
  const retried = await create();
  assert.equal(retried.status, 303);
  assert.equal(
    retried.headers.get("location"),
    routes.sessions.session.index.href({ sessionId: first }),
  );
  assert.deepEqual(calls, [
    `init:${first}`,
    `init:${first}`,
    `register:${first}`,
    `init:${first}`,
    `register:${first}`,
  ]);
});
