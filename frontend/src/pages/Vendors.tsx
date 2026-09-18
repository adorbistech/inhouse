import { useMemo, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { StatusPill } from "../components/ui/StatusPill";
import { Panel } from "../components/ui/Panel";
import { Tabs } from "../components/ui/Tabs";
import { Table } from "../components/ui/Table";
import { Drawer } from "../components/ui/Drawer";
import { FormField, Select, TextInput } from "../components/ui/FormField";
import { vendors as initialVendors } from "../data/mockData";
import { formatCompactNumber, formatDateTime, formatRelative, formatUsd, titleCase } from "../lib/format";
import type { HealthState, Vendor } from "../types/domain";

const STATUS_FILTERS: { key: "all" | HealthState; label: string }[] = [
  { key: "all", label: "All Statuses" },
  { key: "healthy", label: "Healthy" },
  { key: "degraded", label: "Degraded" },
  { key: "disabled", label: "Disabled" },
];

const DETAIL_TABS = [
  { key: "overview", label: "Overview" },
  { key: "credential", label: "Credential" },
  { key: "models", label: "Models" },
  { key: "capabilities", label: "Capabilities" },
  { key: "routing", label: "Routing" },
  { key: "health", label: "Health" },
  { key: "usage", label: "Usage" },
];

const CAPABILITY_OPTIONS = [
  "streaming",
  "tool_calling",
  "vision",
  "multimodal",
  "reasoning",
  "json_output",
  "prompt_caching",
  "web_search",
] as const;

const WORKLOAD_OPTIONS = ["coding_agent", "application_api", "automation", "research", "internal"] as const;

export function Vendors() {
  const [vendors] = useState<Vendor[]>(initialVendors);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | HealthState>("all");
  const [selectedId, setSelectedId] = useState(vendors[0]?.id ?? "");
  const [activeTab, setActiveTab] = useState("credential");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return vendors.filter((v) => {
      const matchesQuery =
        !query ||
        v.name.toLowerCase().includes(query.toLowerCase()) ||
        v.protocol.toLowerCase().includes(query.toLowerCase()) ||
        v.planType.toLowerCase().includes(query.toLowerCase());
      const matchesStatus = statusFilter === "all" || v.health.state === statusFilter;
      return matchesQuery && matchesStatus;
    });
  }, [vendors, query, statusFilter]);

  const selected = vendors.find((v) => v.id === selectedId) ?? vendors[0];
  const selectedAccount =
    selected?.accounts.find((a) => a.id === selectedAccountId) ?? selected?.accounts[0];

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
              Manage AI inference providers, credentials, models and capabilities.
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
            placeholder="Search vendors by name, protocol, type (e.g. coding_plan)…"
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
                    f.key === "healthy" ? "bg-tertiary" : f.key === "degraded" ? "bg-secondary" : "bg-outline"
                  }`}
                />
              )}
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Vendor cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-space-xs">
        {filtered.map((v) => {
          const barColor =
            v.health.state === "healthy"
              ? "bg-tertiary"
              : v.health.state === "degraded"
                ? "bg-secondary"
                : "bg-outline";
          const isSelected = v.id === selectedId;
          return (
            <div
              key={v.id}
              className={`flex flex-col relative cursor-pointer transition-colors ${
                v.health.state === "disabled" || v.health.state === "unreachable"
                  ? "bg-surface-container-low/60 opacity-75"
                  : "bg-surface-container-low"
              } ${isSelected ? "outline outline-1 outline-primary" : ""}`}
              onClick={() => {
                setSelectedId(v.id);
                setSelectedAccountId(null);
                setOpenMenuId(null);
              }}
            >
              <div className={`h-0.5 w-full ${barColor}`} />
              <div className="p-space-md flex flex-col gap-space-sm">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-space-sm min-w-0">
                    <div className="w-8 h-8 bg-surface-container-highest flex items-center justify-center font-headline-md text-headline-md font-bold text-secondary shrink-0">
                      {v.initial}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-space-xs flex-wrap">
                        <span className="font-headline-md text-headline-md font-bold text-on-surface">{v.name}</span>
                        <Chip tone="primary">{titleCase(v.planType)}</Chip>
                      </div>
                      <span className="font-code-dense text-code-dense text-on-surface-variant truncate block">
                        Proto: {titleCase(v.protocol)} • {v.models.length} Models configured
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-space-xs shrink-0 relative">
                    <StatusPill
                      state={v.health.state}
                      detail={
                        v.health.state === "healthy"
                          ? `Healthy (${v.health.uptimePercent.toFixed(1)}%)`
                          : v.health.state === "degraded"
                            ? "Degraded (Rate Limit)"
                            : v.health.state === "unreachable"
                              ? "Unreachable"
                              : "Inactive / Disabled"
                      }
                    />
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
                          Actions · {v.name}
                        </div>
                        {[
                          { icon: "visibility", label: "View Details" },
                          { icon: "edit", label: "Edit" },
                          { icon: "bolt", label: "Test Connection" },
                          { icon: "layers", label: "Manage Models" },
                          { icon: "key", label: "Rotate Credential" },
                        ].map((action) => (
                          <button
                            key={action.label}
                            className="w-full text-left px-space-sm py-1.5 text-on-surface hover:bg-primary hover:text-surface font-label-md text-label-md uppercase flex items-center gap-space-xs"
                          >
                            <Icon name={action.icon} size={14} />
                            <span>{action.label}</span>
                          </button>
                        ))}
                        <div className="h-[1px] bg-surface-container-highest my-1" />
                        <button className="w-full text-left px-space-sm py-1.5 text-error hover:bg-error hover:text-on-error font-label-md text-label-md uppercase flex items-center gap-space-xs">
                          <Icon name="block" size={14} />
                          <span>Disable</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-space-xs items-center pt-space-xs">
                  {v.capabilities.slice(0, 4).map((c) => (
                    <Chip key={c}>{titleCase(c)}</Chip>
                  ))}
                  {v.capabilities.length === 0 && <Chip tone="error">No Capabilities Configured</Chip>}
                  <span className="ml-auto font-code-dense text-code-dense text-on-surface-variant">
                    Last ping: {formatRelative(v.health.lastPingAt)}
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

      {/* Inspector */}
      {selected && (
        <Panel className="mb-space-lg">
          <div className="bg-surface-container-high px-space-md py-space-sm flex flex-col sm:flex-row sm:items-center justify-between gap-space-xs">
            <div className="flex items-center gap-space-sm">
              <span className="font-label-md text-label-md text-primary uppercase">Inspector:</span>
              <span className="font-headline-md text-headline-md text-on-surface font-bold">{selected.name}</span>
              <StatusPill state={selected.health.state} detail={selected.health.state === "healthy" ? "Connected" : titleCase(selected.health.state)} />
            </div>
            <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">ID: {selected.id}</span>
          </div>

          <Tabs
            tabs={DETAIL_TABS.map((t) =>
              t.key === "models" ? { ...t, label: `Models (${selected.models.length})` } : t,
            )}
            active={activeTab}
            onChange={setActiveTab}
          />

          <div className="p-space-md flex flex-col gap-space-md bg-surface-container-low">
            {activeTab === "overview" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                <InfoTile label="Base Endpoint" value={selected.baseEndpoint} mono />
                <InfoTile label="Priority" value={`${selected.priority} / 10`} accent="primary" />
                <InfoTile label="Tier" value={titleCase(selected.tier)} />
                <InfoTile label="Workloads" value={selected.workloads.map(titleCase).join(", ") || "None"} />
                <InfoTile label="Accounts" value={`${selected.accounts.length} configured`} />
                <InfoTile label="Created" value={formatDateTime(selected.createdAt)} />
                <div className="sm:col-span-3 bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant">
                  {selected.description}
                </div>
              </div>
            )}

            {activeTab === "credential" && selected.accounts.length > 0 && selectedAccount && (
              <>
                {selected.accounts.length > 1 && (
                  <div className="flex flex-col gap-space-xs">
                    <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">
                      Vendor Account ({selected.accounts.length} configured)
                    </span>
                    <div className="flex flex-wrap gap-space-xs">
                      {selected.accounts.map((acct) => {
                        const isActive = acct.id === selectedAccount.id;
                        return (
                          <button
                            key={acct.id}
                            onClick={() => setSelectedAccountId(acct.id)}
                            className={`flex items-center gap-space-xs px-space-sm py-1.5 border transition-colors ${
                              isActive
                                ? "bg-surface-container-highest border-primary text-on-surface"
                                : "bg-surface border-outline-variant text-on-surface-variant hover:text-on-surface"
                            }`}
                          >
                            <span
                              className={`w-1.5 h-1.5 ${
                                acct.status === "healthy"
                                  ? "bg-tertiary"
                                  : acct.status === "degraded"
                                    ? "bg-secondary"
                                    : "bg-outline"
                              }`}
                            />
                            <span className="font-code-dense text-code-dense uppercase">{acct.label}</span>
                            <Chip tone={isActive ? "primary" : "neutral"}>{acct.environment}</Chip>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="flex flex-col gap-space-xs">
                  <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">
                    Masked Inhouse Encrypted Secret — {selectedAccount.label}
                  </span>
                  <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-space-sm bg-surface p-space-sm">
                    <div className="flex items-center gap-space-sm">
                      <Icon name="key" className="text-primary" size={18} />
                      <span className="font-code-dense text-code-dense text-on-surface font-bold tracking-widest">
                        {selectedAccount.credential.maskedSecret}
                      </span>
                      <Chip tone={selectedAccount.credential.validity === "valid" ? "tertiary" : "error"}>
                        {selectedAccount.credential.validity}
                      </Chip>
                    </div>
                    <div className="flex items-center gap-space-xs">
                      <Button variant="secondary" className="px-space-sm py-1">Reveal Once</Button>
                      <Button variant="secondary" className="px-space-sm py-1">
                        <Icon name="content_copy" size={14} />
                        Copy Fingerprint
                      </Button>
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                  <InfoTile label="Created Date" value={formatDateTime(selectedAccount.credential.createdAt)} />
                  <InfoTile
                    label="Last Tested"
                    value={`${formatRelative(selectedAccount.credential.lastTestedAt)}${
                      selectedAccount.credential.lastTestResult
                        ? ` (${selectedAccount.credential.lastTestResult})`
                        : ""
                    }`}
                  />
                  <InfoTile label="Key Vault Store" value={selectedAccount.credential.vaultStore} accent="primary" />
                </div>
                <div className="flex flex-wrap items-center gap-space-sm pt-space-xs">
                  <Button variant="primary">
                    <Icon name="bolt" size={16} />
                    Test Connection
                  </Button>
                  <Button variant="secondary">
                    <Icon name="sync" size={16} />
                    Rotate Credential
                  </Button>
                  <Button variant="destructive" className="ml-auto">
                    <Icon name="power_settings_new" size={16} />
                    Disable
                  </Button>
                </div>
              </>
            )}

            {activeTab === "models" && (
              <Table
                rowKey={(m) => m.id}
                rows={selected.models}
                columns={[
                  { header: "Model", render: (m) => <span className="text-on-surface font-bold">{m.displayName}</span> },
                  { header: "Model ID", render: (m) => <span className="text-on-surface-variant">{m.modelId}</span> },
                  { header: "Context", render: (m) => <span className="text-on-surface-variant">{(m.contextWindowTokens / 1000).toFixed(0)}K</span> },
                  {
                    header: "Cost (in/out per 1M)",
                    render: (m) => (
                      <span className="text-on-surface-variant">
                        {formatUsd(m.cost.inputPerMillionUsd)} / {formatUsd(m.cost.outputPerMillionUsd)}
                      </span>
                    ),
                  },
                  { header: "Status", render: (m) => <StatusPill state={m.status} /> },
                ]}
              />
            )}
            {activeTab === "models" && selected.models.length === 0 && (
              <div className="bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant text-center">
                No models configured for this vendor.
              </div>
            )}

            {activeTab === "capabilities" && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
                {CAPABILITY_OPTIONS.map((cap) => {
                  const enabled = selected.capabilities.includes(cap);
                  return (
                    <div
                      key={cap}
                      className={`flex items-center gap-2 bg-surface p-space-sm ${enabled ? "" : "opacity-50"}`}
                    >
                      <span
                        className={`w-3 h-3 border border-outline-variant ${enabled ? "bg-primary" : ""}`}
                      />
                      <span
                        className={`font-code-dense text-code-dense uppercase ${
                          enabled ? "text-on-surface" : "text-on-surface-variant"
                        }`}
                      >
                        {titleCase(cap)}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}

            {activeTab === "routing" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                <InfoTile label="Priority Rank" value={`${selected.priority} / 10`} accent="primary" />
                <InfoTile label="Default Tier" value={titleCase(selected.tier)} />
                <InfoTile label="Max Provider Attempts" value={String(selected.fallback.maxProviderAttempts)} />
                <InfoTile
                  label="Fallback on Timeout"
                  value={selected.fallback.fallbackOnTimeout ? "Enabled" : "Disabled"}
                  accent={selected.fallback.fallbackOnTimeout ? "tertiary" : undefined}
                />
                <InfoTile
                  label="Fallback on Rate Limit"
                  value={selected.fallback.fallbackOnRateLimit ? "Enabled" : "Disabled"}
                  accent={selected.fallback.fallbackOnRateLimit ? "tertiary" : undefined}
                />
                <InfoTile
                  label="Max Execution Time"
                  value={`${(selected.fallback.maxTotalExecutionTimeMs / 1000).toFixed(1)}s`}
                />
              </div>
            )}

            {activeTab === "health" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                <InfoTile label="Uptime" value={`${selected.health.uptimePercent.toFixed(1)}%`} accent="tertiary" />
                <InfoTile label="Error Rate" value={`${selected.health.errorRatePercent.toFixed(1)}%`} />
                <InfoTile label="Latency P50 / P95 / P99" value={`${selected.health.latencyP50Ms} / ${selected.health.latencyP95Ms} / ${selected.health.latencyP99Ms}ms`} />
                <InfoTile label="Last Incident" value={formatRelative(selected.health.lastIncidentAt)} />
                <InfoTile label="Last Ping" value={formatRelative(selected.health.lastPingAt)} />
              </div>
            )}

            {activeTab === "usage" && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
                <InfoTile label="Window" value={selected.usage.windowLabel} />
                <InfoTile label="Requests" value={selected.usage.requests.toLocaleString()} accent="primary" />
                <InfoTile
                  label="Success Rate"
                  value={`${selected.usage.successRatePercent.toFixed(1)}%`}
                  accent="tertiary"
                />
                <InfoTile label="Tokens In" value={formatCompactNumber(selected.usage.tokensInputTotal)} />
                <InfoTile label="Tokens Out" value={formatCompactNumber(selected.usage.tokensOutputTotal)} />
                <InfoTile label="Cost (Window)" value={formatUsd(selected.usage.costUsd)} accent="primary" />
              </div>
            )}
          </div>
        </Panel>
      )}

      <AddVendorDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
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

function AddVendorDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Drawer open={open} onClose={onClose} title="Add Vendor" subtitle="Configure a new inference provider for Inhouse (mock — not persisted).">
      <form
        className="flex flex-col gap-space-lg"
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={1} title="Basic Information" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
            <FormField label="Vendor Name">
              <TextInput placeholder="e.g. Anthropic Bedrock West" />
            </FormField>
            <FormField label="Vendor Type">
              <Select defaultValue="coding_plan">
                <option value="coding_plan">Coding Plan</option>
                <option value="payg">PAYG</option>
                <option value="general_api">General API</option>
                <option value="local">Local</option>
                <option value="custom">Custom</option>
              </Select>
            </FormField>
            <FormField label="API Protocol">
              <Select defaultValue="openai_compatible">
                <option value="openai_compatible">OpenAI-compatible</option>
                <option value="anthropic_compatible">Anthropic-compatible</option>
                <option value="custom_rest">Custom REST</option>
              </Select>
            </FormField>
            <FormField label="Base API Endpoint">
              <TextInput className="text-primary" defaultValue="https://api.provider.com/v1" />
            </FormField>
          </div>
          <FormField label="Description">
            <TextInput placeholder="Mission-critical inference cluster for code intelligence pipeline" />
          </FormField>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={2} title="Authentication" />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
            <FormField label="Auth Type">
              <Select defaultValue="api_key">
                <option value="api_key">API Key</option>
                <option value="bearer_token">Bearer Token</option>
                <option value="aws_iam_role">AWS IAM Role</option>
                <option value="mtls_client_cert">mTLS Client Cert</option>
              </Select>
            </FormField>
            <FormField label="Masked Key / Secret Token" className="sm:col-span-2">
              <div className="flex items-center gap-space-xs">
                <TextInput type="password" placeholder="Paste vendor secret" className="w-full" />
                <Button type="button" variant="secondary" className="shrink-0 px-space-sm py-2">
                  Show Once
                </Button>
                <Button type="button" variant="primary" className="shrink-0 px-space-sm py-2">
                  Test Connection
                </Button>
              </div>
            </FormField>
          </div>
          <div className="bg-surface p-space-sm flex items-start gap-space-xs">
            <Icon name="verified_user" className="text-tertiary" size={18} />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Credentials are stored server-side with <strong className="text-on-surface">AES-256 GCM encryption</strong> and
              are never exposed to the browser. This is a vendor credential — distinct from Inhouse API keys.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={3} title="Capabilities Grid" />
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
            {CAPABILITY_OPTIONS.map((cap) => (
              <label key={cap} className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer hover:bg-surface-container-high">
                <input type="checkbox" className="accent-primary" />
                <span className="font-code-dense text-code-dense text-on-surface uppercase">{titleCase(cap)}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={4} title="Allowed Workloads" />
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-space-xs">
            {WORKLOAD_OPTIONS.map((w) => (
              <label key={w} className="flex items-center gap-2 bg-surface p-space-sm cursor-pointer hover:bg-surface-container-high">
                <input type="checkbox" className="accent-primary" />
                <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">{w}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-space-sm bg-surface-container-low p-space-md">
          <SectionLabel n={5} title="Routing & Priority" />
          <div className="flex flex-col gap-space-xs bg-surface p-space-sm">
            <div className="flex items-center justify-between">
              <span className="font-code-dense text-code-dense text-on-surface-variant uppercase">
                Priority Rank (1 = Fallback, 10 = Primary)
              </span>
              <span className="font-headline-md text-headline-md font-bold text-primary">05</span>
            </div>
            <input type="range" min={1} max={10} defaultValue={5} className="w-full accent-primary" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-sm">
            <FormField label="Default Tier">
              <Select defaultValue="tier_2_standard">
                <option value="tier_1_high_reliability">Tier 1 (High Reliability)</option>
                <option value="tier_2_standard">Tier 2 (Standard)</option>
                <option value="tier_3_batch">Tier 3 (Batch)</option>
              </Select>
            </FormField>
          </div>
        </div>

        <div className="flex items-center justify-end gap-space-sm">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            <Icon name="add" size={16} />
            Add Vendor
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
