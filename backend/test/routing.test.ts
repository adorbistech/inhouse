import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidationError } from "../src/lib/httpErrors.js";
import {
  validateCreateRoutingFallbackRuleInput,
  validateCreateRoutingTierInput,
  validateRoutingFallbackRulePatchInput,
  validateRoutingPreviewInput,
  validateRoutingTierPatchInput,
} from "../src/validation/routing.js";

const VENDOR_ID = "11111111-1111-1111-1111-111111111111";
const MODEL_ID = "22222222-2222-2222-2222-222222222222";
const WORKLOAD_ID = "33333333-3333-3333-3333-333333333333";
const TIER_A = "44444444-4444-4444-4444-444444444444";
const TIER_B = "55555555-5555-5555-5555-555555555555";

test("validateCreateRoutingTierInput accepts a minimal valid payload and defaults optional fields", () => {
  const input = validateCreateRoutingTierInput({ vendorId: VENDOR_ID, modelId: MODEL_ID, tierNumber: 1 });
  assert.equal(input.vendorId, VENDOR_ID);
  assert.equal(input.modelId, MODEL_ID);
  assert.equal(input.tierNumber, 1);
  assert.equal(input.priority, 0);
  assert.equal(input.enabled, true);
  assert.equal(input.timeoutOverrideMs, null);
  assert.equal(input.maxAttempts, null);
});

test("validateCreateRoutingTierInput rejects a non-UUID vendorId/modelId", () => {
  assert.throws(
    () => validateCreateRoutingTierInput({ vendorId: "not-a-uuid", modelId: MODEL_ID, tierNumber: 1 }),
    ValidationError,
  );
  assert.throws(
    () => validateCreateRoutingTierInput({ vendorId: VENDOR_ID, modelId: "not-a-uuid", tierNumber: 1 }),
    ValidationError,
  );
});

test("validateCreateRoutingTierInput rejects a negative tierNumber", () => {
  assert.throws(
    () => validateCreateRoutingTierInput({ vendorId: VENDOR_ID, modelId: MODEL_ID, tierNumber: -1 }),
    ValidationError,
  );
});

test("validateCreateRoutingTierInput rejects a non-positive timeoutOverrideMs/maxAttempts", () => {
  assert.throws(
    () =>
      validateCreateRoutingTierInput({
        vendorId: VENDOR_ID,
        modelId: MODEL_ID,
        tierNumber: 1,
        timeoutOverrideMs: 0,
      }),
    ValidationError,
  );
  assert.throws(
    () =>
      validateCreateRoutingTierInput({
        vendorId: VENDOR_ID,
        modelId: MODEL_ID,
        tierNumber: 1,
        maxAttempts: -3,
      }),
    ValidationError,
  );
});

test("validateRoutingTierPatchInput requires at least one field", () => {
  assert.throws(() => validateRoutingTierPatchInput({}), ValidationError);
});

test("validateRoutingTierPatchInput accepts a partial patch", () => {
  const patch = validateRoutingTierPatchInput({ enabled: false });
  assert.deepEqual(patch, { enabled: false });
});

test("validateRoutingTierPatchInput allows explicitly clearing timeoutOverrideMs/maxAttempts to null", () => {
  const patch = validateRoutingTierPatchInput({ timeoutOverrideMs: null, maxAttempts: null });
  assert.deepEqual(patch, { timeout_override_ms: null, max_attempts: null });
});

test("validateCreateRoutingFallbackRuleInput accepts a valid payload", () => {
  const input = validateCreateRoutingFallbackRuleInput({
    fromTierId: TIER_A,
    toTierId: TIER_B,
    conditionType: "on_timeout",
    conditionConfig: { thresholdMs: 5000 },
  });
  assert.equal(input.fromTierId, TIER_A);
  assert.equal(input.toTierId, TIER_B);
  assert.equal(input.conditionType, "on_timeout");
  assert.deepEqual(input.conditionConfig, { thresholdMs: 5000 });
  assert.equal(input.priority, 0);
  assert.equal(input.enabled, true);
});

test("validateCreateRoutingFallbackRuleInput rejects a self-referencing rule", () => {
  assert.throws(
    () =>
      validateCreateRoutingFallbackRuleInput({
        fromTierId: TIER_A,
        toTierId: TIER_A,
        conditionType: "on_timeout",
      }),
    ValidationError,
  );
});

test("validateCreateRoutingFallbackRuleInput rejects an unrecognized conditionType", () => {
  assert.throws(
    () =>
      validateCreateRoutingFallbackRuleInput({
        fromTierId: TIER_A,
        toTierId: TIER_B,
        conditionType: "on_full_moon",
      }),
    ValidationError,
  );
});

test("validateCreateRoutingFallbackRuleInput rejects a non-object conditionConfig", () => {
  assert.throws(
    () =>
      validateCreateRoutingFallbackRuleInput({
        fromTierId: TIER_A,
        toTierId: TIER_B,
        conditionType: "on_error",
        conditionConfig: "not-an-object",
      }),
    ValidationError,
  );
});

test("validateRoutingFallbackRulePatchInput requires at least one field", () => {
  assert.throws(() => validateRoutingFallbackRulePatchInput({}), ValidationError);
});

test("validateRoutingFallbackRulePatchInput accepts a partial patch", () => {
  const patch = validateRoutingFallbackRulePatchInput({ priority: 3 });
  assert.deepEqual(patch, { priority: 3 });
});

test("validateRoutingPreviewInput accepts a minimal payload", () => {
  const input = validateRoutingPreviewInput({ workloadId: WORKLOAD_ID });
  assert.equal(input.workloadId, WORKLOAD_ID);
  assert.equal(input.modelId, undefined);
  assert.equal(input.capabilityIds, undefined);
});

test("validateRoutingPreviewInput accepts optional modelId and capabilityIds", () => {
  const capId = "66666666-6666-6666-6666-666666666666";
  const input = validateRoutingPreviewInput({ workloadId: WORKLOAD_ID, modelId: MODEL_ID, capabilityIds: [capId] });
  assert.equal(input.modelId, MODEL_ID);
  assert.deepEqual(input.capabilityIds, [capId]);
});

test("validateRoutingPreviewInput rejects a missing workloadId", () => {
  assert.throws(() => validateRoutingPreviewInput({}), ValidationError);
});

test("validateRoutingPreviewInput rejects a non-UUID entry in capabilityIds", () => {
  assert.throws(
    () => validateRoutingPreviewInput({ workloadId: WORKLOAD_ID, capabilityIds: ["not-a-uuid"] }),
    ValidationError,
  );
});

test("validateRoutingPreviewInput never accepts provider-shaped fields (they are simply ignored, not persisted)", () => {
  const input = validateRoutingPreviewInput({
    workloadId: WORKLOAD_ID,
    apiKey: "sk-should-be-ignored",
    outboundHeaders: { "X-Injected": "true" },
  });
  assert.deepEqual(Object.keys(input).sort(), ["capabilityIds", "modelId", "workloadId"].sort());
});
