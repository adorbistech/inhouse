import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  ProviderHealthApi,
  ProviderVerificationApi,
  VendorAccountApi,
  VendorApi,
  VendorCredentialApi,
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

/**
 * Maps Block 09's observed provider-account health onto the same
 * `HealthState`/`StatusPill` the rest of this page already uses for
 * vendor status — a distinct concept (this is an *observation*, not an
 * operator's administrative status), reusing the existing visual
 * language rather than inventing a second one. `"unknown"` (never
 * checked — no adapter exists yet) renders the same as "disabled": a
 * neutral, non-alarming state, not a false "healthy".
 */
function providerHealthToState(status: ProviderHealthApi["status"]): HealthState {
  if (status === "healthy") return "healthy";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy") return "unreachable";
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

  const [credentials, setCredentials] = useState<VendorCredentialApi[]>([]);
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

  const refreshDetail = useCallback(async (id: string) => {
    setDetailLoading(true);
    setDetailError(null);
    try {
      const [{ vendor }, { credentials: creds }] = await Promise.all([
        api.getVendor(id),
        api.listCredentials(id),
      ]);
      setSelectedDetail(vendor);
      setCredentials(creds);
    } catch (error) {
      setDetailError(errorMessage(error));
      setSelectedDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) {
      setSelectedAccountId(null);
      refreshDetail(selectedId);
    } else {
      setSelectedDetail(null);
      setCredentials([]);
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
  const accountCredential = selectedAccount
    ? credentials.find((c) => c.vendorAccountId === selectedAccount.id)
    : undefined;

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
                    vendorId={selectedDetail.id}
                    adapterSupported={selectedDetail.adapterSupported}
                    vendorEnabled={selectedDetail.status === "enabled"}
                    accounts={selectedDetail.accounts}
                    selectedAccount={selectedAccount}
                    credential={accountCredential}
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

function VendorAccountsAndCredentials({
  vendorId,
  adapterSupported,
  vendorEnabled,
  accounts,
  selectedAccount,
  credential,
  onSelectAccount,
  onChanged,
  onError,
}: {
  vendorId: string;
  adapterSupported: boolean;
  vendorEnabled: boolean;
  accounts: VendorAccountApi[];
  selectedAccount: VendorAccountApi | undefined;
  credential: VendorCredentialApi | undefined;
  onSelectAccount: (id: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [addingAccount, setAddingAccount] = useState(false);
  const [newAccountSlug, setNewAccountSlug] = useState("");
  const [newAccountName, setNewAccountName] = useState("");
  const [registeringCredential, setRegisteringCredential] = useState(false);
  const [credentialType, setCredentialType] = useState("api_key");
  const [secretMode, setSecretMode] = useState<"managed" | "external">("managed");
  const [secret, setSecret] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [rotating, setRotating] = useState(false);
  const [rotateSecretMode, setRotateSecretMode] = useState<"managed" | "external">("managed");
  const [rotateSecret, setRotateSecret] = useState("");
  const [rotateSecretRef, setRotateSecretRef] = useState("");
  const [health, setHealth] = useState<ProviderHealthApi | null>(null);
  const [verifyingAccountId, setVerifyingAccountId] = useState<string | null>(null);
  const [verification, setVerification] = useState<ProviderVerificationApi | null>(null);
  const [healthRefreshFailedFor, setHealthRefreshFailedFor] = useState<string | null>(null);
  // Lets an in-flight verification tell whether its account is still the one on screen.
  const selectedAccountIdRef = useRef<string | undefined>(undefined);
  selectedAccountIdRef.current = selectedAccount?.id;
  const verifying = selectedAccount !== undefined && verifyingAccountId === selectedAccount.id;
  // Only ever show a result that belongs to the account currently selected.
  const shownVerification = verification && verification.vendorAccountId === selectedAccount?.id ? verification : null;

  useEffect(() => {
    if (!selectedAccount) {
      setHealth(null);
      return;
    }
    let cancelled = false;
    api
      .getAccountHealth(vendorId, selectedAccount.id)
      .then(({ health: h }) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {
        if (!cancelled) setHealth(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vendorId, selectedAccount]);

  async function verifySelectedAccount() {
    if (!selectedAccount) return;
    const accountId = selectedAccount.id;
    setVerifyingAccountId(accountId);
    setVerification(null);
    setHealthRefreshFailedFor(null);
    try {
      const { verification: result } = await api.verifyAccount(vendorId, accountId);
      setVerification(result);
      // A failed refresh must not turn a completed verification into a reported failure.
      try {
        const { health: refreshed } = await api.getAccountHealth(vendorId, accountId);
        if (selectedAccountIdRef.current === accountId) setHealth(refreshed);
      } catch {
        setHealthRefreshFailedFor(accountId);
      }
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Failed to verify account.");
    } finally {
      setVerifyingAccountId((current) => (current === accountId ? null : current));
    }
  }

  async function submitNewAccount() {
    try {
      await api.createAccount(vendorId, { slug: newAccountSlug, displayName: newAccountName });
      setAddingAccount(false);
      setNewAccountSlug("");
      setNewAccountName("");
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Failed to create account.");
    }
  }

  async function submitCredential() {
    if (!selectedAccount) return;
    try {
      await api.createCredential(
        vendorId,
        secretMode === "managed"
          ? { vendorAccountId: selectedAccount.id, credentialType, secret }
          : { vendorAccountId: selectedAccount.id, credentialType, secretRef },
      );
      setRegisteringCredential(false);
      // Never retain the raw secret in state any longer than it takes to submit it.
      setSecret("");
      setSecretRef("");
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Failed to register credential.");
    }
  }

  async function toggleCredentialStatus() {
    if (!credential) return;
    try {
      await api.updateCredential(vendorId, credential.id, {
        status: credential.status === "enabled" ? "disabled" : "enabled",
      });
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Failed to update credential status.");
    }
  }

  async function submitRotate() {
    if (!credential) return;
    try {
      await api.updateCredential(
        vendorId,
        credential.id,
        rotateSecretMode === "managed" ? { secret: rotateSecret } : { secretRef: rotateSecretRef },
      );
      setRotating(false);
      setRotateSecret("");
      setRotateSecretRef("");
      onChanged();
    } catch (error) {
      onError(error instanceof ApiError ? error.message : "Failed to rotate credential.");
    }
  }

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-space-sm">
        <div className="bg-surface p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
          No accounts configured for this vendor yet.
        </div>
        {!addingAccount ? (
          <Button variant="secondary" onClick={() => setAddingAccount(true)} className="self-start">
            <Icon name="add" size={16} />
            Add Account
          </Button>
        ) : (
          <NewAccountForm
            slug={newAccountSlug}
            name={newAccountName}
            onSlugChange={setNewAccountSlug}
            onNameChange={setNewAccountName}
            onCancel={() => setAddingAccount(false)}
            onSubmit={submitNewAccount}
          />
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-space-xs">
        <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">
          Vendor Account ({accounts.length} configured)
        </span>
        <div className="flex flex-wrap gap-space-xs items-center">
          {accounts.map((acct) => {
            const isActive = selectedAccount?.id === acct.id;
            return (
              <button
                key={acct.id}
                onClick={() => onSelectAccount(acct.id)}
                className={`flex items-center gap-space-xs px-space-sm py-1.5 border transition-colors ${
                  isActive
                    ? "bg-surface-container-highest border-primary text-on-surface"
                    : "bg-surface border-outline-variant text-on-surface-variant hover:text-on-surface"
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 ${
                    acct.status === "enabled" ? "bg-tertiary" : acct.status === "unavailable" ? "bg-error" : "bg-outline"
                  }`}
                />
                <span className="font-code-dense text-code-dense uppercase">{acct.displayName}</span>
              </button>
            );
          })}
          {!addingAccount && (
            <button
              onClick={() => setAddingAccount(true)}
              className="flex items-center gap-1 px-space-sm py-1.5 border border-dashed border-outline-variant text-on-surface-variant hover:text-on-surface"
            >
              <Icon name="add" size={14} />
              <span className="font-code-dense text-code-dense uppercase">Add Account</span>
            </button>
          )}
        </div>
        {addingAccount && (
          <NewAccountForm
            slug={newAccountSlug}
            name={newAccountName}
            onSlugChange={setNewAccountSlug}
            onNameChange={setNewAccountName}
            onCancel={() => setAddingAccount(false)}
            onSubmit={submitNewAccount}
          />
        )}
      </div>

      {selectedAccount && (
        <div className="flex flex-col gap-space-sm">
          <div className="flex flex-col gap-space-xs">
            <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">
              Account Health — {selectedAccount.displayName}
            </span>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-space-sm bg-surface p-space-sm">
              <StatusPill
                state={providerHealthToState(health?.status ?? "unknown")}
                detail={health && health.status !== "unknown" ? titleCase(health.status) : "Unknown — Not Checked"}
              />
              {health && health.status !== "unknown" && (
                <div className="flex flex-wrap items-center gap-space-sm font-code-dense text-code-dense text-on-surface-variant">
                  {health.lastLatencyMs !== null && <span>{health.lastLatencyMs}ms latency</span>}
                  {health.lastCheckedAt && <span>Checked {formatDateTime(health.lastCheckedAt)}</span>}
                  {health.lastErrorCategory && <span className="text-error">{titleCase(health.lastErrorCategory)}</span>}
                </div>
              )}
              <Button
                variant="secondary"
                onClick={verifySelectedAccount}
                disabled={verifying || !vendorEnabled || selectedAccount.status !== "enabled" || !adapterSupported}
              >
                {verifying ? "Verifying…" : "Verify Account"}
              </Button>
            </div>
            {shownVerification && (
              <div role="status" className="flex flex-wrap items-center gap-space-sm bg-surface p-space-sm font-code-dense text-code-dense text-on-surface-variant">
                <span className={shownVerification.status === "healthy" ? "text-tertiary" : "text-error"}>
                  Verification: {titleCase(shownVerification.status)}
                </span>
                <span>{shownVerification.message}</span>
                {shownVerification.errorCategory && <span>Category: {titleCase(shownVerification.errorCategory)}</span>}
                {shownVerification.safeErrorCode && <span>Code: {shownVerification.safeErrorCode}</span>}
                {shownVerification.latencyMs !== null && <span>{shownVerification.latencyMs}ms latency</span>}
                <span>Checked {formatDateTime(shownVerification.checkedAt)}</span>
                {healthRefreshFailedFor === shownVerification.vendorAccountId && (
                  <span>Verification completed, but the account health could not be refreshed.</span>
                )}
              </div>
            )}
          </div>
          {credential ? (
            <>
              <div className="flex flex-col gap-space-xs">
                <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">
                  Credential — {selectedAccount.displayName}
                </span>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-space-sm bg-surface p-space-sm">
                  <div className="flex items-center gap-space-sm">
                    <Icon name="key" className="text-primary" size={18} />
                    <span className="font-code-dense text-code-dense text-on-surface font-bold">
                      {credential.credentialType}: {credential.hasManagedSecret ? credential.maskedSecret : credential.secretRef}
                    </span>
                    {credential.hasManagedSecret && <Chip tone="secondary">Inhouse Vault</Chip>}
                    <Chip tone={credential.status === "enabled" ? "tertiary" : "error"}>{credential.status}</Chip>
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                <InfoTile label="Created" value={formatDateTime(credential.createdAt)} />
                <InfoTile label="Last Tested" value={credential.lastTestedAt ? formatDateTime(credential.lastTestedAt) : "Never"} />
                <InfoTile label="Last Successful" value={credential.lastSuccessfulAt ? formatDateTime(credential.lastSuccessfulAt) : "Never"} />
              </div>

              {rotating ? (
                <div className="flex flex-col gap-space-sm bg-surface p-space-sm">
                  <SecretModeToggle mode={rotateSecretMode} onChange={setRotateSecretMode} />
                  {rotateSecretMode === "managed" ? (
                    <FormField label="New Secret (encrypted by Inhouse before storage; never shown again)">
                      <TextInput
                        type="password"
                        autoComplete="off"
                        value={rotateSecret}
                        onChange={(e) => setRotateSecret(e.target.value)}
                        placeholder="Paste the new provider secret"
                      />
                    </FormField>
                  ) : (
                    <FormField label="New Secret Reference (vault path / ID — never the raw secret)">
                      <TextInput
                        value={rotateSecretRef}
                        onChange={(e) => setRotateSecretRef(e.target.value)}
                        placeholder="e.g. vault://inhouse/vendor-credentials/…"
                      />
                    </FormField>
                  )}
                  <div className="flex items-center gap-space-xs justify-end">
                    <Button
                      variant="secondary"
                      type="button"
                      onClick={() => {
                        setRotating(false);
                        setRotateSecret("");
                        setRotateSecretRef("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      type="button"
                      onClick={submitRotate}
                      disabled={rotateSecretMode === "managed" ? !rotateSecret : !rotateSecretRef}
                    >
                      Save New Secret
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-space-sm pt-space-xs">
                  <Button variant="secondary" onClick={() => setRotating(true)}>
                    <Icon name="autorenew" size={16} />
                    Rotate Secret
                  </Button>
                  <Button variant="secondary" onClick={toggleCredentialStatus}>
                    <Icon name={credential.status === "enabled" ? "toggle_off" : "toggle_on"} size={16} />
                    {credential.status === "enabled" ? "Disable" : "Enable"}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled
                    title={
                      adapterSupported
                        ? "A technical adapter exists for this vendor's protocol, but connection testing/execution is implemented in a later block."
                        : "No technical adapter is registered for this vendor's protocol yet, and connection testing/execution is implemented in a later block."
                    }
                  >
                    <Icon name="bolt" size={16} />
                    Test Connection (Not Yet Available)
                  </Button>
                  <Button
                    variant="destructive"
                    className="ml-auto"
                    onClick={async () => {
                      try {
                        await api.deleteCredential(vendorId, credential.id);
                        onChanged();
                      } catch (error) {
                        onError(error instanceof ApiError ? error.message : "Failed to remove credential.");
                      }
                    }}
                  >
                    <Icon name="delete" size={16} />
                    Remove
                  </Button>
                </div>
              )}
            </>
          ) : registeringCredential ? (
            <div className="flex flex-col gap-space-sm bg-surface p-space-sm">
              <FormField label="Credential Type">
                <TextInput value={credentialType} onChange={(e) => setCredentialType(e.target.value)} />
              </FormField>
              <SecretModeToggle mode={secretMode} onChange={setSecretMode} />
              {secretMode === "managed" ? (
                <FormField label="Secret (encrypted by Inhouse before storage; never shown again)">
                  <TextInput
                    type="password"
                    autoComplete="off"
                    value={secret}
                    onChange={(e) => setSecret(e.target.value)}
                    placeholder="Paste the provider secret"
                  />
                </FormField>
              ) : (
                <FormField label="Secret Reference (vault path / ID — never the raw secret)">
                  <TextInput
                    value={secretRef}
                    onChange={(e) => setSecretRef(e.target.value)}
                    placeholder="e.g. vault://inhouse/vendor-credentials/…"
                  />
                </FormField>
              )}
              <div className="flex items-center gap-space-xs justify-end">
                <Button
                  variant="secondary"
                  type="button"
                  onClick={() => {
                    setRegisteringCredential(false);
                    setSecret("");
                    setSecretRef("");
                  }}
                >
                  Cancel
                </Button>
                <Button
                  variant="primary"
                  type="button"
                  onClick={submitCredential}
                  disabled={secretMode === "managed" ? !secret : !secretRef}
                >
                  Save Credential
                </Button>
              </div>
            </div>
          ) : (
            <div className="bg-surface p-space-sm flex flex-col items-center gap-space-xs text-center">
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                No credential configured for this account.
              </span>
              <Button variant="secondary" onClick={() => setRegisteringCredential(true)}>
                <Icon name="key" size={16} />
                Add Credential
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/**
 * Chooses which of Block 08's two mutually-exclusive secret storage modes
 * a credential write uses: the recommended INHOUSE-managed vault (the
 * backend encrypts and stores the actual secret, AES-256-GCM — see
 * docs/CREDENTIAL_VAULT.md) or an external reference the operator already
 * manages elsewhere. Never both.
 */
function SecretModeToggle({
  mode,
  onChange,
}: {
  mode: "managed" | "external";
  onChange: (mode: "managed" | "external") => void;
}) {
  return (
    <div className="flex items-center gap-space-xs bg-surface-container-low p-1 self-start">
      {(
        [
          { key: "managed", label: "Inhouse Vault" },
          { key: "external", label: "External Reference" },
        ] as const
      ).map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          className={`font-code-dense text-code-dense uppercase px-space-sm py-1 transition-colors ${
            mode === option.key ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NewAccountForm({
  slug,
  name,
  onSlugChange,
  onNameChange,
  onCancel,
  onSubmit,
}: {
  slug: string;
  name: string;
  onSlugChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-space-xs bg-surface p-space-sm items-end">
      <FormField label="Slug" className="flex-1">
        <TextInput value={slug} onChange={(e) => onSlugChange(e.target.value)} placeholder="e.g. primary" />
      </FormField>
      <FormField label="Display Name" className="flex-1">
        <TextInput value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="e.g. Primary Account" />
      </FormField>
      <div className="flex items-center gap-space-xs shrink-0">
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="button" onClick={onSubmit} disabled={!slug || !name}>
          Save
        </Button>
      </div>
    </div>
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
