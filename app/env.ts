// Secrets are optional in celld, which also supports running without key storage.
export interface Env
  extends Omit<Cloudflare.Env, "OPENCODE_API_KEY" | "USER_KEY_ENCRYPTION_KEY"> {
  OPENCODE_API_KEY?: string;
  USER_KEY_ENCRYPTION_KEY?: string;
}
