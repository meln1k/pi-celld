import { createController } from "remix/router";

import { routes } from "../../routes.ts";
import { profile, userCell } from "../../cells/user/cell.ts";
import { SettingsPage } from "./page.tsx";

export const settingsController = createController(routes.settings, {
  actions: {
    async index(context) {
      const user = await profile(context.env);
      return context.render(<SettingsPage user={user} />);
    },
    async save({ request, env }) {
      const response = await userCell(env).saveKey(request);
      if (!response.ok) return response;
      return new Response(null, {
        status: 303,
        headers: { Location: routes.settings.index.href() },
      });
    },
  },
});
