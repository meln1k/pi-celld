import type { Handle } from "remix/component";
import { Document } from "../document.tsx";
import { Workspace } from "../workspace.tsx";
import { Chat } from "./public/chat.tsx";
import type { SessionState, UserState } from "./public/session-state.ts";

export function SessionPage(
  handle: Handle<{ user: UserState; sessionId: string; initial: SessionState }>,
) {
  return () => (
    <Document title="Agent session · Pi Celld">
      <Workspace user={handle.props.user} activeSessionId={handle.props.sessionId}>
        <Chat sessionId={handle.props.sessionId} initial={handle.props.initial} />
      </Workspace>
    </Document>
  );
}
