# Printful

Print-on-demand fulfillment for Swell, backed by [Printful](https://www.printful.com). The app syncs the Printful catalog into a table you map your own products against, quotes live shipping rates at checkout, submits paid orders to Printful, and writes tracking back onto the Swell order.

**Live fulfillment is off by default.** Until you turn it on, paid orders are created at Printful as drafts and never confirmed — nothing is printed and nothing is charged. This is the safe way to see exactly what would be sent before it costs money.

## Works with any storefront

This app has no storefront of its own and needs none. Everything it produces lands on ordinary Swell records — the products you map to its catalog, the shipping services on the cart, the shipment and its tracking code on the order — so whatever theme or storefront app you sell through renders the results without knowing this app is installed.

## Setup

1. **Create a Printful token.** In Printful, go to Settings → Developers and create a private token with the `orders`, `catalog` and `webhooks` scopes.
2. **Paste it into the app.** In Swell, open Apps → Printful → Settings and enter the token. If your token can see more than one Printful store, also fill in the store ID.
3. **Enable the carrier.** Go to Settings → Shipping. The Printful row appears there. Toggle it on and click **Save changes**.

   Step 3 is not optional and installing the app does not do it for you. Until the carrier row is saved as enabled, Swell never asks the app for rates and checkout silently shows only your native shipping services.
4. **Let the catalog sync.** It runs nightly, or trigger it immediately with `swell api post '/functions/printful/catalog-sync-run'`. Each run stops at a request budget and the next run resumes where it left off, so a large catalog fills in over several runs rather than exhausting Printful's rate limit in one go.
5. **Map the variants you sell.** Open Products → Printful catalog, find the catalog variant you want, and set its **Swell variant** to the product variant customers buy. Catalog variants with no Swell variant are synced but not for sale. This is the link the rate and submit paths follow — a variant with no catalog row is quoted by your native carriers and never reaches Printful.
6. **Set up the print job.** On each mapped product, open the **Printful** tab and set the print technique and the artwork, either one artwork URL or a list of placements for products that print in more than one spot. Nothing fills this in for you. A product mapped to a catalog variant but left without artwork is accepted at checkout and reaches Printful with nothing to print.
7. **Place a test order.** With live fulfillment off, the order appears in the Printful dashboard as an unconfirmed draft. Open it from the Printful tab on the Swell order and check the items, sizes and print files.
8. **Turn on live fulfillment** in the app settings once that draft looks right.

## What the merchant sees

- **Printful tab on each order** — Printful order id, status, a link into the Printful dashboard, and the last error if there was one. Orders can be filtered by failed submission from the orders list.
- **Printful fulfillments** (under Orders) — the submission jobs, with a Failed tab. Retrying a stuck job is a matter of setting its state back to Pending.
- **Printful catalog** (under Products) — the mapping from Swell variants to Printful catalog variants, including which ones still need a resync.
- **Printful tab on each product** — the print job: catalog variant, technique, artwork and placements, and the print area to size that artwork against. A **Printful** tab on the products list narrows it to the products set up for print-on-demand.

## Configuration

| Setting | What it does |
| --- | --- |
| Printful API token | Private token from Printful Settings → Developers. Use a separate token for your test environment. |
| Printful store ID | Only needed for account-level tokens that can see more than one store. |
| Live fulfillment | Off: paid orders become Printful drafts and stop there. On: they are confirmed for production and charged. |
| Fallback shipping rate | Flat rate offered when Printful is slow or rate-limited. Empty means offer nothing rather than a wrong price. |
| Fallback service name | What that rate is called at checkout. |
| Quote cache lifetime | How long a quote is reused for the same destination and cart. Printful allows 120 requests a minute across everything the app does, so this is what keeps checkout inside the budget. |
| Rate request timeout | How long to wait for a quote before falling back. The function itself is killed at 10 seconds. |
| Webhook secret / public key | Written by the app when it registers with Printful. Read-only — re-registering rotates them. |

## Things worth knowing

- **Printful order confirmation is the charge point.** Creating a draft is free; confirming it bills your Printful account. The app confirms only when live fulfillment is on and it is running in the live environment.
- **Print files are cached by URL at Printful.** Every artwork URL carries a content hash, so changing a design produces a new URL and Printful refetches it. Reusing a URL after changing its contents prints the old design.
- **Print files are validated after confirmation.** An order can be accepted and then fail. The app subscribes to Printful's failure event and surfaces it on the order.
- **Cancellations are reported, not acted on.** If an order is canceled or refunded at Printful, the app records it and notifies you. It does not cancel or refund the Swell order for you.
- **Products are curated, not imported.** The catalog sync fills the Printful catalog table; it never creates a product in your store. You pick the handful of products you want to sell and point each one at a catalog variant by hand. A swag shop sells six products, not five hundred, and choosing those six is faster than pruning a full catalog import — and it keeps you from listing a garment you have never seen a print file for.

## Before release

`swell app release` refuses a non-theme app that has no `support_email`, no `assets/icon.*`, or no screenshot, so the first two are blocking, not dress-up:

- **`support_email` in `swell.json` is a placeholder.** It currently reads `support@example.com`. Set it to a real inbox — it is published to the marketplace as the contact for this app.
- **`assets/` is empty.** It needs `assets/icon.png` and at least one screenshot under `assets/screenshots/`.
- **A carrier logo, if you add one.** The shipping extension has no `carrier_logo_src` today. If you add one, it points at an asset in this repo, e.g. `assets/carrier-logo.png`, and that file has to exist.

## Support

Open an issue in this repository.
