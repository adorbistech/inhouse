import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Vendors } from "./Vendors";
import type { VendorApi, VendorDetailApi } from "../types/api";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      listVendors: vi.fn(),
      getVendor: vi.fn(),
      createVendor: vi.fn(),
      updateVendor: vi.fn(),
      disableVendor: vi.fn(),
      enableVendor: vi.fn(),
      setVendorCapabilities: vi.fn(),
      setVendorWorkloads: vi.fn(),
      listAccounts: vi.fn(),
      createAccount: vi.fn(),
      updateAccount: vi.fn(),
      disableAccount: vi.fn(),
      listCredentials: vi.fn(),
      createCredential: vi.fn(),
      updateCredential: vi.fn(),
      deleteCredential: vi.fn(),
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

function toDetail(vendor: VendorApi, extra: Partial<VendorDetailApi> = {}): VendorDetailApi {
  return { ...vendor, accounts: [], capabilities: [], workloads: [], ...extra };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.listCapabilities).mockResolvedValue({ capabilities: [] });
  vi.mocked(api.listWorkloads).mockResolvedValue({ workloads: [] });
  vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [] });
});

describe("Vendors page", () => {
  test("shows a loading state while vendors are being fetched", async () => {
    vi.mocked(api.listVendors).mockReturnValue(new Promise(() => {}));
    render(<Vendors />);
    expect(await screen.findByText(/loading vendors/i)).toBeInTheDocument();
  });

  test("shows an error state with a retry action when the vendor list fails to load", async () => {
    vi.mocked(api.listVendors)
      .mockRejectedValueOnce(new ApiError(500, "INTERNAL_SERVER_ERROR", "boom", "req-1"))
      .mockResolvedValueOnce({ vendors: [] });

    render(<Vendors />);
    expect(await screen.findByText(/failed to load vendors/i)).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText(/no vendors configured/i)).toBeInTheDocument());
  });

  test("shows an empty state when there are no vendors", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [] });
    render(<Vendors />);
    expect(await screen.findByText(/no vendors configured/i)).toBeInTheDocument();
  });

  test("renders the vendor list and shows detail for the selected vendor", async () => {
    const vendor = sampleVendor();
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });

    render(<Vendors />);

    expect(await screen.findByText("Test Vendor")).toBeInTheDocument();
    await waitFor(() => expect(api.getVendor).toHaveBeenCalledWith("vnd_1"));
    expect(await screen.findByText(/inspector:/i)).toBeInTheDocument();
  });

  test("Add Vendor: submitting the form calls api.createVendor with the expected payload", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [] });
    const created = sampleVendor({ id: "vnd_new", slug: "new-vendor", displayName: "New Vendor" });
    vi.mocked(api.createVendor).mockResolvedValue({ vendor: toDetail(created) });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(created) });

    render(<Vendors />);
    await screen.findByText(/no vendors configured/i);

    await userEvent.click(screen.getByRole("button", { name: /add vendor/i }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText(/vendor slug/i), "new-vendor");
    await userEvent.type(within(dialog).getByLabelText(/vendor name/i), "New Vendor");

    await userEvent.click(within(dialog).getByRole("button", { name: /^add vendor$/i }));

    await waitFor(() => expect(api.createVendor).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.createVendor).mock.calls[0]?.[0];
    expect(payload?.slug).toBe("new-vendor");
    expect(payload?.displayName).toBe("New Vendor");
    // The Add Vendor form must never collect a raw provider secret.
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("apiKey");
  });

  test("disabling a vendor from the card menu calls api.disableVendor", async () => {
    const vendor = sampleVendor();
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });
    vi.mocked(api.disableVendor).mockResolvedValue({ vendor: toDetail({ ...vendor, status: "disabled" }) });

    render(<Vendors />);
    await screen.findByText("Test Vendor");

    await userEvent.click(screen.getByRole("button", { name: /vendor actions/i }));
    await userEvent.click(screen.getByRole("button", { name: /^disable$/i }));

    await waitFor(() => expect(api.disableVendor).toHaveBeenCalledWith("vnd_1"));
  });

  test("switching the selected account updates which credential is displayed", async () => {
    const vendor = sampleVendor();
    const detail = toDetail(vendor, {
      accounts: [
        {
          id: "acct_1",
          vendorId: "vnd_1",
          slug: "primary",
          displayName: "Primary Account",
          status: "enabled",
          externalAccountRef: null,
          createdAt: "2026-09-19T00:00:00Z",
          updatedAt: "2026-09-19T00:00:00Z",
        },
        {
          id: "acct_2",
          vendorId: "vnd_1",
          slug: "secondary",
          displayName: "Secondary Account",
          status: "enabled",
          externalAccountRef: null,
          createdAt: "2026-09-19T00:00:00Z",
          updatedAt: "2026-09-19T00:00:00Z",
        },
      ],
    });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: detail });
    vi.mocked(api.listCredentials).mockResolvedValue({
      credentials: [
        {
          id: "cred_2",
          vendorAccountId: "acct_2",
          credentialType: "api_key",
          status: "enabled",
          secretRef: "vault://secondary",
          createdAt: "2026-09-19T00:00:00Z",
          updatedAt: "2026-09-19T00:00:00Z",
          lastTestedAt: null,
          lastSuccessfulAt: null,
        },
      ],
    });

    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(screen.getByRole("button", { name: /credential/i }));

    expect(await screen.findByText(/no credential configured/i)).toBeInTheDocument();

    await userEvent.click(screen.getByText("Secondary Account"));
    expect(await screen.findByText(/vault:\/\/secondary/)).toBeInTheDocument();
  });

  test("capabilities tab shows a data-driven empty state instead of hardcoded options", async () => {
    const vendor = sampleVendor();
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });

    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(screen.getByRole("button", { name: /^capabilities$/i }));

    expect(await screen.findByText(/no capabilities are defined/i)).toBeInTheDocument();
  });
});
