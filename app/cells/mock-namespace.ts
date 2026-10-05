import type { DurableObjectNamespace, Rpc } from "@cloudflare/workers-types";

// Test doubles implement ordinary async methods, not Workers' RPC transport.
export function mockNamespace<Cell extends Rpc.DurableObjectBranded>(
  getByName: (name: string) => Omit<Cell, "alarm" | "__DURABLE_OBJECT_BRAND">,
  idFromName?: DurableObjectNamespace["idFromName"],
): DurableObjectNamespace<Cell> {
  return { getByName, idFromName } as unknown as DurableObjectNamespace<Cell>;
}
