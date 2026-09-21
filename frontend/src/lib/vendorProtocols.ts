/**
 * The only protocol identifiers the Add Vendor form may submit.
 *
 * Each `value` MUST equal the `protocol` of a registered backend adapter
 * (`backend/src/services/adapters/adapterRegistry.ts`, matched exactly). That
 * is enforced by `backend/test/vendorProtocolContract.test.ts`, which checks
 * this list against the real registry in both directions. A protocol with no
 * adapter is deliberately absent: a vendor created with it could never be
 * verified or executed. Stored vendors with other protocols still display
 * their raw `protocol` string; this list only governs creation.
 */
export const VENDOR_PROTOCOLS = [{ value: "openai-compatible", label: "OpenAI-compatible" }] as const;

export const DEFAULT_VENDOR_PROTOCOL: string = VENDOR_PROTOCOLS[0].value;

/** Canonical credential type for a new provider API key (free-text field; not consumed by execution). */
export const DEFAULT_CREDENTIAL_TYPE = "api-key";
