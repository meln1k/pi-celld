import type { Handle } from "remix/component";
import { routes } from "../../routes.ts";
import { Document } from "../document.tsx";
import { Workspace } from "../workspace.tsx";
import type { UserState } from "../sessions/public/session-state.ts";

export function HomePage(handle: Handle<{ user: UserState }>) {
  const sessionId = crypto.randomUUID();
  return () => (
    <Document>
      <Workspace user={handle.props.user}>
        <main class="shell home">
          <section>
            <p class="home-heading">DURABLE AGENT SESSIONS</p>
            <h1>
              One conversation.
              <br />
              One dedicated cell.
            </h1>
            <p class="home-description">
              Start an agent session with its own SQLite-backed memory. Messages and progress stay
              with your cell, even across restarts.
            </p>
            <form action={routes.sessions.create.href()} method="post">
              <input type="hidden" name="sessionId" value={sessionId} />
              <button class="home-create">+ New session</button>
            </form>
            <p class="home-note">Remix interface · pi-durable runtime · celld storage</p>
          </section>
        </main>
      </Workspace>
    </Document>
  );
}
