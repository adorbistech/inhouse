import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Routing } from "./Routing";
import type {
  ModelApi,
  RoutingDecisionApi,
  RoutingFallbackRuleApi,
  RoutingTierApi,
  VendorApi,
  WorkloadApi,
} from "../types/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      listWorkloads: vi.fn(),
      listVendors: vi.fn(),
      listModels: vi.fn(),
      listCapabilities: vi.fn(),
      getRoutingConfig: vi.fn(),
      createRoutingTier: vi.fn(),
      updateRoutingTier: vi.fn(),
      disableRoutingTier: vi.fn(),
      enableRoutingTier: vi.fn(),
      createRoutingFallbackRule: vi.fn(),
      updateRoutingFallbackRule: vi.fn(),
      disableRoutingFallbackRule: vi.fn(),
      previewRouting: vi.fn(),
    },
  };
});

import { api, ApiError } from "../lib/api";

function sampleWorkload(overrides: Partial<WorkloadApi> = {}): WorkloadApi {
  return {
    id: "wl_1",
    slug: "chat",
    displayName: "Chat",
    description: null,
    status: "enabled",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function sampleVendor(overrides: Partial<VendorApi> = {}): VendorApi {
  return {
    id: "vnd_1",
    slug: "test-vendor",
    displayName: "Test Vendor",
    vendorType: "general_api",
    protocol: "custom_rest",
    baseEndpoint: "https://api.example.invalid/v1",
    description: null,
    status: "enabled",
    billingType: "metered",
    defaultTier: 1,
    maxTier: 3,
    automaticFallback: true,
    timeoutMs: 5000,
    retryMaxAttempts: 2,
    retryBackoffMs: 250,
    priority: 5,
    retryOnTimeout: true,
    retryOnRateLimit: false,
    retryOn5xx: false,
    retryOnAuthFailure: false,
    retryOnInvalidResponse: false,
    adapterSupported: false,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function sampleModel(overrides: Partial<ModelApi> = {}): ModelApi {
  return {
    id: "mdl_1",
    vendorId: "vnd_1",
    providerModelId: "provider-model",
    inhouseAlias: "test-model",
    displayName: "Test Model",
    contextWindow: null,
    status: "enabled",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function sampleTier(overrides: Partial<RoutingTierApi> = {}): RoutingTierApi {
  return {
    id: "tier_1",
    workloadId: "wl_1",
    tierNumber: 1,
    vendorId: "vnd_1",
    modelId: "mdl_1",
    priority: 5,
    enabled: true,
    timeoutOverrideMs: null,
    maxAttempts: null,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function sampleRule(overrides: Partial<RoutingFallbackRuleApi> = {}): RoutingFallbackRuleApi {
  return {
    id: "rule_1",
    workloadId: "wl_1",
    fromTierId: "tier_1",
    toTierId: "tier_2",
    conditionType: "on_timeout",
    conditionConfig: {},
    priority: 0,
    enabled: true,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function sampleDecision(overrides: Partial<RoutingDecisionApi> = {}): RoutingDecisionApi {
  const candidate = {
    tierId: "tier_1",
    tierNumber: 1,
    priority: 5,
    tierEnabled: true,
    vendor: { id: "vnd_1", slug: "test-vendor", displayName: "Test Vendor", status: "enabled" },
    model: { id: "mdl_1", inhouseAlias: "test-model", displayName: "Test Model", status: "enabled" },
    health: "unknown" as const,
    accounts: [],
    retryPolicy: null,
    outgoingFallbackRules: [],
    eligible: true,
    reasons: [],
  };
  return {
    workload: { id: "wl_1", slug: "chat", displayName: "Chat", status: "enabled" },
    requested: { modelId: null, capabilityIds: [] },
    candidates: [candidate],
    selectedCandidate: candidate,
    outcome: "selected",
    fallbackRules: [],
    generatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });
  vi.mocked(api.listModels).mockResolvedValue({ models: [sampleModel()] });
  vi.mocked(api.listCapabilities).mockResolvedValue({ capabilities: [] });
  vi.mocked(api.getRoutingConfig).mockResolvedValue({ workload: sampleWorkload(), tiers: [], fallbackRules: [] });
});

describe("Routing page", () => {
  test("shows a loading state while workloads are being fetched", async () => {
    vi.mocked(api.listWorkloads).mockReturnValue(new Promise(() => {}));
    render(<Routing />);
    await waitFor(() => expect(screen.getByText(/loading workloads/i)).toBeInTheDocument());
  });

  test("shows an error state with a retry action when the workload list fails to load", async () => {
    vi.mocked(api.listWorkloads)
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL_SERVER_ERROR", "boom", "req-1"))
      .mockResolvedValueOnce({ workloads: [] });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText(/failed to load workloads/i)).toBeInTheDocument());
    expect(screen.getByText("boom")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/no workloads configured/i)).toBeInTheDocument());
  });

  test("shows an empty state when there are no workloads", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [] });
    render(<Routing />);
    await waitFor(() => expect(screen.getByText(/no workloads configured/i)).toBeInTheDocument());
  });

  test("selects the first workload automatically and shows an empty tiers state", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });

    render(<Routing />);

    await waitFor(() => expect(screen.getByText(/no routing tiers are configured/i)).toBeInTheDocument());
    expect(api.getRoutingConfig).toHaveBeenCalledWith("wl_1");
  });

  test("renders configured tiers and fallback rules", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier(), sampleTier({ id: "tier_2", tierNumber: 2 })],
      fallbackRules: [sampleRule()],
    });

    render(<Routing />);

    await waitFor(() => expect(screen.getAllByText("test-model").length).toBeGreaterThan(0));
    expect(screen.getAllByText("#1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Test Vendor").length).toBeGreaterThan(0);
    expect(screen.getByText("On Timeout")).toBeInTheDocument();
  });

  test("Add Tier: submitting the form calls api.createRoutingTier with the expected payload", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.createRoutingTier).mockResolvedValue({ tier: sampleTier() });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText(/no routing tiers are configured/i)).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /add tier/i }));
    await userEvent.selectOptions(screen.getByLabelText(/^vendor$/i), "vnd_1");
    await userEvent.selectOptions(screen.getByLabelText(/^model$/i), "mdl_1");

    await userEvent.click(screen.getByRole("button", { name: /^add tier$/i }));

    await waitFor(() => expect(api.createRoutingTier).toHaveBeenCalledTimes(1));
    const [workloadId, payload] = vi.mocked(api.createRoutingTier).mock.calls[0]!;
    expect(workloadId).toBe("wl_1");
    expect(payload).toMatchObject({ vendorId: "vnd_1", modelId: "mdl_1", tierNumber: 1, priority: 0 });
  });

  test("toggling a tier's status calls api.disableRoutingTier / api.enableRoutingTier", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier()],
      fallbackRules: [],
    });
    vi.mocked(api.disableRoutingTier).mockResolvedValue({ tier: sampleTier({ enabled: false }) });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /^disable$/i }));
    await waitFor(() => expect(api.disableRoutingTier).toHaveBeenCalledWith("wl_1", "tier_1"));
  });

  test("Add Fallback Rule is only offered once at least two tiers exist", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier()],
      fallbackRules: [],
    });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    expect(screen.queryByRole("button", { name: /add rule/i })).not.toBeInTheDocument();
    expect(screen.getByText(/at least two tiers are required/i)).toBeInTheDocument();
  });

  test("Add Fallback Rule: submitting the form calls api.createRoutingFallbackRule", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier(), sampleTier({ id: "tier_2", tierNumber: 2 })],
      fallbackRules: [],
    });
    vi.mocked(api.createRoutingFallbackRule).mockResolvedValue({ fallbackRule: sampleRule() });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /add rule/i }));
    const dialog = screen.getByText(/^from tier$/i).closest("form") as HTMLElement;
    await userEvent.selectOptions(within(dialog).getByLabelText(/from tier/i), "tier_1");
    await userEvent.selectOptions(within(dialog).getByLabelText(/to tier/i), "tier_2");

    await userEvent.click(within(dialog).getByRole("button", { name: /^add rule$/i }));

    await waitFor(() => expect(api.createRoutingFallbackRule).toHaveBeenCalledTimes(1));
    const [workloadId, payload] = vi.mocked(api.createRoutingFallbackRule).mock.calls[0]!;
    expect(workloadId).toBe("wl_1");
    expect(payload).toMatchObject({ fromTierId: "tier_1", toTierId: "tier_2" });
  });

  test("Run Preview calls api.previewRouting and renders the decision, including the selected candidate", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier()],
      fallbackRules: [],
    });
    vi.mocked(api.previewRouting).mockResolvedValue({ decision: sampleDecision() });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /run preview/i }));

    await waitFor(() => expect(api.previewRouting).toHaveBeenCalledWith({ workloadId: "wl_1", modelId: undefined, capabilityIds: undefined }));
    await waitFor(() => expect(screen.getByText(/selected candidate/i)).toBeInTheDocument());
    expect(screen.getByText("Selected")).toBeInTheDocument();
    expect(screen.getByText("Eligible")).toBeInTheDocument();
  });

  test("a preview with no eligible candidates shows exclusion reasons, never claiming a candidate was selected", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier({ enabled: false })],
      fallbackRules: [],
    });
    vi.mocked(api.previewRouting).mockResolvedValue({
      decision: sampleDecision({
        outcome: "no_eligible_candidate",
        selectedCandidate: null,
        candidates: [
          {
            tierId: "tier_1",
            tierNumber: 1,
            priority: 5,
            tierEnabled: false,
            vendor: { id: "vnd_1", slug: "test-vendor", displayName: "Test Vendor", status: "enabled" },
            model: { id: "mdl_1", inhouseAlias: "test-model", displayName: "Test Model", status: "enabled" },
            health: "unknown",
            accounts: [],
            retryPolicy: null,
            outgoingFallbackRules: [],
            eligible: false,
            reasons: ["tier_disabled"],
          },
        ],
      }),
    });

    render(<Routing />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /run preview/i }));

    await waitFor(() => expect(screen.getByText("Excluded")).toBeInTheDocument());
    expect(screen.getByText("Tier Disabled")).toBeInTheDocument();
    expect(screen.queryByText(/selected candidate/i)).not.toBeInTheDocument();
  });

  test("a failed preview surfaces the API error message without crashing", async () => {
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    vi.mocked(api.getRoutingConfig).mockResolvedValue({
      workload: sampleWorkload(),
      tiers: [sampleTier()],
      fallbackRules: [],
    });
    vi.mocked(api.previewRouting).mockRejectedValue(new ApiError(404, "NOT_FOUND", "Workload not found.", "req-2"));

    render(<Routing />);
    await waitFor(() => expect(screen.getByText("#1")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /run preview/i }));

    await waitFor(() => expect(screen.getByText("Workload not found.")).toBeInTheDocument());
  });
});
