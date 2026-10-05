import { createController } from "remix/router";

import { routes } from "../../routes.ts";
import { profile } from "../../cells/user/cell.ts";
import { HomePage } from "./page.tsx";

export const rootController = createController(routes, {
  actions: {
    async home(context) {
      const user = await profile(context.env);
      return context.render(<HomePage user={user} />);
    },
  },
});
