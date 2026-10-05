import type { Handle } from "remix/component";
import { routes } from "../../routes.ts";
import { Document } from "../document.tsx";
import { Workspace } from "../workspace.tsx";
import type { UserState } from "../sessions/public/session-state.ts";

export function SettingsPage(handle: Handle<{ user: UserState }>) {
  return () => (
    <Document title="Settings · Pi Celld">
      <Workspace user={handle.props.user}>
        <main class="shell settings">
          <h1>Settings</h1>
          <p class="settings-description">
            Your OpenCode Go key is encrypted in your user cell. Agent cells retrieve it
            server-side; it is never included in the session transcript.
          </p>
          <p role="status">
            {handle.props.user.hasApiKey
              ? "An API key is saved. Enter a new key to replace it."
              : "No API key is saved."}
          </p>
          {!handle.props.user.keyStorageAvailable && (
            <p role="alert" class="key-warning">
              Configure USER_KEY_ENCRYPTION_KEY on the server to enable encrypted key storage.
            </p>
          )}
          <form action={routes.settings.save.href()} method="post">
            <label for="apiKey">OpenCode API key</label>
            <input
              id="apiKey"
              name="apiKey"
              type="password"
              autoComplete="off"
              required
              maxLength={2048}
              disabled={!handle.props.user.keyStorageAvailable}
            />
            <button disabled={!handle.props.user.keyStorageAvailable}>Save key</button>
          </form>
          {handle.props.user.hasApiKey && (
            <form action={routes.settings.save.href()} method="post" class="remove-key">
              <button name="intent" value="remove">
                Remove key
              </button>
            </form>
          )}
          <p class="settings-note">This app has no sign-in yet. Keep the server private.</p>
        </main>
      </Workspace>
    </Document>
  );
}
