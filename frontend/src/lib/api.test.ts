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
