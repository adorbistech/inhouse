/**
 * Small shared UI-level types with no backend equivalent of their own —
 * generic visual state, not business/provider data. Everything that used
 * to live here as a Block 02 mock domain model (Vendor, RoutingPolicy,
 * TelemetryPoint, InhouseApiKey, etc.) has been removed: the frontend now
 * reads that state exclusively from the real Inhouse API (see
 * `./api.ts`), and where no such API exists yet, pages show an explicit
 * "not yet available" state instead of fabricating one.
 */

export type HealthState = "healthy" | "degraded" | "disabled" | "unreachable";
