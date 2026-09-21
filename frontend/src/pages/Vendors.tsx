import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VendorAccountsAndCredentials } from "./VendorAccounts";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { StatusPill } from "../components/ui/StatusPill";
import { Panel } from "../components/ui/Panel";
import { Tabs } from "../components/ui/Tabs";
import { Drawer } from "../components/ui/Drawer";
import { FormField, Select, TextInput } from "../components/ui/FormField";
import { formatDateTime, titleCase } from "../lib/format";
import { api, ApiError } from "../lib/api";
import type { HealthState } from "../types/domain";
import type {
  CapabilityApi,
  CreateVendorPayload,
  VendorApi,
  VendorDetailApi,
  VendorStatus,
  WorkloadApi,
} from "../types/api";

const STATUS_FILTERS: { key: "all" | VendorStatus; label: string }[] = [
  { key: "all", label: "All Statuses" },
  { key: "enabled", label: "Enabled" },
  { key: "disabled", label: "Disabled" },
  { key: "unavailable", label: "Unavailable" },
];

const DETAIL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "credential", label: "Credential" },
  { key: "capabilities", label: "Capabilities" },
  { key: "workloads", label: "Workloads" },
  { key: "routing", label: "Routing" },
];

function vendorStatusToHealthState(status: VendorStatus): HealthState {
  if (status === "enabled") return "healthy";
  if (status === "unavailable") return "unreachable";
  return "disabled";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "An unexpected error occurred.";
}

export function Vendors() {
  const [vendors, setVendors] = useState<VendorApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [capabilitiesCatalog, setCapabilitiesCatalog] = useState<CapabilityApi[]>([]);
  const [workloadsCatalog, setWorkloadsCatalog] = useState<WorkloadApi[]>([]);

  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | VendorStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<VendorDetailApi | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [activeTab, setActiveTab] = useState("overview");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshVendors = useCallback(async () => {
    try {
      const { vendors: rows } = await api.listVendors();
      setVendors(rows);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refreshVendors();
    api
      .listCapabilities()
      .then(({ capabilities }) => setCapabilitiesCatalog(capabilities))
      .catch(() => setCapabilitiesCatalog([]));
    api
      .listWorkloads()
      .then(({ workloads }) => setWorkloadsCatalog(workloads))
      .catch(() => setWorkloadsCatalog([]));
  }, [refreshVendors]);

  // Only the latest detail request may write state, so a slow response for one vendor cannot replace another's.
  const detailRequest = useRef(0);
  const refreshDetail = useCallback(async (id: string) => {
    const request = ++detailRequest.current;
    setDetailLoading(true);
    setDetailError(null);
    try {
      const { vendor } = await api.getVendor(id);
      if (request !== detailRequest.current) return;
      setSelectedDetail(vendor);
    } catch (error) {
      if (request !== detailRequest.current) return;
      setDetailError(errorMessage(error));
      setSelectedDetail(null);
    } finally {
      if (request === detailRequest.current) setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) {
      setSelectedAccountId(null);
      refreshDetail(selectedId);
    } else {
      setSelectedDetail(null);
    }
  }, [selectedId, refreshDetail]);

  useEffect(() => {
    if (!selectedId && vendors && vendors.length > 0) {
      setSelectedId(vendors[0]?.id ?? null);
    }
  }, [vendors, selectedId]);

  const filtered = useMemo(() => {
    if (!vendors) return [];
    return vendors.filter((v) => {
      const matchesQuery =
        !query ||
        v.displayName.toLowerCase().includes(query.toLowerCase()) ||
        v.protocol.toLowerCase().includes(query.toLowerCase()) ||
        v.vendorType.toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === "all" || v.status === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [vendors, query, statusFilter]);

  const selectedAccount =
    selectedDetail?.accounts.find((a) => a.id === selectedAccountId) ?? selectedDetail?.accounts[0];

  async function handleAddVendor(payload: CreateVendorPayload) {
    const { vendor } = await api.createVendor(payload);
    await refreshVendors();
    setSelectedId(vendor.id);
    setDrawerOpen(false);
  }

  async function handleToggleStatus(vendor: VendorApi) {
    setActionError(null);
    try {
      if (vendor.status === "enabled") {
        await api.disableVendor(vendor.id);
      } else {
        await api.enableVendor(vendor.id);
      }
      await refreshVendors();
      if (selectedId === vendor.id) await refreshDetail(vendor.id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function handleToggleCapability(capabilityId: string) {
    if (!selectedDetail) return;
    const current = new Set(selectedDetail.capabilities.map((c) => c.id));
    if (current.has(capabilityId)) {
      current.delete(capabilityId);
    } else {
      current.add(capabilityId);
    }
    setActionError(null);
    try {
      await api.setVendorCapabilities(selectedDetail.id, Array.from(current));
      await refreshDetail(selectedDetail.id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function handleToggleWorkload(workloadId: string) {
    if (!selectedDetail) return;
    const current = new Set(selectedDetail.workloads.map((w) => w.id));
    if (current.has(workloadId)) {
      current.delete(workloadId);
    } else {
      current.add(workloadId);
    }
    setActionError(null);
    try {
      await api.setVendorWorkloads(selectedDetail.id, Array.from(current));
      await refreshDetail(selectedDetail.id);
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  if (listError) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center">
        <Icon name="error" className="text-error" size={28} />
        <span className="font-headline-md text-headline-md font-bold text-on-surface">Failed to load vendors</span>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">{listError}</p>
        <Button variant="secondary" onClick={() => refreshVendors()}>
          <Icon name="refresh" size={16} />
          Retry
        </Button>
      </div>
    );
  }

  if (vendors === null) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center">
        <Icon name="hourglass_top" className="text-primary animate-pulse" size={28} />
        <span className="font-body-md text-body-md text-on-surface-variant">Loading vendors…</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-space-xs">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-space-sm">
          <div>
            <div className="flex items-center gap-space-xs flex-wrap">
              <span className="font-headline-lg text-headline-lg font-bold text-on-surface uppercase">Vendors</span>
              <Chip tone="primary">{vendors.length} Total</Chip>
            </div>
            <p className="font-body-md text-body-md text-on-surface-variant mt-1 max-w-xl">
              Manage AI inference providers, credentials, capabilities and workloads.
            </p>
          </div>
          <Button variant="primary" onClick={() => setDrawerOpen(true)} className="shrink-0">
            <Icon name="add" size={16} />
            Add Vendor
          </Button>
        </div>

        <div className="flex items-center gap-space-xs bg-surface-container-low px-space-sm py-space-sm">
          <Icon name="search" size={18} className="text-on-surface-variant" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search vendors by name, protocol, type…"
            className="bg-transparent outline-none font-body-sm text-body-sm text-on-surface w-full placeholder:text-outline-variant"
          />
        </div>

        <div className="flex items-center gap-space-xs flex-wrap">
          <span className="font-label-md text-label-md text-on-surface-variant uppercase shrink-0">Filter:</span>
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setStatusFilter(f.key)}
              className={`font-label-md text-label-md uppercase px-space-sm py-1 flex items-center gap-1 transition-colors ${
                statusFilter === f.key
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface-variant hover:text-on-surface"
              }`}
            >
              {f.key !== "all" && (
                <span
                  className={`w-1.5 h-1.5 ${
                    f.key === "enabled" ? "bg-tertiary" : f.key === "unavailable" ? "bg-error" : "bg-outline"
                  }`}
                />
              )}
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {actionError && (
        <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm flex items-center justify-between gap-space-sm">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      {/* Vendor cards */}
      {vendors.length === 0 ? (
        <div className="bg-surface-container-low p-space-lg text-center flex flex-col items-center gap-space-sm">
          <Icon name="hub" className="text-outline-variant" size={32} />
          <span className="font-headline-md text-headline-md font-bold text-on-surface">No vendors configured</span>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">
            No vendors exist in the Inhouse database yet. Click "Add Vendor" to configure the first inference
            provider.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-space-xs">
          {filtered.map((v) => {
            const healthState = vendorStatusToHealthState(v.status);
            const barColor =
              healthState === "healthy" ? "bg-tertiary" : healthState === "unreachable" ? "bg-error" : "bg-outline";
            const isSelected = v.id === selectedId;
            return (
              <div
                key={v.id}
                className={`flex flex-col relative cursor-pointer transition-colors ${
                  v.status !== "enabled" ? "bg-surface-container-low/60 opacity-75" : "bg-surface-container-low"
                } ${isSelected ? "outline outline-1 outline-primary" : ""}`}
                onClick={() => {
                  setSelectedId(v.id);
                  setOpenMenuId(null);
                }}
              >
                <div className={`h-0.5 w-full ${barColor}`} />
                <div className="p-space-md flex flex-col gap-space-sm">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-space-sm min-w-0">
                      <div className="w-8 h-8 bg-surface-container-highest flex items-center justify-center font-headline-md text-headline-md font-bold text-secondary shrink-0">
                        {v.displayName.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-space-xs flex-wrap">
                          <span className="font-headline-md text-headline-md font-bold text-on-surface">
                            {v.displayName}
                          </span>
                          <Chip tone="primary">{titleCase(v.vendorType)}</Chip>
                          <Chip tone={v.adapterSupported ? "tertiary" : undefined}>
                            {v.adapterSupported ? "Adapter Ready" : "No Adapter"}
                          </Chip>
                        </div>
                        <span className="font-code-dense text-code-dense text-on-surface-variant truncate block">
                          Proto: {titleCase(v.protocol)} • Priority {v.priority}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-space-xs shrink-0 relative">
                      <StatusPill state={healthState} detail={titleCase(v.status)} />
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuId(openMenuId === v.id ? null : v.id);
                        }}
                        className="w-7 h-7 bg-surface-container-high hover:bg-surface-container-highest text-on-surface flex items-center justify-center"
                        aria-label="Vendor actions"
                      >
                        <Icon name="more_vert" size={16} />
                      </button>
                      {openMenuId === v.id && (
                        <div className="absolute right-0 top-8 w-52 bg-surface-container-high border border-outline-variant z-20 shadow-2xl">
                          <div className="px-space-sm py-1.5 font-label-md text-label-md text-on-surface-variant uppercase border-b border-outline-variant">
                            Actions · {v.displayName}
                          </div>
                          <button
                            className="w-full text-left px-space-sm py-1.5 text-on-surface hover:bg-primary hover:text-surface font-label-md text-label-md uppercase flex items-center gap-space-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedId(v.id);
                              setOpenMenuId(null);
                            }}
                          >
                            <Icon name="visibility" size={14} />
                            <span>View Details</span>
                          </button>
                          <div className="h-[1px] bg-surface-container-highest my-1" />
                          <button
                            className={`w-full text-left px-space-sm py-1.5 font-label-md text-label-md uppercase flex items-center gap-space-xs ${
                              v.status === "enabled" ? "text-error hover:bg-error hover:text-on-error" : "text-tertiary hover:bg-tertiary hover:text-on-tertiary"
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpenMenuId(null);
                              handleToggleStatus(v);
                            }}
                          >
                            <Icon name={v.status === "enabled" ? "block" : "check_circle"} size={14} />
                            <span>{v.status === "enabled" ? "Disable" : "Enable"}</span>
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-space-xs items-center pt-space-xs">
                    <Chip>{titleCase(v.billingType)}</Chip>
                    {v.automaticFallback && <Chip tone="primary">Auto-Fallback</Chip>}
                    <span className="ml-auto font-code-dense text-code-dense text-on-surface-variant">
                      Created {formatDateTime(v.createdAt)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="md:col-span-2 bg-surface-container-low p-space-lg text-center font-body-md text-body-md text-on-surface-variant">
              No vendors match the current search / filter.
            </div>
          )}
        </div>
      )}

      {/* Inspector */}
      {selectedId && (
        <Panel className="mb-space-lg">
          {detailLoading && !selectedDetail && (
            <div className="p-space-lg text-center font-body-sm text-body-sm text-on-surface-variant">
              Loading vendor detail…
            </div>
          )}
          {detailError && (
            <div className="p-space-lg text-center flex flex-col items-center gap-space-sm">
              <span className="font-body-sm text-body-sm text-error">{detailError}</span>
              <Button variant="secondary" onClick={() => refreshDetail(selectedId)}>
                Retry
              </Button>
            </div>
          )}
          {selectedDetail && (
            <>
              <div className="bg-surface-container-high px-space-md py-space-sm flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs">
                <div className="flex items-center gap-space-sm">
                  <span className="font-label-md text-label-md text-primary uppercase">Inspector:</span>
                  <span className="font-headline-md text-headline-md text-on-surface font-bold">
                    {selectedDetail.displayName}
                  </span>
                  <StatusPill
                    state={vendorStatusToHealthState(selectedDetail.status)}
                    detail={titleCase(selectedDetail.status)}
                  />
                </div>
                <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">
                  ID: {selectedDetail.id}
                </span>
              </div>

              <Tabs tabs={DETAIL_TABS} active={activeTab} onChange={setActiveTab} />

              <div className="p-space-md flex flex-col gap-space-md bg-surface-container-low">
                {activeTab === "overview" && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                    <InfoTile label="Base Endpoint" value={selectedDetail.baseEndpoint} mono />
                    <InfoTile label="Priority" value={`${selectedDetail.priority} / 10`} accent="primary" />
                    <InfoTile
                      label="Tier Range"
                      value={`${selectedDetail.defaultTier ?? "—"} / ${selectedDetail.maxTier ?? "—"}`}
                    />
                    <InfoTile
                      label="Workloads"
                      value={selectedDetail.workloads.map((w) => titleCase(w.slug)).join(", ") || "None"}
                    />
                    <InfoTile
                      label="Adapter Support"
                      value={selectedDetail.adapterSupported ? "Available" : "Not Available"}
                      accent={selectedDetail.adapterSupported ? "tertiary" : undefined}
                    />
                    <InfoTile label="Accounts" value={`${selectedDetail.accounts.length} configured`} />
                    <InfoTile label="Created" value={formatDateTime(selectedDetail.createdAt)} />
                    <div className="sm:col-span-3 bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant">
                      {selectedDetail.description ?? "No description provided."}
                    </div>
                  </div>
                )}

                {activeTab === "credential" && (
                  <VendorAccountsAndCredentials
                    key={selectedDetail.id}
                    vendorId={selectedDetail.id}
                    adapterSupported={selectedDetail.adapterSupported}
                    vendorEnabled={selectedDetail.status === "enabled"}
                    accounts={selectedDetail.accounts}
                    selectedAccount={selectedAccount}
                    onSelectAccount={setSelectedAccountId}
                    onChanged={() => refreshDetail(selectedDetail.id)}
                    onError={setActionError}
                  />
                )}

                {activeTab === "capabilities" && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
                    {capabilitiesCatalog.length === 0 && (
                      <div className="col-span-full bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant text-center">
                        No capabilities are defined in the Inhouse database yet.
                      </div>
                    )}
                    {capabilitiesCatalog.map((cap) => {
                      const enabled = selectedDetail.capabilities.some((c) => c.id === cap.id);
                      return (
                        <button
                          key={cap.id}
                          onClick={() => handleToggleCapability(cap.id)}
                          className={`flex items-center gap-2 bg-surface p-space-sm text-left ${enabled ? "" : "opacity-50"}`}
                        >
                          <span className={`w-3 h-3 border border-outline-variant ${enabled ? "bg-primary" : ""}`} />
                          <span
                            className={`font-code-dense text-code-dense uppercase ${
                              enabled ? "text-on-surface" : "text-on-surface-variant"
                            }`}
                          >
                            {titleCase(cap.slug)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {activeTab === "workloads" && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
                    {workloadsCatalog.length === 0 && (
                      <div className="col-span-full bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant text-center">
                        No workloads are defined in the Inhouse database yet.
                      </div>
                    )}
                    {workloadsCatalog.map((w) => {
                      const enabled = selectedDetail.workloads.some((x) => x.id === w.id);
                      return (
                        <button
                          key={w.id}
                          onClick={() => handleToggleWorkload(w.id)}
                          className={`flex items-center gap-2 bg-surface p-space-sm text-left ${enabled ? "" : "opacity-50"}`}
                        >
                          <span className={`w-3 h-3 border border-outline-variant ${enabled ? "bg-primary" : ""}`} />
                          <span
                            className={`font-code-dense text-code-dense uppercase ${
                              enabled ? "text-on-surface" : "text-on-surface-variant"
                            }`}
                          >
                            {titleCase(w.slug)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {activeTab === "routing" && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                    <InfoTile label="Priority Rank" value={`${selectedDetail.priority} / 10`} accent="primary" />
                    <InfoTile
                      label="Default / Max Tier"
                      value={`${selectedDetail.defaultTier ?? "—"} / ${selectedDetail.maxTier ?? "—"}`}
                    />
                    <InfoTile
                      label="Automatic Fallback"
                      value={selectedDetail.automaticFallback ? "Enabled" : "Disabled"}
                      accent={selectedDetail.automaticFallback ? "tertiary" : undefined}
                    />
                    <InfoTile label="Timeout" value={`${selectedDetail.timeoutMs ?? "—"}ms`} />
                    <InfoTile label="Retry Max Attempts" value={String(selectedDetail.retryMaxAttempts ?? "—")} />
                    <InfoTile label="Retry Backoff" value={`${selectedDetail.retryBackoffMs ?? "—"}ms`} />
                    {(
                      [
                        ["Retry on Timeout", selectedDetail.retryOnTimeout],
                        ["Retry on Rate Limit", selectedDetail.retryOnRateLimit],
                        ["Retry on 5xx", selectedDetail.retryOn5xx],
                        ["Retry on Auth Failure", selectedDetail.retryOnAuthFailure],
                        ["Retry on Invalid Response", selectedDetail.retryOnInvalidResponse],
                      ] as [string, boolean][]
                    ).map(([label, value]) => (
                      <InfoTile key={label} label={label} value={value ? "Enabled" : "Disabled"} accent={value ? "tertiary" : undefined} />
                    ))}
                    <div className="sm:col-span-3 bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant">
                      Routing execution (which vendor actually serves a request) is implemented in a later block.
                      This tab only displays and edits the vendor-level configuration Block 06 persists.
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </Panel>
      )}

      <AddVendorDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        capabilitiesCatalog={capabilitiesCatalog}
        workloadsCatalog={workloadsCatalog}
        onSubmit={handleAddVendor}
      />
    </>
  );
}

function InfoTile({
  label,
  value,
  mono,
  accent,
}: {
  label: string;
  value: string;
  mono?: boolean;
  accent?: "primary" | "tertiary";
}) {
  return (
    <div className="bg-surface p-space-sm flex flex-col gap-0.5 min-w-0">
      <span className="font-code-dense text-code-dense text-outline uppercase">{label}</span>
      <span
        className={`font-body-md text-body-md font-bold truncate ${
          accent === "primary" ? "text-primary" : accent === "tertiary" ? "text-tertiary" : "text-on-surface"
        } ${mono ? "font-code-dense text-code-dense" : ""}`}
      >
        {value}
      </span>
    </div>
  );
}

function AddVendorDrawer({
  open,
  onClose,
  capabilitiesCatalog,
  workloadsCatalog,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  capabilitiesCatalog: CapabilityApi[];
  workloadsCatalog: WorkloadApi[];
  onSubmit: (payload: CreateVendorPayload) => Promise<void>;
}) {
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [vendorType, setVendorType] = useState("general_api");
  const [protocol, setProtocol] = useState("custom_rest");
  const [baseEndpoint, setBaseEndpoint] = useState("https://api.provider.com/v1");
  const [billingType, setBillingType] = useState("metered");
  const [capabilityIds, setCapabilityIds] = useState<Set<string>>(new Set());
  const [workloadIds, setWorkloadIds] = useState<Set<string>>(new Set());
  const [priority, setPriority] = useState(5);
  const [defaultTier, setDefaultTier] = useState(1);
  const [maxTier, setMaxTier] = useState(3);
  const [automaticFallback, setAutomaticFallback] = useState(true);
  const [timeoutMs, setTimeoutMs] = useState(30000);
  const [retryMaxAttempts, setRetryMaxAttempts] = useState(3);
  const [retryBackoffMs, setRetryBackoffMs] = useState(500);
  const [retryOnTimeout, setRetryOnTimeout] = useState(true);
  const [retryOnRateLimit, setRetryOnRateLimit] = useState(true);
  const [retryOn5xx, setRetryOn5xx] = useState(true);
  const [retryOnAuthFailure, setRetryOnAuthFailure] = useState(false);
  const [retryOnInvalidResponse, setRetryOnInvalidResponse] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  function toggle(set: Set<string>, setSet: (s: Set<string>) => void, id: string) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSet(next);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        slug,
        displayName,
        description: description || undefined,
        vendorType,
        protocol,
        baseEndpoint,
        billingType,
        priority,
        defaultTier,
        maxTier,
        automaticFallback,
        timeoutMs,
        retryMaxAttempts,
        retryBackoffMs,
        retryOnTimeout,
        retryOnRateLimit,
        retryOn5xx,
        retryOnAuthFailure,
        retryOnInvalidResponse,
        capabilityIds: Array.from(capabilityIds),
        workloadIds: Array.from(workloadIds),
      });
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "Failed to create vendor.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Add Vendor" subtitle="Configure a new inference provider for Inhouse.">
      <form className="flex flex-col gap-space-lg" onSubmit={handleSubmit}>
        {submitError && (
          <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm">
            {submitError}
          </div>
        )}

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={1} title="Basic Information" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <FormField label="Vendor Slug (stable identifier)">
              <TextInput
                value={slug}
                onChange={(e) => setSlug(e.target.value)}
                placeholder="e.g. my-inference-vendor"
                required
              />
            </FormField>
            <FormField label="Vendor Name">
              <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </FormField>
          </div>
          <FormField label="Description">
            <TextInput value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </FormField>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={2} title="Vendor Configuration" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <FormField label="Vendor Type">
              <Select value={vendorType} onChange={(e) => setVendorType(e.target.value)}>
                <option value="coding_plan">Coding Plan</option>
                <option value="payg">PAYG</option>
                <option value="general_api">General API</option>
                <option value="local">Local</option>
                <option value="custom">Custom</option>
              </Select>
            </FormField>
            <FormField label="API Protocol">
              <Select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="anthropic_compatible">Anthropic-compatible</option>
                <option value="custom_rest">Custom REST</option>
              </Select>
            </FormField>
            <FormField label="Base API Endpoint">
              <TextInput value={baseEndpoint} onChange={(e) => setBaseEndpoint(e.target.value)} className="text-primary" required />
            </FormField>
            <FormField label="Billing Type">
              <TextInput value={billingType} onChange={(e) => setBillingType(e.target.value)} />
            </FormField>
          </div>
          <div className="bg-surface p-space-sm flex items-start gap-space-xs">
            <Icon name="verified_user" className="text-tertiary" size={18} />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Vendor credentials are registered separately, after the vendor is created, as a{" "}
              <strong className="text-on-surface">reference to a secret vault entry</strong> — this form never asks
              for a provider API key or secret.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={3} title="Capabilities" />
          {capabilitiesCatalog.length === 0 ? (
            <div className="bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant text-center">
              No capabilities are defined in the Inhouse database yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
              {capabilitiesCatalog.map((cap) => (
                <label key={cap.id} className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer hover:bg-surface-container-high">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={capabilityIds.has(cap.id)}
                    onChange={() => toggle(capabilityIds, setCapabilityIds, cap.id)}
                  />
                  <span className="font-code-dense text-code-dense text-on-surface uppercase">{titleCase(cap.slug)}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={4} title="Allowed Workloads" />
          {workloadsCatalog.length === 0 ? (
            <div className="bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant text-center">
              No workloads are defined in the Inhouse database yet.
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-space-xs">
              {workloadsCatalog.map((w) => (
                <label key={w.id} className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer hover:bg-surface-container-high">
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={workloadIds.has(w.id)}
                    onChange={() => toggle(workloadIds, setWorkloadIds, w.id)}
                  />
                  <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">{w.slug}</span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={5} title="Priority & Tier" />
          <div className="flex flex-col gap-space-xs bg-surface p-space-sm">
            <div className="flex items-center justify-between">
              <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">
                Priority Rank (0 = Fallback, 10 = Primary)
              </span>
              <span className="font-headline-md text-headline-md font-bold text-primary">
                {String(priority).padStart(2, "0")}
              </span>
            </div>
            <input
              type="range"
              min={0}
              max={10}
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              className="w-full accent-primary"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <FormField label="Default Tier">
              <TextInput type="number" min={0} value={defaultTier} onChange={(e) => setDefaultTier(Number(e.target.value))} />
            </FormField>
            <FormField label="Max Tier">
              <TextInput type="number" min={0} value={maxTier} onChange={(e) => setMaxTier(Number(e.target.value))} />
            </FormField>
          </div>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={6} title="Retry & Timeout Configuration" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
            <FormField label="Timeout (ms)">
              <TextInput type="number" min={0} value={timeoutMs} onChange={(e) => setTimeoutMs(Number(e.target.value))} />
            </FormField>
            <FormField label="Retry Max Attempts">
              <TextInput
                type="number"
                min={0}
                value={retryMaxAttempts}
                onChange={(e) => setRetryMaxAttempts(Number(e.target.value))}
              />
            </FormField>
            <FormField label="Retry Backoff (ms)">
              <TextInput
                type="number"
                min={0}
                value={retryBackoffMs}
                onChange={(e) => setRetryBackoffMs(Number(e.target.value))}
              />
            </FormField>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-space-xs">
            <label className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={automaticFallback} onChange={(e) => setAutomaticFallback(e.target.checked)} />
              <span className="font-code-dense text-code-dense uppercase text-on-surface">Auto Fallback</span>
            </label>
            <label className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={retryOnTimeout} onChange={(e) => setRetryOnTimeout(e.target.checked)} />
              <span className="font-code-dense text-code-dense uppercase text-on-surface">Retry on Timeout</span>
            </label>
            <label className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={retryOnRateLimit} onChange={(e) => setRetryOnRateLimit(e.target.checked)} />
              <span className="font-code-dense text-code-dense uppercase text-on-surface">Retry on Rate Limit</span>
            </label>
            <label className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={retryOn5xx} onChange={(e) => setRetryOn5xx(e.target.checked)} />
              <span className="font-code-dense text-code-dense uppercase text-on-surface">Retry on 5xx</span>
            </label>
            <label className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer">
              <input type="checkbox" className="accent-primary" checked={retryOnAuthFailure} onChange={(e) => setRetryOnAuthFailure(e.target.checked)} />
              <span className="font-code-dense text-code-dense uppercase text-on-surface">Retry on Auth Failure</span>
            </label>
            <label className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary"
                checked={retryOnInvalidResponse}
                onChange={(e) => setRetryOnInvalidResponse(e.target.checked)}
              />
              <span className="font-code-dense text-code-dense uppercase text-on-surface">Retry on Invalid Response</span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-space-sm">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !slug || !displayName || !baseEndpoint}>
            <Icon name="add" size={16} />
            {submitting ? "Saving…" : "Add Vendor"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function SectionLabel({ n, title }: { n: number; title: string }) {
  return (
    <div className="flex items-center gap-space-xs">
      <span className="font-label-md text-label-md text-primary uppercase">Section {String(n).padStart(2, "0")}</span>
      <span className="font-headline-md text-headline-md text-on-surface font-bold">{title}</span>
    </div>
  );
}
