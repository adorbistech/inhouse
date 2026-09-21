import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefaultAdapterRegistry } from "../src/services/adapters/adapterRegistry.js";
// The Control Panel's protocol list. Imported from the frontend source (pure module, no imports)
// so this test checks what the Add Vendor form ACTUALLY submits against the REAL adapter registry.
import { DEFAULT_VENDOR_PROTOCOL, VENDOR_PROTOCOLS } from "../../frontend/src/lib/vendorProtocols.ts";

const registry = createDefaultAdapterRegistry();

test("every protocol the Add Vendor form can submit is a registered adapter id (exact match)", () => {
  assert.ok(VENDOR_PROTOCOLS.length > 0);
  for (const option of VENDOR_PROTOCOLS) {
    assert.equal(registry.has(option.value), true, `UI protocol "${option.value}" has no registered adapter`);
    assert.equal(registry.get(option.value)?.protocol, option.value);
  }
});

test("every registered adapter protocol is offered by the Add Vendor form (no adapter is unreachable from the UI)", () => {
  const offered = new Set<string>(VENDOR_PROTOCOLS.map((o) => o.value));
  for (const protocol of registry.listSupportedProtocols()) {
    assert.equal(offered.has(protocol), true, `registered adapter "${protocol}" is not selectable in the Control Panel`);
  }
});

test("openai-compatible is registered, is the form default, and underscore drift is impossible", () => {
  assert.equal(registry.has("openai-compatible"), true);
  assert.equal(DEFAULT_VENDOR_PROTOCOL, "openai-compatible");
  assert.equal(registry.has(DEFAULT_VENDOR_PROTOCOL), true);
  for (const option of VENDOR_PROTOCOLS) {
    assert.equal(option.value.includes("_"), false, `"${option.value}" must use the hyphenated canonical form`);
    assert.equal(option.value, option.value.trim().toLowerCase());
  }
  assert.equal(registry.has("openai_compatible"), false);
});
