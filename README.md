# Printful

Print-on-demand fulfillment for Swell, backed by [Printful](https://www.printful.com). Design products in Printful and the app creates them in Swell. It quotes live Printful shipping rates at checkout, submits paid orders to Printful, and writes tracking back onto the Swell order.

**Live fulfillment is off by default.** Until you turn it on, paid orders are created at Printful as drafts and never confirmed — nothing is printed and nothing is charged. This is the safe way to see exactly what would be sent before it costs money.

## Works with any storefront

This app has no storefront of its own and needs none. Everything it produces lands on ordinary Swell records — the products it syncs from Printful, the shipping services on the cart, the shipment and its tracking code on the order — so whatever theme or storefront app you sell through renders the results without knowing this app is installed.

## Setup

1. **Design your products in Printful.** In Printful, add a store of the *Manual order platform / API* type, then add products to it with Printful's design tools: pick a product, place your artwork, generate mockups and set your retail prices.
2. **Create a Printful token.** In Printful, go to Settings → Developers and create a private token for that store with the `orders`, `sync_products` and `webhooks` scopes.
3. **Paste it into the app.** In Swell, open Apps → Printful → Settings and enter the token. If it is an account-level token that can see more than one Printful store, also fill in the store ID.
4. **Enable the carrier.** Go to Settings → Shipping. The Printful row appears there. Toggle it on and click **Save changes**.

   This step is not optional and installing the app does not do it for you. Until the carrier row is saved as enabled, Swell never asks the app for rates and checkout silently shows only your native shipping services.
5. **Review your products.** The sync runs every five minutes. Each Printful product becomes a Swell product with its colors and sizes as variants, Printful's mockups as photos and your Printful retail prices. Products arrive as drafts: check the name, description and prices, then make them active. To sync right away, run `swell api post '/functions/printful/product-sync-run'`.
6. **Place a test order.** With live fulfillment off, the order appears in the Printful dashboard as an unconfirmed draft. Open it from the Printful tab on the Swell order and check the items, sizes and print files.
7. **Turn on live fulfillment** in the app settings once that draft looks right.

## Keeping products in sync

- **Printful owns the design and the variants.** Add a color or size in Printful and the sync adds the variant in Swell; remove or discontinue one and it is taken off sale. A product deleted or ignored in Printful is taken off sale in Swell and kept for order history.
- **To stop selling a product, delete or ignore it in Printful.** Deleting it only in Swell does not stop the sync: the next run creates it again as a draft.
- **Swell owns what shoppers see.** After the first sync, the name, description, prices and photos are yours to edit, and the sync never overwrites them. A variant added later gets its Printful retail price when it is first linked.
- **Combinations Printful does not make are switched off.** Swell builds a variant for every color and size combination; the ones Printful does not offer, such as a color that stops at XL, are made inactive.
- **Prices are copied as numbers.** If your Printful store and your Swell store use different currencies, set the prices in Swell.
- **Mockups are linked, not copied.** Product photos point at Printful's CDN.
- **A large store syncs over several runs.** Each run spends a small share of Printful's rate limit, which checkout also uses, and handles new products first.

## What the merchant sees

- **Printful tab on each order** — Printful order id, status, a link into the Printful dashboard, and the last error if there was one. Orders can be filtered by failed submission from the orders list.
- **Printful fulfillments** (under Orders) — the submission jobs, with a Failed tab. Retrying a stuck job is a matter of setting its state back to Pending.
- **Printful tab on each product** — the Printful product it was created from and when it last synced. A **Printful** tab on the products list narrows it to the products synced from Printful.
- **Printful variants** (under Products) — which Swell variant each Printful variant is sold as. The sync maintains this; nothing needs editing.
- **Last product sync** (in the app settings) — when the sync last ran and what it did, including errors such as a token without the `sync_products` scope.

## Configuration

| Setting | What it does |
| --- | --- |
| Printful API token | Private token from Printful Settings → Developers, for your Manual order platform / API store. Use a separate token for your test environment. |
| Printful store ID | Only needed for account-level tokens that can see more than one store. |
| Live fulfillment | Off: paid orders become Printful drafts and stop there. On: they are confirmed for production and charged. |
| Fallback shipping rate | Flat rate offered when Printful is slow or rate-limited. Empty means offer nothing rather than a wrong price. |
| Fallback service name | What that rate is called at checkout. |
| Quote cache lifetime | How long a quote is reused for the same destination and cart. Printful allows 120 requests a minute across everything the app does, so this is what keeps checkout inside the budget. |
| Rate request timeout | How long to wait for a quote before falling back. The function itself is killed at 10 seconds. |
| Webhook secret / public key | Written by the app when it registers with Printful. Read-only — re-registering rotates them. |
| Last product sync / Last sync result | Written by the sync after every run. Read-only. |

## Things worth knowing

- **Printful order confirmation is the charge point.** Creating a draft is free; confirming it bills your Printful account. The app confirms only when live fulfillment is on and it is running in the live environment.
- **Printful prints what you designed there.** Orders reference the Printful product variant, so Printful uses the print files stored with your design. Change a design in Printful and later orders print the new version.
- **Print files are validated after confirmation.** An order can be accepted and then fail. The app subscribes to Printful's failure event and surfaces it on the order.
- **Cancellations are reported, not acted on.** If an order is canceled or refunded at Printful, the app records it and notifies you. It does not cancel or refund the Swell order for you.

## Support

Open an issue in this repository.
