import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminToken, api } from "./api";

const TOKEN = "unit-test-admin-token-0123456789abcdef";

function mockFetch() {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ vendors: [], status: "ok" }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentAuthorization(fetchMock: ReturnType<typeof mockFetch>, call = 0): string | undefined {
  const init = (fetchMock.mock.calls[call] as unknown as [string, RequestInit])[1];
  return (init.headers as Record<string, string>).Authorization;
}

describe("control-plane admin token", () => {
  beforeEach(() => {
    adminToken.clear();
  });
  afterEach(() => {
    adminToken.clear();
    vi.unstubAllGlobals();
  });

  it("is sent as a Bearer header on control-plane calls (reads and writes) once set", async () => {
    const fetchMock = mockFetch();
    adminToken.set(TOKEN);
    await api.listVendors();
    await api.disableModel("m1");
    await api.previewRouting({} as never);
    for (let i = 0; i < 3; i++) expect(sentAuthorization(fetchMock, i)).toBe(`Bearer ${TOKEN}`);
  });

  it("is not sent on the public health probe", async () => {
    const fetchMock = mockFetch();
    adminToken.set(TOKEN);
    await api.getSystemHealth();
    expect(sentAuthorization(fetchMock)).toBeUndefined();
  });

  it("sends no Authorization header when no token is set", async () => {
    const fetchMock = mockFetch();
    await api.listVendors();
    expect(sentAuthorization(fetchMock)).toBeUndefined();
  });

  it("lives in sessionStorage only, never localStorage", () => {
    adminToken.set(TOKEN);
    expect(sessionStorage.getItem("inhouse.adminToken")).toBe(TOKEN);
    expect(JSON.stringify({ ...localStorage })).not.toContain(TOKEN);
  });
});

describe("account operations client (Block 14B-2)", () => {
  beforeEach(() => {
    adminToken.clear();
  });
  afterEach(() => {
    adminToken.clear();
    vi.unstubAllGlobals();
  });

  it("sends the admin token on every account, readiness, health, history and verification call, and nothing else", async () => {
    const fetchMock = mockFetch();
    adminToken.set(TOKEN);
    await api.getAccountReadiness("v1", "a1");
    await api.getAccountHealth("v1", "a1");
    await api.getAccountHealthEvents("v1", "a1", 20);
    await api.verifyAccount("v1", "a1");
    await api.updateAccount("v1", "a1", { status: "enabled" });
    await api.disableAccount("v1", "a1");
    const calls = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url, init]) => `${init.method ?? "GET"} ${url}`)).toEqual([
      "GET /v1/vendors/v1/accounts/a1/readiness",
      "GET /v1/vendors/v1/accounts/a1/health",
      "GET /v1/vendors/v1/accounts/a1/health/events?limit=20",
      "POST /v1/vendors/v1/accounts/a1/verify",
      "PATCH /v1/vendors/v1/accounts/a1",
      "DELETE /v1/vendors/v1/accounts/a1",
    ]);
    for (let i = 0; i < calls.length; i++) expect(sentAuthorization(fetchMock, i)).toBe(`Bearer ${TOKEN}`);
  });

  it("does not use a client execution key: the only credential sent is the stored admin token", async () => {
    const fetchMock = mockFetch();
    adminToken.set(TOKEN);
    await api.getAccountReadiness("v1", "a1");
    expect(sentAuthorization(fetchMock)).not.toMatch(/ihk_/);
  });

  it("drops the external secretRef (and any unexpected field) from credential responses before it can reach UI state", async () => {
    const wire = {
      id: "c1",
      vendorAccountId: "a1",
      credentialType: "api_key",
      status: "enabled",
      secretRef: "vault://should/never/reach/the/ui",
      hasManagedSecret: false,
      maskedSecret: null,
      secretCiphertext: "leak",
      createdAt: "2026-09-19T00:00:00Z",
      updatedAt: "2026-09-19T00:00:00Z",
      lastTestedAt: null,
      lastSuccessfulAt: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ credentials: [wire], credential: wire }), { status: 200 })),
    );
    const listed = await api.listCredentials("v1");
    const created = await api.createCredential("v1", { vendorAccountId: "a1", credentialType: "api_key", secretRef: "x" });
    const updated = await api.updateCredential("v1", "c1", { status: "disabled" });
    for (const c of [listed.credentials[0], created.credential, updated.credential]) {
      expect(JSON.stringify(c)).not.toMatch(/secretRef|vault:\/\/|secretCiphertext|leak/);
      expect(c).toMatchObject({ id: "c1", hasManagedSecret: false, status: "enabled" });
    }
  });
});
