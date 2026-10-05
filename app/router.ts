import {
  createContextKey,
  createRouter,
  type Middleware,
  type MiddlewareContext,
} from "remix/router";
import { render } from "remix/middleware/render";
import { assets } from "./assets.ts";

import { rootController } from "./actions/home/controller.tsx";
import { settingsController } from "./actions/settings/controller.tsx";
import { sessionController, sessionsController } from "./actions/sessions/controller.tsx";
import { routes } from "./routes.ts";
import type { Env } from "./env.ts";

const renderMiddleware = render({ assets });
const Environment = createContextKey<Env>();
type EnvironmentMiddleware = Middleware<{ key: typeof Environment; value: Env; property: "env" }>;
type AppContext = MiddlewareContext<[EnvironmentMiddleware, typeof renderMiddleware]>;

declare module "remix" {
  interface RouterTypes {
    context: AppContext;
  }
}

const middleware: Middleware[] = [
  ({ request }, next) => {
    if (request.method === "POST" && request.headers.get("origin") !== new URL(request.url).origin)
      return new Response("Invalid origin", { status: 403 });
    return next();
  },
];

export function createAppRouter() {
  const environments = new WeakMap<Request, Env>();
  const loadEnvironment: EnvironmentMiddleware = (context, next) => {
    const env = environments.get(context.request);
    if (!env) throw new Error("Missing request environment");
    context.set(Environment, env, { property: "env" });
    return next();
  };
  const router = createRouter({ middleware: [loadEnvironment, renderMiddleware] });
  router.map(routes, { ...rootController, middleware });
  router.map(routes.settings, { ...settingsController, middleware });
  router.map(routes.sessions, { ...sessionsController, middleware });
  router.map(routes.sessions.session, {
    ...sessionController,
    middleware: [...middleware, ...(sessionController.middleware ?? [])],
  });
  return {
    async fetch(request: Request, env: Env) {
      environments.set(request, env);
      try {
        return await router.fetch(request);
      } finally {
        environments.delete(request);
      }
    },
  };
}

export const router = createAppRouter();
