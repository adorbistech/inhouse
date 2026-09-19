import assert from "node:assert/strict";
import { test } from "node:test";
import { ValidationError } from "../src/lib/httpErrors.js";
import {
  validateHealthHistoryQuery,
  validateHealthObservationInput,
} from "../src/validation/providerHealth.js";

test("a valid healthy observation with no error category is accepted", () => {
  const input = validateHealthObservationInput({ status: "healthy", latencyMs: 120, source: "manual" });
  assert.equal(input.status, "healthy");
  assert.equal(input.errorCategory, null);
  assert.equal(input.latencyMs, 120);
  assert.equal(input.source, "manual");
  assert.ok(input.checkedAt instanceof Date);
});

test("a valid unhealthy observation requires an error category", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "unhealthy", source: "manual" }),
    ValidationError,
  );
  const input = validateHealthObservationInput({
    status: "unhealthy",
    errorCategory: "timeout",
    source: "adapter",
  });
  assert.equal(input.errorCategory, "timeout");
});

test("a healthy observation rejects an error category", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "healthy", errorCategory: "timeout", source: "manual" }),
    ValidationError,
  );
});

test("an invalid status is rejected", () => {
  assert.throws(() => validateHealthObservationInput({ status: "operational", source: "manual" }), ValidationError);
});

test("an invalid error category is rejected", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "unhealthy", errorCategory: "provider_hates_us", source: "manual" }),
    ValidationError,
  );
});

test("an invalid source is rejected", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "healthy", source: "the_internet" }),
    ValidationError,
  );
});

test("negative latency is rejected", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "healthy", latencyMs: -1, source: "manual" }),
    ValidationError,
  );
});

test("a non-integer latency is rejected", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "healthy", latencyMs: 12.5, source: "manual" }),
    ValidationError,
  );
});

test("an absurdly large latency is rejected", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "healthy", latencyMs: 999_999_999, source: "manual" }),
    ValidationError,
  );
});

test("an impossible (far-future) timestamp is rejected", () => {
  assert.throws(
    () =>
      validateHealthObservationInput({
        status: "healthy",
        source: "manual",
        checkedAt: new Date(Date.now() + 10_000_000).toISOString(),
      }),
    ValidationError,
  );
});

test("a small amount of clock skew in checkedAt is tolerated", () => {
  const input = validateHealthObservationInput({
    status: "healthy",
    source: "manual",
    checkedAt: new Date(Date.now() + 5_000).toISOString(),
  });
  assert.ok(input.checkedAt instanceof Date);
});

test("an unparseable checkedAt is rejected", () => {
  assert.throws(
    () => validateHealthObservationInput({ status: "healthy", source: "manual", checkedAt: "not-a-date" }),
    ValidationError,
  );
});

test("an oversized safeErrorCode is rejected", () => {
  assert.throws(
    () =>
      validateHealthObservationInput({
        status: "unhealthy",
        errorCategory: "unknown",
        source: "manual",
        safeErrorCode: "x".repeat(500),
      }),
    ValidationError,
  );
});

test("a non-object observation is rejected", () => {
  assert.throws(() => validateHealthObservationInput("not-an-object"), ValidationError);
  assert.throws(() => validateHealthObservationInput(null), ValidationError);
});

test("validateHealthHistoryQuery defaults to a sane limit and rejects out-of-range values", () => {
  assert.equal(validateHealthHistoryQuery({}).limit, 50);
  assert.equal(validateHealthHistoryQuery({ limit: "10" }).limit, 10);
  assert.throws(() => validateHealthHistoryQuery({ limit: "0" }), ValidationError);
  assert.throws(() => validateHealthHistoryQuery({ limit: "5000" }), ValidationError);
  assert.throws(() => validateHealthHistoryQuery({ limit: "not-a-number" }), ValidationError);
});
