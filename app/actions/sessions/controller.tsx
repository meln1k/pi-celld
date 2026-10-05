import { createController, type Middleware } from "remix/router";
import { parseFormData } from "remix/form-data-parser";

import { routes } from "../../routes.ts";
import { isSessionId, profile, userCell } from "../../cells/user/cell.ts";
import { tryAsync } from "../../result.ts";
import { SessionPage } from "./page.tsx";

export const sessionsController = createController(routes.sessions, {
  actions: {
    events: ({ request, env }) => userCell(env).fetch(request),
    async create({ request, env }) {
      let sessionId: string;
      if (request.body) {
        const [form, error] = await tryAsync(
          parseFormData(request, { maxFiles: 0, maxParts: 1, maxTotalSize: 1024 }),
          () => "Invalid session form",
        );
        if (error !== undefined) return new Response(error, { status: 400 });
        sessionId = String(form.get("sessionId") ?? "");
        if (!isSessionId(sessionId)) return new Response("Invalid session ID", { status: 400 });
      } else {
        sessionId = crypto.randomUUID();
      }
      // The form retains its UUID on retries; initialization and registration are idempotent.
      const [, initError] = await tryAsync(
        env.AGENT_SESSIONS.getByName(sessionId).init(),
        () => "Session creation failed",
      );
      if (initError !== undefined) return new Response(initError, { status: 502 });
      const [, registrationError] = await tryAsync(
        userCell(env).registerSession(sessionId),
        () => "Session registration failed; retry the form.",
      );
      if (registrationError !== undefined)
        return new Response("Session registration failed; retry the form.", { status: 502 });
      return new Response(null, {
        status: 303,
        headers: { Location: routes.sessions.session.index.href({ sessionId }) },
      });
    },
  },
});

const validateSessionId: Middleware = ({ params }, next) => {
  if (!isSessionId(params.sessionId)) return new Response("Not Found", { status: 404 });
  return next();
};

export const sessionController = createController(routes.sessions.session, {
  middleware: [validateSessionId],
  actions: {
    async index(context) {
      const { sessionId } = context.params;
      const [initial, user] = await Promise.all([
        context.env.AGENT_SESSIONS.getByName(sessionId).state(),
        profile(context.env),
      ]);
      return context.render(<SessionPage user={user} sessionId={sessionId} initial={initial} />);
    },
    state: async ({ env, params }) =>
      Response.json(await env.AGENT_SESSIONS.getByName(params.sessionId).state()),
    events: ({ env, request, params }) =>
      env.AGENT_SESSIONS.getByName(params.sessionId).fetch(request),
    messages: ({ env, request, params }) =>
      env.AGENT_SESSIONS.getByName(params.sessionId).messages(request),
    stop: async ({ env, params }) =>
      Response.json(await env.AGENT_SESSIONS.getByName(params.sessionId).stop()),
  },
});
