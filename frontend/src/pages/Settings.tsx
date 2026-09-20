import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Panel, PanelHeader } from "../components/ui/Panel";
import { Table } from "../components/ui/Table";
import { Drawer } from "../components/ui/Drawer";
import { FormField, Select, TextInput } from "../components/ui/FormField";
import { StatusPill } from "../components/ui/StatusPill";
import { Toggle } from "../components/ui/Toggle";
import { formatDateTime, titleCase } from "../lib/format";
import { adminToken, api, ApiError } from "../lib/api";
import type { HealthState } from "../types/domain";
import type {
  ApiKeyApi,
  CapabilityApi,
  CreateModelPayload,
  ModelApi,
  SystemHealthApi,
  UsageLedgerEntryApi,
  VendorApi,
  VendorStatus,
  WorkloadApi,
} from "../types/api";

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

const SETTINGS_TABS = [
  { key: "api", label: "API" },
  { key: "routing", label: "Routing" },
  { key: "models", label: "Models" },
  { key: "accounting", label: "Accounting" },
  { key: "system", label: "System" },
];

export function Settings() {
  const [tab, setTab] = useState("routing");

  return (
    <>
      <div>
        <span className="font-headline-lg text-headline-lg font-bold text-on-surface uppercase">Settings</span>
        <p className="font-body-md text-body-md text-on-surface-variant mt-1 max-w-xl">
          Configure Inhouse API routing, models, accounting and system behavior.
        </p>
      </div>

      <div className="flex items-center gap-space-xs flex-wrap bg-surface-container-low p-space-xs">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`font-label-md text-label-md uppercase px-space-md py-2 transition-colors ${
              tab === t.key ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {t.label} {t.key === "routing" && tab === "routing" && <span className="opacity-70">(Active)</span>}
          </button>
        ))}
      </div>

      {tab === "api" && <ApiTab />}
      {tab === "routing" && <RoutingTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "accounting" && <AccountingTab />}
      {tab === "system" && <SystemTab />}
    </>
  );
}

function ApiTab() {
  return (
    <div className="flex flex-col gap-space-md mb-space-lg">
      <Panel>
        <PanelHeader title="API & Endpoints" eyebrow="V1.2 PROTOCOL" />
        <div className="p-space-md flex flex-col gap-space-sm">
          <EndpointRow label="OpenAI Compatible" path="/v1/chat/completions" header="Header: Bearer <INHOUSE_KEY>" />
          <EndpointRow label="Anthropic Compatible" path="/v1/messages" header="Header: x-api-key <INHOUSE_KEY> (or Bearer)" />
          <div className="bg-surface-container-high p-space-sm flex items-start gap-space-xs">
            <Icon name="terminal" className="text-secondary" size={18} />
            <div className="font-body-sm text-body-sm text-on-surface-variant">
              <div className="text-on-surface font-bold">Developer / Claude Code Setup</div>
              <div className="font-code-dense text-code-dense mt-1">
                export ANTHROPIC_BASE_URL=&lt;INHOUSE_API_ORIGIN&gt;
                <br />
                export ANTHROPIC_AUTH_TOKEN=&lt;INHOUSE_KEY&gt;
                <br />
                export ANTHROPIC_CUSTOM_HEADERS="x-inhouse-workload-id: &lt;WORKLOAD_ID&gt;"
              </div>
              <div className="mt-1">
                The workload is always explicit — a header or a <code className="font-code-dense">workloadId</code>{" "}
                body field — and a key can only use the workloads it was granted below.
              </div>
            </div>
          </div>
          <div className="bg-surface p-space-sm flex items-start gap-space-xs">
            <Icon name="info" className="text-secondary shrink-0" size={18} />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Both endpoints support streaming (<code className="font-code-dense">"stream": true</code>) and
              client-defined tool calls. Images, documents and server-side tools are not supported and are
              rejected rather than ignored.
            </p>
          </div>
        </div>
      </Panel>

      <ApiKeysPanel />
    </div>
  );
}

/**
 * Real Inhouse execution-key management (Block 12) — a separate credential
 * class from vendor credentials (Block 08): these keys authenticate a
 * client to Inhouse's execution endpoints, never a provider directly. The
 * raw key is shown exactly once, right after creation (`api.createApiKey`'s
 * one-time `rawKey`), and never requested or displayed again afterward.
 */
function ApiKeysPanel() {
  const [keys, setKeys] = useState<ApiKeyApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [revealedKey, setRevealedKey] = useState<{ name: string; rawKey: string } | null>(null);
  const [workloads, setWorkloads] = useState<WorkloadApi[]>([]);
  const [selectedWorkloadIds, setSelectedWorkloadIds] = useState<Set<string>>(new Set());
  const [tokenInput, setTokenInput] = useState("");
  const [hasAdminToken, setHasAdminToken] = useState(() => adminToken.get() !== null);

  const refresh = useCallback(async () => {
    try {
      const { apiKeys } = await api.listApiKeys();
      setKeys(apiKeys);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    api
      .listWorkloads()
      .then(({ workloads: list }) => setWorkloads(list))
      .catch(() => setWorkloads([]));
  }, []);

  function saveAdminToken(e: React.FormEvent) {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    adminToken.set(tokenInput.trim());
    setTokenInput("");
    setHasAdminToken(true);
    refresh();
  }

  function clearAdminToken() {
    adminToken.clear();
    setHasAdminToken(false);
    setKeys(null);
  }

  function toggleWorkload(id: string) {
    const next = new Set(selectedWorkloadIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedWorkloadIds(next);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    setCreating(true);
    try {
      const { apiKey, rawKey } = await api.createApiKey({ name, workloadIds: [...selectedWorkloadIds] });
      setRevealedKey({ name: apiKey.name, rawKey });
      setName("");
      setSelectedWorkloadIds(new Set());
      await refresh();
    } catch (error) {
      setCreateError(error instanceof ApiError ? error.message : "Failed to create API key.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(key: ApiKeyApi) {
    try {
      await api.revokeApiKey(key.id);
      await refresh();
    } catch (error) {
      setListError(errorMessage(error));
    }
  }

  return (
    <Panel className="mb-space-lg">
      <PanelHeader title="Inhouse Access Tokens" eyebrow={keys ? `${keys.length} ISSUED` : undefined} />
      <p className="px-space-md pt-space-sm font-body-sm text-body-sm text-on-surface-variant">
        Client-facing credentials for the execution endpoints above. A separate credential class from vendor
        credentials — never used to authenticate against a provider directly, and never able to read a provider
        secret.
      </p>

      <div className="p-space-md flex flex-col gap-space-sm">
        <form onSubmit={saveAdminToken} className="flex flex-col sm:flex-row items-end gap-space-xs bg-surface p-space-sm">
          <FormField label={hasAdminToken ? "Admin Token (set for this tab)" : "Admin Token"} className="flex-1">
            <TextInput
              type="password"
              autoComplete="off"
              value={tokenInput}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder={hasAdminToken ? "Enter a new token to replace it" : "INHOUSE_ADMIN_TOKEN"}
            />
          </FormField>
          <Button type="submit" variant="secondary" disabled={!tokenInput.trim()}>
            Use Token
          </Button>
          {hasAdminToken && (
            <Button type="button" variant="secondary" onClick={clearAdminToken}>
              Forget
            </Button>
          )}
        </form>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Every control-plane page (vendors, models, routing, keys, usage) requires the server's administrative token.
          It is kept in this browser tab's session only and is sent only to the Inhouse API.
        </p>

        {revealedKey && (
          <div className="bg-tertiary/10 border border-tertiary p-space-sm flex flex-col gap-space-xs">
            <div className="flex items-center justify-between">
              <span className="font-label-md text-label-md text-tertiary uppercase">
                "{revealedKey.name}" — shown once, copy it now
              </span>
              <button onClick={() => setRevealedKey(null)} aria-label="Dismiss">
                <Icon name="close" size={16} />
              </button>
            </div>
            <span className="font-code-dense text-code-dense text-on-surface break-all">{revealedKey.rawKey}</span>
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              Inhouse never stores or displays the raw key again after this.
            </span>
          </div>
        )}

        <form onSubmit={handleCreate} className="flex flex-col gap-space-xs bg-surface p-space-sm">
          <div className="flex flex-col sm:flex-row items-end gap-space-xs">
            <FormField label="New Key Name" className="flex-1">
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. claude-code-dev" required />
            </FormField>
            <Button type="submit" variant="primary" disabled={creating || !name.trim() || selectedWorkloadIds.size === 0}>
              <Icon name="add" size={16} />
              {creating ? "Creating…" : "Create Key"}
            </Button>
          </div>
          <fieldset className="flex flex-col gap-space-xs">
            <legend className="font-label-md text-label-md text-on-surface-variant uppercase">
              Allowed workloads (a key can use nothing it is not granted)
            </legend>
            {workloads.length === 0 ? (
              <span className="font-body-sm text-body-sm text-on-surface-variant">No workloads are configured yet.</span>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
                {workloads.map((w) => (
                  <label key={w.id} className="flex items-center gap-2 bg-surface-container-high p-space-sm cursor-pointer">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={selectedWorkloadIds.has(w.id)}
                      onChange={() => toggleWorkload(w.id)}
                    />
                    <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">{w.slug}</span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </form>
        {createError && <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm">{createError}</div>}

        {listError && (
          <div className="flex flex-col items-center gap-space-sm text-center">
            <span className="font-body-sm text-body-sm text-error">{listError}</span>
            <Button variant="secondary" onClick={() => refresh()}>
              Retry
            </Button>
          </div>
        )}
        {!listError && keys === null && (
          <div className="text-center font-body-sm text-body-sm text-on-surface-variant">Loading…</div>
        )}
        {!listError && keys !== null && keys.length === 0 && (
          <div className="bg-surface p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
            No access tokens issued yet.
          </div>
        )}
        {!listError && keys !== null && keys.length > 0 && (
          <Table
            rowKey={(k) => k.id}
            rows={keys}
            columns={[
              { header: "Name", render: (k) => <span className="text-on-surface font-bold">{k.name}</span> },
              { header: "Key ID", render: (k) => <span className="font-code-dense text-code-dense text-on-surface-variant">{k.keyId}</span> },
              { header: "Status", render: (k) => <Chip tone={k.status === "active" ? "tertiary" : "error"}>{k.status}</Chip> },
              {
                header: "Workloads",
                render: (k) =>
                  k.workloadIds.length === 0 ? (
                    <span className="text-error">none — cannot execute</span>
                  ) : (
                    <span className="font-code-dense text-code-dense text-on-surface-variant">
                      {k.workloadIds.map((id) => workloads.find((w) => w.id === id)?.slug ?? "unknown").join(", ")}
                    </span>
                  ),
              },
              { header: "Last Used", render: (k) => <span className="text-on-surface-variant">{k.lastUsedAt ? formatDateTime(k.lastUsedAt) : "Never"}</span> },
              { header: "Created", render: (k) => <span className="text-on-surface-variant">{formatDateTime(k.createdAt)}</span> },
              {
                header: "Actions",
                render: (k) =>
                  k.status === "active" ? (
                    <Button variant="destructive" className="px-space-sm py-1" onClick={() => handleRevoke(k)}>
                      Revoke
                    </Button>
                  ) : (
                    <span className="font-code-dense text-code-dense text-outline">—</span>
                  ),
              },
            ]}
          />
        )}
      </div>
    </Panel>
  );
}

function EndpointRow({ label, path, header }: { label: string; path: string; header: string }) {
  return (
    <div className="bg-surface p-space-sm flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs">
      <div>
        <div className="font-body-md text-body-md text-on-surface font-bold">{label}</div>
        <div className="font-code-dense text-code-dense text-primary">{path}</div>
        <div className="font-code-dense text-code-dense text-on-surface-variant">{header}</div>
      </div>
      <Button variant="secondary" className="px-space-sm py-1 shrink-0">
        <Icon name="content_copy" size={14} />
        Copy
      </Button>
    </div>
  );
}

/**
 * Every row here comes straight from `api.listVendors()` (Block 06) — the
 * per-vendor priority/fallback/retry fields it already persists. There is
 * no fabricated multi-tier "ladder": routing EXECUTION (which vendor
 * actually serves a given request) is implemented in a later block, so
 * this tab only ever displays and edits configuration, ordered by the
 * priority operators have set on the Vendors page.
 */
function RoutingTab() {
  const [vendors, setVendors] = useState<VendorApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { vendors: rows } = await api.listVendors();
      setVendors(rows);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const ordered = useMemo(() => [...(vendors ?? [])].sort((a, b) => b.priority - a.priority), [vendors]);

  if (listError) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center mb-space-lg">
        <Icon name="error" className="text-error" size={28} />
        <span className="font-headline-md text-headline-md font-bold text-on-surface">Failed to load routing configuration</span>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">{listError}</p>
        <Button variant="secondary" onClick={() => refresh()}>
          <Icon name="refresh" size={16} />
          Retry
        </Button>
      </div>
    );
  }

  if (vendors === null) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center mb-space-lg">
        <Icon name="hourglass_top" className="text-primary animate-pulse" size={28} />
        <span className="font-body-md text-body-md text-on-surface-variant">Loading routing configuration…</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-space-md mb-space-lg">
      <Panel>
        <PanelHeader title="Priority-Ordered Provider Configuration" eyebrow={`${ordered.length} CONFIGURED`} />
        <div className="p-space-md flex flex-col gap-space-sm">
          <div className="bg-surface-container-high p-space-sm flex items-start gap-space-xs">
            <Icon name="info" className="text-secondary shrink-0" size={18} />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Routing execution (which vendor actually serves a request) is implemented in a later block. This tab
              displays the per-vendor priority and fallback configuration Block 06 persists, ordered highest
              priority first — edit a vendor's settings on the Vendors page.
            </p>
          </div>
          {ordered.length === 0 ? (
            <div className="bg-surface p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
              No vendors configured yet.
            </div>
          ) : (
            ordered.map((v) => (
              <div key={v.id} className="bg-surface p-space-sm flex flex-col gap-space-xs">
                <div className="flex items-center justify-between flex-wrap gap-space-xs">
                  <div className="flex items-center gap-space-xs">
                    <span className="font-body-md text-body-md text-on-surface font-bold">{v.displayName}</span>
                    <StatusPill state={vendorStatusToHealthState(v.status)} detail={titleCase(v.status)} />
                  </div>
                  <div className="flex items-center gap-space-xs">
                    <Chip>{titleCase(v.protocol)}</Chip>
                    <Chip tone="primary">Priority {v.priority} / 10</Chip>
                    {v.automaticFallback && <Chip tone="tertiary">Auto-Fallback</Chip>}
                  </div>
                </div>
                <div className="font-code-dense text-code-dense text-on-surface-variant flex flex-wrap gap-space-sm">
                  <span>Timeout: {v.timeoutMs ?? "—"}ms</span>
                  <span>Retry attempts: {v.retryMaxAttempts ?? "—"}</span>
                  <span>Retry backoff: {v.retryBackoffMs ?? "—"}ms</span>
                </div>
                <div className="font-code-dense text-code-dense text-outline flex flex-wrap gap-space-sm">
                  {(
                    [
                      ["Timeout", v.retryOnTimeout],
                      ["Rate Limit", v.retryOnRateLimit],
                      ["5xx", v.retryOn5xx],
                      ["Auth Failure", v.retryOnAuthFailure],
                      ["Invalid Response", v.retryOnInvalidResponse],
                    ] as [string, boolean][]
                  )
                    .filter(([, enabled]) => enabled)
                    .map(([label]) => (
                      <span key={label} className="text-tertiary">
                        Retry on {label}
                      </span>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      </Panel>
    </div>
  );
}

function ModelsTab() {
  const [models, setModels] = useState<ModelApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [realVendors, setRealVendors] = useState<VendorApi[]>([]);
  const [capabilitiesCatalog, setCapabilitiesCatalog] = useState<CapabilityApi[]>([]);
  const [workloadsCatalog, setWorkloadsCatalog] = useState<WorkloadApi[]>([]);
  const [modelCapabilities, setModelCapabilities] = useState<Record<string, CapabilityApi[]>>({});

  const [vendorFilter, setVendorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<"" | "enabled" | "disabled">("");
  const [search, setSearch] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const refreshModels = useCallback(async () => {
    try {
      const { models: rows } = await api.listModels({
        vendorId: vendorFilter || undefined,
        status: statusFilter || undefined,
        search: search || undefined,
      });
      setModels(rows);
      setListError(null);

      const detailEntries = await Promise.all(
        rows.map(async (m) => {
          try {
            const { model } = await api.getModel(m.id);
            return [m.id, model.capabilities] as const;
          } catch {
            return [m.id, []] as const;
          }
        }),
      );
      setModelCapabilities(Object.fromEntries(detailEntries));
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, [vendorFilter, statusFilter, search]);

  useEffect(() => {
    refreshModels();
  }, [refreshModels]);

  useEffect(() => {
    api
      .listVendors()
      .then(({ vendors: rows }) => setRealVendors(rows))
      .catch(() => setRealVendors([]));
    api
      .listCapabilities()
      .then(({ capabilities }) => setCapabilitiesCatalog(capabilities))
      .catch(() => setCapabilitiesCatalog([]));
    api
      .listWorkloads()
      .then(({ workloads }) => setWorkloadsCatalog(workloads))
      .catch(() => setWorkloadsCatalog([]));
  }, []);

  const vendorNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const v of realVendors) map.set(v.id, v.displayName);
    return map;
  }, [realVendors]);

  async function handleToggleStatus(model: ModelApi) {
    setActionError(null);
    try {
      if (model.status === "enabled") {
        await api.disableModel(model.id);
      } else {
        await api.enableModel(model.id);
      }
      await refreshModels();
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function handleAddModel(payload: CreateModelPayload) {
    await api.createModel(payload);
    await refreshModels();
    setDrawerOpen(false);
  }

  if (listError) {
    return (
      <Panel className="mb-space-lg">
        <div className="p-space-lg flex flex-col items-center gap-space-sm text-center">
          <Icon name="error" className="text-error" size={28} />
          <span className="font-headline-md text-headline-md font-bold text-on-surface">Failed to load models</span>
          <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">{listError}</p>
          <Button variant="secondary" onClick={() => refreshModels()}>
            <Icon name="refresh" size={16} />
            Retry
          </Button>
        </div>
      </Panel>
    );
  }

  if (models === null) {
    return (
      <Panel className="mb-space-lg">
        <div className="p-space-lg flex flex-col items-center gap-space-sm text-center">
          <Icon name="hourglass_top" className="text-primary animate-pulse" size={28} />
          <span className="font-body-md text-body-md text-on-surface-variant">Loading models…</span>
        </div>
      </Panel>
    );
  }

  return (
    <div className="flex flex-col gap-space-sm mb-space-lg">
      {actionError && (
        <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm flex items-center justify-between gap-space-sm">
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} aria-label="Dismiss">
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Model Catalog"
          eyebrow={`${models.length} MODELS`}
          right={
            <Button variant="primary" className="px-space-sm py-1" onClick={() => setDrawerOpen(true)}>
              <Icon name="add" size={14} />
              Add Model
            </Button>
          }
        />
        <div className="p-space-sm flex flex-wrap items-center gap-space-xs bg-surface-container-low">
          <Select value={vendorFilter} onChange={(e) => setVendorFilter(e.target.value)} className="py-1">
            <option value="">All Vendors</option>
            {realVendors.map((v) => (
              <option key={v.id} value={v.id}>
                {v.displayName}
              </option>
            ))}
          </Select>
          <Select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as "" | "enabled" | "disabled")}
            className="py-1"
          >
            <option value="">All Statuses</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </Select>
          <TextInput
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search alias, display name, provider model id…"
            className="flex-1 min-w-[200px] py-1"
          />
        </div>
        {models.length === 0 ? (
          <div className="p-space-lg text-center flex flex-col items-center gap-space-sm">
            <Icon name="deployed_code" className="text-outline-variant" size={28} />
            <span className="font-body-sm text-body-sm text-on-surface-variant">
              No models match the current filters, or none are configured yet. Use "Add Model" to register the first
              one.
            </span>
          </div>
        ) : (
          <Table
            rowKey={(m) => m.id}
            rows={models}
            columns={[
              { header: "Model", render: (m) => <span className="text-on-surface font-bold">{m.displayName}</span> },
              {
                header: "Vendor",
                render: (m) => (
                  <span className="text-on-surface-variant">{vendorNameById.get(m.vendorId) ?? m.vendorId}</span>
                ),
              },
              {
                header: "Provider Model ID",
                render: (m) => <span className="font-code-dense text-code-dense text-on-surface-variant">{m.providerModelId}</span>,
              },
              {
                header: "Inhouse Alias",
                render: (m) => <span className="font-code-dense text-code-dense text-primary">{m.inhouseAlias}</span>,
              },
              {
                header: "Context",
                render: (m) => (
                  <span className="text-on-surface-variant">
                    {m.contextWindow ? `${(m.contextWindow / 1000).toFixed(0)}K` : "—"}
                  </span>
                ),
              },
              {
                header: "Capabilities",
                render: (m) => (
                  <div className="flex flex-wrap gap-1">
                    {(modelCapabilities[m.id] ?? []).map((c) => (
                      <Chip key={c.id}>{titleCase(c.slug)}</Chip>
                    ))}
                  </div>
                ),
              },
              {
                header: "Status",
                render: (m) => <Chip tone={m.status === "enabled" ? "tertiary" : "error"}>{m.status}</Chip>,
              },
              {
                header: "Actions",
                render: (m) => (
                  <Button
                    variant="secondary"
                    className="px-space-sm py-1"
                    onClick={() => handleToggleStatus(m)}
                  >
                    {m.status === "enabled" ? "Disable" : "Enable"}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Panel>

      <AddModelDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        vendors={realVendors}
        capabilitiesCatalog={capabilitiesCatalog}
        workloadsCatalog={workloadsCatalog}
        onSubmit={handleAddModel}
      />
    </div>
  );
}

function AddModelDrawer({
  open,
  onClose,
  vendors: vendorOptions,
  capabilitiesCatalog,
  workloadsCatalog,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  vendors: VendorApi[];
  capabilitiesCatalog: CapabilityApi[];
  workloadsCatalog: WorkloadApi[];
  onSubmit: (payload: CreateModelPayload) => Promise<void>;
}) {
  const [vendorId, setVendorId] = useState("");
  const [providerModelId, setProviderModelId] = useState("");
  const [inhouseAlias, setInhouseAlias] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [contextWindow, setContextWindow] = useState<number | "">("");
  const [status, setStatus] = useState<"enabled" | "disabled">("enabled");
  const [capabilityIds, setCapabilityIds] = useState<Set<string>>(new Set());
  const [workloadIds, setWorkloadIds] = useState<Set<string>>(new Set());
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
        vendorId,
        providerModelId,
        inhouseAlias,
        displayName,
        contextWindow: contextWindow === "" ? undefined : contextWindow,
        status,
        capabilityIds: Array.from(capabilityIds),
        workloadIds: Array.from(workloadIds),
      });
      setVendorId("");
      setProviderModelId("");
      setInhouseAlias("");
      setDisplayName("");
      setContextWindow("");
      setCapabilityIds(new Set());
      setWorkloadIds(new Set());
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : "Failed to create model.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Drawer open={open} onClose={onClose} title="Add Model" subtitle="Register a model that belongs to an existing vendor.">
      <form className="flex flex-col gap-space-lg" onSubmit={handleSubmit}>
        {submitError && (
          <div className="bg-error/10 border border-error text-error p-space-sm font-body-sm text-body-sm">
            {submitError}
          </div>
        )}

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <FormField label="Vendor">
            <Select value={vendorId} onChange={(e) => setVendorId(e.target.value)} required>
              <option value="" disabled>
                {vendorOptions.length === 0 ? "No vendors configured yet" : "Select a vendor…"}
              </option>
              {vendorOptions.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.displayName}
                </option>
              ))}
            </Select>
          </FormField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <FormField label="Provider Model ID">
              <TextInput
                value={providerModelId}
                onChange={(e) => setProviderModelId(e.target.value)}
                placeholder="the identifier the vendor understands"
                required
              />
            </FormField>
            <FormField label="Inhouse Alias">
              <TextInput
                value={inhouseAlias}
                onChange={(e) => setInhouseAlias(e.target.value)}
                placeholder="the stable identifier Inhouse exposes"
                required
              />
            </FormField>
            <FormField label="Display Name">
              <TextInput value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
            </FormField>
            <FormField label="Context Window (tokens)">
              <TextInput
                type="number"
                min={0}
                value={contextWindow}
                onChange={(e) => setContextWindow(e.target.value === "" ? "" : Number(e.target.value))}
              />
            </FormField>
          </div>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <span className="font-label-md text-label-md text-primary uppercase">Capabilities</span>
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
          <span className="font-label-md text-label-md text-primary uppercase">Workloads</span>
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
          <label className="flex items-center justify-between bg-surface p-space-sm cursor-pointer">
            <span className="font-code-dense text-code-dense uppercase text-on-surface">Enabled</span>
            <Toggle checked={status === "enabled"} onChange={(checked) => setStatus(checked ? "enabled" : "disabled")} />
          </label>
        </div>

        <div className="flex items-center justify-end gap-space-sm">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={submitting || !vendorId || !providerModelId || !inhouseAlias || !displayName}>
            <Icon name="add" size={16} />
            {submitting ? "Saving…" : "Add Model"}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

function AccountingTab() {
  const [vendors, setVendors] = useState<VendorApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { vendors: rows } = await api.listVendors();
      setVendors(rows);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-space-md mb-space-lg">
      <UsageLedgerPanel />

      <Panel className="mb-space-lg">
        <PanelHeader title="Configured Billing Types" eyebrow={vendors ? `${vendors.length} VENDORS` : undefined} />
        {listError && (
          <div className="p-space-md flex flex-col items-center gap-space-sm text-center">
            <span className="font-body-sm text-body-sm text-error">{listError}</span>
            <Button variant="secondary" onClick={() => refresh()}>
              Retry
            </Button>
          </div>
        )}
        {!listError && vendors === null && (
          <div className="p-space-md text-center font-body-sm text-body-sm text-on-surface-variant">Loading…</div>
        )}
        {!listError && vendors !== null && vendors.length === 0 && (
          <div className="p-space-md text-center font-body-sm text-body-sm text-on-surface-variant">
            No vendors configured yet.
          </div>
        )}
        {!listError && vendors !== null && vendors.length > 0 && (
          <Table
            rowKey={(v) => v.id}
            rows={vendors}
            columns={[
              { header: "Provider", render: (v) => <span className="text-on-surface font-bold">{v.displayName}</span> },
              { header: "Billing Type", render: (v) => <span className="text-on-surface-variant">{titleCase(v.billingType)}</span> },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}

/**
 * Real execution/usage telemetry (Block 12) from `GET /v1/usage` — one row
 * per execution the API actually attempted (never per retry/fallback
 * attempt — see `attemptCount`/`isFallback`). `providerCost`/`inhouseCost`
 * are shown as "—" rather than a fabricated `$0.00`: no pricing
 * configuration exists anywhere in Inhouse yet, so this panel never
 * invents a dollar figure.
 */
function UsageLedgerPanel() {
  const [entries, setEntries] = useState<UsageLedgerEntryApi[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { usage } = await api.listUsage(50);
      setEntries(usage);
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <Panel>
      <PanelHeader
        title="Execution & Usage Ledger"
        eyebrow={entries ? `${entries.length} RECENT` : undefined}
        right={
          <Button variant="secondary" className="px-space-sm py-1" onClick={() => refresh()}>
            <Icon name="refresh" size={14} />
            Refresh
          </Button>
        }
      />
      <div className="p-space-md flex flex-col gap-space-sm">
        <div className="bg-surface p-space-sm flex items-start gap-space-xs">
          <Icon name="info" className="text-secondary shrink-0" size={18} />
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Provider/Inhouse cost columns show "—" until a pricing configuration exists — Inhouse never estimates or
            fabricates a dollar figure.
          </p>
        </div>

        {listError && (
          <div className="flex flex-col items-center gap-space-sm text-center">
            <span className="font-body-sm text-body-sm text-error">{listError}</span>
            <Button variant="secondary" onClick={() => refresh()}>
              Retry
            </Button>
          </div>
        )}
        {!listError && entries === null && (
          <div className="text-center font-body-sm text-body-sm text-on-surface-variant">Loading…</div>
        )}
        {!listError && entries !== null && entries.length === 0 && (
          <div className="bg-surface p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
            No executions recorded yet.
          </div>
        )}
        {!listError && entries !== null && entries.length > 0 && (
          <Table
            rowKey={(e) => e.id}
            rows={entries}
            columns={[
              {
                header: "Execution",
                render: (e) => <span className="font-code-dense text-code-dense text-primary">{e.executionId.slice(0, 8)}</span>,
              },
              {
                header: "Status",
                render: (e) => (
                  <Chip tone={e.status === "success" ? "tertiary" : "error"}>{e.status === "success" ? "Success" : e.errorCategory ?? "Error"}</Chip>
                ),
              },
              {
                header: "Attempts",
                render: (e) => (
                  <span className="text-on-surface-variant">
                    {e.attemptCount}
                    {e.isFallback && (
                      <Chip tone="primary" className="ml-1">
                        Fallback
                      </Chip>
                    )}
                  </span>
                ),
              },
              {
                header: "Tokens (in/out)",
                render: (e) => (
                  <span className="font-code-dense text-code-dense text-on-surface-variant">
                    {e.inputTokens ?? "—"} / {e.outputTokens ?? "—"}
                  </span>
                ),
              },
              { header: "Latency", render: (e) => <span className="text-on-surface-variant">{e.latencyMs !== null ? `${e.latencyMs}ms` : "—"}</span> },
              { header: "Provider Cost", render: () => <span className="text-outline">—</span> },
              { header: "Inhouse Cost", render: () => <span className="text-outline">—</span> },
              { header: "Created", render: (e) => <span className="text-on-surface-variant">{formatDateTime(e.createdAt)}</span> },
            ]}
          />
        )}
      </div>
    </Panel>
  );
}

/** Every row here comes from the real `GET /v1/health` liveness check — never fabricated. */
function SystemTab() {
  const [health, setHealth] = useState<SystemHealthApi | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.getSystemHealth();
      setHealth(result);
      setHealthError(null);
    } catch (error) {
      setHealthError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="flex flex-col gap-space-md mb-space-lg">
      <Panel>
        <PanelHeader title="System Status" eyebrow="LIVE FROM /v1/health" />
        {healthError && (
          <div className="p-space-md flex flex-col items-center gap-space-sm text-center">
            <span className="font-body-sm text-body-sm text-error">{healthError}</span>
            <Button variant="secondary" onClick={() => refresh()}>
              Retry
            </Button>
          </div>
        )}
        {!healthError && health === null && (
          <div className="p-space-md text-center font-body-sm text-body-sm text-on-surface-variant">Checking…</div>
        )}
        {!healthError && health !== null && (
          <div className="p-space-md grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <StatusRow label="Status" value={health.status === "ok" ? "OK" : health.status} ok={health.status === "ok"} />
            <StatusRow label="Environment" value={health.environment} ok />
            <StatusRow label="Service" value={health.service} ok />
            <StatusRow label="Platform" value={health.platform} ok />
            <StatusRow label="Last Checked" value={formatDateTime(health.timestamp)} ok />
          </div>
        )}
      </Panel>

      <Panel className="mb-space-lg">
        <PanelHeader title="Audit Log" eyebrow="NOT YET AVAILABLE" />
        <div className="p-space-md flex items-start gap-space-xs">
          <Icon name="info" className="text-secondary shrink-0" size={18} />
          <p className="font-body-sm text-body-sm text-on-surface-variant">
            Audit event capture and the audit log feed are implemented in a later block. No events are displayed
            here yet.
          </p>
        </div>
      </Panel>
    </div>
  );
}

function StatusRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="bg-surface p-space-sm flex items-center justify-between">
      <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">{label}</span>
      <span className={`font-body-md text-body-md font-bold ${ok ? "text-tertiary" : "text-error"}`}>{value}</span>
    </div>
  );
}
