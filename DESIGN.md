# Design: `printful` (integration)

App id: **`printful`** · type `integration` · extension `{ id: "printful", type: "shipping", carrier: "printful" }`

---

## 1. File tree — `printful`

Scaffold: `swell create app printful --type integration --integration-type shipping --integration-id printful -y`

```
printful/
├── swell.json                      # id printful, type integration, permissions [], extensions:[{id:"printful",type:"shipping",carrier:"printful",carrier_logo_src:"assets/carrier-logo.png"}]
├── README.md                       # becomes App Store full_description
├── package.json                    # devDep @swell/app-types; no runtime Node deps needed
├── tsconfig.json                   # lib:["esnext","webworker"], types:["@swell/app-types"]
├── .swellrc                        # CLI-generated remote app id — do not edit
├── .gitignore
│
├── assets/
│   ├── icon.png                    # REQUIRED for non-theme release (versions.js:484-520)
│   ├── carrier-logo.png            # carrier_logo_src; uploaded into extension_assets[]
│   ├── description.md
│   └── screenshots/01-settings.png # REQUIRED: ≥1 screenshot for non-theme release
│
├── settings/
│   └── printful.json               # filename matches extension id → renders as the extension's settings panel.
│                                   # Fields: api_token (short_text, ui:"secure"), store_id (short_text, optional —
│                                   # only for account-level tokens), webhook_secret (secure, written by the app),
│                                   # webhook_public_key, live_fulfillment (toggle, default false — the money switch),
│                                   # fallback_rate (number, ui:"currency", localized), fallback_service_name (text),
│                                   # quote_cache_ttl (integer), sync_categories (tags), rate_timeout_ms (integer)
│
├── models/
│   ├── orders.json                 # extends standard orders → $app.printful.{printful_order_id, printful_status,
│                                   # dashboard_url, confirmed_at, submit_state, last_error}
│   ├── products.json               # extends standard products → $app.printful.{catalog_product_id, technique,
│                                   # placements[], print_area{w,h,dpi}, artwork_url, artwork_hash}
│   ├── catalog-items.json          # NEW app collection: one row per Printful catalog_variant_id.
│                                   # variant_id (Swell), catalog_variant_id, catalog_product_id, size, color,
│                                   # base_cost_by_technique{}, placement_prices{}, currency, stale (bool), date_synced
│   ├── fulfillments.json           # NEW app collection: the durable order-submit job. UNIQUE order_id (the lock),
│                                   # printful_order_id, state enum[pending,created,calculating,confirmed,failed],
│                                   # attempts, date_next_attempt (drives model schedule), last_error, external_id
│   ├── printful-events.json        # NEW app collection: verified inbound webhook envelope, dedupe key unique,
│                                   # processed (bool), process_error — makes webhook receipt fast and replayable
│   └── sync-runs.json              # NEW app collection: catalog sync cursor + request budget + last completed offset
│
├── content/
│   ├── orders.json                 # admin: "Printful" tab on the order editor — printful_order_id (readonly),
│                                   # status, dashboard_url link, last_error; list tab "Printful failed"
│   ├── catalog-items.json          # admin: list/edit views for the mapping collection, nav under Products
│   └── fulfillments.json           # admin: operator view of stuck/failed jobs with a manual retry action
│
├── functions/
│   ├── lib/                        # subdirectory = shared code, NOT deployed as functions.
│   │   │                           # ⚠ edits here need `swell app push --force` (hashing is top-level-file only)
│   │   ├── printful.ts             # REST client: fetch + Bearer + conditional X-PF-Store-Id, dual error-envelope
│   │   │                           # parser (problem+json vs {code,result,error}) keyed on content-type,
│   │   │                           # 429/retry-after handling, AbortController budget
│   │   ├── env.ts                  # environment guard — see §3.4
│   │   ├── settings.ts             # typed `req.swell.settings(`${req.appId}/printful`)` wrapper
│   │   ├── mapping.ts              # Swell items ⇄ catalog_variant_id + placements/layers
│   │   ├── rates.ts                # rate cache key + Printful rate → shipment_rating.service mapping
│   │   └── signature.ts            # hex-decode + Web Crypto HMAC-SHA256 verify
│   │
│   ├── catalog-sync.ts             # cron "0 3 * * *" — budgeted, resumable paginated catalog pull
│   ├── catalog-sync-run.ts         # route (public:false) — manual/dev trigger + resume, returns run status
│   ├── shipping-rates.ts           # after:order.shipping, config.extension:"printful", fields:["shipment_rating"]
│   ├── order-submit.ts             # model event order.paid — creates the fulfillment claim, does NO Printful I/O
│   ├── fulfillment-advance.ts      # model events fulfillment.created/updated + schedule{formula:"date_next_attempt"}
│   │                               # — the durable create → wait → confirm state machine
│   ├── fulfillment-sweep.ts        # cron "*/10 * * * *" — safety net for jobs whose schedule was lost
│   ├── printful-webhook.ts         # route public:true, methods:["post"] — verify signature, persist, return 200
│   └── printful-event-handle.ts    # model event printful-event.created — the slow enrichment path
│
├── notifications/
│   ├── printful-order-failed.json  # admin:true, event bound to a custom fulfillment event
│   └── printful-order-failed.tpl
│
└── test/
    ├── mock-request.ts             # scaffolded
    ├── swell-client.ts             # scaffolded
    ├── unit/
    │   ├── signature.test.ts       # known-vector HMAC + hex-decode rejection of non-hex secrets
    │   ├── rates.test.ts           # Printful rate JSON → shipment_rating.services, incl. absent delivery days
    │   ├── env.test.ts             # live/test/local discrimination table
    │   └── mapping.test.ts
    └── integration/
        ├── shipping-rates.test.ts  # order write → shipment_rating.services persisted
        ├── order-submit.test.ts    # order.paid fired twice → exactly one fulfillment record
        └── webhook.test.ts         # signed payload → shipment created on the Swell order
```

**Note:** no `components/` and no `frontend/`. Components render only in checkout's payment step — a shipping extension that ships `components/*.tsx` deploys cleanly and renders nothing. A `frontend/` iframe would add a developer-owned Cloudflare account dependency for a dashboard this app doesn't need; `content/` views cover the admin surface.

---

## 2. The four integration flows

### Flow A — Catalog sync

| # | Swell side | Printful side |
|---|---|---|
| 1 | `functions/catalog-sync.ts`, `cron: { schedule: "0 3 * * *" }`. Also reachable as `functions/catalog-sync-run.ts` route for manual/dev runs. | — |
| 2 | Read `apps/printful/sync-runs` for the cursor; read settings for token + `store_id`. | — |
| 3 | — | `GET https://api.printful.com/v2/catalog-products?limit=100&offset=<cursor>` · **auth required** (v2 catalog is not public — verified 401 live; only v1 is open) |
| 4 | — | per product: `GET /v2/catalog-products/{id}/catalog-variants?limit=100&offset=…` — **paginate.** The OpenAPI `parameters` array omits limit/offset but the response `_links` prove they exist with default limit 20 |
| 5 | — | per product: `GET /v2/catalog-products/{id}/prices?limit=100&offset=…` — **paginate**, default limit 10 |
| 6 | — | optional: `GET /v2/catalog-products/{id}/mockup-styles` → `print_area_width/height` (inches) + `dpi` |
| 7 | Upsert `POST/PUT /apps/printful/catalog-items` per `catalog_variant_id`; upsert standard `/products` + `/products:variants` and write linkage with `req.appValues({...})`. Use `req.swell.transaction([...])` (≤10 ops) for per-product atomicity. | — |
| 8 | Hard-stop at a request budget (e.g. 40 Printful calls or 7s), persist cursor, exit. Next cron tick resumes. | — |
| 9 | `printful-event-handle.ts` marks rows `stale: true`. | invalidation via `catalog_price_changed` (payload is only `{catalog_product_ids:[…]}` — a ping, refetch prices) and `catalog_stock_updated` |

**Cost formula** (from the endpoint's own description): `variant.techniques[chosen].price` (base, **already includes one placement**) + each *additional* `product.placements[].price` + `placement_options[].price[value]` + `layers[].additional_price` + `layers[].layer_options[].price[value]`. V2 changed from V1: the first placement's price is now populated rather than null, so you must subtract the included placement yourself or double-count.

**Confirm during build:** (a) that limit/offset actually work on `catalog-variants` and `prices`; (b) `retail_price` / `retail_discounted_price` are in the spec's `required` arrays but never defined in `properties` — do not build margin logic on them; (c) `discount_tiers` is returned in the docs' example but absent from the schema entirely; (d) `Product.placements[].print_area_width/height` are also required-but-undefined — read geometry from `/mockup-styles`, not from the product.

**Defer to v2 of the app:** mockup generation. `POST /v2/mockup-tasks` → poll `GET /v2/mockup-tasks?id=` → `mockup_url` is deleted after ~24h, and catalog variant images are mostly transparent PNGs needing compositing over `primary_hex_color`. **Confirm:** how a Swell function uploads a binary into Swell storage — the research did not verify a file-upload API callable from a function. Ship v1 with flat product images.

### Flow B — Shipping quote at checkout

| # | Swell side | Printful side |
|---|---|---|
| 1 | Merchant enables the carrier: Settings → Shipping → toggle the Printful row → **Save changes**. Writes `enabled: true` + `extension_app_id` + `extension_config_id`. **`swell app push` writes none of these.** | — |
| 2 | Cart/order write triggers `order.shipping`. `functions/shipping-rates.ts` — `config.extension: "printful"`, `model: { events: ["after:order.shipping"], fields: ["shipment_rating"] }` | — |
| 3 | Read defensively: `const items = req.data.items ?? req.data.$record?.items`, `const ship = req.data.shipping ?? req.data.$record?.shipping`. `req.data` is the **partial write payload**, not the full order — `items` is only written when items/currency/account changed (`items.js:84-107`). Bail cleanly if `ship?.country` is absent. | — |
| 4 | Map items → `catalog_variant_id` via one `apps/printful/catalog-items` query. Compute a cache key: `(country, state, zip, currency, sorted[variant×qty])`. Cache hit → return without a Printful call. | — |
| 5 | — | `POST https://api.printful.com/v2/shipping-rates` body `{ recipient: { country_code, state_code?, zip?, city? }, order_items: [{source:"catalog", catalog_variant_id, quantity}], currency }`. **Scope: `orders` (write)** — unintuitive for a read-only quote. |
| 6 | Return `{ shipment_rating: { services: [{ id: \`printful_${r.shipping}\`, name: r.shipping_method_name.trim(), price: parseFloat(r.rate), carrier: "printful" }] } }`. The rate id is the response's **`shipping`** field (e.g. `"STANDARD"`), not `id`; `rate` is a **string**; `min/max_delivery_days|date` may be absent. Keep the raw code recoverable from the service id — Flow C needs it. | — |
| 7 | Platform merges services **by `id`** (`util.js:504-541`), appends unmatched ids, then re-sorts by price. You cannot delete native services from the hook. Then `setShippingDetailsFromRating` copies the selected service's `price`/`name` onto `order.shipping`. | — |

**Failure handling:** never throw. `after:` hooks can never block a write (`canRejectWrite` returns false unless `hook === 'before'`), and there are no retries (`orders.shipping` declares no `hook_retry_attempts`). On timeout/429/error, return the settings-configured flat fallback service plus `{ shipment_rating: { errors: [{ code, message }] } }`. Errors also surface as `$function_errors` on the API response.

**Gotcha:** the post-hook change gate (`getRatedFields`) compares only `{id, name, price, description}`. Services differing solely in `carrier`/`pickup`/`tax_code` will not trip `isDiff`, and `setShippingDetailsFromRating` + `sortShippingServices` won't run.

### Flow C — Order submission

| # | Swell side | Printful side |
|---|---|---|
| 1 | `functions/order-submit.ts` — `model: { events: ["order.paid"] }`. `order.paid` is edge-triggered by the platform (`paid: true` AND `$record.paid !== true`), but event *delivery* still retries. | — |
| 2 | Guards, in order: environment (§3.4) → `settings.live_fulfillment` → order has ≥1 mapped item. | — |
| 3 | **Claim:** `POST /apps/printful/fulfillments` with `{ order_id, external_id: order.id, state: "pending", attempts: 0, date_next_attempt: now }`. `order_id` has `"unique": true` — a duplicate delivery hits the unique constraint and exits. **This is the only real lock.** Return. Zero Printful I/O on the hot path. | — |
| 4 | `fulfillment.created` fires `functions/fulfillment-advance.ts` (`model: { events: ["fulfillment.created","fulfillment.updated"], schedule: { formula: "date_next_attempt" } }`). | — |
| 5 | state `pending`: | `GET /v2/orders/@<swell_order_id>` — **200 ⇒ adopt** (never re-create); **404 ⇒** `POST /v2/orders` with `external_id`, `shipping` (the code recovered from the selected service id), `recipient`, `order_items[{ source:"catalog", catalog_variant_id, quantity, external_id: <swell order item id>, placements:[{ placement, technique, layers:[{ type:"file", url: <artwork url + content hash> }] }] }]` |
| 6 | Persist `printful_order_id`, state → `calculating`, `date_next_attempt = now + 30s`. | response returns `costs.calculation_status: "calculating"` with every cost field null |
| 7 | **Wake on `order_updated`** (Flow D), not on a poll — the docs state: *"If you are subscribed to the `order_updated` webhook event, you will receive an event when the calculation is finished."* The schedule + sweeper are the fallback. | `GET /v2/orders/{printful_order_id}` → `costs.calculation_status` |
| 8 | `done` → | `POST /v2/orders/@<swell_order_id>/confirmation` — **send no request body.** This is the charge point. |
| 9 | state → `confirmed`; `req.swell.put('/orders/{id}', req.appValues({ printful_order_id, printful_status: "pending", dashboard_url, confirmed_at }))`. | — |
| 10 | `failed` or the `order_failed` webhook → state `failed`, `last_error`, fire `notifications/printful-order-failed`. On any transport error: `attempts++`, exponential `date_next_attempt`, cap at 8 → `failed`. **Never throw** — the write re-arms the schedule. | — |

### Flow D — Tracking writeback

| # | Swell side | Printful side |
|---|---|---|
| 1 | One-time setup (from `catalog-sync-run.ts` or a dedicated setup route): | `POST /v2/webhooks` with `{ default_url: "https://<store>.swell.store/functions/printful/printful-webhook", events: [{type:"shipment_sent"},{type:"shipment_delivered"},{type:"order_updated"},{type:"order_failed"},{type:"order_canceled"},{type:"catalog_price_changed"},{type:"catalog_stock_updated", params:[{name:"products", value:[…]}]}] }`. **Destructive singleton** — one config per token; this call disables the previous one. Persist `secret_key` immediately (visible once). Leave `expires_at: null`. Response envelope is `{code, result, extra}`, not `{data}`. |
| 2 | `functions/printful-webhook.ts` — `route: { public: true, methods: ["post"] }`. Verify HMAC over `req.rawBody` (§3.5). Mismatch/missing → 401, ignore. | Printful `POST`s `{type, occurred_at, retries, store_id, data}` with headers `x-pf-webhook-signature` (hex) and `x-pf-webhook-public-key` (base64). |
| 3 | `POST /apps/printful/printful-events` (dedupe key `type + order/shipment id + occurred_at`, unique). **Return 200 immediately** — Printful retries at 1, 4, 16, 64, 256, 1024 minutes and will amplify any slow path. | — |
| 4 | `printful-event.created` → `functions/printful-event-handle.ts`. | — |
| 5 | `shipment_sent`: the payload has `tracking_number` + `tracking_url` but **no carrier and no item list**, and Printful splits orders across shipments. So: | `GET /v2/orders/{printful_order_id}/shipments` → find by shipment id → `carrier`, `service`, `tracking_number`, `tracking_url`, `shipment_items[].order_item_external_id` |
| 6 | `POST /shipments` `{ order_id, items: [{ order_item_id, quantity }], carrier, service, tracking_code, $app: { printful: { shipment_id, tracking_url } } }`. Item matching works because Flow C set `order_items[].external_id` to the Swell order item id. This is what marks the Swell order shipped / partially shipped and fires the customer notification. | — |
| 7 | `order_updated` → re-run `fulfillment-advance` for that job (the cost-calculation wake-up). `order_failed` → state `failed` + admin notification. `order_canceled` / `order_refunded` → write `$app.printful.printful_status` and notify; **do not** auto-cancel or auto-refund the Swell order. | — |

**Confirm:** whether Swell auto-derives `order.delivered` from shipments, or whether `shipment_delivered` should write it explicitly.

---

## 3. The hard parts, ranked

**1. Inbound webhook reachability — architecture risk, spike this first.**
`references/functions-routes.md` states that external callers reaching a route through the storefront gateway need an app public key in the `Authorization` header **even for `public: true` routes**, or the gateway returns 404. Printful sends only its own two headers and cannot be configured to add one. No app in `/Users/eric/swell-apps` receives a third-party webhook (grep for `rawBody` returns nothing), so this pattern is unproven here. If a query-string key doesn't satisfy the gateway, Flow D needs a relay (a thin Worker in a `frontend/` dir on this app, or the merchant's domain) that adds the header — a real scope addition. **Resolve before writing any other code.**

**2. Rate limit vs. a synchronous checkout hook with a 10s ceiling.**
120 req / 60s, `x-ratelimit-policy: 120;w=60;`, `x-ratelimit-reset` growing 0.5s per token, breach → 429 with `retry-after` and a 60s lockout (all reproduced live, twice). **The cliff: a cart whose summary item quantity exceeds 100 drops to 5 req/60s.** The bucket keying (per token / per store / per IP) is undocumented; the unauthenticated bucket is demonstrably IP-keyed. Catalog sync and rate quotes share it.
Mitigations: budget-capped, resumable catalog sync that never runs at peak and leaves headroom; a rate cache keyed on `(country, state, zip, currency, sorted variant×qty)` with a short TTL (this contradicts Printful's advice to quote only at order time — accept the small mismatch risk to survive the cliff); an `AbortController` at ~6s falling back to the configured flat rate; read `x-ratelimit-remaining` and pre-emptively serve the fallback when it's low.
Function timeout is 10000ms default; `config.timeout` accepts up to 20000ms but that requires the `functions.long_timeout` feature **and** can be revoked at runtime by the per-client `functions.timeout_boost_disabled` flag. **Design for 10s; treat 20s as an optimization you can lose.**
**Unverified and blocking:** `/v2/shipping-rates` latency. The docs publish no figure, no SLA, no timeout, and no measurement was possible without a token. Measure p50/p95/p99 with a real token across 1-item, 10-item, and >100-unit carts before committing to the synchronous design.

**3. Idempotency on order submit.**
Printful has **no idempotency key** — verified exhaustively, not spot-checked: 0 hits for `idempot`/`duplicat` across the 525KB spec, and the complete set of custom headers in all of v2 is exactly `{X-PF-Language, X-PF-Store-Id}`. A retried `POST /v2/orders` creates a duplicate order and, once confirmed, a duplicate **charge**.
Three layers, and only one is a real lock: (i) `unique: true` on `fulfillments.order_id` — the actual mutex; (ii) `external_id = <swell order id>` + `GET /v2/orders/@<id>` before every create — reduces the window, doesn't close it (two concurrent invocations can both see 404); (iii) a state machine that only reaches `confirmation` from `calculating`. **Confirm:** whether Printful enforces `external_id` uniqueness — nothing in the spec says it does.
Swell-side: `order.paid` is edge-triggered on the transition, but delivery retries — check `req.data.$event.delivery.attempts`.

**4. Environment guard — test must never confirm a real Printful order.**
Source-verified mechanism: `generateAppPublicKey(env)` returns `` `app_pk_${envKeySegment(env)}${alphanum(32)}` `` and `envKeySegment` returns **empty string when env is falsy** (`api/admin/features/clients/lib.js:5-22`). `alphanum` is `[A-Za-z0-9]`. So the live/default environment's key has **no env segment**; test's is `app_pk_test_…`; a custom env named `staging` gives `app_pk_staging_…`. Default-deny:

```ts
export const isLiveEnv = (req: SwellRequest) =>
  /^app_pk_[A-Za-z0-9]{32}$/.test(req.publicKey ?? "");   // anything else, incl. missing, is NOT live
```

Four layers stacked: `req.isLocalDev` short-circuits everything; `isLiveEnv` must be true; `settings.live_fulfillment` toggle defaults false; separate Printful tokens per environment in settings. And structurally — **`POST /v2/orders` is free; only `/confirmation` charges.** Safe test mode = create the draft, never confirm, surface the Printful `dashboard_url` for manual inspection.
**Confirm on first invocation:** that `Swell-Public-Key` is populated on model-event invocations, not just routes. `FunctionClient.getRequestOptions` sends it (`server/services/functions/client.js:565-576`), but log it once and remove the log.

**5. Webhook signature verification with the hex-decoded secret.**
Documented verbatim: *"in the `secret_key` field we return the hexadecimal representation of the secret key… you need to decode it before passing it to the tool or method that calculates the signature."* Skipping the decode fails 100% of the time (independently reproduced: hex-decoded key → `180aa016…`, same string as ASCII → `d4ccddad…`).
Traps: (a) hash `req.rawBody`, never a re-stringified `req.body`; (b) validate the secret is strictly even-length `[0-9a-fA-F]` before decoding — a naive `parseInt` loop yields `NaN` for a bad char and silently writes `0`, and Printful's own doc example contains a stray `w` at index 68; (c) signature header is **hex**, public-key header is **base64**; (d) prefer `crypto.subtle.verify` over a manual compare (constant time, per the skill's routes reference); (e) `secret_key` is returned once only; (f) `POST /v2/webhooks` is a destructive singleton per token — a second registration silently kills the first; (g) if `expires_at` lapses, `GET /v2/webhooks` 404s until you pass `?show_expired=true`, and re-subscribing rotates the key pair.
**Unverified:** the exact byte range Printful signs. Raw body is the strong inference from one troubleshooting sentence, but no live Printful-signed event was ever tested. Validate against a real event before go-live; there is also no timestamp/replay header, so dedupe on `(type, id, occurred_at)` yourself.

**6. Merchant activation is not code, and the documented bind path is contested.**
`swell app push` never writes the carrier row. Until Settings → Shipping → toggle → **Save changes**, the rating hook silently never fires; shipping is the only extension type where `enabled: false` blocks dispatch. Also verified: an extension-scoped function (`config.extension` set) does **not** fire when `extension_config_id` is missing — the in-source comment claiming otherwise is wrong; all three fields are hard requirements.
**The activated state is directly readable**, which is what makes this debuggable rather than mysterious: `GET /settings/shipments` → the carrier row for this app, with `extension_app_id` set and `enabled === true`. Platform-verified (`api/com/settings/shipments.json:87` `carriers[].extension_app_id`; `api/com/features/orders/shipping.js:371-433` branches on it). Nothing here reads that today — it is the first thing to check by hand when rates never appear, and the obvious candidate if this app ever grows a diagnostic surface.
**Discrepancy to confirm:** the skill reference says the record is `carriers.<extId>`; swell-admin (`components/settings/shipping.js:146`) and swell-cli (`lib/inspect/extensions.ts` `shippingBindId`) both say `carriers.app_<appId>_<extId>`. Don't hand-construct it — read `swell inspect extensions app.printful.printful`, branch on `action_owner`, and surface `action` verbatim when it's `merchant`.

**7. Print files: async validation, URL dedupe, undetermined units.**
Printful dedupes by URL and returns the existing file *without refreshing its contents* — **every artwork URL must carry a content hash or version token**, or customers get stale prints. Validation is asynchronous and fails *after* confirmation, reverting the order to `failed`, so subscribing to `order_failed` is mandatory, not optional. The API publishes **no** required DPI, minimum dimensions, max size, or color profile — the only geometry is per-placement `print_area_width`/`print_area_height` (inches) + `dpi` from `/mockup-styles`; compute required pixels per product rather than hardcoding 300 DPI from marketing pages. And `LayerPosition` documents `top/left/width/height` as inches while the docs' own example uses `1800/2400/450` and adds `area_width`/`area_height` fields that exist nowhere in the schema — **placement units are genuinely undetermined.** Confirm with one live order before writing positioning code. `.ai`, `.psd`, `.tiff` are deprecated.

**8. Permission posture — decide once, write it down.**
`permissions: []` means **full** access (`server/client.js:1236` `// Empty array means full permissions`). It is the `swell create app` default and this app should keep it. Consequences to accept explicitly: any installed app can read this app's Printful token from `/settings/printful` — there is genuinely no ownership filter (`server/model.js:10567-10585`; `Model.getSettingConfig` at `model.js:14496-14545` never references the caller's app id). If anyone later tightens `permissions` to look responsible, the `/apps` + `/settings` own-app exemption compares `stack[1]` to the canonical ObjectId while `req.swell.settings()` sends the slug, so it misses; and `:clients`, `:functions`, and `:transaction` hit no exemption at all — `req.swell.transaction()` would start 403ing. `public` is **not** a real permission token; it grants nothing.

**9. Beta-API drift.**
v2 is formally `2.0.0-beta` with no published v1 sunset date and **no product/sync management at all** — if the store ever needs to push products *into* a Printful store rather than pull the catalog, v2 cannot do it. Error shapes are not uniform and the inconsistency lands on the endpoints we use: RFC 9457 problem+json is *not* implemented for all Catalog ops, Create/Confirm/Retrieve Order, Retrieve Shipments, or any Webhook op — those return legacy `{code, result, error}` — while `/v2/shipping-rates` *does* use problem+json. **Branch the error parser on `content-type`, not on version.** Webhook endpoints return `{code, result, extra}`; everything else `{data, paging, _links}`. Write tolerant parsers, pin to documented field names, contract-test the ~8 endpoints on a schedule.

**10. Swell-side operational limits.**
Response bodies over 75 KB are silently dropped (paginate — never return a full catalog from a route). Model-event functions auto-disable after ~4 days of continuous failure (2 days if `timeout` > 10s; immediately on 404) until redeployed. Change detection hashes **top-level files only** — editing `functions/lib/*` leaves importing bundles stale, so always `swell app push --force` after subdirectory-only edits. A second function in the same app on the same `event + extension + phase` is logged as a conflict and only one result is used.

**11. The rating hook does not always fire.**
`rateShipment` has three early exits before any dispatch: no `shipment_rating` in `origData` and `shouldShippingPriceBeRecalculated` false; caller-supplied `shipment_rating.services`; no line item with `delivery === 'shipment'` (digital-only cart). Both `triggerExtension` calls are additionally wrapped in `if (shippingParamsChanged)`, computed against the `shipment_rating.fingerprint`. Do not assume every order write re-rates — this shapes the cache design.

---

## 4. Build order

Every step names the gate(s) it satisfies and the check that proves it.

**0. Spikes — resolve three unknowns before writing app code.** *(Gate 1)*
- 0a. Obtain a Printful private token in a sandbox store. `GET /v2/stores` → exactly one row ⇒ store-level (omit `X-PF-Store-Id`); more than one ⇒ account-level (header required on every store-scoped call, including `POST /v2/files` and `POST /v2/mockup-tasks`). `GET /v2/oauth-scopes` to confirm the real scope strings (the spec declares `file_library` while endpoints reference `file-library`, and `/v2/approval-sheets` references an undeclared `files`).
  ✅ **Check:** measured p50/p95/p99 for `POST /v2/shipping-rates` at 1 item, 10 items, and >100 units. **If p95 > 5s, Flow B must be redesigned around cached/flat rates before proceeding.**
- 0b. Deploy a throwaway `public: true` route in a scratch app; `curl` it from outside with **no** `Authorization` header.
  ✅ **Check:** HTTP 200, not 404. If 404, retry with the key as a query param; if that also fails, design the relay now.
- 0c. Confirm the test environment is enabled on the store (`swell app push` fails with *"Test environment is not enabled for this store"* otherwise). `swell inspect models /orders` to confirm the `shipping` and `paid` event types.
  ✅ **Check:** a trivial `swell app push` succeeds.

**1. Scaffold the app + manifest.** `swell create app printful --type integration --integration-type shipping --integration-id printful -y`. Set `carrier: "printful"`, `permissions: []`, `description`. *(Gates 1–3)*
✅ `swell app push` succeeds; `swell inspect extensions --app=.` lists `app.printful.printful` with `action_owner: "merchant"`.

**2. Settings.** `swell schema setting --format=dts` first. Author `settings/printful.json` — filename matches the extension id so the admin renders it as the extension panel. Copy field shapes from `/Users/eric/swell-apps/shipping_example/settings/config.json` and `example-payment-integration/settings/credentials.json`, **not** from the dts `CoreFieldType` enum: the generated dts drops the `AliasFieldType` branch, so `text`/`toggle`/`integer` look invalid but are defined in `app-schemas/schema/setting.json` and work. Local JSON validation fails on this CLI build (`no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`) — push is the authoritative check. *(Gates 2–4)*
✅ `swell inspect settings --app=.` shows the record; the merchant can paste a token in the dashboard.

**3. Models.** `swell schema model --format=dts`, then `swell create model …` for each of `catalog-items`, `fulfillments`, `printful-events`, `sync-runs`, plus the `orders.json` / `products.json` extensions. Put `unique: true` on `fulfillments.order_id` and on the `printful-events` dedupe key. *(Gates 1–4)*
✅ `swell inspect models apps/printful/fulfillments` matches the manifest; a duplicate `POST /apps/printful/fulfillments` with the same `order_id` is rejected. **Also confirm here: the event root for a kebab-case app collection** — is it `fulfillment.created` or something else? Read it off `swell inspect models`; do not guess.

**4. Printful client + environment guard (`functions/lib/`).** Model `lib/printful.ts` on `/Users/eric/swell-apps/payment_example/functions/lib/razorpay.ts` — `fetch` + `Headers` + Web Crypto, no Node SDK, no Node built-ins (Workers, `compatibility_date 2023-05-18`, no `nodejs_compat`). npm deps *are* bundled by esbuild, so a pure-ESM helper is fine. Dual error-envelope parser keyed on `content-type`. *(Gates 3, 5)*
✅ `npm run typecheck` clean; unit tests cover the env-guard truth table (`app_pk_<32>` → live; `app_pk_test_…` → not live; `undefined` → not live) and both error envelopes.

**5. Shipping rating hook — the first thing that must work end to end.** `functions/shipping-rates.ts` with `extension: "printful"`, `model: { events: ["after:order.shipping"], fields: ["shipment_rating"] }`. Log `req.data` once on first invocation to verify the payload shape against the defensive reads, then remove the log. *(Gates 1–5)*
✅ `swell inspect extensions app.printful.printful` → `status: "activated"` (after the merchant toggles the carrier and saves); changing a cart's shipping address produces `shipment_rating.services` containing a `printful_*` entry; `swell logs --type function --app=.` shows the invocation and the Printful response. Integration test in `test/integration/shipping-rates.test.ts`.
⚠ **Hand the merchant activation steps verbatim** — a code-only agent cannot perform them, and until they're done the function silently never runs.

**6. Catalog sync.** Cron + resumable route, budget-capped. *(Gates 1–5)*
✅ `swell api post '/functions/printful/catalog-sync-run'` populates `apps/printful/catalog-items`; a second run resumes from the cursor rather than restarting; the run's Printful request count stays under budget. Verify pagination actually works on `catalog-variants` (a product with >20 variants must yield >20 rows) and `prices` (>10).

**7. Order submit claim + durable advance.** `order-submit.ts`, `fulfillment-advance.ts`, `fulfillment-sweep.ts`. Live confirmation gated behind `isLiveEnv && settings.live_fulfillment`. *(Gates 1–5)*
✅ Fire `order.paid` twice for one order → exactly one `fulfillments` row and exactly one Printful draft. In test env, the job reaches state `calculating` and **stops** — no `/confirmation` call is ever made (assert this explicitly in the integration test). Confirm `GET /v2/orders/@<swell_order_id>` returns the adopted draft.

**8. Webhook receiver + event handler.** `printful-webhook.ts` (verify → persist → 200) and `printful-event-handle.ts` (enrich → `POST /shipments`). Register the config with `POST /v2/webhooks` and store `secret_key`. *(Gates 1–5)*
✅ A **real Printful-signed event** passes verification (this is where the raw-body inference gets validated); a tampered body is rejected 401; a duplicate delivery creates no second Swell shipment; `swell api get '/shipments?order_id=…'` shows the correct `carrier`, `service`, `tracking_code` and the right `order_item_id`s. Also confirm `order_updated` wakes the fulfillment job and drives it to `confirmed`.

**9. Admin surface + failure notification.** `content/orders.json`, `content/fulfillments.json`, `notifications/printful-order-failed.*`. *(Gates 2–5)*
✅ `swell inspect content --app=.` and `swell inspect notifications --app=.` show the expected `(model, name)` bindings; a forced `failed` job produces an admin email and a visible order tab.

**10. Release prep.** Assets (`assets/icon.*` and ≥1 screenshot), `support_email`, README as `full_description`. Read `references/app-publishing.md` before `swell app version` — version creation pushes and deploys as a side effect. *(Gate 4)*
✅ `swell app version` succeeds without asset or metadata errors; installing the app into a clean test store reproduces steps 5–9 from scratch.

---

### Open items to confirm during the build (not designed around)

| # | Item | Where it bites |
|---|---|---|
| 1 | Gateway public-key requirement on `public: true` routes for third-party callers | Flow D — architecture-changing |
| 2 | `/v2/shipping-rates` p50/p95/p99 with a real token | Flow B — decides synchronous vs cached-only |
| 3 | `limit`/`offset` on `/v2/catalog-products/{id}/catalog-variants` and `/prices` | Flow A — silent truncation at 20 / 10 |
| 4 | Whether Printful enforces `external_id` uniqueness | Flow C idempotency residual race |
| 5 | Exact byte range Printful HMACs (raw body is inference, never tested against a live event) | Flow D signature verification |
| 6 | `Swell-Public-Key` populated on model-event invocations, not just routes | The environment guard |
| 7 | `carriers.<extId>` (skill) vs `carriers.app_<appId>_<extId>` (admin + CLI source) | Merchant activation debugging |
| 8 | Event root for kebab-case app collections (`fulfillment.created`?) | Steps 3, 7, 8 all depend on it |
| 9 | How a function uploads a binary into Swell storage | Mockup re-hosting (deferred to v2) |
| 10 | Placement units — inches (schema) vs `area_width`/`area_height` pixels (docs example) | Print-file positioning |
| 11 | Whether Swell auto-derives `order.delivered` from shipments | Flow D step 7 |
