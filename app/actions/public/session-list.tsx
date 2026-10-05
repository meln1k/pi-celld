import { clientEntry, type Handle } from "remix/component";
import { routes } from "../../routes.ts";
import type { SessionSummary } from "../sessions/public/session-state.ts";

export const SessionList = clientEntry(
  import.meta.url,
  function SessionList(handle: Handle<{ initial: SessionSummary[]; activeSessionId?: string }>) {
    let sessions = handle.props.initial;
    let disconnected = false;

    handle.queueTask(() => {
      const events = new EventSource(routes.sessions.events.href());
      events.onerror = () => {
        disconnected = true;
        void handle.update();
      };
      events.onmessage = (event) => {
        sessions = JSON.parse(event.data);
        disconnected = false;
        void handle.update();
      };
      handle.signal.addEventListener("abort", () => events.close(), { once: true });
    });

    const link = (session: SessionSummary) => (
      <a
        href={routes.sessions.session.index.href({ sessionId: session.id })}
        aria-current={session.id === handle.props.activeSessionId ? "page" : undefined}
      >
        <span
          class={`session-activity ${disconnected ? "unknown" : session.busy ? "busy" : "ready"}`}
          role="img"
          aria-label={disconnected ? "Status unavailable" : session.busy ? "Working" : "Ready"}
          title={disconnected ? "Status unavailable" : session.busy ? "Working" : "Ready"}
        />
        <span>{session.title}</span>
      </a>
    );

    return () => (
      <nav aria-label="Sessions">
        <p class="sessions-heading">YOUR SESSIONS</p>
        {disconnected && (
          <p role="status" class="no-sessions">
            Reconnecting…
          </p>
        )}
        {!sessions.length && <p class="no-sessions">No sessions yet.</p>}
        <ul class="session-tree">
          {sessions
            .filter((session) => !session.parentId)
            .map((session) => {
              const children = sessions.filter((child) => child.parentId === session.id);
              return (
                <li key={session.id}>
                  {link(session)}
                  {!!children.length && (
                    <ul aria-label={`Children of ${session.title}`}>
                      {children.map((child) => (
                        <li key={child.id}>{link(child)}</li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
        </ul>
      </nav>
    );
  },
);
