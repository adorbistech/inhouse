# Services

Business logic orchestration: validation happens before this layer,
routes call into it, and it owns transactions and audit-event recording.
No SQL lives here — every query goes through a typed repository.

- `vendorService.ts` (Block 06) — the Vendor System: vendors, vendor
  accounts, vendor credential metadata, and vendor capability/workload
  assignment.

Reserved for future Inhouse business logic not yet built: model catalog,
routing, telemetry, accounting, provider adapters.
