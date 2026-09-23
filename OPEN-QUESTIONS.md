# Open questions

Things this app is built around that were never confirmed against a live Printful account or a
deployed Swell store. Each one names where it bites and how to settle it. Resolve the first four
before turning on live fulfillment.

## 1. Does Printful reject a duplicate `external_id`?

**Where it bites:** duplicate charges. `functions/order-submit.ts`, `functions/fulfillment-advance.ts`.

Swell offers no atomic primitive, so the app cannot fully close the duplicate-submit race on its own:

- `unique: true` on a model field is a read-then-write check, not a database index. The flag populates
  `config.cache.uniqueFields`, which `Model.prototype.validateUniqueFields` consumes by running a find
  and rejecting if a row comes back. Two racing inserts can both find nothing and both insert.
- A `where` key in a PUT body filters the read the update performs first, and returns `null` on a miss,
  so `null` is a reliable "did not apply" signal. But on a match the write goes out by record id
  unconditionally. It narrows the window to one round trip; it does not close it.

Both checks collapse ordinary duplicate deliveries, which arrive seconds to minutes apart. Under true
concurrency a residual race remains, and the only durable guarantee would be Printful refusing a
`POST /v2/orders` that reuses an `external_id` it already holds. Nothing in the Printful spec says it
does.

**How to settle it:** with a sandbox token, POST two orders carrying the same `external_id` and see
whether the second is rejected or creates a second order. If it creates a second order, the app needs a
stronger claim than the platform can express, and confirmation should be gated behind an operator step
rather than automated.

## 2. Can Printful reach a `public: true` route?

**Where it bites:** tracking writeback never arrives. `functions/printful-webhook.ts`.

The routes reference states that external callers reaching a route through the storefront gateway need
an app public key in the `Authorization` header even for public routes, or the gateway returns 404.
Printful sends only its own two headers and cannot be configured to add one. No app in this workspace
receives a third-party webhook, so the pattern is unproven here.

**How to settle it:** deploy a throwaway public route and `curl` it from outside with no
`Authorization` header. A 404 means Flow D needs a relay that adds the header, which is a real scope
addition.

## 3. What is the p95 latency of `POST /v2/shipping-rates`?

**Where it bites:** blank shipping options at checkout. `functions/shipping-rates.ts`.

The rating hook runs synchronously inside the checkout request under a 10s function timeout. Printful
publishes no latency figure, no SLA and no timeout for this endpoint.

**How to settle it:** measure p50, p95 and p99 with a real token across a 1-item cart, a 10-item cart,
and one whose total quantity exceeds 100 (that last case drops the rate limit from 120/min to 5/min).
If p95 exceeds 5s, the synchronous design has to be replaced with cached or flat rates.

## 4. What exact bytes does Printful sign?

**Where it bites:** every webhook rejected, or worse, forged ones accepted. `functions/lib/signature.ts`.

The docs state the `secret_key` is returned hex-encoded and must be decoded to raw bytes before
hashing, and the app does that. That the signature covers the raw request body is a strong inference
from one troubleshooting sentence, not a documented guarantee, and no live Printful-signed event was
ever tested against this code.

There is also no timestamp or nonce header, so replay protection is the app's own dedupe key.

**How to settle it:** register a webhook, trigger a real event, and confirm verification passes before
go-live.

## 5. Smaller unknowns

| Question | Where it bites |
| --- | --- |
| Is `Swell-Public-Key` populated on model-event invocations, not just routes? | The environment guard in `functions/lib/env.ts` defaults to "not live" if it is absent, so the failure is safe but would block live fulfillment entirely. |
| Is the carrier bound at `carriers.<extId>` or `carriers.app_<appId>_<extId>`? | Debugging why the rating hook never fires. Read it off `swell inspect extensions app.printful.printful` rather than constructing it. |
| Is the event root for a kebab-case app collection `printful-event.created`? | `functions/printful-event-handle.ts` never fires if it is not. Confirm with `swell inspect models apps/printful/printful-events`. |
| Are placement coordinates inches or pixels? | Print positioning. The schema documents inches; the docs' own example uses numbers that only make sense as pixels. |
| Does Swell derive `order.delivered` from shipments, or must `shipment_delivered` write it? | Order status accuracy after delivery. |
