# Legacy-to-MERN parity contract

This document preserves the behavioral contract extracted from the Python system before `temp/` is removed.

## Architecture and ownership

The target is one deployable modular backend with four strict authority modules and one role-based React frontend. MongoDB collections remain authority-scoped:

- Exchange owns venues, instruments, listings, members, order book, executions, obligations and instructions.
- Broker owns traders, sessions, local routing records, exchange replicas, client attribution and enlistments.
- Storage owns vault lots, present owner and append-only transfer history.
- Desk owns account books, local orders/trades, cash, valuation marks, positions, P&L, settlement replicas and reports.

No module may reinterpret another authority's terminal state. In particular, the broker and desk cannot settle an exchange obligation.

## Identity and permissions

- Authentication identities are normalized in one `users` collection and discriminated by `userType`: Trader, Broker, Exchange, or Storage.
- Operator authorization realms remain separate at runtime: Broker, Exchange and Storage; Trader users are routed to the account-scoped Desk realm.
- Roles are Admin, Operations and Read-only. Only Admin/Operations mutate domain state.
- The last active administrator in a realm cannot be demoted or disabled.
- Traders are broker clients, not operators, but share the same identity collection. Their opaque 12-hour session token is stored only as SHA-256 in `usersessions`.
- Trader states: `Active -> Suspended | Closed`, `Suspended -> Active | Closed`, `Closed` is terminal.
- Suspended users may authenticate to read their reason but cannot trade. Password/status changes end existing sessions.

## Matching contract

- Incoming orders cross continuously against the best opposite resting order.
- Buy orders take the lowest offer; sell orders take the highest bid. Equal prices use earliest shared sequence.
- The resting order price is the execution price.
- Partial fills rest their exact residual; order and execution events share one monotonic sequence.
- Tick, lot, price-band, venue and listing rules are checked in the service, never only in UI.
- A malformed request has no side effect. A refused member creates no exchange order. A valid member's rule failure creates a `Rejected` order.
- Broker order references are idempotent per member. Trader client references are idempotent per trader.
- Same-member self-trades are legal because one broker can represent both clients.

## Broker routing contract

Routing states are `Pending`, `Routed`, `Rejected`, `Refused`, and `Unrouted`.

- The broker records an instruction before attempting delivery.
- `Rejected` means the exchange received and declined it; terminal.
- `Refused` means membership/credentials prevented delivery; retryable.
- `Unrouted` means transport did not complete; retryable.
- Retry preserves the same local order ID.
- Optional principal step-in happens at most once and posts a deliberate opposite member order.
- Exchange fills are pulled idempotently. Own-client crossings create a second broker perspective with `:cp` identity.
- Obligation attribution joins execution ID **and side**; unattributed rows remain visible.

## Accounting contract

Only `Completed` trades affect positions, P&L and primary cash movement. Draft, Submitted, Cancelled and Reversed trades remain visible without accounting effect.

Weighted-average engine rules:

- Buy/open long charges increase basis.
- Sell/open short charges reduce its signed average entry value.
- Scaling in uses weighted average.
- Reductions preserve remaining average cost.
- Realized P&L is generated only by closed quantity.
- A zero crossing splits charges pro rata between closed and newly opened quantities.
- Shorts use negative quantity and negative signed cost basis.
- Tiny quantities below `1e-9` are flat.
- Every replay is ordered by trade date, creation time and stable identity so back-dated trades recompute deterministically.
- Accounts are isolated; the same symbol in two account books never shares average cost or realized P&L.

Cash rules:

- Buy movement: `-(quantity * price + charges)`.
- Sell movement: `quantity * price - charges`.
- Amendment corrects the primary movement and audits the previous value.
- Reversal preserves the original and appends an equal opposite movement.
- Deposits are positive, withdrawals are stored negative, adjustments may have either sign, and zero is invalid.

P&L is always `realized + unrealized`; charges already live in basis/realized calculations and are never subtracted twice.

## Settlement and custody contract

- Every execution creates exactly two bilateral obligations, one per member/side.
- Settlement days and depository are snapshots at trade time; later relisting never mutates history.
- Spot settlement uses weekends-excluded T+N. Holidays are intentionally not invented. `1M` clamps to a valid calendar date then rolls to a business day.
- Cash leg states: Unsettled, Settled, Failed.
- Security leg states: Instructed, Attested, Failed. It is never labelled Settled.
- Delivery-versus-payment settles both mirrored obligations once; repeat settle/fail is rejected.
- Exact physical lots must exist, be held by the seller, match security/depository/weight and sum exactly to delivered quantity.
- Storage transfer must succeed before security attestation. Owner history is append-only. Withdrawn lots cannot move.
- Exchange lot states are Held, Obligated and Delivered; a failed operation releases obligated lots.
- Overdue and days-late values are derived from settlement date, not persisted authority fields.

## Audit and immutability

Material writes emit field-level old/new audit events with actor, realm, collection and record identity. Matching and settlement use MongoDB transactions; production MongoDB therefore requires a replica set. Trades, orders, obligations, custody transfers and audit events are never hard-deleted as a lifecycle operation. Instruments/listings are retired through status.

## Frontend parity

All legacy pages are represented, including desk trade/order/blotter/holdings/P&L/cash/prices/reports/settings; broker dashboard/clients/enlistments/routing/executions/exchange/settlement/settings; exchange dashboard/mandis/instruments/securities/brokers/order book/depositories/settlement/instructions/settings; storage vault/inventory/history; and realm audit views.
