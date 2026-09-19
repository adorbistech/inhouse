import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings";
import type { CapabilityApi, ModelApi, ModelDetailApi, VendorApi, WorkloadApi } from "../types/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      listModels: vi.fn(),
      getModel: vi.fn(),
      createModel: vi.fn(),
      updateModel: vi.fn(),
      disableModel: vi.fn(),
      enableModel: vi.fn(),
      setModelCapabilities: vi.fn(),
      setModelWorkloads: vi.fn(),
      listVendors: vi.fn(),
      listCapabilities: vi.fn(),
      listWorkloads: vi.fn(),
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

function toDetail(model: ModelApi, extra: Partial<ModelDetailApi> = {}): ModelDetailApi {
  return { ...model, capabilities: [], workloads: [], ...extra };
}

function sampleCapability(overrides: Partial<CapabilityApi> = {}): CapabilityApi {
  return {
    id: "cap_1",
    slug: "vision",
    displayName: "Vision",
    description: "Image understanding.",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

function sampleWorkload(overrides: Partial<WorkloadApi> = {}): WorkloadApi {
  return {
    id: "wl_1",
    slug: "coding_agent",
    displayName: "Coding Agent",
    description: "Coding agent traffic.",
    status: "enabled",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
    ...overrides,
  };
}

async function openModelsTab() {
  render(<Settings />);
  await userEvent.click(screen.getByRole("button", { name: /^models$/i }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listModels).mockResolvedValue({ models: [] });
  vi.mocked(api.listVendors).mockResolvedValue({ vendors: [] });
  vi.mocked(api.listCapabilities).mockResolvedValue({ capabilities: [] });
  vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [] });
});

describe("Settings — Models tab", () => {
  test("renders the Model Catalog panel when the Models tab is selected", async () => {
    await openModelsTab();
    expect(await screen.findByText("Model Catalog")).toBeInTheDocument();
  });

  test("shows an empty state when there are no models", async () => {
    await openModelsTab();
    expect(await screen.findByText(/no models match the current filters/i)).toBeInTheDocument();
  });

  test("displays models returned from the API", async () => {
    const model = sampleModel();
    vi.mocked(api.listModels).mockResolvedValue({ models: [model] });
    vi.mocked(api.getModel).mockResolvedValue({ model: toDetail(model) });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });

    await openModelsTab();

    expect(await screen.findByText("Test Model")).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getByText("provider-model-1")).toBeInTheDocument();
    expect(within(table).getByText("inhouse-alias-1")).toBeInTheDocument();
    expect(within(table).getByText("Test Vendor")).toBeInTheDocument();
  });

  test("shows a failed-to-load state with retry when the model list fails", async () => {
    vi.mocked(api.listModels)
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL_SERVER_ERROR", "boom", "req-1"))
      .mockResolvedValueOnce({ models: [] });

    await openModelsTab();

    expect(await screen.findByText(/failed to load models/i)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/no models match the current filters/i)).toBeInTheDocument());
  });

  test("Add Model drawer opens from the Model Catalog panel", async () => {
    await openModelsTab();
    await screen.findByText(/no models match the current filters/i);

    await userEvent.click(screen.getByRole("button", { name: /add model/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByText(/register a model that belongs to an existing vendor/i)).toBeInTheDocument();
  });

  test("the submit button stays disabled until required fields are filled", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });

    await openModelsTab();
    await screen.findByText(/no models match the current filters/i);
    await userEvent.click(screen.getByRole("button", { name: /add model/i }));

    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: /^add model$/i });
    expect(submit).toBeDisabled();

    await userEvent.selectOptions(within(dialog).getByLabelText(/^vendor$/i), "vnd_1");
    await userEvent.type(within(dialog).getByLabelText(/provider model id/i), "provider-model-2");
    await userEvent.type(within(dialog).getByLabelText(/inhouse alias/i), "inhouse-alias-2");
    expect(submit).toBeDisabled();

    await userEvent.type(within(dialog).getByLabelText(/display name/i), "New Model");
    expect(submit).toBeEnabled();
  });

  test("submitting the Add Model form calls api.createModel with the expected payload, including selected capabilities and workloads", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });
    vi.mocked(api.listCapabilities).mockResolvedValue({ capabilities: [sampleCapability()] });
    vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [sampleWorkload()] });
    const created = sampleModel({ id: "mdl_new" });
    vi.mocked(api.createModel).mockResolvedValue({ model: toDetail(created) });

    await openModelsTab();
    await screen.findByText(/no models match the current filters/i);
    await userEvent.click(screen.getByRole("button", { name: /add model/i }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^vendor$/i), "vnd_1");
    await userEvent.type(within(dialog).getByLabelText(/provider model id/i), "provider-model-2");
    await userEvent.type(within(dialog).getByLabelText(/inhouse alias/i), "inhouse-alias-2");
    await userEvent.type(within(dialog).getByLabelText(/display name/i), "New Model");

    await userEvent.click(within(dialog).getByText(/vision/i));
    await userEvent.click(within(dialog).getByText(/coding_agent/i));

    // Once selected, listModels is called again to refresh — set up its next
    // resolution before submitting so the refresh doesn't hang.
    vi.mocked(api.listModels).mockResolvedValue({ models: [created] });
    vi.mocked(api.getModel).mockResolvedValue({ model: toDetail(created) });

    await userEvent.click(within(dialog).getByRole("button", { name: /^add model$/i }));

    await waitFor(() => expect(api.createModel).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.createModel).mock.calls[0]?.[0];
    expect(payload?.vendorId).toBe("vnd_1");
    expect(payload?.providerModelId).toBe("provider-model-2");
    expect(payload?.inhouseAlias).toBe("inhouse-alias-2");
    expect(payload?.displayName).toBe("New Model");
    expect(payload?.capabilityIds).toEqual(["cap_1"]);
    expect(payload?.workloadIds).toEqual(["wl_1"]);
  });

  test("a successful create refreshes the model list and closes the drawer", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });
    const created = sampleModel({ id: "mdl_new", displayName: "Freshly Created" });
    vi.mocked(api.createModel).mockResolvedValue({ model: toDetail(created) });

    await openModelsTab();
    await screen.findByText(/no models match the current filters/i);
    await userEvent.click(screen.getByRole("button", { name: /add model/i }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^vendor$/i), "vnd_1");
    await userEvent.type(within(dialog).getByLabelText(/provider model id/i), "provider-model-2");
    await userEvent.type(within(dialog).getByLabelText(/inhouse alias/i), "inhouse-alias-2");
    await userEvent.type(within(dialog).getByLabelText(/display name/i), "Freshly Created");

    vi.mocked(api.listModels).mockResolvedValue({ models: [created] });
    vi.mocked(api.getModel).mockResolvedValue({ model: toDetail(created) });

    await userEvent.click(within(dialog).getByRole("button", { name: /^add model$/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Freshly Created")).toBeInTheDocument();
  });

  test("an API error on create is surfaced inside the drawer without closing it", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [sampleVendor()] });
    vi.mocked(api.createModel).mockRejectedValue(
      new ApiError(409, "CONFLICT", 'A model with alias "inhouse-alias-2" already exists.', "req-2"),
    );

    await openModelsTab();
    await screen.findByText(/no models match the current filters/i);
    await userEvent.click(screen.getByRole("button", { name: /add model/i }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^vendor$/i), "vnd_1");
    await userEvent.type(within(dialog).getByLabelText(/provider model id/i), "provider-model-2");
    await userEvent.type(within(dialog).getByLabelText(/inhouse alias/i), "inhouse-alias-2");
    await userEvent.type(within(dialog).getByLabelText(/display name/i), "New Model");

    await userEvent.click(within(dialog).getByRole("button", { name: /^add model$/i }));

    expect(await within(dialog).findByText(/already exists/i)).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  test("toggling a model's status calls api.disableModel or api.enableModel", async () => {
    const model = sampleModel();
    vi.mocked(api.listModels).mockResolvedValue({ models: [model] });
    vi.mocked(api.getModel).mockResolvedValue({ model: toDetail(model) });
    vi.mocked(api.disableModel).mockResolvedValue({ model: toDetail({ ...model, status: "disabled" }) });

    await openModelsTab();
    await screen.findByText("Test Model");

    await userEvent.click(screen.getByRole("button", { name: /^disable$/i }));

    await waitFor(() => expect(api.disableModel).toHaveBeenCalledWith("mdl_1"));
  });
});
