import { describe, test, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Vendors } from "./Vendors";
import type { AccountReadinessApi, VendorApi, VendorDetailApi } from "../types/api";

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
      getAccountReadiness: vi.fn(),
      getAccountHealthEvents: vi.fn(),
      verifyAccount: vi.fn(),
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

function toDetail(vendor: VendorApi, extra: Partial<VendorDetailApi> = {}): VendorDetailApi {
  return { ...vendor, accounts: [], capabilities: [], workloads: [], ...extra };
}

function sampleReadiness(accountId: string, overrides: Partial<AccountReadinessApi> = {}): AccountReadinessApi {
  return {
    readiness: "unverified",
    reason: "never_verified",
    vendorId: "vnd_1",
    vendorAccountId: accountId,
    vendorStatus: "enabled",
    accountStatus: "enabled",
    adapterSupported: true,
    credential: { present: true, enabled: true, usable: true, lastTestedAt: null, lastSuccessfulAt: null },
    health: {
      status: "unknown",
      lastCheckedAt: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
      lastLatencyMs: null,
      lastErrorCategory: null,
      lastSafeErrorCode: null,
    },
    ...overrides,
  };
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
  vi.mocked(api.getAccountReadiness).mockImplementation(async (vendorId, accountId) => ({
    readiness: sampleReadiness(accountId, { vendorId }),
  }));
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
    // Deliberately do NOT touch the API Protocol dropdown: the untouched default must be executable.

    await userEvent.click(within(dialog).getByRole("button", { name: /^add vendor$/i }));

    await waitFor(() => expect(api.createVendor).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(api.createVendor).mock.calls[0]?.[0];
    expect(payload?.slug).toBe("new-vendor");
    expect(payload?.displayName).toBe("New Vendor");
    // The untouched default must be the backend adapter's canonical protocol id (exact-match registry).
    expect(payload?.protocol).toBe("openai-compatible");
    // The Add Vendor form must never collect a raw provider secret.
    expect(payload).not.toHaveProperty("secret");
    expect(payload).not.toHaveProperty("apiKey");
  });

  test("Add Vendor offers only executable protocols: no underscore or adapter-less option", async () => {
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [] });
    render(<Vendors />);
    await screen.findByText(/no vendors configured/i);
    await userEvent.click(screen.getByRole("button", { name: /add vendor/i }));
    const dialog = await screen.findByRole("dialog");
    const select = within(dialog).getByLabelText(/api protocol/i) as HTMLSelectElement;
    expect(select.value).toBe("openai-compatible");
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["openai-compatible"]);
  });

  test("disabling a vendor from the card menu calls api.disableVendor", async () => {
    const vendor = sampleVendor();
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });
    vi.mocked(api.disableVendor).mockResolvedValue({ vendor: toDetail({ ...vendor, status: "disabled" }) });

    render(<Vendors />);
    await screen.findByText("Test Vendor");

    await userEvent.click(await screen.findByRole("button", { name: /vendor actions/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^disable$/i }));

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
    await userEvent.click(await screen.findByRole("button", { name: /credential/i }));

    expect(await screen.findByText(/no credentials configured/i)).toBeInTheDocument();

    await userEvent.click(await screen.findByText("Secondary Account"));
    const credentialsRegion = await screen.findByRole("region", { name: /account credentials/i });
    expect(await within(credentialsRegion).findByText("External Reference")).toBeInTheDocument();
    expect(screen.queryByText(/no credentials configured/i)).not.toBeInTheDocument();
  });

  test("Block 10: a vendor with no registered adapter for its protocol shows 'No Adapter', never as executable", async () => {
    const vendor = sampleVendor({ adapterSupported: false });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });

    render(<Vendors />);

    expect(await screen.findByText("Test Vendor")).toBeInTheDocument();
    expect(screen.getByText(/no adapter/i)).toBeInTheDocument();
    expect(screen.queryByText(/adapter ready/i)).not.toBeInTheDocument();
  });

  test("Block 10: a vendor whose protocol has a registered adapter shows 'Adapter Ready'", async () => {
    const vendor = sampleVendor({ adapterSupported: true, protocol: "openai-compatible" });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });

    render(<Vendors />);

    expect(await screen.findByText("Test Vendor")).toBeInTheDocument();
    expect(screen.getByText(/adapter ready/i)).toBeInTheDocument();
  });

  test("capabilities tab shows a data-driven empty state instead of hardcoded options", async () => {
    const vendor = sampleVendor();
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor) });

    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(await screen.findByRole("button", { name: /^capabilities$/i }));

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
    await userEvent.click(await screen.findByRole("button", { name: /credential/i }));
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
    await screen.findByText(/no credentials configured/i);

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
    await screen.findByText(/no credentials configured/i);
    vi.mocked(api.createCredential).mockResolvedValue({ credential: managedCredential() });
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [managedCredential()] });

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-raw-secret-value");
    await userEvent.click(screen.getByRole("button", { name: /^save credential$/i }));

    await waitFor(() => expect(api.createCredential).toHaveBeenCalledTimes(1));
    const [calledVendorId, payload] = vi.mocked(api.createCredential).mock.calls[0]!;
    expect(calledVendorId).toBe(vendor.id);
    expect(payload).toMatchObject({ vendorAccountId: "acct_1", credentialType: "api-key", secret: "sk-raw-secret-value" });
    expect(payload).not.toHaveProperty("secretRef");

    // The raw secret never lingers in the DOM after a successful save.
    await waitFor(() => expect(screen.queryByPlaceholderText(/paste the provider secret/i)).not.toBeInTheDocument());
    expect(screen.queryByText("sk-raw-secret-value")).not.toBeInTheDocument();
  });

  test("switching to External Reference mode calls createCredential with `secretRef`, never `secret`", async () => {
    await openCredentialTabWithAccount();
    await screen.findByText(/no credentials configured/i);
    vi.mocked(api.createCredential).mockResolvedValue({
      credential: managedCredential({ hasManagedSecret: false, maskedSecret: null }),
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
    expect(payload).toMatchObject({ vendorAccountId: "acct_1", credentialType: "api-key", secretRef: "vault://external/path" });
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
    await screen.findByText(/no credentials configured/i);
    vi.mocked(api.createCredential).mockRejectedValue(
      new ApiError(400, "VALIDATION_ERROR", 'Exactly one of "secret" or "secretRef" must be provided.', "req-3"),
    );

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-raw-secret-value");
    await userEvent.click(screen.getByRole("button", { name: /^save credential$/i }));

    expect(await screen.findByText(/exactly one of "secret" or "secretref" must be provided/i)).toBeInTheDocument();
  });

  test("a failed credential creation does not retain the raw secret in the form", async () => {
    await openCredentialTabWithAccount();
    await screen.findByText(/no credentials configured/i);
    vi.mocked(api.createCredential).mockRejectedValue(new ApiError(500, "INTERNAL_ERROR", "Vault unavailable.", "req-4"));

    await userEvent.click(screen.getByRole("button", { name: /add credential/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-raw-secret-value");
    await userEvent.click(screen.getByRole("button", { name: /^save credential$/i }));

    expect(await screen.findByText(/vault unavailable/i)).toBeInTheDocument();
    // The form may stay open for a retry, but the typed secret must be gone from state and DOM.
    expect(screen.getByPlaceholderText(/paste the provider secret/i)).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("sk-raw-secret-value");
    expect(window.sessionStorage.length + window.localStorage.length).toBe(0);
  });

  test("a failed secret rotation does not retain the new raw secret in the form", async () => {
    vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [managedCredential()] });
    await openCredentialTabWithAccount();
    await screen.findByText(/\*\*\*\*\.\.\.wxyz/);
    vi.mocked(api.updateCredential).mockRejectedValue(new ApiError(500, "INTERNAL_ERROR", "Vault unavailable.", "req-5"));

    await userEvent.click(await screen.findByRole("button", { name: /rotate secret/i }));
    await userEvent.type(screen.getByPlaceholderText(/paste the new provider secret/i), "sk-rotated-secret");
    await userEvent.click(screen.getByRole("button", { name: /^save new secret$/i }));

    expect(await screen.findByText(/vault unavailable/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste the new provider secret/i)).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("sk-rotated-secret");
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

  async function renderWithAccount(vendorOverrides: Partial<VendorApi> = {}) {
    const vendor = sampleVendor(vendorOverrides);
    const detail = toDetail(vendor, { accounts: [primaryAccount] });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: detail });
    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(await screen.findByRole("button", { name: /credential/i }));
    return vendor;
  }

  test("shows 'Unknown — Not Checked' when an account has never been observed", async () => {
    await renderWithAccount();
    expect(await screen.findByText(/not verified/i)).toBeInTheDocument();
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

  test("a failed health fetch does not crash the page and shows an explicit error, not a fake status", async () => {
    vi.mocked(api.getAccountHealth).mockRejectedValue(new Error("network error"));

    await renderWithAccount();

    const region = await screen.findByRole("region", { name: /account health/i });
    expect(await within(region).findByRole("alert")).toHaveTextContent("Failed to load account health.");
    expect(within(region).queryByText(/not verified/i)).not.toBeInTheDocument();
  });

  test("Verify Account runs verification, shows the safe result and refreshes health", async () => {
    vi.mocked(api.verifyAccount).mockResolvedValue({
      verification: {
        vendorId: "v1",
        vendorAccountId: "acct_1",
        protocol: "openai-compatible",
        status: "unhealthy",
        latencyMs: 42,
        errorCategory: "authentication",
        safeErrorCode: "401",
        message: "Verification failed (authentication).",
        checkedAt: "2026-09-19T12:00:00.000Z",
      },
    });
    await renderWithAccount({ adapterSupported: true });

    await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));

    expect(await screen.findByText(/Verification: Unhealthy/)).toBeInTheDocument();
    expect(screen.getByText("Code: 401")).toBeInTheDocument();
    expect(screen.getByText("42ms latency")).toBeInTheDocument();
    expect(api.verifyAccount).toHaveBeenCalledTimes(1);
    expect(api.getAccountHealth).toHaveBeenCalledTimes(2);
  });

  test("Verify Account is disabled when the vendor has no adapter", async () => {
    await renderWithAccount({ adapterSupported: false });
    expect(await screen.findByRole("button", { name: /verify account/i })).toBeDisabled();
  });

  const verificationFor = (accountId: string) => ({
    vendorId: "vnd_1",
    vendorAccountId: accountId,
    protocol: "openai-compatible",
    status: "healthy" as const,
    latencyMs: 7,
    errorCategory: null,
    safeErrorCode: null,
    message: `Verified ${accountId}.`,
    checkedAt: "2026-09-19T12:00:00.000Z",
  });
  const healthFor = (accountId: string, status: "healthy" | "unknown") => ({
    health: {
      vendorAccountId: accountId,
      status,
      consecutiveFailures: 0,
      lastCheckedAt: status === "healthy" ? "2026-09-19T12:00:00.000Z" : null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastLatencyMs: null,
      lastErrorCategory: null,
      lastSafeErrorCode: null,
    },
  });

  test("Verify Account is disabled when the vendor itself is disabled", async () => {
    await renderWithAccount({ adapterSupported: true, status: "disabled" });
    expect(await screen.findByRole("button", { name: /verify account/i })).toBeDisabled();
  });

  test("a verification started for one account is never shown under, or applied to, another account", async () => {
    const secondAccount = { ...primaryAccount, id: "acct_2", slug: "secondary", displayName: "Secondary Account" };
    const vendor = sampleVendor({ adapterSupported: true });
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor, { accounts: [primaryAccount, secondAccount] }) });
    vi.mocked(api.getAccountHealth).mockImplementation(async (_vendorId, accountId) =>
      healthFor(accountId, "unknown"),
    );
    let finish: (v: { verification: ReturnType<typeof verificationFor> }) => void = () => {};
    vi.mocked(api.verifyAccount).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(await screen.findByRole("button", { name: /credential/i }));

    await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));
    expect(await screen.findByRole("button", { name: /verifying/i })).toBeDisabled();

    await userEvent.click(await screen.findByText("Secondary Account"));
    // Account B has no verification in flight, so it can be verified independently.
    expect(await screen.findByRole("button", { name: /verify account/i })).toBeEnabled();

    vi.mocked(api.getAccountHealth).mockImplementation(async (_vendorId, accountId) =>
      healthFor(accountId, accountId === "acct_1" ? "healthy" : "unknown"),
    );
    finish({ verification: verificationFor("acct_1") });
    await waitFor(() => expect(api.getAccountHealth).toHaveBeenCalledWith("vnd_1", "acct_1"));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByText(/Verified acct_1/)).not.toBeInTheDocument();
    expect(await screen.findByText(/not verified/i)).toBeInTheDocument();

    await userEvent.click(await screen.findByText("Primary Account"));
    expect(await screen.findByText("Verified acct_1.")).toBeInTheDocument();
  });

  test("a failed health refresh after a successful verification does not report a verification failure", async () => {
    vi.mocked(api.verifyAccount).mockResolvedValue({ verification: verificationFor("acct_1") });
    await renderWithAccount({ adapterSupported: true });
    await screen.findByText(/not verified/i);
    vi.mocked(api.getAccountHealth).mockRejectedValue(new Error("refresh failed"));

    await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));

    expect(await screen.findByText("Verified acct_1.")).toBeInTheDocument();
    expect(screen.getByText(/could not be refreshed/i)).toBeInTheDocument();
    expect(screen.queryByText(/failed to verify account/i)).not.toBeInTheDocument();
  });
});

describe("Vendors page — Account operational control plane (Block 14B-2)", () => {
  const acctA = {
    id: "acct_1",
    vendorId: "vnd_1",
    slug: "primary",
    displayName: "Primary Account",
    status: "enabled" as const,
    externalAccountRef: null as string | null,
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T00:00:00Z",
  };
  const acctB = { ...acctA, id: "acct_2", slug: "secondary", displayName: "Secondary Account" };

  const credential = (overrides: Record<string, unknown> = {}) => ({
    id: "cred_1",
    vendorAccountId: "acct_1",
    credentialType: "api_key",
    status: "enabled" as const,
    hasManagedSecret: true,
    maskedSecret: "****...wxyz",
    createdAt: "2026-09-19T00:00:00Z",
    updatedAt: "2026-09-19T01:00:00Z",
    lastTestedAt: "2026-09-19T12:00:00.000Z" as string | null,
    lastSuccessfulAt: null as string | null,
    ...overrides,
  });

  const healthSnapshot = (accountId: string, overrides: Record<string, unknown> = {}) => ({
    health: {
      vendorAccountId: accountId,
      status: "healthy" as const,
      consecutiveFailures: 0,
      lastCheckedAt: "2026-09-19T12:00:00.000Z" as string | null,
      lastSuccessAt: "2026-09-19T12:00:00.000Z" as string | null,
      lastFailureAt: null as string | null,
      lastLatencyMs: 180 as number | null,
      lastErrorCategory: null as null | "rate_limit" | "timeout",
      lastSafeErrorCode: null as string | null,
      ...overrides,
    },
  });

  const verification = (accountId: string, overrides: Record<string, unknown> = {}) => ({
    vendorId: "vnd_1",
    vendorAccountId: accountId,
    protocol: "openai-compatible",
    status: "healthy" as const,
    latencyMs: 7,
    errorCategory: null,
    safeErrorCode: null,
    message: `Verified ${accountId}.`,
    checkedAt: "2026-09-19T12:00:00.000Z",
    ...overrides,
  });

  async function open(opts: { vendor?: Partial<VendorApi>; accounts?: (typeof acctA)[] } = {}) {
    const vendor = sampleVendor({ adapterSupported: true, ...opts.vendor });
    const accounts = opts.accounts ?? [acctA];
    vi.mocked(api.listVendors).mockResolvedValue({ vendors: [vendor] });
    vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(vendor, { accounts }) });
    render(<Vendors />);
    await screen.findByText("Test Vendor");
    await userEvent.click(await screen.findByRole("button", { name: /credential/i }));
    await screen.findByRole("region", { name: /account details/i });
    return vendor;
  }

  const region = (name: RegExp) => screen.findByRole("region", { name });

  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  describe("account lifecycle", () => {
    test("an enabled account shows its name, slug, status, and empty external reference", async () => {
      await open();
      const details = await region(/account details/i);
      expect(within(details).getByText("Primary Account", { selector: "span.font-bold" })).toBeInTheDocument();
      expect(within(details).getByText("primary")).toBeInTheDocument();
      expect(within(details).getByText("enabled")).toBeInTheDocument();
      expect(within(details).getByText("External ref: —")).toBeInTheDocument();
      expect(within(details).getByRole("button", { name: /disable account/i })).toBeInTheDocument();
      expect(within(details).queryByRole("button", { name: /enable account/i })).not.toBeInTheDocument();
    });

    test("a disabled account shows its status and offers Enable, not Disable", async () => {
      await open({ accounts: [{ ...acctA, status: "disabled" as never, externalAccountRef: "acct-ref-9" }] });
      const details = await region(/account details/i);
      expect(within(details).getByText("disabled")).toBeInTheDocument();
      expect(within(details).getByText("External ref: acct-ref-9")).toBeInTheDocument();
      expect(within(details).getByRole("button", { name: /enable account/i })).toBeInTheDocument();
      expect(within(details).queryByRole("button", { name: /disable account/i })).not.toBeInTheDocument();
    });

    test("disabling requires confirmation, then calls the API and re-reads readiness from the backend", async () => {
      await open();
      vi.mocked(api.disableAccount).mockResolvedValue({ account: { ...acctA, status: "disabled" } });
      const details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /disable account/i }));
      expect(api.disableAccount).not.toHaveBeenCalled();

      const readinessCallsBefore = vi.mocked(api.getAccountReadiness).mock.calls.length;
      const vendorCallsBefore = vi.mocked(api.getVendor).mock.calls.length;
      vi.mocked(api.getVendor).mockResolvedValue({
        vendor: toDetail(sampleVendor({ adapterSupported: true }), { accounts: [{ ...acctA, status: "disabled" }] }),
      });
      vi.mocked(api.getAccountReadiness).mockResolvedValue({
        readiness: sampleReadiness("acct_1", { readiness: "disabled", reason: "account_not_enabled", accountStatus: "disabled" }),
      });
      await userEvent.click(within(details).getByRole("button", { name: /confirm disable/i }));

      await waitFor(() => expect(api.disableAccount).toHaveBeenCalledWith("vnd_1", "acct_1"));
      const readiness = await region(/account readiness/i);
      // "Disabled" appears twice by design: the readiness pill and the Account Status tile.
      expect(await within(readiness).findByText("account_not_enabled")).toBeInTheDocument();
      expect(within(readiness).getAllByText("Disabled")).toHaveLength(2);
      expect(vi.mocked(api.getAccountReadiness).mock.calls.length).toBeGreaterThan(readinessCallsBefore);
      expect(vi.mocked(api.getVendor).mock.calls.length).toBeGreaterThan(vendorCallsBefore);
      expect(await within(await region(/account details/i)).findByRole("button", { name: /enable account/i })).toBeInTheDocument();
    });

    test("cancelling the disable confirmation changes nothing", async () => {
      await open();
      const details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /disable account/i }));
      await userEvent.click(within(details).getByRole("button", { name: /^cancel$/i }));
      expect(api.disableAccount).not.toHaveBeenCalled();
      expect(within(details).getByRole("button", { name: /disable account/i })).toBeInTheDocument();
    });

    test("enabling calls updateAccount with status enabled and shows the backend's new readiness", async () => {
      await open({ accounts: [{ ...acctA, status: "disabled" as never }] });
      vi.mocked(api.updateAccount).mockResolvedValue({ account: acctA });
      vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(sampleVendor({ adapterSupported: true }), { accounts: [acctA] }) });
      vi.mocked(api.getAccountReadiness).mockResolvedValue({
        readiness: sampleReadiness("acct_1", { readiness: "ready", reason: "last_check_healthy" }),
      });

      await userEvent.click(within(await region(/account details/i)).getByRole("button", { name: /enable account/i }));

      await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith("vnd_1", "acct_1", { status: "enabled" }));
      expect(await within(await region(/account readiness/i)).findByText("Ready")).toBeInTheDocument();
      expect(await within(await region(/account details/i)).findByRole("button", { name: /disable account/i })).toBeInTheDocument();
    });

    test("a failed status change surfaces the error and leaves the account state as the server reports it", async () => {
      await open();
      vi.mocked(api.disableAccount).mockRejectedValue(new ApiError(500, "INTERNAL", "Could not disable.", "req-x"));
      const details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /disable account/i }));
      await userEvent.click(within(details).getByRole("button", { name: /confirm disable/i }));
      expect(await screen.findByText("Could not disable.")).toBeInTheDocument();
      expect(within(details).getByText("enabled")).toBeInTheDocument();
    });

    test("editing the display name sends only that field", async () => {
      await open();
      vi.mocked(api.updateAccount).mockResolvedValue({ account: { ...acctA, displayName: "Renamed" } });
      const details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /edit account/i }));
      const name = within(details).getByLabelText("Display Name");
      await userEvent.clear(name);
      await userEvent.type(name, "Renamed");
      await userEvent.click(within(details).getByRole("button", { name: /save account/i }));
      await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith("vnd_1", "acct_1", { displayName: "Renamed" }));
    });

    test("editing the slug sends only the slug", async () => {
      await open();
      vi.mocked(api.updateAccount).mockResolvedValue({ account: { ...acctA, slug: "new-slug" } });
      const details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /edit account/i }));
      const slug = within(details).getByLabelText("Slug");
      await userEvent.clear(slug);
      await userEvent.type(slug, "new-slug");
      await userEvent.click(within(details).getByRole("button", { name: /save account/i }));
      await waitFor(() => expect(api.updateAccount).toHaveBeenCalledWith("vnd_1", "acct_1", { slug: "new-slug" }));
    });

    test("the external account reference can be set, and cleared (sent as null)", async () => {
      await open();
      vi.mocked(api.updateAccount).mockResolvedValue({ account: { ...acctA, externalAccountRef: "acct-123" } });
      // The page re-reads the vendor right after the write, so the refreshed copy must already be in place.
      vi.mocked(api.getVendor).mockResolvedValue({
        vendor: toDetail(sampleVendor({ adapterSupported: true }), { accounts: [{ ...acctA, externalAccountRef: "acct-123" }] }),
      });
      let details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /edit account/i }));
      await userEvent.type(within(details).getByLabelText(/external account reference/i), "acct-123");
      await userEvent.click(within(details).getByRole("button", { name: /save account/i }));
      await waitFor(() => expect(api.updateAccount).toHaveBeenLastCalledWith("vnd_1", "acct_1", { externalAccountRef: "acct-123" }));

      vi.mocked(api.getVendor).mockResolvedValue({ vendor: toDetail(sampleVendor({ adapterSupported: true }), { accounts: [acctA] }) });
      vi.mocked(api.updateAccount).mockResolvedValue({ account: acctA });
      expect(await screen.findByText("External ref: acct-123")).toBeInTheDocument();
      details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /edit account/i }));
      await userEvent.clear(within(details).getByLabelText(/external account reference/i));
      await userEvent.click(within(details).getByRole("button", { name: /save account/i }));
      await waitFor(() => expect(api.updateAccount).toHaveBeenLastCalledWith("vnd_1", "acct_1", { externalAccountRef: null }));
    });

    test("a server-side validation error is shown in the form and the form stays open", async () => {
      await open();
      vi.mocked(api.updateAccount).mockRejectedValue(
        new ApiError(400, "VALIDATION_ERROR", '"slug" must be lowercase letters, digits and hyphens.', "req-v"),
      );
      const details = await region(/account details/i);
      await userEvent.click(within(details).getByRole("button", { name: /edit account/i }));
      const slug = within(details).getByLabelText("Slug");
      await userEvent.clear(slug);
      await userEvent.type(slug, "Bad Slug");
      await userEvent.click(within(details).getByRole("button", { name: /save account/i }));
      expect(await within(details).findByRole("alert")).toHaveTextContent(/must be lowercase/i);
      expect(within(details).getByLabelText("Slug")).toHaveValue("Bad Slug");
    });
  });

  describe("readiness (rendered from the backend, never recomputed)", () => {
    test.each([
      ["ready", "last_check_healthy", "Ready"],
      ["disabled", "account_not_enabled", "Disabled"],
      ["unsupported", "no_adapter_for_protocol", "Unsupported"],
      ["missing_credential", "no_enabled_credential", "Missing Credential"],
      ["unverified", "never_verified", "Unverified"],
      ["unhealthy", "last_check_unhealthy", "Unhealthy"],
    ] as const)("%s / %s is displayed as %s", async (state, reason, label) => {
      vi.mocked(api.getAccountReadiness).mockResolvedValue({ readiness: sampleReadiness("acct_1", { readiness: state, reason }) });
      await open();
      const panel = await region(/account readiness/i);
      expect(await within(panel).findByText(label)).toBeInTheDocument();
      expect(within(panel).getByText(reason)).toBeInTheDocument();
    });

    test("degraded health is displayed consistently as READY with reason last_check_degraded", async () => {
      vi.mocked(api.getAccountReadiness).mockResolvedValue({
        readiness: sampleReadiness("acct_1", {
          readiness: "ready",
          reason: "last_check_degraded",
          health: { ...sampleReadiness("acct_1").health, status: "degraded" },
        }),
      });
      vi.mocked(api.getAccountHealth).mockResolvedValue(healthSnapshot("acct_1", { status: "degraded", lastErrorCategory: "rate_limit" }));
      await open();
      const readiness = await region(/account readiness/i);
      expect(await within(readiness).findByText("Ready")).toBeInTheDocument();
      expect(within(readiness).getByText("last_check_degraded")).toBeInTheDocument();
      expect(within(readiness).queryByText(/^Degraded$/)).not.toBeInTheDocument();
      expect(await within(await region(/account health/i)).findByText("Degraded")).toBeInTheDocument();
    });

    test("shows the vendor, account, adapter and credential facts the backend reports", async () => {
      vi.mocked(api.getAccountReadiness).mockResolvedValue({
        readiness: sampleReadiness("acct_1", {
          adapterSupported: false,
          credential: { present: true, enabled: true, usable: false, lastTestedAt: "2026-09-19T12:00:00.000Z", lastSuccessfulAt: null },
        }),
      });
      await open();
      const panel = await region(/account readiness/i);
      expect(await within(panel).findByText("Not registered")).toBeInTheDocument();
      const usable = within(panel).getByText("Credential Usable").parentElement!;
      expect(within(usable).getByText("No")).toBeInTheDocument();
      expect(within(panel).getByText("Vendor Status")).toBeInTheDocument();
      expect(within(panel).getByText("Last Tested")).toBeInTheDocument();
    });

    test("the account list shows each account's backend readiness", async () => {
      vi.mocked(api.getAccountReadiness).mockImplementation(async (_v, accountId) => ({
        readiness: accountId === "acct_1"
          ? sampleReadiness(accountId, { readiness: "ready", reason: "last_check_healthy" })
          : sampleReadiness(accountId, { readiness: "unhealthy", reason: "last_check_unhealthy" }),
      }));
      await open({ accounts: [acctA, acctB] });
      expect(await screen.findByTestId("readiness-badge-acct_1")).toHaveTextContent("Ready");
      expect(await screen.findByTestId("readiness-badge-acct_2")).toHaveTextContent("Unhealthy");
    });

    test("a readiness failure is shown as an error, never as a guessed state", async () => {
      vi.mocked(api.getAccountReadiness).mockRejectedValue(new ApiError(500, "INTERNAL", "Readiness unavailable.", "r"));
      await open();
      const panel = await region(/account readiness/i);
      expect(await within(panel).findByRole("alert")).toHaveTextContent("Readiness unavailable.");
      expect(within(panel).queryByText("Ready")).not.toBeInTheDocument();
    });
  });

  describe("credentials", () => {
    test("shows safe credential metadata only, and never a secret or external reference", async () => {
      const leaky = { ...credential({ id: "cred_ext", hasManagedSecret: false, maskedSecret: null }), secretRef: "vault://leaky/ref" };
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [credential(), leaky] });
      await open();
      const panel = await region(/account credentials/i);
      expect(await within(panel).findByText("api_key: ****...wxyz")).toBeInTheDocument();
      expect(within(panel).getByText("Inhouse Vault")).toBeInTheDocument();
      expect(within(panel).getByText("External Reference")).toBeInTheDocument();
      expect(within(panel).getAllByText("Last Tested").length).toBe(2);
      expect(within(panel).getAllByText("Never")).toHaveLength(2);
      expect(document.body.textContent).not.toContain("vault://leaky");
      expect(document.body.innerHTML).not.toMatch(/ciphertext|auth_?tag|secretRef/i);
    });

    test("with no credentials it shows an explicit empty state", async () => {
      await open();
      expect(await within(await region(/account credentials/i)).findByText("No credentials configured for this account.")).toBeInTheDocument();
    });

    test("a credential load failure is shown as an error", async () => {
      vi.mocked(api.listCredentials).mockRejectedValue(new Error("boom"));
      await open();
      expect(await within(await region(/account credentials/i)).findByRole("alert")).toHaveTextContent("Failed to load credentials.");
    });

    test("only the selected account's credentials are listed", async () => {
      vi.mocked(api.listCredentials).mockResolvedValue({
        credentials: [credential({ id: "c1", vendorAccountId: "acct_1", credentialType: "type_a" }), credential({ id: "c2", vendorAccountId: "acct_2", credentialType: "type_b" })],
      });
      await open({ accounts: [acctA, acctB] });
      const panel = await region(/account credentials/i);
      expect(await within(panel).findByText(/type_a/)).toBeInTheDocument();
      expect(within(panel).queryByText(/type_b/)).not.toBeInTheDocument();
    });

    test("enabling a disabled credential calls updateCredential and reloads credentials and readiness", async () => {
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [credential({ status: "disabled" })] });
      await open();
      vi.mocked(api.updateCredential).mockResolvedValue({ credential: credential() });
      const readinessBefore = vi.mocked(api.getAccountReadiness).mock.calls.length;
      const listBefore = vi.mocked(api.listCredentials).mock.calls.length;
      await userEvent.click(await screen.findByRole("button", { name: /^enable$/i }));
      await waitFor(() => expect(api.updateCredential).toHaveBeenCalledWith("vnd_1", "cred_1", { status: "enabled" }));
      await waitFor(() => expect(vi.mocked(api.listCredentials).mock.calls.length).toBeGreaterThan(listBefore));
      await waitFor(() => expect(vi.mocked(api.getAccountReadiness).mock.calls.length).toBeGreaterThan(readinessBefore));
    });

    test("removing a credential calls deleteCredential and reloads credentials and readiness", async () => {
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [credential()] });
      await open();
      vi.mocked(api.deleteCredential).mockResolvedValue(undefined);
      const readinessBefore = vi.mocked(api.getAccountReadiness).mock.calls.length;
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [] });
      await userEvent.click(await screen.findByRole("button", { name: /remove/i }));
      await waitFor(() => expect(api.deleteCredential).toHaveBeenCalledWith("vnd_1", "cred_1"));
      expect(await screen.findByText("No credentials configured for this account.")).toBeInTheDocument();
      expect(vi.mocked(api.getAccountReadiness).mock.calls.length).toBeGreaterThan(readinessBefore);
    });

    test("attaching a credential reloads credentials and readiness, and clears the typed secret", async () => {
      await open();
      vi.mocked(api.createCredential).mockResolvedValue({ credential: credential() });
      const readinessBefore = vi.mocked(api.getAccountReadiness).mock.calls.length;
      await userEvent.click(await screen.findByRole("button", { name: /add credential/i }));
      await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-typed-secret");
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [credential()] });
      await userEvent.click(screen.getByRole("button", { name: /^save credential$/i }));
      await waitFor(() => expect(api.createCredential).toHaveBeenCalledTimes(1));
      expect(await screen.findByText("api_key: ****...wxyz")).toBeInTheDocument();
      expect(vi.mocked(api.getAccountReadiness).mock.calls.length).toBeGreaterThan(readinessBefore);
      expect(document.body.textContent).not.toContain("sk-typed-secret");
    });

    test("a half-typed secret is discarded when the operator switches accounts", async () => {
      await open({ accounts: [acctA, acctB] });
      await userEvent.click(await screen.findByRole("button", { name: /add credential/i }));
      await userEvent.type(screen.getByPlaceholderText(/paste the provider secret/i), "sk-half-typed");
      await userEvent.click(await screen.findByText("Secondary Account"));
      await userEvent.click(await screen.findByText("Primary Account"));
      expect(screen.queryByPlaceholderText(/paste the provider secret/i)).not.toBeInTheDocument();
      expect(document.body.innerHTML).not.toContain("sk-half-typed");
    });
  });

  describe("verification", () => {
    test("Verify Account calls the verify endpoint for the selected account", async () => {
      vi.mocked(api.verifyAccount).mockResolvedValue({ verification: verification("acct_1") });
      await open();
      await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));
      await waitFor(() => expect(api.verifyAccount).toHaveBeenCalledWith("vnd_1", "acct_1"));
    });

    test("the stale 'Test Connection' control is gone; Verify Account is the single verification action", async () => {
      await open();
      await screen.findByRole("button", { name: /verify account/i });
      expect(screen.queryByText(/test connection/i)).not.toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /verify/i })).toHaveLength(1);
    });

    test("while running the button is disabled, progress is shown, and a second click does not start another verification", async () => {
      const pending = deferred<{ verification: ReturnType<typeof verification> }>();
      vi.mocked(api.verifyAccount).mockReturnValue(pending.promise);
      await open();
      const button = await screen.findByRole("button", { name: /verify account/i });
      fireEvent.click(button);
      fireEvent.click(button);
      const verifying = await screen.findByRole("button", { name: /verifying/i });
      expect(verifying).toBeDisabled();
      expect(screen.getByText(/verification in progress/i)).toBeInTheDocument();
      fireEvent.click(verifying);
      expect(api.verifyAccount).toHaveBeenCalledTimes(1);
      pending.resolve({ verification: verification("acct_1") });
      expect(await screen.findByRole("button", { name: /verify account/i })).toBeEnabled();
      expect(api.verifyAccount).toHaveBeenCalledTimes(1);
    });

    test("a successful verification refreshes readiness, health, history and credentials from the backend", async () => {
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [credential({ lastTestedAt: null })] });
      vi.mocked(api.verifyAccount).mockResolvedValue({ verification: verification("acct_1") });
      await open();
      const before = {
        readiness: vi.mocked(api.getAccountReadiness).mock.calls.length,
        health: vi.mocked(api.getAccountHealth).mock.calls.length,
        events: vi.mocked(api.getAccountHealthEvents).mock.calls.length,
        creds: vi.mocked(api.listCredentials).mock.calls.length,
      };
      vi.mocked(api.getAccountReadiness).mockResolvedValue({ readiness: sampleReadiness("acct_1", { readiness: "ready", reason: "last_check_healthy" }) });
      vi.mocked(api.getAccountHealth).mockResolvedValue(healthSnapshot("acct_1"));
      vi.mocked(api.listCredentials).mockResolvedValue({ credentials: [credential({ lastTestedAt: "2026-09-19T12:30:00.000Z", lastSuccessfulAt: "2026-09-19T12:30:00.000Z" })] });

      await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));

      expect(await screen.findByText("Verified acct_1.")).toBeInTheDocument();
      expect(await within(await region(/account readiness/i)).findByText("Ready")).toBeInTheDocument();
      expect(await within(await region(/account health/i)).findByText("Healthy")).toBeInTheDocument();
      const creds = await region(/account credentials/i);
      await waitFor(() => expect(within(creds).queryByText("Never")).not.toBeInTheDocument());
      expect(vi.mocked(api.getAccountReadiness).mock.calls.length).toBe(before.readiness + 1);
      expect(vi.mocked(api.getAccountHealth).mock.calls.length).toBe(before.health + 1);
      expect(vi.mocked(api.getAccountHealthEvents).mock.calls.length).toBe(before.events + 1);
      expect(vi.mocked(api.listCredentials).mock.calls.length).toBe(before.creds + 1);
      expect(screen.queryByText(/could not be refreshed/i)).not.toBeInTheDocument();
    });

    test("a failed verification shows the safe backend error, and does not pretend a result exists", async () => {
      vi.mocked(api.verifyAccount).mockRejectedValue(new ApiError(409, "CONFLICT", "This account has no enabled credential to verify.", "req-c"));
      await open();
      const health = await region(/account health/i);
      await userEvent.click(await within(health).findByRole("button", { name: /verify account/i }));
      expect(await within(health).findByRole("alert")).toHaveTextContent("This account has no enabled credential to verify.");
      expect(within(health).queryByText(/^Verification:/)).not.toBeInTheDocument();
      expect(within(health).queryByText(/could not be refreshed/i)).not.toBeInTheDocument();
    });

    test("a provider-side failure result is displayed as a result (safe category/code only)", async () => {
      vi.mocked(api.verifyAccount).mockResolvedValue({
        verification: verification("acct_1", { status: "unhealthy", errorCategory: "authentication", safeErrorCode: "401", message: "Verification failed (authentication)." }),
      });
      await open();
      await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));
      expect(await screen.findByText("Verification: Unhealthy")).toBeInTheDocument();
      expect(screen.getByText("Code: 401")).toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    test("a successful verification followed by failed refreshes stays a success, and says which reads failed", async () => {
      vi.mocked(api.verifyAccount).mockResolvedValue({ verification: verification("acct_1") });
      await open();
      vi.mocked(api.getAccountReadiness).mockRejectedValue(new Error("refresh failed"));
      vi.mocked(api.listCredentials).mockRejectedValue(new Error("refresh failed"));
      await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));
      expect(await screen.findByText("Verified acct_1.")).toBeInTheDocument();
      expect(await screen.findByText(/verification completed, but the account readiness, credentials could not be refreshed/i)).toBeInTheDocument();
      expect(screen.queryByText(/failed to verify account/i)).not.toBeInTheDocument();
      expect(screen.getByText("Verification: Healthy")).toBeInTheDocument();
    });

    test("verification is disabled for a disabled account, a disabled vendor, and a vendor without an adapter", async () => {
      await open({ accounts: [{ ...acctA, status: "disabled" as never }] });
      const button = await screen.findByRole("button", { name: /verify account/i });
      expect(button).toBeDisabled();
      await userEvent.click(button);
      expect(api.verifyAccount).not.toHaveBeenCalled();
    });
  });

  describe("health and history", () => {
    test("shows the full current health snapshot", async () => {
      vi.mocked(api.getAccountHealth).mockResolvedValue(
        healthSnapshot("acct_1", { status: "unhealthy", consecutiveFailures: 3, lastFailureAt: "2026-09-19T13:00:00.000Z", lastErrorCategory: "timeout", lastSafeErrorCode: "TIMEOUT" }),
      );
      await open();
      const panel = await region(/account health/i);
      expect(await within(panel).findByText("Unhealthy")).toBeInTheDocument();
      for (const label of ["Last Checked", "Last Success", "Last Failure", "Consecutive Failures", "Latency", "Error Category", "Safe Error Code"]) {
        expect(within(panel).getByText(label)).toBeInTheDocument();
      }
      expect(within(panel).getByText("3")).toBeInTheDocument();
      expect(within(panel).getByText("180ms latency")).toBeInTheDocument();
      expect(within(panel).getByText("Timeout")).toBeInTheDocument();
      expect(within(panel).getByText("TIMEOUT")).toBeInTheDocument();
    });

    test("an account that was never verified shows 'Not verified'", async () => {
      await open();
      expect(await within(await region(/account health/i)).findByText("Not verified")).toBeInTheDocument();
    });

    test("health history is collapsed by default and lists safe event fields once expanded", async () => {
      vi.mocked(api.getAccountHealthEvents).mockResolvedValue({
        events: [
          { id: "e2", vendorAccountId: "acct_1", status: "unhealthy", latencyMs: null, errorCategory: "authentication", safeErrorCode: "401", source: "adapter", checkedAt: "2026-09-19T13:00:00.000Z", createdAt: "2026-09-19T13:00:00.000Z" },
          { id: "e1", vendorAccountId: "acct_1", status: "healthy", latencyMs: 55, errorCategory: null, safeErrorCode: null, source: "adapter", checkedAt: "2026-09-19T12:00:00.000Z", createdAt: "2026-09-19T12:00:00.000Z" },
        ],
      });
      await open();
      const history = await region(/health history/i);
      const toggle = await within(history).findByRole("button", { name: /health history \(2\)/i });
      expect(within(history).queryByRole("table")).not.toBeInTheDocument();
      await userEvent.click(toggle);
      const table = within(history).getByRole("table");
      expect(within(table).getByText("Authentication")).toBeInTheDocument();
      expect(within(table).getByText("401")).toBeInTheDocument();
      expect(within(table).getByText("55ms")).toBeInTheDocument();
      expect(within(table).getAllByRole("row")).toHaveLength(3);
    });

    test("an empty history says so", async () => {
      await open();
      const history = await region(/health history/i);
      await userEvent.click(await within(history).findByRole("button", { name: /health history/i }));
      expect(await within(history).findByText("No health events recorded")).toBeInTheDocument();
    });

    test("a history load failure is shown as an error", async () => {
      vi.mocked(api.getAccountHealthEvents).mockRejectedValue(new ApiError(500, "INTERNAL", "History unavailable.", "r"));
      await open();
      const history = await region(/health history/i);
      await userEvent.click(await within(history).findByRole("button", { name: /health history/i }));
      expect(await within(history).findByRole("alert")).toHaveTextContent("History unavailable.");
    });

    test("a health API error is shown, not swallowed", async () => {
      vi.mocked(api.getAccountHealth).mockRejectedValue(new ApiError(500, "INTERNAL", "Health lookup failed.", "r"));
      await open();
      expect(await within(await region(/account health/i)).findByRole("alert")).toHaveTextContent("Health lookup failed.");
    });
  });

  describe("race safety", () => {
    test("a late response for account A never overwrites account B's data", async () => {
      const lateHealth = deferred<ReturnType<typeof healthSnapshot>>();
      const lateReadiness = deferred<{ readiness: AccountReadinessApi }>();
      const lateEvents = deferred<{ events: never[] }>();
      vi.mocked(api.getAccountHealth).mockImplementation((_v, id) =>
        id === "acct_1" ? lateHealth.promise : Promise.resolve(healthSnapshot(id, { status: "healthy", lastLatencyMs: 22 })),
      );
      vi.mocked(api.getAccountReadiness).mockImplementation((_v, id) =>
        id === "acct_1" ? lateReadiness.promise : Promise.resolve({ readiness: sampleReadiness(id, { readiness: "ready", reason: "last_check_healthy" }) }),
      );
      vi.mocked(api.getAccountHealthEvents).mockImplementation((_v, id) =>
        id === "acct_1"
          ? lateEvents.promise
          : Promise.resolve({ events: [{ id: "eB", vendorAccountId: id, status: "healthy" as const, latencyMs: 22, errorCategory: null, safeErrorCode: null, source: "adapter" as const, checkedAt: "2026-09-19T12:00:00.000Z", createdAt: "2026-09-19T12:00:00.000Z" }] }),
      );
      await open({ accounts: [acctA, acctB] });

      // Account A is selected and its three reads are still pending. Switch to B.
      await userEvent.click(await screen.findByText("Secondary Account"));
      const health = await region(/account health/i);
      expect(await within(health).findByText("Healthy")).toBeInTheDocument();
      expect(within(health).getByText("22ms latency")).toBeInTheDocument();
      const readiness = await region(/account readiness/i);
      expect(await within(readiness).findByText("Ready")).toBeInTheDocument();

      // Now A's responses arrive late, describing a very different state.
      await act(async () => {
        lateHealth.resolve(healthSnapshot("acct_1", { status: "unhealthy", lastLatencyMs: 9999, lastErrorCategory: "timeout", consecutiveFailures: 7 }));
        lateReadiness.resolve({ readiness: sampleReadiness("acct_1", { readiness: "unhealthy", reason: "last_check_unhealthy" }) });
        lateEvents.resolve({ events: [] });
      });

      expect(within(await region(/account health/i)).getByText("Healthy")).toBeInTheDocument();
      expect(within(await region(/account health/i)).queryByText("Unhealthy")).not.toBeInTheDocument();
      expect(within(await region(/account health/i)).queryByText("9999ms latency")).not.toBeInTheDocument();
      expect(within(await region(/account readiness/i)).getByText("Ready")).toBeInTheDocument();
      expect(within(await region(/account readiness/i)).queryByText("last_check_unhealthy")).not.toBeInTheDocument();

      // A's data landed under A, so it is what is shown when A is selected again.
      await userEvent.click(await screen.findByText("Primary Account"));
      expect(screen.getByTestId("readiness-badge-acct_1")).toHaveTextContent("Unhealthy");
    });

    test("an older response for the same account cannot replace a newer one", async () => {
      const first = deferred<{ readiness: AccountReadinessApi }>();
      vi.mocked(api.getAccountReadiness)
        .mockImplementationOnce(() => first.promise)
        .mockImplementation(async (_v, id) => ({ readiness: sampleReadiness(id, { readiness: "ready", reason: "last_check_healthy" }) }));
      vi.mocked(api.verifyAccount).mockResolvedValue({ verification: verification("acct_1") });
      await open();
      await userEvent.click(await screen.findByRole("button", { name: /verify account/i }));
      expect(await within(await region(/account readiness/i)).findByText("Ready")).toBeInTheDocument();
      await act(async () => {
        first.resolve({ readiness: sampleReadiness("acct_1", { readiness: "unverified", reason: "never_verified" }) });
      });
      expect(within(await region(/account readiness/i)).getByText("Ready")).toBeInTheDocument();
      expect(within(await region(/account readiness/i)).queryByText("never_verified")).not.toBeInTheDocument();
    });
  });
});
