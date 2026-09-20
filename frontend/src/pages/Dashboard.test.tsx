import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dashboard } from "./Dashboard";
import type { ModelApi, VendorApi } from "../types/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      listVendors: vi.fn(),
      listModels: vi.fn(),
    },
  };
});

import { api, ApiError } from "../lib/api";

function sampleVendor(overrides: Partial<VendorApi> = {}): VendorApi {
  return {
    id: "vnd_1",
    slug: "test-vendor",
    displayName: "Test Vendor",
    vendorType: "general_api",
    protocol: "custom_rest",
    baseEndpoint: "https://api.example.invalid/v1",
    description: "A test vendor.",
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
    providerModelId: "provider-model-1",
    inhouseAlias: "inhouse-alias-1",
    displayName: "Test Model",
    contextWindow: 128000,
    status: "enabled",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listVendors).mockResolvedValue({ vendors: [] });
  vi.mocked(api.listModels).mockResolvedValue({ models: [] });
});

describe("Dashboard (Block 10 audit fix)", () => {
  test("shows an empty configuration state when no vendors exist — never fabricates providers", async () => {
    render(<Dashboard />);
    expect(await screen.findByText(/no providers configured/i)).toBeInTheDocument();
  });

  test("computes KPI counts from real API data, with no hardcoded business provider inventory", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({
      vendors: [
        sampleVendor({ id: "vnd_a", displayName: "Configured Vendor A", status: "enabled", adapterSupported: true }),
        sampleVendor({ id: "vnd_b", displayName: "Configured Vendor B", status: "disabled", adapterSupported: false }),
      ],
    });
    vi.mocked(api.listModels).mockResolvedValue({ models: [sampleModel()] });

    render(<Dashboard />);

    expect(await screen.findByText("Configured Vendor A")).toBeInTheDocument();
    expect(screen.getByText("Configured Vendor B")).toBeInTheDocument();

    function statValue(label: string) {
      return screen.getByText(label).closest("div")?.parentElement?.querySelector(".font-headline-lg")?.textContent;
    }
    expect(statValue("Vendors Configured")).toBe("2");
    expect(statValue("Enabled Vendors")).toBe("1");
    expect(statValue("Adapter-Ready")).toBe("1");
    expect(statValue("Models Configured")).toBe("1");

    for (const banned of ["z.ai", "Cerebras", "Alibaba", "OpenCode"]) {
      expect(screen.queryByText(new RegExp(banned, "i"))).not.toBeInTheDocument();
    }
  });

  test("never presents execution, telemetry or cost figures as real — states they are not yet available", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });
    render(<Dashboard />);
    expect(
      await screen.findByText(/routing execution, live traffic telemetry \(requests\/success\/latency\/fallbacks\) and cost/i),
    ).toBeInTheDocument();
  });

  test("shows a failed-to-load state with retry when the API call fails", async () => {
    vi.mocked(api.listVendors)
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL_SERVER_ERROR", "boom", "req-1"))
      .mockResolvedValueOnce({ vendors: [] });

    render(<Dashboard />);

    expect(await screen.findByText(/failed to load dashboard/i)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/no providers configured/i)).toBeInTheDocument());
  });
});
