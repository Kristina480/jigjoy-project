# Box Office API black-box verification

This directory contains a focused black-box verification plan for the Box Office HTTP API contract.

## Scope

The verification targets a running server only. It does not depend on implementation internals and is designed to be executed against the standalone project rooted at `hidden/box-office/` after implementation exists.

Coverage includes:
- accounts and sessions
- authentication and role enforcement
- event creation, listing, filtering, ordering, and cancellation
- order creation, payment, cancellation, access control, and list ordering
- discount validation, usage counting, release on cancel/expiry, and calculations
- waitlist creation, visibility, strict FIFO servicing, head-of-line blocking, and 6-ticket-limit skip behavior
- lazy expiration effects on availability, order status, discount reuse, and waitlist servicing
- organizer report aggregation and authorization
- representative validation-precedence checks

## Suggested execution modes

### 1. Executable test run (recommended)

Once an implementation is added in this folder, expose a script such as one of:
- `npm test`
- `npm run test:blackbox`
- `node ./tests/box-office.blackbox.js`

The test runner should:
1. start the application with `PORT` set to a free local port and `HOLD_SECONDS=2`
2. wait for the server to accept connections
3. run the scenarios from `TEST_MATRIX.md`
4. exit non-zero on any mismatch
5. stop the server cleanly

### 2. Manual verification

Use `TEST_MATRIX.md` as a concrete pass/fail checklist. Each case is written in black-box terms with setup, request, and expected result.

## Timing assumptions for expiration cases

To make expiration reproducible:
- run with `HOLD_SECONDS=2`
- after creating a hold that must expire, wait until at least 3 seconds have elapsed since `createdAt`
- trigger a read or mutation that must reflect lazy expiration

## Required oracle rules

All assertions should also verify:
- every error body is exactly an object with a string `error`
- every returned id is a string
- response times are ISO strings normalized with `toISOString()`
- passwords never appear in any response
- protected-route precedence is `401` before `403` before `400`

## Recommended test data discipline

- Use unique emails per run.
- Use event start times far enough in the future for normal flows, plus one event within 24 hours for refund-window checks.
- Use distinct tier names within each event to avoid ambiguity.
- Avoid relying on implementation-specific id or token formats.
