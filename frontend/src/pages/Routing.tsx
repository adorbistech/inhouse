import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Panel, PanelHeader } from "../components/ui/Panel";
import { Table } from "../components/ui/Table";
import { FormField, Select, TextInput } from "../components/ui/FormField";
import { StatusPill } from "../components/ui/StatusPill";
import { titleCase } from "../lib/format";
import { api, ApiError } from "../lib/api";
import type { HealthState } from "../types/domain";
import {
  FALLBACK_CONDITION_TYPES,
  type CapabilityApi,
  type FallbackConditionType,
  type ModelApi,
  type RoutingCandidateApi,
  type RoutingDecisionApi,
  type RoutingFallbackRuleApi,
  type RoutingTierApi,
  type VendorApi,
  type WorkloadApi,
} from "../types/api";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

function healthToState(health: RoutingCandidateApi["health"]): HealthState {
  if (health === "healthy") return "healthy";
  if (health === "degraded") return "degraded";
  if (health === "unhealthy") return "unreachable";
  return "disabled";
}

function reasonLabel(reason: string): string {
  if (reason.startsWith("capability_not_supported:")) return "Missing capability";
  return titleCase(reason);
}

export function Routing() {
  const [workloads, setWorkloads] = useState<WorkloadApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [vendorsCatalog, setVendorsCatalog] = useState<VendorApi[]>([]);
  const [modelsCatalog, setModelsCatalog] = useState<ModelApi[]>([]);
  const [capabilitiesCatalog, setCapabilitiesCatalog] = useState<CapabilityApi[]>([]);

  const [selectedWorkloadId, setSelectedWorkloadId] = useState<string | null>(null);
  const [tiers, setTiers] = useState<RoutingTierApi[]>([]);
  const [fallbackRules, setFallbackRules] = useState<RoutingFallbackRuleApi[]>([]);
  const [configLoading, setConfigLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [addingTier, setAddingTier] = useState(false);
  const [addingRule, setAddingRule] = useState(false);

  const [decision, setDecision] = useState<RoutingDecisionApi | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewModelId, setPreviewModelId] = useState("");
  const [previewCapabilityIds, setPreviewCapabilityIds] = useState<Set<string>>(new Set());

  const refreshWorkloads = useCallback(async () => {
    try {
      const { workloads: rows } = await api.listWorkloads();
      setWorkloads(rows);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refreshWorkloads();
    api.listVendors().then(({ vendors }) => setVendorsCatalog(vendors)).catch(() => setVendorsCatalog([]));
    api.listModels().then(({ models }) => setModelsCatalog(models)).catch(() => setModelsCatalog([]));
    api
      .listCapabilities()
      .then(({ capabilities }) => setCapabilitiesCatalog(capabilities))
      .catch(() => setCapabilitiesCatalog([]));
  }, [refreshWorkloads]);

  useEffect(() => {
    if (!selectedWorkloadId && workloads && workloads.length > 0) {
      setSelectedWorkloadId(workloads[0]?.id ?? null);
    }
  }, [workloads, selectedWorkloadId]);

  const refreshConfig = useCallback(async (workloadId: string) => {
    setConfigLoading(true);
    setConfigError(null);
    try {
      const { tiers: t, fallbackRules: f } = await api.getRoutingConfig(workloadId);
      setTiers(t);
      setFallbackRules(f);
    } catch (error) {
      setConfigError(errorMessage(error));
      setTiers([]);
      setFallbackRules([]);
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedWorkloadId) {
      setDecision(null);
      setPreviewError(null);
      refreshConfig(selectedWorkloadId);
    } else {
      setTiers([]);
      setFallbackRules([]);
    }
  }, [selectedWorkloadId, refreshConfig]);

  const vendorById = useMemo(() => new Map(vendorsCatalog.map((v) => [v.id, v])), [vendorsCatalog]);
  const modelById = useMemo(() => new Map(modelsCatalog.map((m) => [m.id, m])), [modelsCatalog]);

  async function handleToggleTier(tier: RoutingTierApi) {
    if (!selectedWorkloadId) return;
    setActionError(null);
    try {
      if (tier.enabled) {
        await api.disableRoutingTier(selectedWorkloadId, tier.id);
      } else {
        await api.enableRoutingTier(selectedWorkloadId, tier.id);
      }
      await refreshConfig(selectedWorkloadId);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function handleToggleRule(rule: RoutingFallbackRuleApi) {
    if (!selectedWorkloadId) return;
    setActionError(null);
    try {
      if (rule.enabled) {
        await api.disableRoutingFallbackRule(selectedWorkloadId, rule.id);
      } else {
        await api.updateRoutingFallbackRule(selectedWorkloadId, rule.id, { enabled: true });
      }
      await refreshConfig(selectedWorkloadId);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function handleRunPreview() {
    if (!selectedWorkloadId) return;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const { decision: result } = await api.previewRouting({
        workloadId: selectedWorkloadId,
        modelId: previewModelId || undefined,
        capabilityIds: previewCapabilityIds.size > 0 ? Array.from(previewCapabilityIds) : undefined,
      });
      setDecision(result);
    } catch (error) {
      setPreviewError(errorMessage(error));
      setDecision(null);
    } finally {
      setPreviewLoading(false);
    }
  }

  if (listError) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center">
        <Icon name="error" className="text-error" size={28} />
        <span className="font-headline-md text-headline-md font-bold text-on-surface">Failed to load workloads</span>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">{listError}</p>
        <Button variant="secondary" onClick={() => refreshWorkloads()}>
          <Icon name="refresh" size={16} />
          Retry
        </Button>
      </div>
    );
  }

  if (workloads === null) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center">
        <Icon name="hourglass_top" className="text-primary animate-pulse" size={28} />
        <span className="font-body-md text-body-md text-on-surface-variant">Loading workloads…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-md mb-space-lg">
      <div>
        <span className="font-headline-lg text-headline-lg font-bold text-on-surface uppercase">Routing</span>
        <p className="font-body-md text-body-md text-on-surface-variant mt-1 max-w-2xl">
          Routing policy and deterministic candidate selection over configured tiers and fallback rules. This is a
          policy/explanation layer — nothing here sends a request to a provider.
        </p>
      </div>

      {workloads.length === 0 ? (
        <div className="bg-surface-container-low p-space-lg text-center flex flex-col items-center gap-space-sm">
          <Icon name="alt_route" className="text-outline-variant" size={32} />
          <span className="font-headline-md text-headline-md font-bold text-on-surface">No workloads configured</span>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">
            Routing is configured per workload, and no workloads exist in the Inhouse database yet.
          </p>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-space-xs bg-surface-container-low p-space-sm flex-wrap">
            <span className="font-label-md text-label-md text-on-surface-variant uppercase shrink-0">Workload:</span>
            <Select
              value={selectedWorkloadId ?? ""}
              onChange={(e) => setSelectedWorkloadId(e.target.value || null)}
              className="py-1 min-w-[220px]"
            >
              {workloads.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.displayName} ({w.status})
                </option>
              ))}
            </Select>
          </div>

          {actionError && (
            <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm flex items-center justify-between gap-space-sm">
              <span>{actionError}</span>
              <button onClick={() => setActionError(null)} aria-label="Dismiss">
                <Icon name="close" size={16} />
              </button>
            </div>
          )}

          {selectedWorkloadId && (
            <>
              {configError && (
                <Panel>
                  <div className="p-space-lg flex flex-col items-center gap-space-sm text-center">
                    <span className="font-body-sm text-body-sm text-error">{configError}</span>
                    <Button variant="secondary" onClick={() => refreshConfig(selectedWorkloadId)}>
                      Retry
                    </Button>
                  </div>
                </Panel>
              )}

              {!configError && configLoading && (
                <Panel>
                  <div className="p-space-lg text-center font-body-sm text-body-sm text-on-surface-variant">
                    Loading routing configuration…
                  </div>
                </Panel>
              )}

              {!configError && !configLoading && (
                <>
                  <Panel>
                    <PanelHeader
                      title="Routing Tiers"
                      eyebrow={`${tiers.length} CONFIGURED`}
                      right={
                        !addingTier && (
                          <Button variant="primary" className="px-space-sm py-1" onClick={() => setAddingTier(true)}>
                            <Icon name="add" size={14} />
                            Add Tier
                          </Button>
                        )
                      }
                    />
                    {addingTier && (
                      <AddTierForm
                        vendors={vendorsCatalog}
                        models={modelsCatalog}
                        onCancel={() => setAddingTier(false)}
                        onSubmit={async (payload) => {
                          await api.createRoutingTier(selectedWorkloadId, payload);
                          setAddingTier(false);
                          await refreshConfig(selectedWorkloadId);
                        }}
                      />
                    )}
                    {tiers.length === 0 ? (
                      <div className="p-space-lg text-center flex flex-col items-center gap-space-sm">
                        <Icon name="layers_clear" className="text-outline-variant" size={28} />
                        <span className="font-body-sm text-body-sm text-on-surface-variant">
                          No routing tiers are configured for this workload yet.
                        </span>
                      </div>
                    ) : (
                      <Table
                        rowKey={(t) => t.id}
                        rows={[...tiers].sort((a, b) => a.tierNumber - b.tierNumber || b.priority - a.priority)}
                        columns={[
                          { header: "Tier", render: (t) => <span className="text-on-surface font-bold">#{t.tierNumber}</span> },
                          {
                            header: "Vendor",
                            render: (t) => <span className="text-on-surface-variant">{vendorById.get(t.vendorId)?.displayName ?? t.vendorId}</span>,
                          },
                          {
                            header: "Model",
                            render: (t) => (
                              <span className="font-code-dense text-code-dense text-primary">
                                {modelById.get(t.modelId)?.inhouseAlias ?? t.modelId}
                              </span>
                            ),
                          },
                          { header: "Priority", render: (t) => <Chip tone="primary">{t.priority}</Chip> },
                          {
                            header: "Timeout / Max Attempts",
                            render: (t) => (
                              <span className="font-code-dense text-code-dense text-on-surface-variant">
                                {t.timeoutOverrideMs ?? "—"}ms / {t.maxAttempts ?? "—"}
                              </span>
                            ),
                          },
                          {
                            header: "Status",
                            render: (t) => <Chip tone={t.enabled ? "tertiary" : "error"}>{t.enabled ? "Enabled" : "Disabled"}</Chip>,
                          },
                          {
                            header: "Actions",
                            render: (t) => (
                              <Button variant="secondary" className="px-space-sm py-1" onClick={() => handleToggleTier(t)}>
                                {t.enabled ? "Disable" : "Enable"}
                              </Button>
                            ),
                          },
                        ]}
                      />
                    )}
                  </Panel>

                  <Panel>
                    <PanelHeader
                      title="Fallback Rules"
                      eyebrow={`${fallbackRules.length} CONFIGURED`}
                      right={
                        !addingRule &&
                        tiers.length >= 2 && (
                          <Button variant="primary" className="px-space-sm py-1" onClick={() => setAddingRule(true)}>
                            <Icon name="add" size={14} />
                            Add Rule
                          </Button>
                        )
                      }
                    />
                    {addingRule && (
                      <AddFallbackRuleForm
                        tiers={tiers}
                        onCancel={() => setAddingRule(false)}
                        onSubmit={async (payload) => {
                          await api.createRoutingFallbackRule(selectedWorkloadId, payload);
                          setAddingRule(false);
                          await refreshConfig(selectedWorkloadId);
                        }}
                      />
                    )}
                    {fallbackRules.length === 0 ? (
                      <div className="p-space-lg text-center font-body-sm text-body-sm text-on-surface-variant">
                        {tiers.length < 2
                          ? "At least two tiers are required before a fallback rule can be configured."
                          : "No fallback rules are configured for this workload yet."}
                      </div>
                    ) : (
                      <Table
                        rowKey={(r) => r.id}
                        rows={fallbackRules}
                        columns={[
                          {
                            header: "From Tier",
                            render: (r) => <span className="text-on-surface">#{tiers.find((t) => t.id === r.fromTierId)?.tierNumber ?? "?"}</span>,
                          },
                          {
                            header: "To Tier",
                            render: (r) => <span className="text-on-surface">#{tiers.find((t) => t.id === r.toTierId)?.tierNumber ?? "?"}</span>,
                          },
                          { header: "Condition", render: (r) => <Chip>{titleCase(r.conditionType)}</Chip> },
                          { header: "Priority", render: (r) => <span className="text-on-surface-variant">{r.priority}</span> },
                          {
                            header: "Status",
                            render: (r) => <Chip tone={r.enabled ? "tertiary" : "error"}>{r.enabled ? "Enabled" : "Disabled"}</Chip>,
                          },
                          {
                            header: "Actions",
                            render: (r) => (
                              <Button variant="secondary" className="px-space-sm py-1" onClick={() => handleToggleRule(r)}>
                                {r.enabled ? "Disable" : "Enable"}
                              </Button>
                            ),
                          },
                        ]}
                      />
                    )}
                    <p className="px-space-md pb-space-md font-body-sm text-body-sm text-on-surface-variant">
                      A fallback rule describes configuration only — Inhouse does not evaluate it to actually execute a
                      fallback in this block.
                    </p>
                  </Panel>

                  <Panel>
                    <PanelHeader
                      title="Routing Preview (Dry-Run)"
                      eyebrow="CONFIGURATION SIMULATION ONLY"
                      right={
                        <Button variant="primary" className="px-space-sm py-1" onClick={handleRunPreview} disabled={previewLoading}>
                          <Icon name="play_arrow" size={14} />
                          {previewLoading ? "Running…" : "Run Preview"}
                        </Button>
                      }
                    />
                    <div className="p-space-md flex flex-col gap-space-sm">
                      <div className="bg-surface-container-high p-space-sm flex items-start gap-space-xs">
                        <Icon name="info" className="text-secondary shrink-0" size={18} />
                        <p className="font-body-sm text-body-sm text-on-surface-variant">
                          A preview explains what Inhouse would select for this workload right now. It never contacts
                          a provider, consumes a credential, or records usage — this is not live execution.
                        </p>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
                        <FormField label="Filter to a specific model (optional)">
                          <Select value={previewModelId} onChange={(e) => setPreviewModelId(e.target.value)} className="py-1">
                            <option value="">Any model configured on a tier</option>
                            {modelsCatalog.map((m) => (
                              <option key={m.id} value={m.id}>
                                {m.displayName}
                              </option>
                            ))}
                          </Select>
                        </FormField>
                        {capabilitiesCatalog.length > 0 && (
                          <FormField label="Require capabilities (optional)">
                            <div className="flex flex-wrap gap-1">
                              {capabilitiesCatalog.map((cap) => {
                                const checked = previewCapabilityIds.has(cap.id);
                                return (
                                  <button
                                    type="button"
                                    key={cap.id}
                                    onClick={() => {
                                      const next = new Set(previewCapabilityIds);
                                      if (next.has(cap.id)) next.delete(cap.id);
                                      else next.add(cap.id);
                                      setPreviewCapabilityIds(next);
                                    }}
                                    className={`font-code-dense text-code-dense uppercase px-space-xs py-1 border ${
                                      checked
                                        ? "bg-primary text-on-primary border-primary"
                                        : "bg-surface text-on-surface-variant border-outline-variant"
                                    }`}
                                  >
                                    {titleCase(cap.slug)}
                                  </button>
                                );
                              })}
                            </div>
                          </FormField>
                        )}
                      </div>

                      {previewError && <div className="font-body-sm text-body-sm text-error">{previewError}</div>}

                      {decision && <RoutingDecisionView decision={decision} />}
                    </div>
                  </Panel>
                </>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function RoutingDecisionView({ decision }: { decision: RoutingDecisionApi }) {
  return (
    <div className="flex flex-col gap-space-sm">
      <div className="flex items-center gap-space-xs flex-wrap">
        <span className="font-code-dense text-code-dense text-outline uppercase">Outcome:</span>
        <Chip tone={decision.outcome === "selected" ? "tertiary" : "error"}>{titleCase(decision.outcome)}</Chip>
      </div>

      {decision.selectedCandidate && (
        <div className="bg-tertiary/10 border border-tertiary p-space-sm flex flex-col gap-1">
          <span className="font-label-md text-label-md text-tertiary uppercase">Selected Candidate</span>
          <span className="font-body-md text-body-md text-on-surface font-bold">
            Tier #{decision.selectedCandidate.tierNumber} — {decision.selectedCandidate.vendor?.displayName ?? "Unknown vendor"} /{" "}
            {decision.selectedCandidate.model?.inhouseAlias ?? "Unknown model"}
          </span>
        </div>
      )}

      <div className="flex flex-col gap-space-xs">
        {decision.candidates.map((c, index) => (
          <div key={c.tierId} className={`bg-surface p-space-sm flex flex-col gap-1 ${c.eligible ? "" : "opacity-70"}`}>
            <div className="flex items-center justify-between flex-wrap gap-space-xs">
              <div className="flex items-center gap-space-xs">
                <span className="font-code-dense text-code-dense text-outline">#{index + 1}</span>
                <span className="font-body-md text-body-md text-on-surface font-bold">
                  Tier {c.tierNumber} — {c.vendor?.displayName ?? "Unknown vendor"} / {c.model?.inhouseAlias ?? "Unknown model"}
                </span>
              </div>
              <div className="flex items-center gap-space-xs">
                <Chip tone="primary">Priority {c.priority}</Chip>
                <StatusPill state={healthToState(c.health)} detail={titleCase(c.health)} />
                <Chip tone={c.eligible ? "tertiary" : "error"}>{c.eligible ? "Eligible" : "Excluded"}</Chip>
              </div>
            </div>
            {c.reasons.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {c.reasons.map((reason) => (
                  <Chip key={reason} tone="error">
                    {reasonLabel(reason)}
                  </Chip>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function AddTierForm({
  vendors,
  models,
  onCancel,
  onSubmit,
}: {
  vendors: VendorApi[];
  models: ModelApi[];
  onCancel: () => void;
  onSubmit: (payload: { vendorId: string; modelId: string; tierNumber: number; priority: number }) => Promise<void>;
}) {
  const [vendorId, setVendorId] = useState("");
  const [modelId, setModelId] = useState("");
  const [tierNumber, setTierNumber] = useState(1);
  const [priority, setPriority] = useState(0);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const modelOptions = vendorId ? models.filter((m) => m.vendorId === vendorId) : models;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({ vendorId, modelId, tierNumber, priority });
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "Failed to create routing tier.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="p-space-md bg-surface-container-high flex flex-col gap-space-sm" onSubmit={handleSubmit}>
      {submitError && <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm">{submitError}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-4 gap-space-sm">
        <FormField label="Vendor">
          <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
            <option value="" disabled>
              {vendors.length === 0 ? "No vendors configured" : "Select a vendor…"}
            </option>
            {vendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Model">
          <Select value={modelId} onChange={(e) => setModelId(e.target.value)} required>
            <option value="" disabled>
              {modelOptions.length === 0 ? "No models available" : "Select a model…"}
            </option>
            {modelOptions.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Tier Number">
          <TextInput type="number" min={0} value={tierNumber} onChange={(e) => setTierNumber(Number(e.target.value))} />
        </FormField>
        <FormField label="Priority">
          <TextInput type="number" min={0} value={priority} onChange={(e) => setPriority(Number(e.target.value))} />
        </FormField>
      </div>
      <p className="font-body-sm text-body-sm text-on-surface-variant">
        The selected vendor and model must already be assigned to this workload (on the Vendors/Settings pages) —
        Inhouse never widens that assignment implicitly.
      </p>
      <div className="flex items-center justify-end gap-space-xs">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !vendorId || !modelId}>
          {submitting ? "Saving…" : "Add Tier"}
        </Button>
      </div>
    </form>
  );
}

function AddFallbackRuleForm({
  tiers,
  onCancel,
  onSubmit,
}: {
  tiers: RoutingTierApi[];
  onCancel: () => void;
  onSubmit: (payload: { fromTierId: string; toTierId: string; conditionType: FallbackConditionType }) => Promise<void>;
}) {
  const [fromTierId, setFromTierId] = useState("");
  const [toTierId, setToTierId] = useState("");
  const [conditionType, setConditionType] = useState<FallbackConditionType>("on_timeout");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({ fromTierId, toTierId, conditionType });
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "Failed to create fallback rule.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="p-space-md bg-surface-container-high flex flex-col gap-space-sm" onSubmit={handleSubmit}>
      {submitError && <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm">{submitError}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
        <FormField label="From Tier">
          <Select value={fromTierId} onChange={(e) => setFromTierId(e.target.value)} required>
            <option value="" disabled>
              Select a tier…
            </option>
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                Tier #{t.tierNumber}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="To Tier">
          <Select value={toTierId} onChange={(e) => setToTierId(e.target.value)} required>
            <option value="" disabled>
              Select a tier…
            </option>
            {tiers.map((t) => (
              <option key={t.id} value={t.id}>
                Tier #{t.tierNumber}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Condition">
          <Select value={conditionType} onChange={(e) => setConditionType(e.target.value as FallbackConditionType)}>
            {FALLBACK_CONDITION_TYPES.map((c) => (
              <option key={c} value={c}>
                {titleCase(c)}
              </option>
            ))}
          </Select>
        </FormField>
      </div>
      <div className="flex items-center justify-end gap-space-xs">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={submitting || !fromTierId || !toTierId || fromTierId === toTierId}>
          {submitting ? "Saving…" : "Add Rule"}
        </Button>
      </div>
    </form>
  );
}
