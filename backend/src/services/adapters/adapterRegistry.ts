import type { ProviderAdapter } from "../providerAdapter.js";
import { OpenAiCompatibleAdapter } from "./openAiCompatibleAdapter.js";

/**
 * Code-defined map of technical protocol identifier -> adapter
 * implementation. This is the one place protocol support is decided, and
 * it is deliberately not a business-provider inventory: a business vendor
 * (a `vendors` row, created through the frontend/API) becomes executable
 * only when its `protocol` column matches a key registered here — the
 * registry has no idea which vendors exist, and `vendors` has no idea
 * which protocols have adapters. See docs/PROVIDER_ADAPTERS.md.
 *
 * `has()`/`get()` returning "not found" for an unrecognized protocol is a
 * normal, expected state — a vendor can be fully configured in the
 * database (identity, endpoint, credentials, models) with no adapter
 * available yet, and that must never be silently treated as executable.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    if (this.adapters.has(adapter.protocol)) {
      throw new Error(`An adapter for protocol "${adapter.protocol}" is already registered.`);
    }
    this.adapters.set(adapter.protocol, adapter);
  }

  get(protocol: string): ProviderAdapter | undefined {
    return this.adapters.get(protocol);
  }

  has(protocol: string): boolean {
    return this.adapters.has(protocol);
  }

  listSupportedProtocols(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

/**
 * The registry this codebase actually runs with. Adding a new protocol
 * adapter means registering it here — it must never mean adding a business
 * vendor name anywhere in this file or its callers.
 */
export function createDefaultAdapterRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new OpenAiCompatibleAdapter());
  return registry;
}
