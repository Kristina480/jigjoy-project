# Box Office API focused black-box verification matrix

This matrix is written from the HTTP contract in `API_CONTRACT.md` and `examples/box-office/specification.md`.

## Conventions for all cases

- Base URL: `http://127.0.0.1:$PORT`
- Use JSON request bodies unless the case explicitly uses invalid JSON.
- For protected routes, include `Authorization: Bearer <token>` when specified.
- For every error case, also assert:
  - status code matches expected
  - body shape is exactly `{ "error": string }`
- For every success case, also assert:
  - JSON response parses
  - no response includes a password
  - any date fields are ISO `toISOString()` strings
  - all ids are strings

## Shared setup fixture

Create these users and sessions first unless a case states otherwise:
- organizer A
- organizer B
- customer A
- customer B
- customer C
- customer D

Log in each user and keep their bearer tokens.

Suggested canonical events created during setup:
- `eventMain`: on-sale event owned by organizer A, starts more than 48h in the future, tiers:
  - `GA` price 5000 quantity 5
  - `VIP` price 12000 quantity 2
- `eventRefundCutoff`: owned by organizer A, starts between now+1h and now+23h, tier:
  - `Soon` price 4000 quantity 5
- `eventSearchB`: owned by organizer B, starts later than `eventMain`, venue/title chosen so search and sorting can be checked

---

## 1. Accounts and auth

### A1 Create organizer user
- Request: `POST /users`
- Body: valid organizer payload
- Expect: `201`; body has `id,email,name,role`; role `organizer`; no password

### A2 Create customer user
- Request: `POST /users`
- Body: valid customer payload
- Expect: `201`

### A3 Reject invalid email
- Request: `POST /users`
- Body: email without `.` after `@`
- Expect: `400`

### A4 Reject short password
- Request: `POST /users`
- Body: password length 7
- Expect: `400`

### A5 Reject invalid role
- Request: `POST /users`
- Body: role `admin`
- Expect: `400`

### A6 Email uniqueness is case-insensitive
- Precondition: user exists with `Alice@example.com`
- Request: `POST /users` with `alice@EXAMPLE.com`
- Expect: `409`

### A7 Create session
- Request: `POST /sessions`
- Body: valid email/password
- Expect: `200` with string `token`

### A8 Reject wrong password
- Request: `POST /sessions`
- Body: right email wrong password
- Expect: `401`

### A9 Reject malformed JSON on public endpoint
- Request: `POST /sessions` with invalid JSON body
- Expect: `400`

### A10 Get current user
- Request: `GET /me` as organizer A and customer A
- Expect: `200` with caller user object each time

### A11 Protected route without token
- Request: `GET /me`
- Expect: `401`

### A12 Protected route with malformed bearer header
- Request: `GET /me` with `Authorization: Token abc`
- Expect: `401`

### A13 Protected route with valid token but wrong role
- Request: `POST /events` using customer token and otherwise invalid body
- Expect: `403` not `400`

### A14 Protected route invalid JSON still loses to bad token
- Request: `POST /events` with invalid JSON and no token
- Expect: `401`

---

## 2. Events

### E1 Organizer creates event
- Request: `POST /events` as organizer A
- Body: valid future event with 2 tiers
- Expect: `201`; `status=on_sale`; `organizerId` matches caller; each tier has `id` and `available == quantity`

### E2 Reject event in the past
- Request: `POST /events` as organizer A
- Body: `startsAt` in past
- Expect: `400`

### E3 Reject duplicate tier names
- Request: `POST /events`
- Body: two tiers with same name
- Expect: `400`

### E4 Reject more than 5 tiers
- Request: `POST /events`
- Body: 6 tiers
- Expect: `400`

### E5 List public events sorted by startsAt then title
- Precondition: at least two on-sale events with different start times; if same start then different titles
- Request: `GET /events`
- Expect: `200`; only on-sale events included; ordering matches contract

### E6 Query filtering by date range inclusive
- Request: `GET /events?from=...&to=...`
- Expect: events within bounds included; outside excluded

### E7 Query filtering by case-insensitive q against title or venue
- Request: `GET /events?q=hall` and `GET /events?q=jazz`
- Expect: matching event(s) returned regardless of case

### E8 Pagination
- Request: `GET /events?page=1&pageSize=1`
- Expect: `200`; one item; `total` equals all matching events

### E9 Reject invalid page/pageSize/date query
- Request: invalid `page=0`, `pageSize=51`, or unparsable `from`
- Expect: `400`

### E10 Get single event
- Request: `GET /events/:id`
- Expect: `200`

### E11 Get unknown event
- Request: `GET /events/does-not-exist`
- Expect: `404`

### E12 Only owning organizer may cancel
- Request: `POST /events/:id/cancel` as organizer B against organizer A event
- Expect: `403`

### E13 Cancel event side effects
- Precondition:
  - one paid order for event
  - one held order for event
  - at least one waitlist entry for event tier
- Request: `POST /events/:id/cancel` as owner organizer
- Expect:
  - `200`; event status `cancelled`
  - paid order becomes `refunded`
  - held order becomes `cancelled`
  - waitlist is emptied
  - cancelled event disappears from `GET /events` but remains available via `GET /events/:id`

### E14 Cancelling an already cancelled event
- Request: repeat `POST /events/:id/cancel`
- Expect: `409`

---

## 3. Orders

### O1 Customer creates held order
- Request: `POST /orders` as customer A for `eventMain`
- Body: one valid line item quantity 2
- Expect: `201`; status `held`; unit prices copied from tier; subtotal/total correct; `discountCode=null`; `paidAt=null`; `expiresAt > createdAt`

### O2 Reject empty items
- Request: `POST /orders` with `items: []`
- Expect: `400`

### O3 Reject duplicate tier in same order
- Request: `POST /orders` with same tier twice
- Expect: `400`

### O4 Reject invalid quantity
- Request: `POST /orders` with quantity 0
- Expect: `400`

### O5 Unknown event
- Request: `POST /orders` with unknown `eventId`
- Expect: `404`

### O6 Tier not in event
- Request: `POST /orders` naming tier from another event
- Expect: `400`

### O7 Event not on sale causes state conflict
- Precondition: event cancelled
- Request: `POST /orders`
- Expect: `409`

### O8 Not enough inventory holds nothing
- Precondition: tier quantity known, available fully consumed or request quantity too large
- Request: `POST /orders`
- Expect: `409`; afterward `GET /events/:id` shows availability unchanged except for existing successful orders

### O9 6-ticket per event limit across held and paid orders
- Precondition: customer A already has 6 tickets total on event across held and/or paid orders
- Request: attempt to add 1 more ticket on same event
- Expect: `422`

### O10 Pay held order
- Request: `POST /orders/:id/pay` as owning customer
- Expect: `200`; status `paid`; `paidAt` becomes ISO string

### O11 Pay someone else’s order is hidden
- Request: `POST /orders/:id/pay` as different customer
- Expect: `404`

### O12 Pay expired order
- Precondition: create held order with `HOLD_SECONDS=2`; wait > 2s; trigger pay
- Request: `POST /orders/:id/pay`
- Expect: `409`; subsequent `GET /orders/:id` shows status `expired`

### O13 Cancel held order
- Request: `POST /orders/:id/cancel` on held order by owner
- Expect: `200`; status `cancelled`

### O14 Cancel paid order more than 24h before start refunds
- Precondition: paid order for event starting >24h in future
- Request: `POST /orders/:id/cancel`
- Expect: `200`; status `refunded`

### O15 Cancel paid order within 24h of start is conflict
- Precondition: paid order for `eventRefundCutoff`
- Request: `POST /orders/:id/cancel`
- Expect: `409`

### O16 Cancel someone else’s order is hidden
- Request: `POST /orders/:id/cancel` as different customer
- Expect: `404`

### O17 Get order as owner customer
- Request: `GET /orders/:id` as owning customer
- Expect: `200`

### O18 Get order as event organizer
- Request: `GET /orders/:id` as organizer who owns event
- Expect: `200`

### O19 Get order as unrelated user is hidden
- Request: `GET /orders/:id` as other customer or other organizer
- Expect: `404`

### O20 My orders newest first
- Precondition: customer has multiple orders with distinct creation times
- Request: `GET /me/orders`
- Expect: `200`; array sorted descending by creation time

### O21 Lazy expiration restores availability
- Precondition: create held order consuming remaining ticket(s)
- Wait: > `HOLD_SECONDS`
- Request: `GET /events/:id` or a competing `POST /orders`
- Expect: expired hold no longer counts against `available`

---

## 4. Discount codes

### D1 Organizer creates percent discount
- Request: `POST /events/:id/discounts` as owner organizer
- Body: `{ code, percentOff, maxUses, expiresAt }`
- Expect: `201`; code uppercased; amountOffCents null; uses 0

### D2 Organizer creates amount discount
- Request: `POST /events/:id/discounts`
- Body: `{ code, amountOffCents }`
- Expect: `201`; percentOff null

### D3 Discount validation precedence: wrong role before bad body
- Request: `POST /events/:id/discounts` as customer with invalid body
- Expect: `403`

### D4 Only owning organizer may create discount
- Request: `POST /events/:id/discounts` as organizer B on organizer A event
- Expect: `403`

### D5 Reject invalid discount shape
- Cases:
  - both `percentOff` and `amountOffCents`
  - neither provided
  - `percentOff=0`
  - `amountOffCents=0`
  - code with punctuation or length outside 3..20
  - `maxUses=0`
- Expect: `400`

### D6 Duplicate code on same event, case-insensitive
- Precondition: code `SAVE10` exists on event
- Request: create `save10`
- Expect: `409`

### D7 Apply percent discount at checkout
- Precondition: 2 tickets at 5000 each, discount 10%
- Request: `POST /orders` with `discountCode` in mixed case
- Expect: `201`; stored `discountCode` uppercase; `subtotalCents=10000`; `discountCents=1000`; `totalCents=9000`

### D8 Apply amount discount capped at subtotal
- Precondition: subtotal 5000, amount discount 7000
- Request: `POST /orders`
- Expect: `discountCents=5000`; `totalCents=0`

### D9 Unknown discount is unusable
- Request: `POST /orders` with non-existent code for event
- Expect: `422`

### D10 Expired discount is unusable
- Precondition: discount exists with expiry in near future; wait until expired
- Request: `POST /orders`
- Expect: `422`

### D11 Used-up discount is unusable
- Precondition: discount `maxUses=1`; one held or paid order already uses it
- Request: second order with same code
- Expect: `422`

### D12 Discount use released on cancel
- Precondition: code `maxUses=1`; create held order using it
- Request sequence:
  1. cancel that order
  2. create another order with same code
- Expect: second order succeeds

### D13 Discount use released on expiry
- Precondition: code `maxUses=1`; create held order using it with short hold
- Wait: > `HOLD_SECONDS`
- Request: create new order with same code
- Expect: succeeds because first order is now expired

---

## 5. Waitlist

### W1 Join waitlist when sold out for requested quantity
- Precondition: requested tier has fewer available tickets than requested quantity
- Request: `POST /events/:id/waitlist` as customer B
- Body: `{ tierId, quantity }`
- Expect: `201`; response includes id, eventId, tierId, quantity, position 1

### W2 Reject waitlist quantity outside 1..6
- Requests: quantity 0 and 7
- Expect: `400`

### W3 Reject waitlist when enough tickets are available
- Precondition: tier available >= requested quantity
- Request: `POST /events/:id/waitlist`
- Expect: `409`

### W4 Reject duplicate waitlist entry for same customer and tier
- Precondition: customer already waiting for tier
- Request: second identical waitlist join
- Expect: `409`

### W5 Waitlist positions are per-tier and dynamic
- Precondition: two customers join same tier, one customer joins another tier
- Request: `GET /me/waitlist` for both customers
- Expect: same-tier positions 1 then 2; other tier starts at 1 independently

### W6 Strict FIFO service on cancellation/refund/expiry
- Precondition:
  - tier quantity 5 is sold out
  - waitlist head wants 2
  - second wants 1
  - exactly 2 tickets become available
- Trigger: held order cancel, refund, or expiry releases 2
- Expect:
  - head entry removed
  - head customer receives new held order for quantity 2 with no discount code
  - second entry remains waiting at new position 1

### W7 Head-of-line blocking
- Precondition:
  - head wants 3
  - second wants 1
  - only 2 tickets become available
- Trigger: ticket release
- Expect:
  - nobody is served
  - both entries remain on waitlist in original order

### W8 Waitlist skips over head entry that would exceed 6-ticket limit
- Precondition:
  - head customer already holds/owns 6 tickets for event via other tiers/orders
  - head waitlist entry wants 1
  - second entry wants 1
  - 1 ticket becomes available
- Trigger: ticket release
- Expect:
  - head entry removed without order
  - second entry gets new held order

### W9 Waitlist service after lazy expiration
- Precondition: sold-out tier with waiting customer; existing held order is the only blocker
- Wait: held order expires
- Trigger: `GET /events/:id` or other response that must reflect expiration
- Expect: waiting customer is served according to FIFO rules

### W10 Event cancellation clears waitlist
- Precondition: event has waitlist entries
- Trigger: organizer cancels event
- Expect: `GET /me/waitlist` for affected customers no longer shows those entries

---

## 6. Reports

### R1 Organizer can fetch report
- Request: `GET /events/:id/report` as owning organizer
- Expect: `200`; body has eventId, tiers, grossCents, discountCents, refundedCents, netCents

### R2 Non-owner organizer forbidden
- Request: `GET /events/:id/report` as other organizer
- Expect: `403`

### R3 Customer wrong role rejected before resource/input concerns
- Request: `GET /events/:id/report` as customer
- Expect: `403`

### R4 Report tier counts reflect paid, held, available
- Precondition:
  - one paid order for 2 GA
  - one held order for 1 GA
  - no other active GA orders
- Request: report
- Expect: corresponding tier shows `sold=2`, `held=1`, `available=quantity-3`

### R5 Report money aggregates
- Precondition:
  - paid order A subtotal 10000 discount 1000 total 9000
  - paid order B subtotal 5000 discount 0 total 5000
  - refunded order C total 4000
- Request: report
- Expect:
  - `grossCents=15000`
  - `discountCents=1000`
  - `netCents=14000`
  - `refundedCents=4000`

### R6 Lazy expiration reflected in report
- Precondition: held order exists and then expires
- Wait: > `HOLD_SECONDS`
- Request: `GET /events/:id/report`
- Expect: expired order no longer counted in held; availability reflects release

---

## 7. Focused precedence and unknown-route probes

### P1 Unknown route
- Request: `GET /nope`
- Expect: `404` with error envelope

### P2 Token beats malformed body on protected customer route
- Request: `POST /orders` with invalid JSON and no token
- Expect: `401`

### P3 Role beats malformed body on protected customer route
- Request: `POST /orders` with organizer token and invalid JSON
- Expect: `403`

### P4 Input beats existence on protected owner route
- Request: `POST /events/not-real/discounts` as correct-role organizer with invalid body
- Expect: `400`, not `404`

### P5 Existence beats access-independent limit checks
- Request: `POST /orders` with unknown eventId and also quantity that would exceed limit if real
- Expect: `404`

### P6 State beats limit on orders
- Precondition: event cancelled and customer already has 6 tickets for it from before cancellation
- Request: `POST /orders`
- Expect: `409`, not `422`

---

## 8. Minimal executable subset recommendation

If implementing an automated suite incrementally, prioritize these high-signal cases first:
1. A6, A13, A14
2. E5, E12, E13
3. O8, O9, O12, O14, O21
4. D7, D11, D12, D13
5. W6, W7, W8, W9, W10
6. R4, R5, R6
7. P1-P6

These cover the most failure-prone behavior: precedence, lazy expiration, availability math, discount use accounting, strict FIFO waitlist, 6-ticket cap, and cancellation/refund side effects.
