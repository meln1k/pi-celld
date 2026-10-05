import { clientEntry, on, type Handle } from "remix/component";
import { applyImmutable, type Op } from "@earendil-works/chord/delta";
import type { ConversationView } from "@earendil-works/pi-durable";
import { routes } from "../../../routes.ts";
import { tryAsync } from "../../../result.ts";
import { present, type SessionState } from "./session-state.ts";

export const Chat = clientEntry(
  import.meta.url,
  function Chat(handle: Handle<{ sessionId: string; initial: SessionState }>) {
    let state = handle.props.initial;
    let view: ConversationView | undefined;
    let connected = false;
    let sending = false;
    let error = "";
    let pending: { content: string; requestId: string } | undefined;
    const params = { sessionId: handle.props.sessionId };

    async function submit(form: HTMLFormElement) {
      if (sending) return;
      const body = new FormData(form);
      const draft = String(body.get("content") ?? "");
      const content = draft.trim();
      if (!content) return;
      if (!pending || pending.content !== content)
        pending = { content, requestId: crypto.randomUUID() };
      body.set("content", pending.content);
      body.set("requestId", pending.requestId);
      sending = true;
      error = "";
      void handle.update();
      const [, failure] = await tryAsync(
        (async () => {
          const response = await fetch(form.action, {
            method: "POST",
            body,
            signal: handle.signal,
          });
          if (!response.ok) throw new Error("Message could not be sent");
          pending = undefined;
          if (new FormData(form).get("content") === draft) form.reset();
        })(),
        (reason) => (reason instanceof Error ? reason.message : "Message could not be sent"),
      );
      if (failure !== undefined && !handle.signal.aborted) error = failure;
      sending = false;
      if (!handle.signal.aborted) void handle.update();
    }

    handle.queueTask(() => {
      const events = new EventSource(routes.sessions.session.events.href(params));
      events.onopen = () => {
        connected = true;
        void handle.update();
      };
      events.onerror = () => {
        connected = false;
        void handle.update();
      };
      events.onmessage = (event) => {
        const next = applyImmutable<ConversationView>(view, JSON.parse(event.data) as Op[]);
        state = present(next, next.entries === view?.entries ? state.messages : undefined);
        view = next;
        void handle.update();
      };
      handle.signal.addEventListener("abort", () => events.close(), { once: true });
    });

    return () => (
      <main class="shell chat">
        <section class="chat-header">
          <div>
            <p class="eyebrow">DEDICATED AGENT CELL</p>
            <h1>Agent session</h1>
            <p class="session-id">{params.sessionId}</p>
          </div>
          <span role="status" class={connected ? "connection connected" : "connection"}>
            {connected ? "● Connected" : "○ Reconnecting"}
          </span>
        </section>
        <div class="chat-meta">
          <span>{state.model}</span>
          <span>SQLite persisted</span>
          <span>
            {state.busy ? "Running" : state.queued ? "Paused" : "Ready"}
            {state.queued ? ` · ${state.queued} queued` : ""}
          </span>
        </div>
        <section aria-label="Conversation" class="conversation">
          {!state.messages.length && (
            <div class="empty-conversation">
              <h2>A fresh place to think.</h2>
              <p>Send a message. This cell keeps your conversation across restarts.</p>
            </div>
          )}
          {state.messages.map((message) => (
            <article key={message.id} class={`message ${message.role}`}>
              <p class="eyebrow">{message.role === "user" ? "YOU" : "AGENT"}</p>
              {message.reasoning && (
                <details class="reasoning">
                  <summary>Reasoning</summary>
                  <div class="message-text">{message.reasoning}</div>
                </details>
              )}
              <div class="message-text">{message.text}</div>
              {message.error && <p role="alert">{message.error}</p>}
            </article>
          ))}
          {state.busy && (
            <article class="working">
              <p class="eyebrow">AGENT · WORKING</p>
              {state.reasoning && (
                <details class="reasoning" open>
                  <summary>Reasoning</summary>
                  <div class="message-text">{state.reasoning}</div>
                </details>
              )}
              {state.partial && <div class="message-text">{state.partial}</div>}
              {!state.partial && !state.reasoning && "Thinking…"}
            </article>
          )}
        </section>
        {!state.busy && state.queued > 0 && (
          <p role="status" class="paused">
            The queued messages are paused. Send a new message to continue, or Stop to discard them.
          </p>
        )}
        <form
          action={routes.sessions.session.messages.href(params)}
          method="post"
          mix={on("submit", async (event) => {
            event.preventDefault();
            await submit(event.currentTarget);
          })}
        >
          <noscript>Sending messages requires JavaScript.</noscript>
          <label for="content" class="eyebrow">
            MESSAGE
          </label>
          <textarea
            id="content"
            name="content"
            required
            maxLength={16000}
            rows={3}
            placeholder="What would you like to explore?"
          />
          <div class="composer-footer">
            <span>Saved in your cell. Reopen this URL to continue.</span>
            <div class="composer-buttons">
              {(state.busy || state.queued > 0) && (
                <button
                  type="button"
                  mix={on("click", async () => {
                    const [, failure] = await tryAsync(
                      (async () => {
                        const response = await fetch(routes.sessions.session.stop.href(params), {
                          method: "POST",
                          signal: handle.signal,
                        });
                        if (!response.ok) throw new Error("Could not stop the agent");
                      })(),
                      (reason) => String(reason),
                    );
                    if (failure !== undefined && !handle.signal.aborted) {
                      error = failure;
                      void handle.update();
                    }
                  })}
                >
                  Stop
                </button>
              )}
              <button disabled={sending} class="primary">
                {sending ? "Sending…" : state.busy ? "Queue message" : "Send message"}
              </button>
            </div>
          </div>
          {error && <p role="alert">{error}</p>}
        </form>
      </main>
    );
  },
);
