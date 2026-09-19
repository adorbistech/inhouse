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
      getAccountHealth: vi.fn(),
      getAccountHealthEvents: vi.fn(),
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
  vi.mocked(api.getAccountHealth).mockResolvedValue({
    health: {
      vendorAccountId: "acct_1",
      status: "unknown",
      consecutiveFailures: 0,
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastErrorCategory: null,
      lastSafeErrorCode: null,
    },
  });
  vi.mocked(api.getAccountHealthEvents).mockResolvedValue({ events: [] });
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
          hasManagedSecret: false,
          maskedSecret: null,
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

describe("Vendors page — Credential Vault (Block 08)", () => {
  const primaryAccount = {
    id: "acct_1",
    vendorId: "vnd_1",
    slug: "primary",
    displayName: "Primary Account",
    status: "enabled" as const,
    externalAccountRef: null,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
  };

  function managedCredential(overrides: Record<string, unknown> = {}) {
    return {
      id: "cred_managed",
      vendorAccountId: "acct_1",
      credentialType: "api_key",
      status: "enabled" as const,
      secretRef: null,
      hasManagedSecret: true,
      maskedSecret: "****...wxyz",
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      lastTestedAt: null,
      lastSuccessfulAt: null,
      ...overrides,
    };
  }

  async function openCredentialTabWithAccount() {
    const vendor = sampleVendor();
    const detail = toDetail(vendor, { accounts: [primaryAccount] });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: detail });
    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(screen.getByRole("button", { name: /credential/i }));
    return vendor;
  }

  test("an Inhouse-vault-managed credential displays only the masked value, never a raw secret", async () => {
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [managedCredential()] });
    await openCredentialTabWithAccount();

    expect(await screen.findByText(/\*\*\*\*\.\.\.wxyz/)).toBeInTheDocument();
    expect(screen.getByText(/inhouse vault/i)).toBeInTheDocument();
    expect(screen.queryByText("sk-raw-secret-value")).not.toBeInTheDocument();
  });

  test("Add Credential defaults to Inhouse Vault mode and the save button is disabled until a secret is entered", async () => {
    await openCredentialTabWithAccount();
    await screen.findByText(/no credential configured/i);

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));

    const saveButton = screen.getByRole("button", { name: /^save credential$/i });
    expect(saveButton).toBeDisabled();

    const secretInput = screen.getByPlaceholderText(/paste the provider secret/i);
    expect(secretInput).toHaveAttribute("type", "password");

    await userEvent.type(secretInput, "sk-raw-secret-value");
    expect(saveButton).toBeEnabled();
  });

  test("submitting in Inhouse Vault mode calls createCredential with `secret`, never `secretRef`, and clears the field", async () => {
    const vendor = await openCredentialTabWithAccount();
    await screen.findByText(/no credential configured/i);
    vi.mocked(api.createCredential).mockResolvedValue({ credential: managedCredential() });
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [managedCredential()] });

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-raw-secret-value");
    await userEvent.click(screen.getByRole("button", { name: /^save credential$/i }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledTimes(1));
    const [calledVendorId, payload] = vi.mocked(api.createCredential).mock.calls[0]!;
    expect(calledVendorId).toBe(vendor.id);
    expect(payload).toMatchObject({ vendorAccountId: "acct_1", credentialType: "api_key", secret: "sk-raw-secret-value" });
    expect(payload).not.toHaveProperty("secretRef");

    // The raw secret never lingers in the DOM after a successful save.
    await waitFor(() => expect(screen.queryByPlaceholderText(/paste the provider secret/i)).not.toBeInTheDocument());
    expect(screen.queryByText("sk-raw-secret-value")).not.toBeInTheDocument();
  });

  test("switching to External Reference mode calls createCredential with `secretRef`, never `secret`", async () => {
    await openCredentialTabWithAccount();
    await screen.findByText(/no credential configured/i);
    vi.mocked(api.createCredential).mockResolvedValue({
      credential: managedCredential({ hasManagedSecret: false, maskedSecret: null, secretRef: "vault://external/path" }),
    });

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));
    await userEvent.click(screen.getByRole("button", { name: /external reference/i }));

    const saveButton = screen.getByRole("button", { name: /^save credential$/i });
    expect(saveButton).toBeDisabled();

    await userEvent.type(screen.getByPlaceholderText(/vault:\/\/inhouse/i), "vault://external/path");
    expect(saveButton).toBeEnabled();
    await userEvent.click(saveButton);

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.createCredential).mock.calls[0]![1];
    expect(payload).toMatchObject({ vendorAccountId: "acct_1", credentialType: "api_key", secretRef: "vault://external/path" });
    expect(payload).not.toHaveProperty("secret");
  });

  test("Rotate Secret submits a new managed secret via updateCredential and clears the field", async () => {
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [managedCredential()] });
    const vendor = await openCredentialTabWithAccount();
    await screen.findByText(/\*\*\*\*\.\.\.wxyz/);
    vi.mocked(api.updateCredential).mockResolvedValue({
      credential: managedCredential({ maskedSecret: "****...9999" }),
    });

    await userEvent.click(screen.getByRole("button", { name: /rotate secret/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the new provider secret/i), "sk-rotated-secret");
    await userEvent.click(screen.getByRole("button", { name: /^save new secret$/i }));

    await waitFor(() => expect(api.updateCredential).toHaveBeenCalledWith(vendor.id, "cred_managed", { secret: "sk-rotated-secret" }));
    await waitFor(() => expect(screen.queryByPlaceholderText(/paste the new provider secret/i)).not.toBeInTheDocument());
    expect(screen.queryByText("sk-rotated-secret")).not.toBeInTheDocument();
  });

  test("the Disable/Enable control toggles credential status via updateCredential", async () => {
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [managedCredential()] });
    const vendor = await openCredentialTabWithAccount();
    await screen.findByText(/\*\*\*\*\.\.\.wxyz/);
    vi.mocked(api.updateCredential).mockResolvedValue({ credential: managedCredential({ status: "disabled" }) });

    await userEvent.click(screen.getByRole("button", { name: /^disable$/i }));

    await waitFor(() =>
      expect(api.updateCredential).toHaveBeenCalledWith(vendor.id, "cred_managed", { status: "disabled" }),
    );
  });

  test("a failed credential creation surfaces the API error message without crashing", async () => {
    await openCredentialTabWithAccount();
    await screen.findByText(/no credential configured/i);
    vi.mocked(api.createCredential).mockRejectedValue(
      new ApiError(400, "VALIDATION_ERROR", 'Exactly one of "secret" or "secretRef" must be provided.', "req-3"),
    );

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-raw-secret-value");
    await userEvent.click(screen.getByRole("button", { name: /^save credential$/i }));

    expect(await screen.findByText(/exactly one of "secret" or "secretref" must be provided/i)).toBeInTheDocument();
  });
});

describe("Vendors page — Provider Health (Block 09)", () => {
  const primaryAccount = {
    id: "acct_1",
    vendorId: "vnd_1",
    slug: "primary",
    displayName: "Primary Account",
    status: "enabled" as const,
    externalAccountRef: null,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
  };

  async function renderWithAccount() {
    const vendor = sampleVendor();
    const detail = toDetail(vendor, { accounts: [primaryAccount] });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: detail });
    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(screen.getByRole("button", { name: /credential/i }));
    return vendor;
  }

  test("shows 'Unknown — Not Checked' when an account has never been observed", async () => {
    await renderWithAccount();
    expect(await screen.findByText(/unknown — not checked/i)).toBeInTheDocument();
  });

  test("displays a healthy account's status, latency, and last-checked time", async () => {
    vi.mocked(api.getAccountHealth).mockResolvedValue({
      health: {
        vendorAccountId: "acct_1",
        status: "healthy",
        consecutiveFailures: 0,
        lastCheckedAt: "2026-09-19T12:00:00.000Z",
        lastSuccessAt: "2026-09-19T12:00:00.000Z",
        lastFailureAt: null,
        lastLatencyMs: 180,
        lastErrorCategory: null,
        lastSafeErrorCode: null,
      },
    });

    await renderWithAccount();

    expect(await screen.findByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("180ms latency")).toBeInTheDocument();
  });

  test("displays an unhealthy account's safe error category without any raw error/credential detail", async () => {
    vi.mocked(api.getAccountHealth).mockResolvedValue({
      health: {
        vendorAccountId: "acct_1",
        status: "unhealthy",
        consecutiveFailures: 4,
        lastCheckedAt: "2026-09-19T12:00:00.000Z",
        lastSuccessAt: null,
        lastFailureAt: "2026-09-19T12:00:00.000Z",
        lastLatencyMs: null,
        lastErrorCategory: "authentication",
        lastSafeErrorCode: "401",
      },
    });

    await renderWithAccount();

    expect(await screen.findByText("Unhealthy")).toBeInTheDocument();
    expect(screen.getByText("Authentication")).toBeInTheDocument();
    // Never a raw provider error body, an API key, or a secret of any kind.
    const body = document.body.textContent ?? "";
    expect(body).not.toMatch(/sk-[a-zA-Z0-9]/);
    expect(body.toLowerCase()).not.toContain("bearer ");
  });

  test("degraded status renders distinctly from healthy and unhealthy", async () => {
    vi.mocked(api.getAccountHealth).mockResolvedValue({
      health: {
        vendorAccountId: "acct_1",
        status: "degraded",
        consecutiveFailures: 0,
        lastCheckedAt: "2026-09-19T12:00:00.000Z",
        lastSuccessAt: "2026-09-19T12:00:00.000Z",
        lastFailureAt: null,
        lastLatencyMs: 4200,
        lastErrorCategory: "rate_limit",
        lastSafeErrorCode: "429",
      },
    });

    await renderWithAccount();

    expect(await screen.findByText("Degraded")).toBeInTheDocument();
  });

  test("a failed health fetch does not crash the page and falls back to an unknown display", async () => {
    vi.mocked(api.getAccountHealth).mockRejectedValue(new Error("network error"));

    await renderWithAccount();

    expect(await screen.findByText(/unknown — not checked/i)).toBeInTheDocument();
  });
});
