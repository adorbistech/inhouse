import { useMemo, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { StatCard } from "../components/ui/StatCard";
import { Panel, PanelHeader } from "../components/ui/Panel";
import { Table } from "../components/ui/Table";
import { StatusPill } from "../components/ui/StatusPill";
import { SparklineChart } from "../components/ui/SparklineChart";
import { vendors, telemetry24h, failoverChain, auditLog, platformMetrics } from "../data/mockData";
import { formatCompactNumber, formatRelative, formatUsd } from "../lib/format";

const TIME_WINDOWS = [
  { value: "15m", label: "Window: Last 15m" },
  { value: "1h", label: "Window: Last 1h" },
  { value: "24h", label: "Window: Last 24h" },
  { value: "7d", label: "Window: Last 7d" },
  { value: "30d", label: "Window: Last 30d" },
];

export function Dashboard() {
  const [window_, setWindow] = useState("24h");
  const [lastUpdatedSec, setLastUpdatedSec] = useState(18);

  const totals = useMemo(() => {
    const requests = telemetry24h.reduce((a, p) => a + p.requests, 0);
    const successful = telemetry24h.reduce((a, p) => a + p.successful, 0);
    const failed = telemetry24h.reduce((a, p) => a + p.failed, 0);
    const fallbacks = telemetry24h.reduce((a, p) => a + p.fallbacks, 0);
    const successRate = requests ? (successful / requests) * 100 : 0;
    const avgLatency =
      vendors.reduce((a, v) => a + v.health.latencyP50Ms, 0) / Math.max(1, vendors.length);
    return { requests, successful, failed, fallbacks, successRate, avgLatency };
  }, []);

  const healthyVendors = vendors.filter((v) => v.health.state === "healthy").length;

  const fleetRequestCounts: Record<string, number> = Object.fromEntries(
    vendors.map((v) => [v.id, v.usage.requests]),
  );

  return (
    <>
      {/* Command console controls */}
      <div className="flex flex-col gap-space-xs bg-surface-container-low p-space-sm">
        <div className="flex flex-wrap items-center justify-between gap-space-xs">
          <div className="flex items-center gap-space-xs">
            <span className="w-2 h-2 bg-primary" />
            <span className="font-headline-md text-headline-md uppercase text-on-surface tracking-tight">
              Operational Command Center
            </span>
            <span className="bg-surface-container text-secondary font-code-dense text-code-dense px-space-xs py-0.5 uppercase">
              SYS.LIVE
            </span>
          </div>
          <div className="flex items-center gap-space-sm">
            <span className="font-code-dense text-code-dense text-on-surface-variant flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-tertiary" />
              [Last updated {lastUpdatedSec}s ago]
            </span>
            <Button
              variant="secondary"
              className="px-space-sm py-1 text-primary"
              onClick={() => setLastUpdatedSec(0)}
            >
              <Icon name="refresh" size={14} />
              Refresh
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-space-xs pt-space-xs bg-surface-container-lowest p-space-xs">
          <div className="flex items-center gap-space-xs text-on-surface-variant font-code-dense text-code-dense flex-wrap">
            <span className="text-primary font-bold">NODE:</span> ih-edge-us-east-01
            <span className="text-outline-variant">|</span>
            <span className="text-primary font-bold">ROUTE_MAP:</span> v4.19-adaptive
          </div>
          <select
            value={window_}
            onChange={(e) => setWindow(e.target.value)}
            className="bg-surface-container-high text-on-surface font-code-dense text-code-dense px-space-sm py-1 uppercase cursor-pointer focus:outline-none focus:bg-surface-bright border-none"
          >
            {TIME_WINDOWS.map((w) => (
              <option key={w.value} value={w.value}>
                {w.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-space-xs">
        <StatCard
          label="Requests"
          value={totals.requests.toLocaleString()}
          sublabel="TTL: 24h aggregate"
          accent="primary"
          trailing={<span className="text-tertiary font-code-dense text-code-dense">↑ 8.4%</span>}
        />
        <StatCard
          label="Success Rate"
          value={`${totals.successRate.toFixed(1)}%`}
          sublabel="● Healthy SLA"
          accent="tertiary"
          valueTone="text-tertiary"
          trailing={<span className="w-2 h-2 bg-tertiary" />}
        />
        <StatCard
          label="Tokens"
          value={formatCompactNumber(platformMetrics.tokensInLast24h + platformMetrics.tokensOutLast24h)}
          sublabel={`I:${formatCompactNumber(platformMetrics.tokensInLast24h)} / O:${formatCompactNumber(platformMetrics.tokensOutLast24h)}`}
          accent="secondary"
          trailing={<span className="font-code-dense text-code-dense text-secondary">IN+OUT</span>}
        />
        <StatCard
          label="Avg Latency"
          value={`${totals.avgLatency.toFixed(0)}ms`}
          sublabel={`P95: ${(platformMetrics.avgLatencyP95Ms / 1000).toFixed(2)}s`}
          accent="secondary"
        />
        <StatCard
          label="Fallbacks"
          value={String(totals.fallbacks)}
          sublabel="Auto-routed, clean"
          accent="secondary"
          valueTone="text-secondary"
        />
        <StatCard
          label="Beta Cost"
          value={formatUsd(platformMetrics.betaCostUsd)}
          sublabel={`Allocation: ${platformMetrics.betaCostAllocationPercent}%`}
          accent="primary"
          trailing={<span className="font-code-dense text-code-dense text-outline">CRDB</span>}
        />
      </div>

      {/* Request activity telemetry */}
      <Panel>
        <PanelHeader
          title="Request Activity Telemetry"
          right={
            <div className="flex items-center gap-space-xs font-code-dense text-code-dense text-on-surface-variant uppercase">
              <span className="text-primary">Requests</span>
              <span>Successful</span>
              <span>Failed</span>
              <span>Fallbacks</span>
            </div>
          }
        />
        <div className="p-space-md">
          <SparklineChart
            labels={telemetry24h.map((t) => t.timeLabel)}
            series={[
              { key: "requests", color: "#b5c4ff", values: telemetry24h.map((t) => t.requests) },
              { key: "successful", color: "#4ae176", values: telemetry24h.map((t) => t.successful) },
              { key: "failed", color: "#ffb4ab", values: telemetry24h.map((t) => t.failed) },
              { key: "fallbacks", color: "#7bd0ff", values: telemetry24h.map((t) => t.fallbacks) },
            ]}
          />
        </div>
      </Panel>

      {/* Provider latency benchmarks */}
      <Panel>
        <PanelHeader title="Provider Latency Benchmarks" eyebrow="ALL PROVIDERS" />
        <Table
          rowKey={(v) => v.id}
          rows={vendors}
          columns={[
            { header: "Provider", render: (v) => <span className="text-on-surface font-bold">{v.name}</span> },
            {
              header: "P50",
              render: (v) => <span className="text-on-surface-variant">{v.health.latencyP50Ms}ms</span>,
            },
            {
              header: "P95",
              render: (v) => <span className="text-on-surface-variant">{v.health.latencyP95Ms}ms</span>,
            },
            {
              header: "P99",
              render: (v) => <span className="text-on-surface-variant">{v.health.latencyP99Ms}ms</span>,
            },
            { header: "State", render: (v) => <StatusPill state={v.health.state} /> },
          ]}
        />
      </Panel>

      {/* Recent provider failover flow chain */}
      <Panel>
        <PanelHeader
          title="Recent Provider Failover (Flow Chain)"
          eyebrow="IH-EXEC-0001846"
          right={
            <button className="font-label-md text-label-md text-primary uppercase flex items-center gap-1">
              <Icon name="visibility" size={14} />
              Inspect Execution
            </button>
          }
        />
        <div className="p-space-md flex flex-col gap-space-sm">
          <div className="font-code-dense text-code-dense text-on-surface-variant">
            <span className="text-primary font-bold">CLIENT:</span> Claude Code CLI &nbsp;
            <span className="text-primary font-bold">TASK:</span> CODING_AGENT / repo_refactor &nbsp;
            <span className="text-primary font-bold">TARGET:</span> claude-sonnet /inherited
          </div>
          <div className="flex flex-col gap-1">
            {failoverChain.map((event) => {
              const toneClass =
                event.status === "timeout" || event.status === "rate_limited"
                  ? "border-l-secondary text-secondary"
                  : event.status === "resolved" || event.status === "completed"
                    ? "border-l-tertiary text-tertiary"
                    : "border-l-primary text-primary";
              return (
                <div key={event.id} className={`bg-surface p-space-sm border-l-2 ${toneClass}`}>
                  <div className="flex items-center gap-space-xs">
                    <span className="font-label-md text-label-md uppercase">{event.step}</span>
                    <span className="font-body-md text-body-md text-on-surface font-bold">{event.label}</span>
                    <span className="font-code-dense text-code-dense uppercase ml-auto">{event.status}</span>
                  </div>
                  <div className="font-code-dense text-code-dense text-on-surface-variant mt-1">{event.detail}</div>
                </div>
              );
            })}
          </div>
          <div className="font-code-dense text-code-dense text-tertiary uppercase pt-space-xs">
            Total retry latency overhead: +2.03s · Auto-healing successful
          </div>
        </div>
      </Panel>

      {/* Execution telemetry inspector */}
      <Panel>
        <PanelHeader title="Execution Telemetry Inspector" eyebrow="SUCCESSFUL RESOLUTION" />
        <div className="p-space-md grid grid-cols-1 sm:grid-cols-2 gap-space-sm">
          <div className="bg-surface p-space-sm flex flex-col gap-1">
            <span className="font-code-dense text-code-dense text-outline uppercase">Client App</span>
            <span className="font-body-md text-body-md text-on-surface font-bold">Claude Code v1.2</span>
          </div>
          <div className="bg-surface p-space-sm flex flex-col gap-1">
            <span className="font-code-dense text-code-dense text-outline uppercase">Workload Type</span>
            <span className="font-body-md text-body-md text-on-surface font-bold">CODING_AGENT</span>
          </div>
          <div className="bg-surface p-space-sm flex flex-col gap-1">
            <span className="font-code-dense text-code-dense text-outline uppercase">Requested Model</span>
            <span className="font-body-md text-body-md text-on-surface font-bold">claude-sonnet</span>
          </div>
          <div className="bg-surface p-space-sm flex flex-col gap-1">
            <span className="font-code-dense text-code-dense text-outline uppercase">Routed Provider</span>
            <span className="font-body-md text-body-md text-tertiary font-bold">cerebras-fast</span>
          </div>
        </div>
      </Panel>

      {/* Technical routing headers */}
      <Panel>
        <PanelHeader title="Technical Routing Headers & Safe Masked Diagnostics" />
        <div className="p-space-md bg-surface-container-lowest font-code-dense text-code-dense text-on-surface-variant leading-relaxed overflow-x-auto whitespace-pre">
{`x-adorbis-trace-id: 0a81fo20-8021-4f7b-991f2-06481fa7032d
x-inhouse-env: BETA-PRODUCTION-CLUSTER-04
x-fallback-chain: 2.ai -> alibaba -> cerebras-fast
x-caller-fingerprint: claude-code/v1.2
x-inference-strategy: lowest-cost-with-hard-sla-2.5s`}
        </div>
      </Panel>

      {/* Provider fleet telemetry */}
      <Panel className="mb-space-lg">
        <PanelHeader title="Provider Fleet Telemetry" eyebrow={`${healthyVendors}/${vendors.length} OPERATIONAL`} />
        <Table
          rowKey={(v) => v.id}
          rows={vendors}
          columns={[
            { header: "Provider", render: (v) => <span className="text-on-surface font-bold">{v.name}</span> },
            { header: "Type", render: (v) => <span className="text-on-surface-variant uppercase">{v.planType.replace(/_/g, " ")}</span> },
            { header: "Status", render: (v) => <StatusPill state={v.health.state} /> },
            {
              header: "Requests",
              render: (v) => (
                <span className="text-on-surface-variant">{(fleetRequestCounts[v.id] ?? 0).toLocaleString()}</span>
              ),
            },
            { header: "Success", render: (v) => <span className="text-tertiary">{(100 - v.health.errorRatePercent).toFixed(1)}%</span> },
            { header: "Latency", render: (v) => <span className="text-on-surface-variant">{v.health.latencyP50Ms}ms</span> },
            { header: "Last Ping", render: (v) => <span className="text-outline">{formatRelative(v.health.lastPingAt)}</span> },
          ]}
        />
      </Panel>

      {/* Security footer */}
      <div className="bg-surface-container-lowest p-space-sm font-code-dense text-code-dense text-outline flex flex-wrap items-center gap-space-sm">
        <Icon name="security" size={14} className="text-tertiary" />
        <span>SECURITY POLICY: ZERO_LOGS_PERSISTED · TLS 1.3 ENC</span>
        <span className="ml-auto">INGRESS_IP: 108.51.100.24 READY</span>
      </div>

      <div className="hidden">{auditLog.length}</div>
    </>
  );
}
