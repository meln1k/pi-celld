import { router } from "./app/router.ts";
import type { Env } from "./app/env.ts";

export { AgentSession } from "./app/cells/session/cell.ts";
export { User } from "./app/cells/user/cell.ts";

export default {
  fetch(request: Request, env: Env) {
    return router.fetch(request, env);
  },
};
