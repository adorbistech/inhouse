import { useCallback, useEffect, useMemo, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { StatCard } from "../components/ui/StatCard";
import { Panel, PanelHeader } from "../components/ui/Panel";
import { Table } from "../components/ui/Table";
import { Chip } from "../components/ui/Chip";
import { StatusPill } from "../components/ui/StatusPill";
import { api, ApiError } from "../lib/api";
import { formatDateTime, titleCase } from "../lib/format";
import type { HealthState } from "../types/domain";
import type { ModelApi, VendorApi, VendorStatus } from "../types/api";

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

/**
 * Reads exclusively from the Block 06 vendor API and the Block 07 model
 * API — the Inhouse PostgreSQL database is the only source of truth here.
 * Request routing/execution, live traffic telemetry and cost accounting
 * are not implemented yet (later blocks), so this page never fabricates
 * numbers for them; it says so explicitly instead.
 */
export function Dashboard() {
  const [vendors, setVendors] = useState<VendorApi[] | null>(null);
  const [models, setModels] = useState<ModelApi[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [{ vendors: v }, { models: m }] = await Promise.all([api.listVendors(), api.listModels()]);
      setVendors(v);
      setModels(m);
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const stats = useMemo(() => {
    const v = vendors ?? [];
    return {
      total: v.length,
      enabled: v.filter((x) => x.status === "enabled").length,
      adapterReady: v.filter((x) => x.adapterSupported).length,
      models: (models ?? []).length,
    };
  }, [vendors, models]);

  if (loadError) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center">
        <Icon name="error" className="text-error" size={28} />
        <span className="font-headline-md text-headline-md font-bold text-on-surface">Failed to load dashboard</span>
        <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">{loadError}</p>
        <Button variant="secondary" onClick={() => refresh()}>
          <Icon name="refresh" size={16} />
          Retry
        </Button>
      </div>
    );
  }

  if (vendors === null || models === null) {
    return (
      <div className="bg-surface-container-low p-space-lg flex flex-col items-center gap-space-sm text-center">
        <Icon name="hourglass_top" className="text-primary animate-pulse" size={28} />
        <span className="font-body-md text-body-md text-on-surface-variant">Loading dashboard…</span>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-space-xs bg-surface-container-low p-space-sm">
        <div className="flex flex-wrap items-center justify-between gap-space-xs">
          <div className="flex items-center gap-space-xs">
            <span className="w-2 h-2 bg-primary" />
            <span className="font-headline-md text-headline-md uppercase text-on-surface tracking-tight">
              Configuration Overview
            </span>
            <span className="bg-surface-container text-secondary font-code-dense text-code-dense px-space-xs py-0.5 uppercase">
              DB-BACKED
            </span>
          </div>
          <Button variant="secondary" className="px-space-sm py-1 text-primary" onClick={() => refresh()}>
            <Icon name="refresh" size={14} />
            Refresh
          </Button>
        </div>
        <p className="font-body-sm text-body-sm text-on-surface-variant">
          Reflects configured state in the Inhouse database only. Request routing/execution, live traffic telemetry
          and cost accounting are implemented in a later block.
        </p>
      </div>

      {/* KPI cards — every figure below is a live count from the API, never fabricated. */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
        <StatCard label="Vendors Configured" value={String(stats.total)} sublabel="Total in database" accent="primary" />
        <StatCard
          label="Enabled Vendors"
          value={String(stats.enabled)}
          sublabel="Operator-enabled"
          accent="tertiary"
          valueTone="text-tertiary"
        />
        <StatCard
          label="Adapter-Ready"
          value={String(stats.adapterReady)}
          sublabel="Technical adapter registered"
          accent="secondary"
        />
        <StatCard label="Models Configured" value={String(stats.models)} sublabel="Total in catalog" accent="primary" />
      </div>

      <Panel>
        <PanelHeader title="Configured Providers" eyebrow={`${vendors.length} TOTAL`} />
        {vendors.length === 0 ? (
          <div className="p-space-lg text-center flex flex-col items-center gap-space-sm">
            <Icon name="hub" className="text-outline-variant" size={32} />
            <span className="font-headline-md text-headline-md font-bold text-on-surface">No providers configured</span>
            <p className="font-body-sm text-body-sm text-on-surface-variant max-w-md">
              No vendors exist in the Inhouse database yet. Configure one on the Vendors page.
            </p>
          </div>
        ) : (
          <Table
            rowKey={(v) => v.id}
            rows={vendors}
            columns={[
              { header: "Provider", render: (v) => <span className="text-on-surface font-bold">{v.displayName}</span> },
              { header: "Protocol", render: (v) => <span className="text-on-surface-variant">{titleCase(v.protocol)}</span> },
              { header: "Status", render: (v) => <StatusPill state={vendorStatusToHealthState(v.status)} detail={titleCase(v.status)} /> },
              {
                header: "Adapter",
                render: (v) => (
                  <Chip tone={v.adapterSupported ? "tertiary" : undefined}>
                    {v.adapterSupported ? "Adapter Ready" : "No Adapter"}
                  </Chip>
                ),
              },
              { header: "Priority", render: (v) => <span className="text-on-surface-variant">{v.priority} / 10</span> },
              { header: "Created", render: (v) => <span className="text-outline">{formatDateTime(v.createdAt)}</span> },
            ]}
          />
        )}
      </Panel>

      <Panel className="mb-space-lg">
        <PanelHeader title="Execution, Telemetry & Cost Accounting" eyebrow="NOT YET AVAILABLE" />
        <div className="p-space-md flex flex-col gap-space-sm">
          <div className="bg-surface p-space-sm flex items-start gap-space-xs">
            <Icon name="info" className="text-secondary shrink-0" size={18} />
            <p className="font-body-sm text-body-sm text-on-surface-variant">
              Request routing execution, live traffic telemetry (requests/success/latency/fallbacks) and cost
              accounting are not implemented in this build. This dashboard intentionally does not display simulated
              or example figures for them — those panels ship once request execution exists.
            </p>
          </div>
        </div>
      </Panel>

      <div className="bg-surface-container-lowest p-space-sm font-code-dense text-code-dense text-outline flex flex-wrap items-center gap-space-sm">
        <Icon name="security" size={14} className="text-tertiary" />
        <span>All provider credentials are stored encrypted; this dashboard never renders raw secret material.</span>
      </div>
    </>
  );
}
