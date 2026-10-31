# Box Office API Contract and Implementation Blueprint

This document turns `examples/box-office/specification.md` into a concrete, stable HTTP contract for the future server implementation in `hidden/box-office/`.

Scope of this document:
- exact routes, methods, auth and role rules
- request and response schemas
- exact error envelope shape
- validation and error precedence
- domain rules and state transitions
- waitlist and discount behavior
- report calculations
- sorting, filtering and pagination semantics
- implementation guidance for a black-box-compatible in-memory server

This document does **not** implement the server.

---

## 1. Runtime and environment contract

Implementation must satisfy all of the following:

- Standalone TypeScript project rooted at `hidden/box-office/`
- Runs on Node 22
- Test runner behavior:
  - `npm install`
  - `npm run build` if present
  - `npm start`
- Server listens on `process.env.PORT`
- `process.env.HOLD_SECONDS` controls hold lifetime in seconds
  - default: `600`
  - tests may set it to a small value
- Storage is in-memory only
- No database server
- No external network calls

### Required environment variables

| Name | Required | Default | Meaning |
|---|---:|---:|---|
| `PORT` | yes | none | HTTP listen port |
| `HOLD_SECONDS` | no | `600` | Number of seconds before a held order expires |

### Environment parsing requirements

Implementation guidance:
- `PORT` must be read as provided by the environment and used for the listening port.
- `HOLD_SECONDS` should be parsed once at startup as an integer number of seconds.
- If `HOLD_SECONDS` is absent, use `600`.
- For compatibility, implementations should treat a non-integer or non-positive `HOLD_SECONDS` as configuration error and fail fast at startup, though tests are expected to provide valid values.

---

## 2. Global HTTP conventions

## Content type
- Request and response bodies are JSON.
- If a request body is required and the body is not valid JSON, respond with `400`.
- All successful responses use JSON.
- All error responses use JSON object form:

```json
{ "error": "<any message>" }
```

The message text is not fixed by the spec, but the body shape is fixed and must always be exactly one object with an `error` string.

## Unknown routes
- Any unmatched route returns `404` with:

```json
{ "error": "<any message>" }
```

## IDs
- All ids are strings.
- All ids are unique across the whole API, not just within one resource type.

Implementation guidance:
- A single global id generator is safest.

## Money
- All money values are integer cents.
- Never return decimal money.

## Time
- Request timestamps: any value accepted by JavaScript `Date.parse(...)` is valid.
- Response timestamps: always serialize with `Date.prototype.toISOString()`.
- All returned times are UTC ISO 8601 strings such as `2026-11-02T18:00:00.000Z`.

## Authentication header
Protected endpoints require:

```http
Authorization: Bearer <token>
```

Rules:
- Missing header: `401`
- Malformed header: `401`
- Unknown token: `401`
- Valid token for wrong role: `403`

Implementation guidance:
- Use case-sensitive `Bearer` matching.
- Treat token lookup as exact-string match.

---

## 3. Mandatory validation and error precedence

Checks must happen in this order, and the **first failure decides the response**:

1. token/authentication → `401`
2. caller role requirement → `403`
3. request input/shape/format → `400`
4. named resource existence → `404`
5. caller access to that resource → `403` or `404` depending on endpoint-specific visibility rules
6. resource state conflict → `409`
7. business limits/rule limits → `422`

This precedence is mandatory across endpoints.

### Important interpretation notes

- Invalid JSON is an input failure, therefore `400`, but only after auth/role checks for protected routes.
- For protected endpoints, do not validate body/query/path semantics before token and role checks.
- “Named things” means objects directly referenced by path/body/query ids or codes where existence is part of routing/business lookup.
- “Access to resource” differs by endpoint:
  - some endpoints intentionally hide access with `404`
  - others expose resource existence and use `403`
- “State” means resource exists but is in the wrong current status or time window.
- “Limits” means quantitative/business rule limits like customer cap or unusable discount code.

### Required endpoint-specific access status behavior

- `POST /events/:id/cancel`: wrong organizer for an existing event → `403`
- `POST /events/:id/discounts`: wrong organizer for an existing event → `403`
- `GET /events/:id/report`: wrong organizer for an existing event → `403`
- `POST /orders/:id/pay`: someone else’s order → `404`
- `POST /orders/:id/cancel`: someone else’s order → `404`
- `GET /orders/:id`: caller is neither owning customer nor event organizer → `404`

---

## 4. Canonical data shapes

## 4.1 User

Returned user shape:

```json
{
  "id": "string",
  "email": "user@example.com",
  "name": "User Name",
  "role": "organizer"
}
```

Rules:
- `role` is exactly `"organizer"` or `"customer"`
- Password is never returned by any endpoint
- Email uniqueness is case-insensitive

Implementation guidance:
- Preserve original email casing in responses or normalize consistently; uniqueness and login matching must be case-insensitive.

## 4.2 Event

```json
{
  "id": "string",
  "title": "Jazz Night",
  "venue": "Main Hall",
  "startsAt": "2026-11-02T18:00:00.000Z",
  "status": "on_sale",
  "organizerId": "string",
  "tiers": [
    {
      "id": "string",
      "name": "General",
      "priceCents": 2500,
      "quantity": 100,
      "available": 75
    }
  ]
}
```

Rules:
- `status` is `"on_sale"` or `"cancelled"`
- `available = quantity - heldTickets - paidTickets`
- expired orders do not count as held
- cancelled/refunded orders do not count against availability

## 4.3 Order

```json
{
  "id": "string",
  "eventId": "string",
  "customerId": "string",
  "status": "held",
  "items": [
    {
      "tierId": "string",
      "quantity": 2,
      "unitPriceCents": 2500
    }
  ],
  "subtotalCents": 5000,
  "discountCode": null,
  "discountCents": 0,
  "totalCents": 5000,
  "createdAt": "2026-11-02T18:00:00.000Z",
  "expiresAt": "2026-11-02T18:10:00.000Z",
  "paidAt": null
}
```

Rules:
- `status` is one of:
  - `"held"`
  - `"paid"`
  - `"expired"`
  - `"cancelled"`
  - `"refunded"`
- `discountCode` is `null` or stored code string in uppercase canonical form
- `paidAt` is `null` until order is paid
- `expiresAt` is always present, even for later statuses

## 4.4 Discount

```json
{
  "code": "SAVE10",
  "percentOff": 10,
  "amountOffCents": null,
  "maxUses": 100,
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "uses": 3
}
```

Rules:
- Absent optional inputs become `null` in responses
- exactly one of `percentOff` and `amountOffCents` is non-null
- `code` is stored and returned uppercase
- `uses` counts orders for the event with this code whose status is `held` or `paid`

## 4.5 Waitlist entry

```json
{
  "id": "string",
  "eventId": "string",
  "tierId": "string",
  "quantity": 2,
  "position": 1
}
```

Rules:
- `position` is 1-based within a tier’s current queue
- positions are dynamic and must reflect current queue order when returned

## 4.6 Report

```json
{
  "eventId": "string",
  "tiers": [
    {
      "tierId": "string",
      "name": "General",
      "sold": 10,
      "held": 2,
      "available": 88
    }
  ],
  "grossCents": 25000,
  "discountCents": 1000,
  "refundedCents": 5000,
  "netCents": 24000
}
```

---

## 5. Authentication model blueprint

The specification does not define token format. The implementation may choose any opaque token string so long as:
- `POST /sessions` returns `{ "token": "..." }`
- protected endpoints accept it through `Authorization: Bearer <token>`
- invalid or unknown tokens return `401`

Implementation blueprint:
- Maintain in-memory sessions keyed by token
- Each session maps to exactly one user id
- Multiple sessions per user are acceptable
- Tokens should be unguessable in practice, but tests should only rely on opacity, not format

---

## 6. Route-by-route contract

## 6.1 POST /users
Create account.

### Auth
- Public

### Request body

```json
{
  "email": "alice@example.com",
  "password": "password123",
  "name": "Alice",
  "role": "customer"
}
```

### Input validation
Return `400` unless all are true:
- body is valid JSON object
- `email` is a string containing `@` and also a `.` somewhere after the `@`
- `password` is a string of length at least 8
- `name` is a string with length 1 to 100 inclusive
- `role` is exactly `"organizer"` or `"customer"`

### Conflict
- If another user already exists with same email case-insensitively → `409`

### Success
- Status: `201`
- Response:

```json
{
  "id": "u_1",
  "email": "alice@example.com",
  "name": "Alice",
  "role": "customer"
}
```

### Notes
- Password must be stored privately and never returned.
- Case-insensitive uniqueness means `Alice@Example.com` and `alice@example.com` conflict.

---

## 6.2 POST /sessions
Create login session.

### Auth
- Public

### Request body

```json
{
  "email": "alice@example.com",
  "password": "password123"
}
```

### Input validation
- If body is not valid JSON object with string `email` and string `password`, return `400`.

### Authentication behavior
- Find user by email case-insensitively.
- Compare password exactly.
- Wrong email or wrong password → `401`

### Success
- Status: `200`

```json
{
  "token": "opaque-session-token"
}
```

---

## 6.3 GET /me
Get current user.

### Auth
- Protected
- Any authenticated user

### Success
- `200` with user object

### Failures
- invalid/missing token → `401`

---

## 6.4 POST /events
Create event.

### Auth
- Protected
- organizer only

### Request body

```json
{
  "title": "Jazz Night",
  "venue": "Main Hall",
  "startsAt": "2026-11-02T18:00:00Z",
  "tiers": [
    { "name": "General", "priceCents": 2500, "quantity": 100 },
    { "name": "VIP", "priceCents": 5000, "quantity": 20 }
  ]
}
```

### Validation order
1. token → `401`
2. role organizer → `403`
3. input → `400`

### Input validation
Return `400` unless all are true:
- body is valid JSON object
- `title` is string length 1..100
- `venue` is string length 1..100
- `startsAt` is parseable by `Date.parse`
- parsed `startsAt` is strictly in the future relative to request handling time
- `tiers` is an array with length 1..5
- each tier is an object with:
  - `name`: string
  - `priceCents`: integer >= 0
  - `quantity`: integer in [1, 10000]
- tier names are unique within the event

Implementation guidance:
- Treat tier-name uniqueness as exact string uniqueness, case-sensitive unless implementation explicitly documents otherwise. To avoid ambiguity in tests, tests should use distinct names.

### Success
- `201` with event object
- event `status` is `"on_sale"`
- `organizerId` is caller user id
- each tier gets generated id
- each tier `available` initially equals `quantity`

---

## 6.5 GET /events
List public on-sale events.

### Auth
- Public

### Query parameters
All optional:
- `from`: parseable date
- `to`: parseable date
- `q`: string search term
- `page`: integer >= 1, default `1`
- `pageSize`: integer >= 1 and <= 50, default `10`

### Input validation
Any invalid query value → `400`

Clarifications:
- If `page` or `pageSize` is missing, use defaults.
- If `page` or `pageSize` is present but not a valid integer in range, return `400`.
- If `from` or `to` is present but not parseable by `Date.parse`, return `400`.
- `q` must be a string if provided.

### Filtering
Only include events with `status = "on_sale"`.

Apply optional filters:
- `from`: include only events where `startsAt >= from`
- `to`: include only events where `startsAt <= to`
- bounds are inclusive
- `q`: case-insensitive substring match against `title` or `venue`

### Sorting
Sort by:
1. `startsAt` ascending
2. `title` ascending

Implementation guidance:
- If both equal, preserve stable insertion order or break by id; tests should only depend on required keys.

### Pagination
- `total` = count after filtering, before pagination
- `page` = actual page number used
- `pageSize` = actual page size used
- `items` = slice for requested page
- If page is beyond available results, return empty `items` with same `page`, `pageSize`, `total`

### Success response

```json
{
  "items": [
    {
      "id": "e_1",
      "title": "Jazz Night",
      "venue": "Main Hall",
      "startsAt": "2026-11-02T18:00:00.000Z",
      "status": "on_sale",
      "organizerId": "u_1",
      "tiers": [
        {
          "id": "t_1",
          "name": "General",
          "priceCents": 2500,
          "quantity": 100,
          "available": 100
        }
      ]
    }
  ],
  "page": 1,
  "pageSize": 10,
  "total": 1
}
```

---

## 6.6 GET /events/:id
Get event by id.

### Auth
- Public

### Behavior
- Return event whether `on_sale` or `cancelled`
- Unknown event id → `404`

### Success
- `200` with event object

---

## 6.7 POST /events/:id/cancel
Cancel event.

### Auth
- Protected
- organizer only

### Validation order
1. token → `401`
2. role organizer → `403`
3. input/path shape → `400` only if implementation performs path decoding validation; normally not applicable
4. event existence → `404`
5. organizer ownership → `403`
6. state (`already cancelled`) → `409`

### Success effects
When cancelling an on-sale event:
- event status becomes `"cancelled"`
- every `paid` order for the event becomes `"refunded"`
- every `held` order for the event becomes `"cancelled"`
- every `expired`, `cancelled`, or `refunded` order remains unchanged
- event waitlist is emptied
- no waitlist service is triggered from this cancellation cascade

### Success response
- `200` with updated event object

### Notes
- Before evaluating held orders, implementation must lazily expire any that are already past `expiresAt`, so responses reflect reality.
- Those lazily expired orders should remain `expired`, not become `cancelled`.

---

## 6.8 POST /orders
Create held order.

### Auth
- Protected
- customer only

### Request body

```json
{
  "eventId": "e_1",
  "items": [
    { "tierId": "t_1", "quantity": 2 }
  ],
  "discountCode": "save10"
}
```

### Validation order
1. token → `401`
2. role customer → `403`
3. input/body validation → `400`
4. event existence → `404`
5. resource-specific access check → none beyond role
6. state checks → `409`
7. business limits → `422`

### Input validation
Return `400` unless all are true:
- body is valid JSON object
- `eventId` is a string
- `items` is an array with at least 1 element
- each item has:
  - `tierId` string
  - `quantity` integer >= 1
- no `tierId` appears twice in `items`
- if `discountCode` is present, it is a string

### Named resource and tier validation
- Unknown `eventId` → `404`
- If any `tierId` does not belong to that event → `400`

This tier mismatch is explicitly `400`, not `404`.

### State validation
After lazily expiring any expired held orders system-wide or at least for this event/customer context:
- if event status is not `on_sale` → `409`
- if event `startsAt` is at or before current time → `409`
- if any requested tier lacks enough currently available tickets → `409`
- on insufficient availability, create no order and hold nothing

### Limit validation
- Per-event customer cap: customer may have at most 6 tickets for the event across orders currently in `held` or `paid` status
- `expired`, `cancelled`, and `refunded` orders do not count
- New order quantities are added across all requested items
- If total would exceed 6 → `422`

### Discount validation
If `discountCode` provided, normalize it case-insensitively for lookup.
Return `422` if code is unusable because:
- event does not have that code
- code has expired
- code is used up

### Pricing rules
- `unitPriceCents` comes from current event tier price at order creation time
- `subtotalCents` = sum of `quantity * unitPriceCents` across items
- `discountCents`:
  - percent code: `floor(subtotalCents * percentOff / 100)`
  - amount code: `min(amountOffCents, subtotalCents)`
  - no code: `0`
- `totalCents = subtotalCents - discountCents`
- `discountCode` in stored/returned order should be uppercase canonical code if applied, else `null`

### Success
- `201` with new order in `held` state
- `createdAt` = current time
- `expiresAt` = `createdAt + HOLD_SECONDS * 1000`
- `paidAt` = `null`

### Atomicity requirement
Order creation is all-or-nothing:
- if any item fails availability, no ticket is held for any item
- if any rule fails, no order is created
- discount usage count changes only by virtue of created held/paid orders, not separate counters that can drift

---

## 6.9 POST /orders/:id/pay
Pay held order.

### Auth
- Protected
- customer only

### Validation order
1. token → `401`
2. role customer → `403`
3. input/path validation → usually none
4. order existence → `404`
5. ownership access → someone else’s order is `404`
6. state → `409`

### State validation
Before checking status, lazily expire the order if now > `expiresAt` and status is still `held`.
Then:
- only `held` may transition to `paid`
- `expired`, `cancelled`, `refunded`, or already `paid` → `409`

### Success effects
- set status to `paid`
- set `paidAt` to current time in ISO format
- keep all money fields unchanged

### Success response
- `200` with updated order

---

## 6.10 POST /orders/:id/cancel
Cancel or refund order.

### Auth
- Protected
- customer only

### Validation order
1. token → `401`
2. role customer → `403`
3. input/path validation → usually none
4. order existence → `404`
5. ownership access → someone else’s order is `404`
6. state → `409`

### State rules
Before evaluation, lazily expire if needed.
Then:
- if status is `held` → change to `cancelled`
- if status is `paid`:
  - if event starts more than 24 hours from now → change to `refunded`
  - otherwise → `409`
- if status is `expired`, `cancelled`, or `refunded` → `409`

### Refund window rule
“more than 24 hours from now” means strict inequality:
- allowed only when `event.startsAt - now > 24 hours`
- if exactly 24 hours remain, refund is **not** allowed and response is `409`

### Side effects
- If cancellation/refund frees tickets in one or more tiers, each affected tier’s waitlist must be served strictly FIFO after the status change.

### Success response
- `200` with updated order

---

## 6.11 GET /orders/:id
Get single order.

### Auth
- Protected
- any authenticated user

### Access rules
After token validation:
- if order id does not exist → `404`
- if caller is the order’s customer → allow
- else if caller is the organizer of the order’s event → allow
- else → `404`

### State visibility
Before returning, lazily expire the order if needed.

### Success
- `200` with order object

---

## 6.12 GET /me/orders
List current customer’s orders.

### Auth
- Protected
- customer only

### Behavior
- Return only caller’s orders
- Lazily expire any expired held orders before producing list
- Sort newest first by creation time descending

Implementation guidance:
- If two orders have identical `createdAt`, break ties by creation sequence descending or id; tests should only depend on newest-first semantics.

### Success
- `200` with JSON array of order objects

---

## 6.13 POST /events/:id/discounts
Create event discount code.

### Auth
- Protected
- organizer only

### Request body

```json
{
  "code": "save10",
  "percentOff": 10,
  "maxUses": 100,
  "expiresAt": "2026-12-01T00:00:00Z"
}
```

### Validation order
1. token → `401`
2. role organizer → `403`
3. input → `400`
4. event existence → `404`
5. organizer ownership → `403`
6. state → none specified
7. limits/conflict → duplicate code is `409`; unusable creation limits are input errors

### Input validation
Return `400` unless all are true:
- body is valid JSON object
- `code` is a string matching regex `^[A-Za-z0-9]{3,20}$`
- exactly one of `percentOff` and `amountOffCents` is provided
- if `percentOff` provided: integer from 1 to 100 inclusive
- if `amountOffCents` provided: integer >= 1
- if `maxUses` provided: integer >= 1
- if `expiresAt` provided: parseable by `Date.parse`

### Canonicalization
- Store `code` in uppercase
- Match case-insensitively at checkout

### Conflict
- If event already has same code case-insensitively → `409`

### Success response
- `201`

```json
{
  "code": "SAVE10",
  "percentOff": 10,
  "amountOffCents": null,
  "maxUses": 100,
  "expiresAt": "2026-12-01T00:00:00.000Z",
  "uses": 0
}
```

### Discount usability at checkout
A code is unusable and causes `422` on `POST /orders` if:
- not found on the event
- expired at checkout time
- `maxUses` is non-null and current `uses >= maxUses`

### Expiry boundary
Treat code as expired when current time is strictly greater than `expiresAt`.
If current time equals `expiresAt`, it is still usable unless implementation chooses a stricter interpretation consistently. For black-box stability, prefer: expired when `now > expiresAt`.

---

## 6.14 POST /events/:id/waitlist
Join waitlist for a tier.

### Auth
- Protected
- customer only

### Request body

```json
{
  "tierId": "t_1",
  "quantity": 2
}
```

### Validation order
1. token → `401`
2. role customer → `403`
3. input → `400`
4. event existence → `404`
5. resource-access check → none beyond role
6. state/conflict → `409`
7. limits → none beyond input here

### Input validation
Return `400` unless all are true:
- body is valid JSON object
- `tierId` is a string
- `quantity` is an integer from 1 to 6 inclusive

### Named thing validation
- Unknown event id → `404`
- If `tierId` is not one of the event’s tiers, treat as `400` for consistency with order tier validation and because the body names a tier inconsistent with the chosen event.

### Conflict rules
- Only allowed when the tier currently has fewer than requested `quantity` tickets available
  - if available tickets are enough already, return `409`
- if same customer already has an active waitlist entry for that tier, return `409`

### Success behavior
- Append customer to the end of that tier’s queue
- `position` is 1-based queue position after insertion

### Success response

```json
{
  "id": "w_1",
  "eventId": "e_1",
  "tierId": "t_1",
  "quantity": 2,
  "position": 1
}
```

### Active waitlist entry definition
Implementation guidance:
- Because served entries are removed and event cancellation empties waitlists, “already waiting” means there is a current, not-yet-removed waitlist entry for that customer and tier.

---

## 6.15 GET /me/waitlist
List caller’s waitlist entries.

### Auth
- Protected
- customer only

### Behavior
- Return current active waitlist entries belonging to caller
- Each item includes current dynamic `position`
- Order of returned entries is not explicitly specified

Implementation guidance:
- For deterministic behavior, sort by creation time ascending, then id.

### Success
- `200` with array of waitlist entries

---

## 6.16 GET /events/:id/report
Get event report.

### Auth
- Protected
- organizer only

### Validation order
1. token → `401`
2. role organizer → `403`
3. input/path validation → usually none
4. event existence → `404`
5. organizer ownership → `403`
6. state → none; report is available even for cancelled events unless implementation explicitly documents otherwise, and spec does not forbid it

### Precondition for accurate report
Before calculating, lazily expire any expired held orders relevant to the event.

### Calculations
Per tier:
- `sold` = total quantity from orders with status `paid`
- `held` = total quantity from orders with status `held`
- `available` = tier quantity - sold - held
- `name` comes from tier definition

Whole-event totals:
- `grossCents` = sum of `subtotalCents` over `paid` orders for the event
- `discountCents` = sum of `discountCents` over `paid` orders for the event
- `netCents` = sum of `totalCents` over `paid` orders for the event
- `refundedCents` = sum of `totalCents` over `refunded` orders for the event

### Success response
- `200` with report object

---

## 7. Lazy expiration contract

Held orders expire when past `expiresAt`.

### Required semantic rule
A held order past `expiresAt` is considered `expired`, and its tickets are available again.
The implementation may compute this lazily, but **every response must reflect it**.

### Required operational consequence
Before any response or business action that depends on order status, ticket availability, discount uses, customer cap, waitlist servicing, or report values, the implementation must first apply lazy expiration to all relevant held orders.

At minimum, lazy expiration must be applied before:
- returning any event where `available` is included
- listing events if event availability is derived there
- creating an order
- paying an order
- cancelling an order
- getting an order
- listing `/me/orders`
- creating a waitlist entry
- listing `/me/waitlist` positions if queue could have changed through service after expiration
- cancelling an event
- generating an event report
- computing discount `uses`

### Expiration side effects
When an order expires:
- status changes from `held` to `expired`
- tickets become available
- if the order had a discount code, that code’s effective `uses` decreases because only `held` and `paid` count
- availability increase may trigger waitlist servicing for affected tiers

### Waitlist interaction with expiration
If one or more expired orders free tickets in a tier, that tier’s waitlist must be served strictly FIFO immediately as part of the same logical reconciliation before the response is produced.

Implementation blueprint:
- Centralize a reconciliation routine such as:
  1. expire overdue held orders
  2. for every affected tier, serve waitlist
  3. recompute derived availability/positions/discount uses from authoritative state

---

## 8. State transitions

## Orders

Allowed transitions:

- `held` → `paid` via `POST /orders/:id/pay`
- `held` → `cancelled` via `POST /orders/:id/cancel`
- `held` → `expired` via lazy expiration
- `paid` → `refunded` via:
  - event cancellation, or
  - `POST /orders/:id/cancel` more than 24h before event start

Disallowed transitions:
- `paid` → `cancelled`
- `expired` → anything else
- `cancelled` → anything else
- `refunded` → anything else
- `paid` → `paid` again

## Events

Allowed transitions:
- `on_sale` → `cancelled` via `POST /events/:id/cancel`

Disallowed transitions:
- `cancelled` → `on_sale`
- repeat cancellation → `409`

---

## 9. Per-event 6-ticket cap

A customer may hold or own at most 6 tickets per event.

### Counting rule
Count ticket quantities across all of that customer’s orders for the event whose status is:
- `held`
- `paid`

Do not count:
- `expired`
- `cancelled`
- `refunded`

### Application points
- Enforce on `POST /orders`
- Enforce while serving waitlist entries

### Waitlist service over-cap rule
If the first waitlist entry would take the customer over 6 tickets for that event:
- remove that waitlist entry without creating an order
- continue checking the next entry

That removal is not an error response because it occurs during background reconciliation behavior.

---

## 10. Discount code rules

## Canonicalization and matching
- Codes are stored uppercase
- Matching is case-insensitive
- Returned `discountCode` on orders should be uppercase canonical value

## Uniqueness
- Uniqueness is per event, not global
- Same code may exist on different events
- Same code on same event ignoring case → `409`

## Usage counting
`uses` is not an independently mutable source of truth.
It is the count of orders for the event with that code and status in `{held, paid}`.

Therefore:
- creating a held order increments effective usage
- paying an order does not change effective usage count category; it remains counted
- expiring a held order decrements effective usage
- cancelling a held order decrements effective usage
- refunding a paid order decrements effective usage because refunded is not counted

## Validation order with discounts on order creation
On `POST /orders`:
- first complete input validation
- then confirm event exists
- then tier-membership validation
- then event state and availability validation
- then customer 6-ticket cap
- then discount usability

So if both cap and discount would fail, return `422` for the cap first only if implementation evaluates limits in that order. For black-box stability, implementation should explicitly check cap before discount code usability because the source spec lists cap first.

## Examples
- 10% off `subtotalCents=999` ⇒ `discountCents=floor(999*10/100)=99`
- amount-off 500 on subtotal 300 ⇒ `discountCents=300`

---

## 11. Waitlist service contract

Waitlists are maintained per event tier.

## Joining rules
- Customer-only endpoint
- Quantity 1..6
- Allowed only when current `available < requested quantity`
- One active entry per customer per tier

## FIFO service rule
Whenever tickets become available again for a tier because an order:
- expires
- is cancelled
- is refunded

then that tier’s waitlist must be processed as follows:

1. Look at the first entry only.
2. If that entry’s `quantity` fits in current available tickets:
   - check customer cap
   - if cap would be exceeded, remove entry without creating order and continue
   - else create a new held order for that exact event/tier/quantity
   - no discount code is applied
   - remove entry from waitlist
   - continue from new first entry
3. If the first entry’s quantity does **not** fit, stop processing entirely.
4. Never skip a fitting problem to serve someone behind them.

This is strict FIFO with head-of-line blocking.

## Auto-created held orders from waitlist
When service creates an order:
- it is equivalent to a normal held order except:
  - items contain exactly one item for that tier and queued quantity
  - `discountCode = null`
  - `discountCents = 0`
  - pricing uses current tier price
  - same `createdAt`/`expiresAt` semantics using `HOLD_SECONDS`
- it belongs to the waitlisted customer
- it should immediately affect availability and customer cap counts

### Service triggers
Waitlist service must run after any change that frees tickets:
- order expiration
- order cancellation from held state
- order refund from paid state

Waitlist is also emptied without service when event is cancelled.

---

## 12. Report calculation contract

Reports are event-scoped and organizer-only.

### Included orders by status
Per-tier quantities:
- `sold`: only `paid`
- `held`: only `held`
- `available`: `quantity - sold - held`

Whole-event totals:
- `grossCents`: sum of `subtotalCents` over `paid`
- `discountCents`: sum of `discountCents` over `paid`
- `netCents`: sum of `totalCents` over `paid`
- `refundedCents`: sum of `totalCents` over `refunded`

### Excluded statuses
- `expired` excluded from all sums and held counts
- `cancelled` excluded from all sums and held counts
- `refunded` excluded from sold/gross/discount/net, but included in `refundedCents`

---

## 13. Concrete compatibility examples

## Example A: auth precedence over bad body
Request:

```http
POST /events
Authorization: Bearer badtoken
Content-Type: application/json

not json
```

Response:
- `401`, not `400`

```json
{ "error": "invalid token" }
```

## Example B: role precedence over bad body
Authenticated customer calls organizer endpoint with invalid JSON.

Response:
- `403`, not `400`

## Example C: named event before ownership
Organizer A calls `POST /events/:id/cancel` for:
- unknown event id ⇒ `404`
- existing event owned by Organizer B ⇒ `403`

## Example D: order tier mismatch
`POST /orders` references real event `e1` and tier id from another event.

Response:
- `400`

## Example E: state before limits
If event is already started and request also exceeds customer cap:
- respond `409` because event state fails before limit checks.

## Example F: hold expiration
If `HOLD_SECONDS=2`, order created at `12:00:00.000Z` expires at `12:00:02.000Z`.
At `12:00:02.001Z`, responses must show it as `expired`.

## Example G: customer cap
Customer has one paid order for 4 tickets and one held order for 2 for same event.
Any new order for that event with quantity >= 1 ⇒ `422`.

## Example H: discount uses released
Discount `SAVE10` with `maxUses=1` is used by a held order.
Another checkout with `SAVE10` ⇒ `422`.
If first held order expires or is cancelled, next checkout may use it successfully.

## Example I: waitlist head-of-line blocking
Tier availability becomes 2.
Queue:
1. customer A wants 3
2. customer B wants 1

No one is served because first entry does not fit.

## Example J: waitlist over-cap removal
First waitlist entry fits inventory, but customer already has 6 tickets for event.
That entry is removed with no order.
Then next entry may be served if it fits and cap allows.

## Example K: refund cutoff
If event starts at `2026-11-03T18:00:00.000Z` and now is exactly `2026-11-02T18:00:00.000Z`, customer cancellation of a paid order returns `409` because start is not more than 24 hours away.

---

## 14. Suggested in-memory model for implementation agents

This section is non-normative but intended to reduce ambiguity.

Possible stores:
- `usersById`
- `usersByEmailLower`
- `sessionsByToken`
- `eventsById`
- `ordersById`
- `discountsByEventId`
- `waitlistsByTierId` as FIFO arrays

Suggested authoritative/derived split:
- Store canonical entities without `available` or waitlist `position`
- Compute `available`, `uses`, and `position` on read after reconciliation

Suggested reusable domain routines:
- `now()` abstraction for testability
- `reconcileExpirationsAndWaitlists()`
- `expireOrder(order)`
- `serveWaitlistForTier(tierId)`
- `computeCustomerEventTicketCount(customerId, eventId)`
- `computeDiscountUses(eventId, code)`
- `computeEventView(event)`
- `computeOrderView(order)`
- `computeReport(eventId)`

---

## 15. Minimal OpenAPI-style summary for test authors

This is a quick index, not a full OpenAPI file.

| Method | Path | Auth | Role | Success |
|---|---|---|---|---|
| POST | `/users` | public | none | `201 user` |
| POST | `/sessions` | public | none | `200 {token}` |
| GET | `/me` | bearer | any | `200 user` |
| POST | `/events` | bearer | organizer | `201 event` |
| GET | `/events` | public | none | `200 {items,page,pageSize,total}` |
| GET | `/events/:id` | public | none | `200 event` |
| POST | `/events/:id/cancel` | bearer | organizer | `200 event` |
| POST | `/orders` | bearer | customer | `201 order` |
| POST | `/orders/:id/pay` | bearer | customer | `200 order` |
| POST | `/orders/:id/cancel` | bearer | customer | `200 order` |
| GET | `/orders/:id` | bearer | any | `200 order` |
| GET | `/me/orders` | bearer | customer | `200 order[]` |
| POST | `/events/:id/discounts` | bearer | organizer | `201 discount` |
| POST | `/events/:id/waitlist` | bearer | customer | `201 waitlistEntry` |
| GET | `/me/waitlist` | bearer | customer | `200 waitlistEntry[]` |
| GET | `/events/:id/report` | bearer | organizer | `200 report` |

---

## 16. Non-implementation deliverable status

This file is the stable contract and blueprint only.
No server behavior has been implemented in this task.
