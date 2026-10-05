import type { Handle, RemixNode } from "remix/component";
import { routes } from "../routes.ts";
import type { UserState } from "./sessions/public/session-state.ts";
import { SessionList } from "./public/session-list.tsx";

export function Workspace(
  handle: Handle<{ user: UserState; activeSessionId?: string; children?: RemixNode }>,
) {
  const newSessionId = crypto.randomUUID();
  return () => (
    <div class="workspace">
      <aside class="sidebar">
        <a href={routes.home.href()} class="brand">
          PI / CELLD
        </a>
        <form action={routes.sessions.create.href()} method="post">
          <input type="hidden" name="sessionId" value={newSessionId} />
          <button>+ New session</button>
        </form>
        <SessionList
          initial={handle.props.user.sessions}
          activeSessionId={handle.props.activeSessionId}
        />
        <div class="sidebar-footer">
          <a href={routes.settings.index.href()}>
            Settings · {handle.props.user.hasApiKey ? "Key saved" : "No API key"}
          </a>
          <p>Private · local user</p>
        </div>
      </aside>
      {/* A DOM key replaces the hydrated chat boundary on server frame navigation. */}
      <div data-rmx-key={handle.props.activeSessionId}>{handle.props.children}</div>
    </div>
  );
}
