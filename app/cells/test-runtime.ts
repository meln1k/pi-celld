import type { DurableObjectState } from "@cloudflare/workers-types";

// Deno tests have no Workers runtime; supply only the base class used by the cells.
export abstract class DurableObject<Env> {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
}
