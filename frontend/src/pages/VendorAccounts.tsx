import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../components/ui/Icon";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { StatusPill } from "../components/ui/StatusPill";
import { FormField, TextInput } from "../components/ui/FormField";
import { formatDateTime, titleCase } from "../lib/format";
import { api, ApiError } from "../lib/api";
import { DEFAULT_CREDENTIAL_TYPE } from "../lib/vendorProtocols";
import type { HealthState } from "../types/domain";
import type {
  AccountReadinessApi,
  AccountReadinessState,
  ProviderHealthApi,
  ProviderHealthEventApi,
  ProviderVerificationApi,
  VendorAccountApi,
  VendorCredentialApi,
  VendorStatus,
} from "../types/api";

/**
 * Provider-account operational control plane (Block 14B-2).
 *
 * The backend is the single source of truth: readiness comes from
 * `GET .../readiness`, health from `GET .../health`, and nothing here
 * recomputes either. The mappings below are presentation only (which
 * colour and wording a backend-supplied state gets).
 *
 * Async data lives in maps keyed by account id, and every response is
 * written under the id of the request that produced it — so a late
 * response for account A can never overwrite what is shown for account B.
 * Per-account form state (including any secret being typed) lives in
 * `AccountInspector`, which is remounted per account so it is discarded on
 * every account switch.
 */

type Load<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  // `refreshError`: a later reload failed, so `data` is the last good copy, not fresh.
  | { status: "loaded"; data: T; refreshError?: string };

type LoadMap<T> = Record<string, Load<T>>;
type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

const CREDENTIALS_KEY = "vendor";
const EVENT_LIMIT = 20;

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return fallback;
}

function settle<T>(prev: Load<T> | undefined, result: LoadResult<T>): Load<T> {
  if (result.ok) return { status: "loaded", data: result.data };
  if (prev && prev.status === "loaded") return { ...prev, refreshError: result.message };
  return { status: "error", message: result.message };
}

const READINESS_PILL: Record<AccountReadinessState, HealthState> = {
  ready: "healthy",
  unverified: "degraded",
  missing_credential: "degraded",
  unsupported: "disabled",
  disabled: "disabled",
  unhealthy: "unreachable",
};

const REASON_TEXT: Record<string, string> = {
  vendor_not_enabled: "The vendor is not enabled.",
  account_not_enabled: "The account is not enabled.",
  no_adapter_for_protocol: "No technical adapter is registered for the vendor's protocol.",
  no_enabled_credential: "No enabled credential is configured for this account.",
  credential_not_usable: "The selected credential is an external reference Inhouse cannot use.",
  never_verified: "The account has not been verified yet.",
  last_check_unhealthy: "The last recorded check was unhealthy.",
  last_check_healthy: "The last recorded check was healthy.",
  last_check_degraded: "The last recorded check was degraded; the account remains usable.",
};

function readinessPill(state: string): HealthState {
  return READINESS_PILL[state as AccountReadinessState] ?? "disabled";
}

function providerHealthToState(status: ProviderHealthApi["status"]): HealthState {
  if (status === "healthy") return "healthy";
  if (status === "degraded") return "degraded";
  if (status === "unhealthy") return "unreachable";
  return "disabled";
}

function accountStatusDot(status: VendorStatus): string {
  if (status === "enabled") return "bg-tertiary";
  if (status === "unavailable") return "bg-error";
  return "bg-outline";
}

const yesNo = (value: boolean) => (value ? "Yes" : "No");
const orDash = (value: string | null | undefined) => (value ? value : "—");

export function VendorAccountsAndCredentials({
  vendorId,
  adapterSupported,
  vendorEnabled,
  accounts,
  selectedAccount,
  onSelectAccount,
  onChanged,
  onError,
}: {
  vendorId: string;
  adapterSupported: boolean;
  vendorEnabled: boolean;
  accounts: VendorAccountApi[];
  selectedAccount: VendorAccountApi | undefined;
  onSelectAccount: (id: string) => void;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [addingAccount, setAddingAccount] = useState(false);
  const [newAccountSlug, setNewAccountSlug] = useState("");
  const [newAccountName, setNewAccountName] = useState("");

  const [readiness, setReadiness] = useState<LoadMap<AccountReadinessApi>>({});
  const [health, setHealth] = useState<LoadMap<ProviderHealthApi>>({});
  const [events, setEvents] = useState<LoadMap<ProviderHealthEventApi[]>>({});
  const [credentials, setCredentials] = useState<LoadMap<VendorCredentialApi[]>>({});

  const [verifying, setVerifying] = useState<Set<string>>(new Set());
  const [verifications, setVerifications] = useState<Record<string, ProviderVerificationApi>>({});
  const [verifyErrors, setVerifyErrors] = useState<Record<string, string>>({});
  const [refreshFailures, setRefreshFailures] = useState<Record<string, string[]>>({});

  // A synchronous guard: state updates lag a rapid second click, a ref does not.
  const verifyInFlight = useRef(new Set<string>());
  const alive = useRef(true);
  const sequence = useRef(new Map<string, number>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * Runs one read and stores it under `key`. A response is dropped if the
   * component is gone or a newer request for the same key started after it.
   * Resolves whether the read succeeded (used to tell a refresh failure
   * apart from a failed action).
   */
  const load = useCallback(
    async <T,>(
      key: string,
      fetcher: () => Promise<T>,
      set: React.Dispatch<React.SetStateAction<LoadMap<T>>>,
      slot: string,
      failure: string,
    ): Promise<boolean> => {
      const token = (sequence.current.get(`${key}`) ?? 0) + 1;
      sequence.current.set(key, token);
      let result: LoadResult<T>;
      try {
        result = { ok: true, data: await fetcher() };
      } catch (error) {
        result = { ok: false, message: errorMessage(error, failure) };
      }
      if (alive.current && sequence.current.get(key) === token) {
        set((prev) => ({ ...prev, [slot]: settle(prev[slot], result) }));
      }
      return result.ok;
    },
    [],
  );

  const loadReadiness = useCallback(
    (accountId: string) =>
      load(
        `readiness:${accountId}`,
        () => api.getAccountReadiness(vendorId, accountId).then((r) => r.readiness),
        setReadiness,
        accountId,
        "Failed to load account readiness.",
      ),
    [load, vendorId],
  );
  const loadHealth = useCallback(
    (accountId: string) =>
      load(
        `health:${accountId}`,
        () => api.getAccountHealth(vendorId, accountId).then((r) => r.health),
        setHealth,
        accountId,
        "Failed to load account health.",
      ),
    [load, vendorId],
  );
  const loadEvents = useCallback(
    (accountId: string) =>
      load(
        `events:${accountId}`,
        () => api.getAccountHealthEvents(vendorId, accountId, EVENT_LIMIT).then((r) => r.events),
        setEvents,
        accountId,
        "Failed to load health history.",
      ),
    [load, vendorId],
  );
  const loadCredentials = useCallback(
    () =>
      load(
        `credentials:${vendorId}`,
        () => api.listCredentials(vendorId).then((r) => r.credentials),
        setCredentials,
        CREDENTIALS_KEY,
        "Failed to load credentials.",
      ),
    [load, vendorId],
  );

  // Readiness for every account on the vendor (drives the account list badges), plus
  // credentials once. Re-runs when the account set or the vendor-level facts change.
  const accountIdsKey = accounts.map((a) => a.id).join("|");
  useEffect(() => {
    for (const id of accountIdsKey.split("|").filter(Boolean)) void loadReadiness(id);
    void loadCredentials();
  }, [accountIdsKey, vendorEnabled, adapterSupported, loadReadiness, loadCredentials]);

  // Health and history for the account on screen.
  const selectedId = selectedAccount?.id;
  useEffect(() => {
    if (!selectedId) return;
    void loadHealth(selectedId);
    void loadEvents(selectedId);
  }, [selectedId, loadHealth, loadEvents]);

  async function submitNewAccount() {
    try {
      await api.createAccount(vendorId, { slug: newAccountSlug, displayName: newAccountName });
      setAddingAccount(false);
      setNewAccountSlug("");
      setNewAccountName("");
      onChanged();
    } catch (error) {
      onError(errorMessage(error, "Failed to create account."));
    }
  }

  /** After any account write: reload the account list, then what is derived from it. */
  const afterAccountChange = useCallback(
    async (accountId: string) => {
      onChanged();
      await Promise.all([loadReadiness(accountId), loadHealth(accountId)]);
    },
    [onChanged, loadReadiness, loadHealth],
  );

  /** After any credential write: reload credentials and the readiness they feed. */
  const afterCredentialChange = useCallback(
    async (accountId: string) => {
      await Promise.all([loadCredentials(), loadReadiness(accountId)]);
    },
    [loadCredentials, loadReadiness],
  );

  async function verifyAccount(accountId: string) {
    if (verifyInFlight.current.has(accountId)) return;
    verifyInFlight.current.add(accountId);
    setVerifying((prev) => new Set(prev).add(accountId));
    setVerifications(({ [accountId]: _dropped, ...rest }) => rest);
    setVerifyErrors(({ [accountId]: _dropped, ...rest }) => rest);
    setRefreshFailures(({ [accountId]: _dropped, ...rest }) => rest);
    try {
      const { verification } = await api.verifyAccount(vendorId, accountId);
      if (alive.current) setVerifications((prev) => ({ ...prev, [accountId]: verification }));
      // The verification has already succeeded; a failed refresh below is reported separately.
      const outcomes = await Promise.all([
        loadReadiness(accountId),
        loadHealth(accountId),
        loadEvents(accountId),
        loadCredentials(),
      ]);
      const failed = ["readiness", "health", "history", "credentials"].filter((_, i) => !outcomes[i]);
      if (alive.current && failed.length > 0) setRefreshFailures((prev) => ({ ...prev, [accountId]: failed }));
    } catch (error) {
      if (alive.current) {
        setVerifyErrors((prev) => ({ ...prev, [accountId]: errorMessage(error, "Failed to verify account.") }));
      }
    } finally {
      verifyInFlight.current.delete(accountId);
      if (alive.current) {
        setVerifying((prev) => {
          const next = new Set(prev);
          next.delete(accountId);
          return next;
        });
      }
    }
  }

  const addAccountForm = (
    <NewAccountForm
      slug={newAccountSlug}
      name={newAccountName}
      onSlugChange={setNewAccountSlug}
      onNameChange={setNewAccountName}
      onCancel={() => setAddingAccount(false)}
      onSubmit={submitNewAccount}
    />
  );

  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-space-sm">
        <div className="bg-surface p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
          No accounts configured for this vendor yet.
        </div>
        {!addingAccount ? (
          <Button variant="secondary" onClick={() => setAddingAccount(true)} className="self-start">
            <Icon name="add" size={16} />
            Add Account
          </Button>
        ) : (
          addAccountForm
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-space-xs">
        <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">
          Vendor Account ({accounts.length} configured)
        </span>
        <div className="flex flex-wrap gap-space-xs items-center">
          {accounts.map((acct) => {
            const isActive = selectedAccount?.id === acct.id;
            const r = readiness[acct.id];
            return (
              <button
                key={acct.id}
                onClick={() => onSelectAccount(acct.id)}
                className={`flex items-center gap-space-xs px-space-sm py-1.5 border transition-colors ${
                  isActive
                    ? "bg-surface-container-highest border-primary text-on-surface"
                    : "bg-surface border-outline-variant text-on-surface-variant hover:text-on-surface"
                } ${acct.status !== "enabled" ? "opacity-75" : ""}`}
              >
                <span className={`w-1.5 h-1.5 ${accountStatusDot(acct.status)}`} />
                <span className="font-code-dense text-code-dense uppercase">{acct.displayName}</span>
                {r?.status === "loaded" && (
                  <span
                    data-testid={`readiness-badge-${acct.id}`}
                    className="font-code-dense text-code-dense text-outline uppercase"
                  >
                    {titleCase(r.data.readiness)}
                  </span>
                )}
              </button>
            );
          })}
          {!addingAccount && (
            <button
              onClick={() => setAddingAccount(true)}
              className="flex items-center gap-1 px-space-sm py-1.5 border border-dashed border-outline-variant text-on-surface-variant hover:text-on-surface"
            >
              <Icon name="add" size={14} />
              <span className="font-code-dense text-code-dense uppercase">Add Account</span>
            </button>
          )}
        </div>
        {addingAccount && addAccountForm}
      </div>

      {selectedAccount && (
        <AccountInspector
          key={selectedAccount.id}
          vendorId={vendorId}
          account={selectedAccount}
          vendorEnabled={vendorEnabled}
          adapterSupported={adapterSupported}
          readiness={readiness[selectedAccount.id]}
          health={health[selectedAccount.id]}
          events={events[selectedAccount.id]}
          credentials={credentials[CREDENTIALS_KEY]}
          verifying={verifying.has(selectedAccount.id)}
          verification={verifications[selectedAccount.id]}
          verifyError={verifyErrors[selectedAccount.id]}
          refreshFailures={refreshFailures[selectedAccount.id]}
          onVerify={() => verifyAccount(selectedAccount.id)}
          onAccountChanged={() => afterAccountChange(selectedAccount.id)}
          onCredentialsChanged={() => afterCredentialChange(selectedAccount.id)}
          onError={onError}
        />
      )}
    </>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <span className="font-code-dense text-code-dense text-outline uppercase tracking-wider">{children}</span>;
}

function LoadNote({ state, what }: { state: Load<unknown> | undefined; what: string }) {
  if (!state || state.status === "loading") {
    return (
      <div className="bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant">Loading {what}…</div>
    );
  }
  if (state.status === "error") {
    return (
      <div role="alert" className="bg-surface p-space-sm font-body-sm text-body-sm text-error">
        {state.message}
      </div>
    );
  }
  return null;
}

function RefreshNote({ state }: { state: Load<unknown> | undefined }) {
  if (state?.status !== "loaded" || !state.refreshError) return null;
  return (
    <div className="font-code-dense text-code-dense text-secondary">
      Could not refresh — showing the last loaded data. {state.refreshError}
    </div>
  );
}

function AccountInspector({
  vendorId,
  account,
  vendorEnabled,
  adapterSupported,
  readiness,
  health,
  events,
  credentials,
  verifying,
  verification,
  verifyError,
  refreshFailures,
  onVerify,
  onAccountChanged,
  onCredentialsChanged,
  onError,
}: {
  vendorId: string;
  account: VendorAccountApi;
  vendorEnabled: boolean;
  adapterSupported: boolean;
  readiness: Load<AccountReadinessApi> | undefined;
  health: Load<ProviderHealthApi> | undefined;
  events: Load<ProviderHealthEventApi[]> | undefined;
  credentials: Load<VendorCredentialApi[]> | undefined;
  verifying: boolean;
  verification: ProviderVerificationApi | undefined;
  verifyError: string | undefined;
  refreshFailures: string[] | undefined;
  onVerify: () => void;
  onAccountChanged: () => Promise<void>;
  onCredentialsChanged: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [togglingStatus, setTogglingStatus] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(account.displayName);
  const [editSlug, setEditSlug] = useState(account.slug);
  const [editRef, setEditRef] = useState(account.externalAccountRef ?? "");
  const [editError, setEditError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [registeringCredential, setRegisteringCredential] = useState(false);
  const [credentialType, setCredentialType] = useState(DEFAULT_CREDENTIAL_TYPE);
  const [secretMode, setSecretMode] = useState<"managed" | "external">("managed");
  const [secret, setSecret] = useState("");
  const [secretRef, setSecretRef] = useState("");
  const [rotatingId, setRotatingId] = useState<string | null>(null);
  const [rotateSecretMode, setRotateSecretMode] = useState<"managed" | "external">("managed");
  const [rotateSecret, setRotateSecret] = useState("");
  const [rotateSecretRef, setRotateSecretRef] = useState("");

  const accountEnabled = account.status === "enabled";
  const accountCredentials =
    credentials?.status === "loaded" ? credentials.data.filter((c) => c.vendorAccountId === account.id) : null;

  async function setAccountEnabled(enable: boolean) {
    setTogglingStatus(true);
    try {
      if (enable) await api.updateAccount(vendorId, account.id, { status: "enabled" });
      else await api.disableAccount(vendorId, account.id);
      setConfirmingDisable(false);
      await onAccountChanged();
    } catch (error) {
      onError(errorMessage(error, enable ? "Failed to enable account." : "Failed to disable account."));
    } finally {
      setTogglingStatus(false);
    }
  }

  function startEditing() {
    setEditName(account.displayName);
    setEditSlug(account.slug);
    setEditRef(account.externalAccountRef ?? "");
    setEditError(null);
    setEditing(true);
  }

  async function saveEdit() {
    const patch: { displayName?: string; slug?: string; externalAccountRef?: string | null } = {};
    if (editName !== account.displayName) patch.displayName = editName;
    if (editSlug !== account.slug) patch.slug = editSlug;
    const nextRef = editRef.trim() === "" ? null : editRef;
    if (nextRef !== account.externalAccountRef) patch.externalAccountRef = nextRef;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setEditError(null);
    try {
      await api.updateAccount(vendorId, account.id, patch);
      setEditing(false);
      await onAccountChanged();
    } catch (error) {
      setEditError(errorMessage(error, "Failed to update account."));
    } finally {
      setSaving(false);
    }
  }

  async function submitCredential() {
    try {
      await api.createCredential(
        vendorId,
        secretMode === "managed"
          ? { vendorAccountId: account.id, credentialType, secret }
          : { vendorAccountId: account.id, credentialType, secretRef },
      );
      setRegisteringCredential(false);
      await onCredentialsChanged();
    } catch (error) {
      onError(errorMessage(error, "Failed to register credential."));
    } finally {
      // Never retain the raw secret in state any longer than it takes to submit it — success or failure.
      setSecret("");
      setSecretRef("");
    }
  }

  async function toggleCredentialStatus(credential: VendorCredentialApi) {
    try {
      await api.updateCredential(vendorId, credential.id, {
        status: credential.status === "enabled" ? "disabled" : "enabled",
      });
      await onCredentialsChanged();
    } catch (error) {
      onError(errorMessage(error, "Failed to update credential status."));
    }
  }

  async function submitRotate(credential: VendorCredentialApi) {
    try {
      await api.updateCredential(
        vendorId,
        credential.id,
        rotateSecretMode === "managed" ? { secret: rotateSecret } : { secretRef: rotateSecretRef },
      );
      setRotatingId(null);
      await onCredentialsChanged();
    } catch (error) {
      onError(errorMessage(error, "Failed to rotate credential."));
    } finally {
      setRotateSecret("");
      setRotateSecretRef("");
    }
  }

  async function removeCredential(credential: VendorCredentialApi) {
    try {
      await api.deleteCredential(vendorId, credential.id);
      await onCredentialsChanged();
    } catch (error) {
      onError(errorMessage(error, "Failed to remove credential."));
    }
  }

  const readinessData = readiness?.status === "loaded" ? readiness.data : null;
  const healthData = health?.status === "loaded" ? health.data : null;
  const verifyDisabledReason = !vendorEnabled
    ? "The vendor is disabled."
    : !accountEnabled
      ? "The account is disabled."
      : !adapterSupported
        ? "No technical adapter is registered for this vendor's protocol."
        : null;

  return (
    <div className="flex flex-col gap-space-sm">
      {/* Account details + lifecycle */}
      <section aria-label="Account details" className="flex flex-col gap-space-xs">
        <SectionTitle>Account — {account.displayName}</SectionTitle>
        <div className="flex flex-col gap-space-sm bg-surface p-space-sm">
          <div className="flex flex-wrap items-center gap-space-sm">
            <span className="font-code-dense text-code-dense text-on-surface font-bold">{account.displayName}</span>
            <span className="font-code-dense text-code-dense text-on-surface-variant">{account.slug}</span>
            <Chip tone={accountEnabled ? "tertiary" : account.status === "unavailable" ? "error" : "neutral"}>
              {account.status}
            </Chip>
            <span className="font-code-dense text-code-dense text-on-surface-variant">
              External ref: {orDash(account.externalAccountRef)}
            </span>
          </div>

          {editing ? (
            <div className="flex flex-col gap-space-sm">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-space-xs">
                <FormField label="Display Name">
                  <TextInput value={editName} onChange={(e) => setEditName(e.target.value)} />
                </FormField>
                <FormField label="Slug">
                  <TextInput value={editSlug} onChange={(e) => setEditSlug(e.target.value)} />
                </FormField>
                <FormField label="External Account Reference (not a secret)">
                  <TextInput value={editRef} onChange={(e) => setEditRef(e.target.value)} placeholder="Optional" />
                </FormField>
              </div>
              {editError && (
                <div role="alert" className="font-body-sm text-body-sm text-error">
                  {editError}
                </div>
              )}
              <div className="flex items-center gap-space-xs justify-end">
                <Button variant="secondary" type="button" onClick={() => setEditing(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button variant="primary" type="button" onClick={saveEdit} disabled={saving || !editName || !editSlug}>
                  {saving ? "Saving…" : "Save Account"}
                </Button>
              </div>
            </div>
          ) : confirmingDisable ? (
            <div className="flex flex-wrap items-center gap-space-sm">
              <span className="font-body-sm text-body-sm text-on-surface">
                Disable this account? It will no longer be used for verification or execution.
              </span>
              <Button variant="secondary" onClick={() => setConfirmingDisable(false)} disabled={togglingStatus}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={() => setAccountEnabled(false)} disabled={togglingStatus}>
                Confirm Disable
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-space-sm">
              <Button variant="secondary" onClick={startEditing}>
                <Icon name="edit" size={16} />
                Edit Account
              </Button>
              {accountEnabled ? (
                <Button variant="secondary" onClick={() => setConfirmingDisable(true)} disabled={togglingStatus}>
                  <Icon name="block" size={16} />
                  Disable Account
                </Button>
              ) : (
                <Button variant="secondary" onClick={() => setAccountEnabled(true)} disabled={togglingStatus}>
                  <Icon name="check_circle" size={16} />
                  Enable Account
                </Button>
              )}
            </div>
          )}
        </div>
      </section>

      {/* Readiness — rendered verbatim from the backend */}
      <section aria-label="Account readiness" className="flex flex-col gap-space-xs">
        <SectionTitle>Readiness</SectionTitle>
        <LoadNote state={readiness} what="readiness" />
        {readinessData && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center gap-space-sm bg-surface p-space-sm">
              <StatusPill state={readinessPill(readinessData.readiness)} detail={titleCase(readinessData.readiness)} />
              <span className="font-code-dense text-code-dense text-on-surface-variant">{readinessData.reason}</span>
              <span className="font-body-sm text-body-sm text-on-surface-variant">
                {REASON_TEXT[readinessData.reason] ?? ""}
              </span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
              <InfoTile label="Vendor Status" value={titleCase(readinessData.vendorStatus)} />
              <InfoTile label="Account Status" value={titleCase(readinessData.accountStatus)} />
              <InfoTile label="Adapter" value={readinessData.adapterSupported ? "Supported" : "Not registered"} />
              <InfoTile label="Credential Present" value={yesNo(readinessData.credential.present)} />
              <InfoTile label="Credential Enabled" value={yesNo(readinessData.credential.enabled)} />
              <InfoTile label="Credential Usable" value={yesNo(readinessData.credential.usable)} />
              <InfoTile label="Last Tested" value={formatDateTime(readinessData.credential.lastTestedAt)} />
              <InfoTile label="Last Successful" value={formatDateTime(readinessData.credential.lastSuccessfulAt)} />
            </div>
          </>
        )}
        <RefreshNote state={readiness} />
      </section>

      {/* Health + verification */}
      <section aria-label="Account health" className="flex flex-col gap-space-xs">
        <SectionTitle>Account Health — {account.displayName}</SectionTitle>
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-space-sm bg-surface p-space-sm">
          {health?.status === "error" ? (
            <span role="alert" className="font-body-sm text-body-sm text-error">
              {health.message}
            </span>
          ) : !healthData ? (
            <span className="font-body-sm text-body-sm text-on-surface-variant">Loading health…</span>
          ) : (
            <StatusPill
              state={providerHealthToState(healthData.status)}
              detail={healthData.status === "unknown" ? "Not verified" : titleCase(healthData.status)}
            />
          )}
          <Button
            variant="secondary"
            onClick={onVerify}
            disabled={verifying || verifyDisabledReason !== null}
            title={verifyDisabledReason ?? undefined}
          >
            <Icon name="bolt" size={16} />
            {verifying ? "Verifying…" : "Verify Account"}
          </Button>
        </div>
        {healthData && healthData.status !== "unknown" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
            <InfoTile label="Last Checked" value={formatDateTime(healthData.lastCheckedAt)} />
            <InfoTile label="Last Success" value={formatDateTime(healthData.lastSuccessAt)} />
            <InfoTile label="Last Failure" value={formatDateTime(healthData.lastFailureAt)} />
            <InfoTile label="Consecutive Failures" value={String(healthData.consecutiveFailures)} />
            <InfoTile
              label="Latency"
              value={healthData.lastLatencyMs === null ? "—" : `${healthData.lastLatencyMs}ms latency`}
            />
            <InfoTile
              label="Error Category"
              value={healthData.lastErrorCategory ? titleCase(healthData.lastErrorCategory) : "—"}
            />
            <InfoTile label="Safe Error Code" value={orDash(healthData.lastSafeErrorCode)} mono />
          </div>
        )}
        <RefreshNote state={health} />
        {verifying && (
          <div role="status" className="bg-surface p-space-sm font-code-dense text-code-dense text-on-surface-variant">
            Verification in progress…
          </div>
        )}
        {verifyError && (
          <div role="alert" className="bg-surface p-space-sm font-body-sm text-body-sm text-error">
            {verifyError}
          </div>
        )}
        {verification && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-space-sm bg-surface p-space-sm font-code-dense text-code-dense text-on-surface-variant"
          >
            <span className={verification.status === "healthy" ? "text-tertiary" : "text-error"}>
              Verification: {titleCase(verification.status)}
            </span>
            <span>{verification.message}</span>
            {verification.errorCategory && <span>Category: {titleCase(verification.errorCategory)}</span>}
            {verification.safeErrorCode && <span>Code: {verification.safeErrorCode}</span>}
            {verification.latencyMs !== null && <span>{verification.latencyMs}ms latency</span>}
            <span>Checked {formatDateTime(verification.checkedAt)}</span>
            {refreshFailures && refreshFailures.length > 0 && (
              <span>
                Verification completed, but the account {refreshFailures.join(", ")} could not be refreshed.
              </span>
            )}
          </div>
        )}
      </section>

      {/* Health history */}
      <section aria-label="Health history" className="flex flex-col gap-space-xs">
        <button
          type="button"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((open) => !open)}
          className="flex items-center gap-1 self-start font-code-dense text-code-dense text-outline uppercase tracking-wider hover:text-on-surface"
        >
          <Icon name={historyOpen ? "expand_less" : "expand_more"} size={14} />
          Health History
          {events?.status === "loaded" && ` (${events.data.length})`}
        </button>
        {historyOpen && (
          <>
            <LoadNote state={events} what="health history" />
            {events?.status === "loaded" &&
              (events.data.length === 0 ? (
                <div className="bg-surface p-space-sm font-body-sm text-body-sm text-on-surface-variant">
                  No health events recorded
                </div>
              ) : (
                <div className="overflow-x-auto bg-surface">
                  <table className="w-full text-left font-code-dense text-code-dense">
                    <thead className="text-outline uppercase">
                      <tr>
                        <th className="p-space-xs font-normal">Checked</th>
                        <th className="p-space-xs font-normal">Status</th>
                        <th className="p-space-xs font-normal">Latency</th>
                        <th className="p-space-xs font-normal">Category</th>
                        <th className="p-space-xs font-normal">Code</th>
                      </tr>
                    </thead>
                    <tbody className="text-on-surface-variant">
                      {events.data.map((event) => (
                        <tr key={event.id}>
                          <td className="p-space-xs">{formatDateTime(event.checkedAt)}</td>
                          <td className="p-space-xs">{titleCase(event.status)}</td>
                          <td className="p-space-xs">{event.latencyMs === null ? "—" : `${event.latencyMs}ms`}</td>
                          <td className="p-space-xs">
                            {event.errorCategory ? titleCase(event.errorCategory) : "—"}
                          </td>
                          <td className="p-space-xs">{orDash(event.safeErrorCode)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            <RefreshNote state={events} />
          </>
        )}
      </section>

      {/* Credentials */}
      <section aria-label="Account credentials" className="flex flex-col gap-space-xs">
        <SectionTitle>Credentials — {account.displayName}</SectionTitle>
        <LoadNote state={credentials} what="credentials" />
        {accountCredentials && accountCredentials.length === 0 && !registeringCredential && (
          <div className="bg-surface p-space-sm text-center font-body-sm text-body-sm text-on-surface-variant">
            No credentials configured for this account.
          </div>
        )}
        {accountCredentials?.map((credential) => (
          <div key={credential.id} className="flex flex-col gap-space-xs bg-surface p-space-sm">
            <div className="flex flex-wrap items-center gap-space-sm">
              <Icon name="key" className="text-primary" size={18} />
              <span className="font-code-dense text-code-dense text-on-surface font-bold">
                {credential.credentialType}
                {credential.hasManagedSecret && credential.maskedSecret ? `: ${credential.maskedSecret}` : ""}
              </span>
              <Chip tone={credential.hasManagedSecret ? "secondary" : "neutral"}>
                {credential.hasManagedSecret ? "Inhouse Vault" : "External Reference"}
              </Chip>
              <Chip tone={credential.status === "enabled" ? "tertiary" : "error"}>{credential.status}</Chip>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-space-xs">
              <InfoTile label="Created" value={formatDateTime(credential.createdAt)} />
              <InfoTile label="Updated" value={formatDateTime(credential.updatedAt)} />
              <InfoTile
                label="Last Tested"
                value={credential.lastTestedAt ? formatDateTime(credential.lastTestedAt) : "Never"}
              />
              <InfoTile
                label="Last Successful"
                value={credential.lastSuccessfulAt ? formatDateTime(credential.lastSuccessfulAt) : "Never"}
              />
            </div>

            {rotatingId === credential.id ? (
              <div className="flex flex-col gap-space-sm">
                <SecretModeToggle mode={rotateSecretMode} onChange={setRotateSecretMode} />
                {rotateSecretMode === "managed" ? (
                  <FormField label="New Secret (encrypted by Inhouse before storage; never shown again)">
                    <TextInput
                      type="password"
                      autoComplete="off"
                      value={rotateSecret}
                      onChange={(e) => setRotateSecret(e.target.value)}
                      placeholder="Paste the new provider secret"
                    />
                  </FormField>
                ) : (
                  <FormField label="New Secret Reference (vault path / ID — never the raw secret)">
                    <TextInput
                      value={rotateSecretRef}
                      onChange={(e) => setRotateSecretRef(e.target.value)}
                      placeholder="e.g. vault://inhouse/vendor-credentials/…"
                    />
                  </FormField>
                )}
                <div className="flex items-center gap-space-xs justify-end">
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      setRotatingId(null);
                      setRotateSecret("");
                      setRotateSecretRef("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="primary"
                    type="button"
                    onClick={() => submitRotate(credential)}
                    disabled={rotateSecretMode === "managed" ? !rotateSecret : !rotateSecretRef}
                  >
                    Save New Secret
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-space-sm">
                <Button variant="secondary" onClick={() => setRotatingId(credential.id)}>
                  <Icon name="autorenew" size={16} />
                  Rotate Secret
                </Button>
                <Button variant="secondary" onClick={() => toggleCredentialStatus(credential)}>
                  <Icon name={credential.status === "enabled" ? "toggle_off" : "toggle_on"} size={16} />
                  {credential.status === "enabled" ? "Disable" : "Enable"}
                </Button>
                <Button variant="destructive" className="ml-auto" onClick={() => removeCredential(credential)}>
                  <Icon name="delete" size={16} />
                  Remove
                </Button>
              </div>
            )}
          </div>
        ))}
        <RefreshNote state={credentials} />

        {registeringCredential ? (
          <div className="flex flex-col gap-space-sm bg-surface p-space-sm">
            <FormField label="Credential Type">
              <TextInput value={credentialType} onChange={(e) => setCredentialType(e.target.value)} />
            </FormField>
            <SecretModeToggle mode={secretMode} onChange={setSecretMode} />
            {secretMode === "managed" ? (
              <FormField label="Secret (encrypted by Inhouse before storage; never shown again)">
                <TextInput
                  type="password"
                  autoComplete="off"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="Paste the provider secret"
                />
              </FormField>
            ) : (
              <FormField label="Secret Reference (vault path / ID — never the raw secret)">
                <TextInput
                  value={secretRef}
                  onChange={(e) => setSecretRef(e.target.value)}
                  placeholder="e.g. vault://inhouse/vendor-credentials/…"
                />
              </FormField>
            )}
            <div className="flex items-center gap-space-xs justify-end">
              <Button
                variant="secondary"
                type="button"
                onClick={() => {
                  setRegisteringCredential(false);
                  setSecret("");
                  setSecretRef("");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="button"
                onClick={submitCredential}
                disabled={secretMode === "managed" ? !secret : !secretRef}
              >
                Save Credential
              </Button>
            </div>
          </div>
        ) : (
          accountCredentials && (
            <Button variant="secondary" onClick={() => setRegisteringCredential(true)} className="self-start">
              <Icon name="key" size={16} />
              Add Credential
            </Button>
          )
        )}
      </section>
    </div>
  );
}

/**
 * Chooses which of Block 08's two mutually-exclusive secret storage modes
 * a credential write uses: the recommended INHOUSE-managed vault (the
 * backend encrypts and stores the actual secret, AES-256-GCM — see
 * docs/CREDENTIAL_VAULT.md) or an external reference the operator already
 * manages elsewhere. Never both.
 */
function SecretModeToggle({
  mode,
  onChange,
}: {
  mode: "managed" | "external";
  onChange: (mode: "managed" | "external") => void;
}) {
  return (
    <div className="flex items-center gap-space-xs bg-surface-container-low p-1 self-start">
      {(
        [
          { key: "managed", label: "Inhouse Vault" },
          { key: "external", label: "External Reference" },
        ] as const
      ).map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          className={`font-code-dense text-code-dense uppercase px-space-sm py-1 transition-colors ${
            mode === option.key ? "bg-primary text-on-primary" : "text-on-surface-variant hover:text-on-surface"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function NewAccountForm({
  slug,
  name,
  onSlugChange,
  onNameChange,
  onCancel,
  onSubmit,
}: {
  slug: string;
  name: string;
  onSlugChange: (v: string) => void;
  onNameChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row gap-space-xs bg-surface p-space-sm items-end">
      <FormField label="Slug" className="flex-1">
        <TextInput value={slug} onChange={(e) => onSlugChange(e.target.value)} placeholder="e.g. primary" />
      </FormField>
      <FormField label="Display Name" className="flex-1">
        <TextInput value={name} onChange={(e) => onNameChange(e.target.value)} placeholder="e.g. Primary Account" />
      </FormField>
      <div className="flex items-center gap-space-xs shrink-0">
        <Button variant="secondary" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="button" onClick={onSubmit} disabled={!slug || !name}>
          Save
        </Button>
      </div>
    </div>
  );
}

function InfoTile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="bg-surface p-space-sm flex flex-col gap-0.5 min-w-0">
      <span className="font-code-dense text-code-dense text-outline uppercase">{label}</span>
      <span
        className={`font-body-md text-body-md font-bold truncate text-on-surface ${
          mono ? "font-code-dense text-code-dense" : ""
        }`}
      >
        {value}
      </span>
    </div>
  );
}
