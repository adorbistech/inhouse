import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { CredentialVaultService } from "../lib/credentialVault.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../lib/httpErrors.js";
import { ApiKeysRepository } from "../repositories/apiKeysRepository.js";
import { ModelsRepository } from "../repositories/modelsRepository.js";
import { UsageLedgerRepository } from "../repositories/usageLedgerRepository.js";
import { VendorCredentialsRepository } from "../repositories/vendorCredentialsRepository.js";
import { VendorsRepository } from "../repositories/vendorsRepository.js";
import { WorkloadsRepository } from "../repositories/workloadsRepository.js";
import type { InhouseApiKeyRow, ModelRow, NewUsageLedgerEntry, VendorRow } from "../repositories/types.js";
import { type AdapterRegistry, createDefaultAdapterRegistry } from "./adapters/adapterRegistry.js";
import { isUsableCredential, selectCandidateCredential } from "./accountCredentialSelection.js";
import { getDecryptedCredentialSecret } from "./credentialSecretAccess.js";
import {
  DEFAULT_PROVIDER_TIMEOUT_MS,
  type NormalizedProviderError,
  type NormalizedProviderRequest,
  type NormalizedProviderResponse,
  type NormalizedProviderUsage,
  type NormalizedStreamEvent,
  type ProviderStreamResult,
} from "./providerAdapter.js";
import { RoutingService, type RoutingCandidate } from "./routingService.js";
import { boundedBackoffMs, healthRank, isRetryableCategory, pickFallbackRule } from "./execution/failureClassification.js";
import type {
  ExecutionAttemptRecord,
  ExecutionContext,
  ExecutionErrorCategory,
  ExecutionFailure,
  ExecutionMessage,
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionStreamOutcome,
} from "./execution/types.js";

const DEFAULT_MAX_ATTEMPTS = 1;

/** Resolves after `ms`, or immediately when `signal` aborts — so a cancelled request never sits out a retry backoff. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

interface MutableAttemptState {
  attempts: ExecutionAttemptRecord[];
  nextAttemptNumber: number;
}

type AccountSelection =
  | { ok: true; accountId: string; secret: string }
  | { ok: false; category: ExecutionErrorCategory; safeErrorCode: string | null; message: string };

type ExecutionMode = "unary" | "stream";

type TierAttemptResult =
  | { ok: true; kind: "unary"; response: NormalizedProviderResponse; vendor: VendorRow; accountId: string; model: ModelRow }
  | {
      ok: true;
      kind: "stream";
      stream: Extract<ProviderStreamResult, { ok: true }>;
      vendor: VendorRow;
      accountId: string;
      model: ModelRow;
    }
  | {
      ok: false;
      category: ExecutionErrorCategory;
      safeErrorCode: string | null;
      message: string;
      vendor: VendorRow | null;
      accountId: string | null;
      model: ModelRow | null;
    };

/**
 * A candidate is usable as a *fallback* target even though it does not
 * match the originally-requested model — that is the entire point of
 * falling back to a different tier. `"model_not_requested"` is the one
 * `RoutingCandidate.reasons` entry (see `routingService.ts`'s
 * `buildCandidate`) that only makes sense relative to the *primary*
 * request; every other reason (disabled vendor/model, tier disabled,
 * unhealthy, workload mismatch, …) still disqualifies a fallback target
 * exactly as it disqualifies a primary one.
 */
function isUsableAsFallbackTarget(candidate: RoutingCandidate): boolean {
  return candidate.reasons.every((r) => r === "model_not_requested");
}

/**
 * Orchestrates Block 12's execution layer over the Block 11 routing
 * decision, the Block 10 adapter boundary, and the Block 08 credential
 * vault — the first thing in this codebase allowed to call
 * `getDecryptedCredentialSecret()` and a real `ProviderAdapter.execute()`.
 * Never imports or duplicates routing eligibility logic itself: every
 * execution starts from `RoutingService.preview()`'s already-deterministic
 * candidate list and ordering (see docs/ROUTING_POLICY.md), and only adds
 * what routing explicitly does not do — actually attempting a candidate,
 * retrying it within bounds, and falling back along a matching, enabled
 * `routing_fallback_rules` row. See docs/EXECUTION.md.
 */
export class ExecutionService {
  private readonly routing: RoutingService;
  private readonly workloads: WorkloadsRepository;
  private readonly models: ModelsRepository;
  private readonly vendors: VendorsRepository;
  private readonly vendorCredentials: VendorCredentialsRepository;
  private readonly usageLedger: UsageLedgerRepository;
  private readonly apiKeys: ApiKeysRepository;

  constructor(
    private readonly pool: Pool,
    private readonly vault: CredentialVaultService,
    private readonly adapterRegistry: AdapterRegistry = createDefaultAdapterRegistry(),
  ) {
    this.routing = new RoutingService(pool);
    this.workloads = new WorkloadsRepository(pool);
    this.models = new ModelsRepository(pool);
    this.vendors = new VendorsRepository(pool);
    this.vendorCredentials = new VendorCredentialsRepository(pool);
    this.usageLedger = new UsageLedgerRepository(pool);
    this.apiKeys = new ApiKeysRepository(pool);
  }

  /**
   * Tries every enabled account on `candidate.vendor` in health-then-id
   * order, looking for one with a usable enabled credential — bounded by
   * the (small, finite) number of accounts a vendor has. A decrypt
   * failure (e.g. a corrupted record) is treated exactly like "no usable
   * credential," never surfaced as its own error category — the caller
   * never learns *why* decryption failed, only that this account wasn't
   * usable.
   */
  private async selectAccountAndSecret(candidate: RoutingCandidate): Promise<AccountSelection> {
    const enabledAccounts = candidate.accounts.filter((a) => a.status === "enabled");
    const sorted = [...enabledAccounts].sort((a, b) => {
      const rankDiff = healthRank(a.health) - healthRank(b.health);
      if (rankDiff !== 0) return rankDiff;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    for (const account of sorted) {
      const credentials = await this.vendorCredentials.listByVendorAccountId(account.id);
      // Structural rejection first: no enabled credential, or an external-secretRef-only one, is
      // skipped without a decrypt attempt.
      const enabledCredential = selectCandidateCredential(credentials);
      if (!enabledCredential || !isUsableCredential(enabledCredential)) continue;
      try {
        const secret = await getDecryptedCredentialSecret(this.pool, this.vault, enabledCredential.id);
        return { ok: true, accountId: account.id, secret };
      } catch {
        continue;
      }
    }

    return {
      ok: false,
      category: "configuration",
      safeErrorCode: null,
      message: "No vendor account with a usable, enabled credential is configured for this candidate.",
    };
  }

  /**
   * Attempts one routing candidate (one tier): resolves that tier's own
   * model (never the originally-requested one — see
   * `isUsableAsFallbackTarget`), selects an account/credential, resolves
   * the protocol adapter, and calls it up to that tier's
   * `retryPolicy.maxAttempts` times, honoring the vendor's per-category
   * retry flags. Every call — including account/adapter resolution
   * failures that never reach the network — is appended to `state.attempts`.
   */
  private async attemptCandidate(
    candidate: RoutingCandidate,
    messages: ExecutionMessage[],
    input: ExecutionRequest,
    state: MutableAttemptState,
    isFallback: boolean,
    mode: ExecutionMode,
    ctx: ExecutionContext,
  ): Promise<TierAttemptResult> {
    const vendor = await this.vendors.findById(candidate.vendor!.id);
    const model = candidate.model ? await this.models.findById(candidate.model.id) : null;
    if (!vendor || !model) {
      state.attempts.push({
        attemptNumber: state.nextAttemptNumber++,
        tierId: candidate.tierId,
        tierNumber: candidate.tierNumber,
        vendorId: candidate.vendor!.id,
        vendorSlug: candidate.vendor!.slug,
        vendorAccountId: null,
        modelId: candidate.model?.id ?? "",
        isFallback,
        ok: false,
        errorCategory: "configuration",
        safeErrorCode: null,
        latencyMs: null,
      });
      return {
        ok: false,
        category: "configuration",
        safeErrorCode: null,
        message: "Vendor or model no longer exists.",
        vendor: vendor ?? null,
        accountId: null,
        model: model ?? null,
      };
    }

    const adapter = this.adapterRegistry.get(vendor.protocol);
    if (!adapter) {
      state.attempts.push({
        attemptNumber: state.nextAttemptNumber++,
        tierId: candidate.tierId,
        tierNumber: candidate.tierNumber,
        vendorId: vendor.id,
        vendorSlug: vendor.slug,
        vendorAccountId: null,
        modelId: model.id,
        isFallback,
        ok: false,
        errorCategory: "configuration",
        safeErrorCode: null,
        latencyMs: null,
      });
      return {
        ok: false,
        category: "configuration",
        safeErrorCode: null,
        message: `No provider adapter is registered for protocol "${vendor.protocol}".`,
        vendor,
        accountId: null,
        model,
      };
    }

    const accountSelection = await this.selectAccountAndSecret(candidate);
    if (!accountSelection.ok) {
      state.attempts.push({
        attemptNumber: state.nextAttemptNumber++,
        tierId: candidate.tierId,
        tierNumber: candidate.tierNumber,
        vendorId: vendor.id,
        vendorSlug: vendor.slug,
        vendorAccountId: null,
        modelId: model.id,
        isFallback,
        ok: false,
        errorCategory: accountSelection.category,
        safeErrorCode: accountSelection.safeErrorCode,
        latencyMs: null,
      });
      return {
        ok: false,
        category: accountSelection.category,
        safeErrorCode: accountSelection.safeErrorCode,
        message: accountSelection.message,
        vendor,
        accountId: null,
        model,
      };
    }

    const timeoutMs = candidate.retryPolicy?.timeoutMs ?? vendor.timeout_ms ?? DEFAULT_PROVIDER_TIMEOUT_MS;
    const maxAttempts = Math.max(1, candidate.retryPolicy?.maxAttempts ?? vendor.retry_max_attempts ?? DEFAULT_MAX_ATTEMPTS);
    const normalizedRequest: NormalizedProviderRequest = {
      model: model.provider_model_id,
      messages,
      maxOutputTokens: input.maxOutputTokens,
      temperature: input.temperature,
      stream: mode === "stream",
      ...(input.tools && input.tools.length > 0 ? { tools: input.tools, toolChoice: input.toolChoice ?? null } : {}),
    };
    const adapterConfig = { baseEndpoint: vendor.base_endpoint, timeoutMs };

    const pushAttempt = (ok: boolean, category: ExecutionErrorCategory | null, safeErrorCode: string | null, latencyMs: number | null): void => {
      state.attempts.push({
        attemptNumber: state.nextAttemptNumber++,
        tierId: candidate.tierId,
        tierNumber: candidate.tierNumber,
        vendorId: vendor.id,
        vendorSlug: vendor.slug,
        vendorAccountId: accountSelection.accountId,
        modelId: model.id,
        isFallback,
        ok,
        errorCategory: category,
        safeErrorCode,
        latencyMs,
      });
    };

    if (mode === "stream" && !adapter.executeStream) {
      pushAttempt(false, "configuration", null, null);
      return {
        ok: false,
        category: "configuration",
        safeErrorCode: null,
        message: `The provider adapter for protocol "${vendor.protocol}" does not support streaming.`,
        vendor,
        accountId: accountSelection.accountId,
        model,
      };
    }

    let lastFailure: { category: ExecutionErrorCategory; safeErrorCode: string | null; message: string } | null = null;

    for (let i = 1; i <= maxAttempts; i++) {
      if (ctx.signal?.aborted) {
        lastFailure = { category: "cancelled", safeErrorCode: null, message: "The request was cancelled by the caller." };
        break;
      }

      // An adapter is technically allowed to throw; that must never escape as a raw 500 or skip the ledger.
      let outcome: { ok: true; value: Awaited<ReturnType<typeof adapter.execute>> | ProviderStreamResult } | { ok: false; error: NormalizedProviderError };
      try {
        const value =
          mode === "stream"
            ? await adapter.executeStream!(accountSelection.secret, adapterConfig, normalizedRequest, ctx.signal)
            : await adapter.execute(accountSelection.secret, adapterConfig, normalizedRequest, ctx.signal);
        outcome = { ok: true, value };
      } catch (error) {
        ctx.log?.error(
          { event: "adapter_exception", requestId: ctx.requestId, vendorId: vendor.id, errorName: error instanceof Error ? error.name : "unknown" },
          "Provider adapter threw unexpectedly",
        );
        outcome = { ok: false, error: { category: "unknown", safeErrorCode: "ADAPTER_EXCEPTION", message: "Provider adapter failed unexpectedly." } };
      }

      if (outcome.ok && outcome.value.ok) {
        if (mode === "stream") {
          const stream = outcome.value as Extract<ProviderStreamResult, { ok: true }>;
          pushAttempt(true, null, null, stream.latencyMs);
          return { ok: true, kind: "stream", stream, vendor, accountId: accountSelection.accountId, model };
        }
        const response = (outcome.value as { ok: true; response: NormalizedProviderResponse }).response;
        pushAttempt(true, null, null, response.latencyMs);
        return { ok: true, kind: "unary", response, vendor, accountId: accountSelection.accountId, model };
      }

      const error: NormalizedProviderError = outcome.ok ? (outcome.value as { ok: false; error: NormalizedProviderError }).error : outcome.error;
      pushAttempt(false, error.category, error.safeErrorCode, null);
      lastFailure = error;

      const canRetry = i < maxAttempts && isRetryableCategory(error.category, vendor);
      if (!canRetry) break;
      await sleep(boundedBackoffMs(vendor.retry_backoff_ms), ctx.signal);
    }

    return {
      ok: false,
      category: lastFailure!.category,
      safeErrorCode: lastFailure!.safeErrorCode,
      message: lastFailure!.message,
      vendor,
      accountId: accountSelection.accountId,
      model,
    };
  }

  /**
   * Key-level workload authorization — default deny. Runs before *anything*
   * else (no routing lookup, no credential decryption, no provider call, no
   * ledger row), so a key can never reach a workload it was not explicitly
   * granted, regardless of which vendors happen to be assigned to it.
   * Deliberately indistinguishable for a workload that does not exist: an
   * unpermitted key learns nothing about which workload ids are real.
   */
  private async authorizeWorkload(apiKey: InhouseApiKeyRow, workloadId: string): Promise<void> {
    if (!(await this.apiKeys.isWorkloadAllowed(apiKey.id, workloadId))) {
      throw new ForbiddenError("This API key is not permitted to use the requested workload.", "WORKLOAD_NOT_PERMITTED");
    }
  }

  private async prepare(input: ExecutionRequest) {
    const workload = await this.workloads.findById(input.workloadId);
    if (!workload) {
      throw new NotFoundError(`Workload "${input.workloadId}" was not found.`);
    }
    const model = await this.models.findByAlias(input.modelAlias);
    if (!model) {
      throw new ValidationError(`Unknown model: "${input.modelAlias}".`);
    }
    const decision = await this.routing.preview({ workloadId: workload.id, modelId: model.id });
    return { workload, model, decision };
  }

  /**
   * Walks the routing decision: attempts the selected candidate, then
   * (only when persisted fallback configuration allows) further candidates.
   * Returns the last attempt result. Stops immediately on cancellation —
   * before touching a credential, retrying, or falling back.
   */
  private async runCandidates(
    decision: Awaited<ReturnType<RoutingService["preview"]>>,
    input: ExecutionRequest,
    ctx: ExecutionContext,
    mode: ExecutionMode,
    state: MutableAttemptState,
  ): Promise<{ result: TierAttemptResult; isFallback: boolean }> {
    const visited = new Set<string>();
    let candidate: RoutingCandidate | null = decision.selectedCandidate;
    let isFallback = false;
    let lastResult: TierAttemptResult = {
      ok: false,
      category: "unknown",
      safeErrorCode: null,
      message: "Execution failed for an unknown reason.",
      vendor: null,
      accountId: null,
      model: null,
    };

    while (candidate && !visited.has(candidate.tierId)) {
      if (ctx.signal?.aborted) {
        lastResult = { ...cancelledFailure() };
        break;
      }
      visited.add(candidate.tierId);
      const result = await this.attemptCandidate(candidate, input.messages, input, state, isFallback, mode, ctx);
      lastResult = result;
      if (result.ok) break;

      // Never fall back after the caller went away.
      if (result.category === "cancelled") break;
      // Decide whether to fall back: only if this vendor opted into automatic
      // fallback (Block 06's `automatic_fallback`, unchanged) AND a matching,
      // enabled fallback rule points at a usable, not-yet-attempted tier. The
      // target tier need not match the originally-requested model — see
      // `isUsableAsFallbackTarget`.
      if (!result.vendor?.automatic_fallback) break;
      const rule = pickFallbackRule(candidate.outgoingFallbackRules, result.category, result.safeErrorCode);
      if (!rule) break;
      const nextCandidate = decision.candidates.find(
        (c) => c.tierId === rule.toTierId && !visited.has(c.tierId) && isUsableAsFallbackTarget(c),
      );
      if (!nextCandidate) break;
      candidate = nextCandidate;
      isFallback = true;
    }
    return { result: lastResult, isFallback };
  }

  /**
   * The unary entry point. `apiKey` is the already-authenticated caller
   * (see `services/apiKeyAuthService.ts`). Throws only for a request that is
   * not permitted or malformed (workload not granted to the key / unknown
   * workload / unknown model) — every *execution* failure is a returned
   * `ExecutionFailure`, and one `usage_ledger` row is written for it.
   */
  async execute(apiKey: InhouseApiKeyRow, input: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const executionId = randomUUID();
    await this.authorizeWorkload(apiKey, input.workloadId);
    const { workload, model, decision } = await this.prepare(input);

    if (!decision.selectedCandidate) {
      const failure: ExecutionFailure = {
        ok: false,
        executionId,
        requestId: ctx.requestId,
        category: "no_eligible_candidate",
        message: "No eligible routing candidate was found for this workload/model.",
        attempts: [],
      };
      await this.recordUsage(ctx, {
        executionId, apiKeyId: apiKey.id, workloadId: workload.id, primaryTierId: null, modelId: model.id,
        attempts: [], ok: false, usage: null, errorCategory: failure.category, providerRequestId: null,
      });
      return failure;
    }

    const primaryTierId = decision.selectedCandidate.tierId;
    const state: MutableAttemptState = { attempts: [], nextAttemptNumber: 1 };
    const { result, isFallback } = await this.runCandidates(decision, input, ctx, "unary", state);

    if (result.ok && result.kind === "unary") {
      const outcome: ExecutionOutcome = {
        ok: true,
        executionId,
        requestId: ctx.requestId,
        output: result.response.output,
        toolCalls: result.response.toolCalls ?? [],
        finishReason: result.response.finishReason,
        model: { id: result.model.id, inhouseAlias: result.model.inhouse_alias, providerModelId: result.model.provider_model_id },
        usage: result.response.usage,
        isFallback,
        attempts: state.attempts,
        providerRequestId: result.response.providerRequestId,
      };
      await this.recordUsage(ctx, {
        executionId, apiKeyId: apiKey.id, workloadId: workload.id, primaryTierId, modelId: result.model.id,
        attempts: state.attempts, ok: true, usage: result.response.usage, errorCategory: null,
        providerRequestId: result.response.providerRequestId,
      });
      return outcome;
    }

    const failed = result.ok ? null : result;
    const outcome: ExecutionFailure = {
      ok: false,
      executionId,
      requestId: ctx.requestId,
      category: failed?.category ?? "unknown",
      message: failed?.message ?? "Execution failed for an unknown reason.",
      attempts: state.attempts,
    };
    await this.recordUsage(ctx, {
      executionId, apiKeyId: apiKey.id, workloadId: workload.id, primaryTierId, modelId: model.id,
      attempts: state.attempts, ok: false, usage: null, errorCategory: outcome.category, providerRequestId: null,
    });
    return outcome;
  }

  /**
   * The streaming entry point. Everything up to "a provider accepted the
   * request" behaves exactly like `execute()` — including retry and
   * fallback, both still possible because no byte has been sent to the
   * client yet — and a failure there is a returned `ExecutionFailure`. Once
   * a stream is open it can no longer fall back; the returned `events`
   * always end with `finish` or `error`, and the ledger row is written when
   * they end (or when the consumer abandons them — recorded as cancelled).
   */
  async executeStream(apiKey: InhouseApiKeyRow, input: ExecutionRequest, ctx: ExecutionContext): Promise<ExecutionStreamOutcome> {
    const executionId = randomUUID();
    await this.authorizeWorkload(apiKey, input.workloadId);
    const { workload, model, decision } = await this.prepare(input);

    if (!decision.selectedCandidate) {
      const failure: ExecutionFailure = {
        ok: false,
        executionId,
        requestId: ctx.requestId,
        category: "no_eligible_candidate",
        message: "No eligible routing candidate was found for this workload/model.",
        attempts: [],
      };
      await this.recordUsage(ctx, {
        executionId, apiKeyId: apiKey.id, workloadId: workload.id, primaryTierId: null, modelId: model.id,
        attempts: [], ok: false, usage: null, errorCategory: failure.category, providerRequestId: null,
      });
      return failure;
    }

    const primaryTierId = decision.selectedCandidate.tierId;
    const state: MutableAttemptState = { attempts: [], nextAttemptNumber: 1 };
    const { result, isFallback } = await this.runCandidates(decision, input, ctx, "stream", state);

    if (!result.ok || result.kind !== "stream") {
      const failed = result.ok ? null : result;
      const failure: ExecutionFailure = {
        ok: false,
        executionId,
        requestId: ctx.requestId,
        category: failed?.category ?? "unknown",
        message: failed?.message ?? "Execution failed for an unknown reason.",
        attempts: state.attempts,
      };
      await this.recordUsage(ctx, {
        executionId, apiKeyId: apiKey.id, workloadId: workload.id, primaryTierId, modelId: model.id,
        attempts: state.attempts, ok: false, usage: null, errorCategory: failure.category, providerRequestId: null,
      });
      return failure;
    }

    const provider = result.stream;
    const resolvedModel = result.model;
    const startedAt = Date.now();
    const record = this.recordUsage.bind(this);

    async function* events(): AsyncGenerator<NormalizedStreamEvent> {
      let usage: NormalizedProviderUsage | null = null;
      let providerRequestId: string | null = null;
      let failure: NormalizedProviderError | null = null;
      let finished = false;
      try {
        for await (const event of provider.events) {
          if (event.type === "finish") {
            usage = event.usage;
            providerRequestId = event.providerRequestId;
            finished = true;
          } else if (event.type === "error") {
            failure = event.error;
          }
          yield event;
          if (finished || failure) break;
        }
      } catch (error) {
        ctx.log?.error(
          { event: "adapter_exception", requestId: ctx.requestId, errorName: error instanceof Error ? error.name : "unknown" },
          "Provider stream threw unexpectedly",
        );
        failure = { category: "unknown", safeErrorCode: "ADAPTER_EXCEPTION", message: "Provider adapter failed unexpectedly." };
        yield { type: "error", error: failure };
      } finally {
        provider.close();
        // The consumer stopped before a terminal event: the client went away.
        if (!finished && !failure) {
          failure = { category: "cancelled", safeErrorCode: null, message: "The request was cancelled by the caller." };
        }
        const last = state.attempts[state.attempts.length - 1];
        if (last) {
          last.latencyMs = Date.now() - startedAt;
          if (failure) {
            last.ok = false;
            last.errorCategory = failure.category as ExecutionErrorCategory;
            last.safeErrorCode = failure.safeErrorCode;
          }
        }
        await record(ctx, {
          executionId, apiKeyId: apiKey.id, workloadId: workload.id, primaryTierId, modelId: resolvedModel.id,
          attempts: state.attempts, ok: failure === null, usage: failure === null ? usage : null,
          errorCategory: failure ? (failure.category as ExecutionErrorCategory) : null,
          providerRequestId: failure === null ? providerRequestId : null,
        });
      }
    }

    return {
      ok: true,
      executionId,
      requestId: ctx.requestId,
      model: { id: resolvedModel.id, inhouseAlias: resolvedModel.inhouse_alias, providerModelId: resolvedModel.provider_model_id },
      isFallback,
      events: events(),
    };
  }

  /**
   * Persists exactly one `usage_ledger` row per execution (never per
   * attempt — `attempt_count` carries how many were made). Never records
   * `provider_cost`/`inhouse_cost`: no pricing configuration exists
   * anywhere in this schema yet, and fabricating a number here would
   * violate Block 12 rule 9 ("do not fabricate accounting numbers") — see
   * docs/EXECUTION.md, "Known Gap: Cost Accounting".
   *
   * A ledger write failure never turns a completed provider call into a
   * client-visible error and never leaks a database error: it is logged as
   * a structured `usage_ledger_write_failed` line carrying exactly the
   * fields the row would have held (ids, counts, category — no content, no
   * secrets), which is the operational recovery record. Returns whether the
   * row was written; nothing claims accounting succeeded when it did not.
   */
  private async recordUsage(
    ctx: ExecutionContext,
    input: {
      executionId: string;
      apiKeyId: string;
      workloadId: string;
      primaryTierId: string | null;
      modelId: string;
      attempts: ExecutionAttemptRecord[];
      ok: boolean;
      usage: NormalizedProviderUsage | null;
      errorCategory: ExecutionErrorCategory | null;
      providerRequestId: string | null;
    },
  ): Promise<boolean> {
    const last = input.attempts.length > 0 ? input.attempts[input.attempts.length - 1]! : null;
    const isFallback = input.attempts.some((a) => a.isFallback);
    const fallbackTierId = isFallback && last ? last.tierId : null;

    const entry: NewUsageLedgerEntry = {
      execution_id: input.executionId,
      request_id: ctx.requestId,
      inhouse_api_key_id: input.apiKeyId,
      vendor_id: last?.vendorId ?? null,
      vendor_account_id: last?.vendorAccountId ?? null,
      model_id: last?.modelId ?? input.modelId,
      workload_id: input.workloadId,
      primary_tier_id: input.primaryTierId,
      fallback_tier_id: fallbackTierId,
      is_fallback: isFallback,
      attempt_count: input.attempts.length,
      status: input.ok ? "success" : "error",
      input_tokens: input.usage?.inputTokens ?? null,
      output_tokens: input.usage?.outputTokens ?? null,
      total_tokens: input.usage?.totalTokens ?? null,
      latency_ms: last?.latencyMs ?? null,
      error_category: input.ok ? null : input.errorCategory,
      provider_request_id: input.providerRequestId,
      provider_cost: null,
      inhouse_cost: null,
      currency: null,
    };

    try {
      await this.usageLedger.create(entry);
      return true;
    } catch (error) {
      ctx.log?.error(
        {
          event: "usage_ledger_write_failed",
          ...entry,
          dbErrorCode: (error as { code?: unknown } | null)?.code ?? null,
        },
        "Usage ledger write failed; this record must be reconciled from logs",
      );
      return false;
    }
  }
}

function cancelledFailure(): Extract<TierAttemptResult, { ok: false }> {
  return {
    ok: false,
    category: "cancelled",
    safeErrorCode: null,
    message: "The request was cancelled by the caller.",
    vendor: null,
    accountId: null,
    model: null,
  };
}
