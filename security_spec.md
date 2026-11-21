# Security Specification — FOREX INTELLIGENCE (Phase 0 TDD)

## 1. Data Invariants
1. **Strict Owner Isolation**: Every user document, setting, signal, signal event, notification, push subscription, and audit log lives under `/users/{userId}` and is readable/writable ONLY by the authenticated owner whose `request.auth.uid == userId` and `request.auth.token.email_verified == true`.
2. **Signal Immutability**: Once a signal is created in `/users/{userId}/signals/{signalId}`, its core analytical origin fields (`id`, `userId`, `instrument`, `direction`, `strategy`, `timeframe`, `executionType`, `score`, `recommendedEntry`, `takeProfit`, `stopLoss`, `observedSpread`, `rationale`, `sourceType`, `createdAt`) MUST NEVER be mutated on update.
3. **Terminal State Locking**: Once a signal reaches a terminal status (`TP_ATINGIDO`, `SL_ATINGIDO`, `ENCERRADO_MANUALMENTE`, `INVALIDADO`, `EXPIRADO`), no further updates are permitted (preventing double-closing a position or rewriting historical outcomes).
4. **Append-Only Signal Events**: Events in `/users/{userId}/signals/{signalId}/events/{eventId}` are strictly `create`-only; `update` and `delete` are forbidden so the audit trail cannot be altered.
5. **Master Gate Parent Validation**: Creating a signal event requires verifying via `get()` that the parent signal exists under `/users/{userId}/signals/{signalId}` and belongs to `request.auth.uid`.
6. **Temporal Integrity**: All `createdAt` and `updatedAt` timestamps MUST equal `request.time` (server timestamp).

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Cross-Tenant Signal Read**: User B attempts `get(/users/userA/signals/sig1)` -> `PERMISSION_DENIED`.
2. **Cross-Tenant List Scraping**: User B attempts `list(/users/userA/signals)` -> `PERMISSION_DENIED`.
3. **Identity Spoofing on Create**: User A writes `/users/userA/signals/sig1` with `userId: "userB"` -> `PERMISSION_DENIED`.
4. **Shadow Ghost Field Injection**: User A writes `/users/userA/signals/sig1` with extra `isAdmin: true` -> `PERMISSION_DENIED` (`hasOnly` check).
5. **Mutating Immutable Entry Price**: User A updates `recommendedEntry` on an existing signal -> `PERMISSION_DENIED`.
6. **Double-Closing Terminal Signal**: User A updates a signal already in `TP_ATINGIDO` to `SL_ATINGIDO` -> `PERMISSION_DENIED`.
7. **Unverified Email Write**: Authenticated token with `email_verified: false` attempts write -> `PERMISSION_DENIED`.
8. **ID Poisoning (1KB+ Doc ID)**: User A creates signal with 200-char doc ID or invalid chars `$bad!` -> `PERMISSION_DENIED` (`isValidId`).
9. **Array Flood Attack**: User A creates signal with `indicatorsJustification` containing 50 strings (> max 20) -> `PERMISSION_DENIED`.
10. **Forged Client Timestamp**: User A creates signal with `createdAt` set to a past date instead of `request.time` -> `PERMISSION_DENIED`.
11. **Audit Trail Tampering**: User A attempts to `update` or `delete` an existing `/events/{eventId}` -> `PERMISSION_DENIED`.
12. **Orphaned Event Creation**: User A creates `/users/userA/signals/nonexistent/events/ev1` -> `PERMISSION_DENIED` (Master Gate `exists()` check).
