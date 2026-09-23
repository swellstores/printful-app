import Printful from "./printful";
import type { PrintfulSettings } from "./settings";

const PRODUCT_PAGE = 20;
const VARIANT_PAGE = 100;
const PRICE_PAGE = 100;

// One product can hold hundreds of variants; cap its paging so a single
// product cannot consume a whole run.
const MAX_PAGES_PER_PRODUCT = 5;

// A product costs at least one variants page plus one prices page.
const MIN_PRODUCT_COST = 2;

const DEFAULT_REQUEST_BUDGET = 40;

// The function is killed at 10s. Stop early enough to persist the cursor.
const TIME_BUDGET_MS = 7000;

const TRANSACTION_SIZE = 10;

// Rows cleared per failed product. A product with more rows than this drops out
// of the stale set over the next few runs rather than in one.
const MAX_STALE_ROWS = 100;

export interface SyncStatus {
  id: string;
  state: string;
  product_offset: number;
  requests_used: number;
  items_synced: number;
  last_error?: string | null;
}

interface Budget {
  used: number;
  limit: number;
  deadline: number;
}

function hasBudget(budget: Budget, cost = 1): boolean {
  return budget.used + cost <= budget.limit && Date.now() < budget.deadline;
}

function pageOf(result: any): any[] {
  const data = result?.data;
  return Array.isArray(data) ? data : [];
}

async function fetchVariants(
  printful: Printful,
  budget: Budget,
  productId: number,
) {
  const variants: any[] = [];
  let exhausted = false;
  let truncated = true;

  for (let page = 0; page < MAX_PAGES_PER_PRODUCT; page++) {
    if (!hasBudget(budget)) {
      exhausted = true;
      truncated = false;
      break;
    }

    budget.used++;
    const result = await printful.listCatalogVariants(
      productId,
      VARIANT_PAGE,
      page * VARIANT_PAGE,
    );

    const items = pageOf(result);
    variants.push(...items);

    // The endpoint's documented parameters omit limit/offset but the response
    // links prove they apply, and the default page is only 20 — a short page
    // is the only reliable end-of-list signal.
    if (items.length < VARIANT_PAGE) {
      truncated = false;
      break;
    }
  }

  // Reaching the page cap without a short page means the product has more
  // variants than we read. Reported rather than swallowed: a silently truncated
  // catalog reads as a complete one, and the variants left out are quoted by
  // native carriers and never reach Printful.
  return { variants, exhausted, truncated };
}

/**
 * Printful's base price already includes one placement, so the placement map
 * holds only the extra cost of additional placements. Adding the first
 * placement's price to the base would count it twice.
 */
async function fetchPrices(
  printful: Printful,
  budget: Budget,
  productId: number,
) {
  const costByVariant = new Map<number, Record<string, number>>();
  const placementPrices: Record<string, number> = {};
  let currency: string | undefined;
  let exhausted = false;
  let truncated = true;

  for (let page = 0; page < MAX_PAGES_PER_PRODUCT; page++) {
    if (!hasBudget(budget)) {
      exhausted = true;
      truncated = false;
      break;
    }

    budget.used++;
    const result = await printful.listCatalogPrices(
      productId,
      PRICE_PAGE,
      page * PRICE_PAGE,
    );

    const data = result?.data ?? {};
    const variants = Array.isArray(data) ? data : (data.variants ?? []);

    currency = currency ?? data.currency;

    for (const placement of data.product?.placements ?? []) {
      const price = Number.parseFloat(String(placement?.price));
      if (placement?.id && Number.isFinite(price)) {
        placementPrices[placement.id] = price;
      }
    }

    for (const variant of variants) {
      const byTechnique: Record<string, number> = {};

      for (const technique of variant?.techniques ?? []) {
        const price = Number.parseFloat(String(technique?.price));
        const key = technique?.technique_key ?? technique?.technique;
        if (key && Number.isFinite(price)) {
          byTechnique[key] = price;
        }
      }

      if (variant?.id) {
        costByVariant.set(Number(variant.id), byTechnique);
      }
    }

    if (variants.length < PRICE_PAGE) {
      truncated = false;
      break;
    }
  }

  return { costByVariant, placementPrices, currency, exhausted, truncated };
}

async function upsertCatalogItems(req: SwellRequest, rows: any[]) {
  if (rows.length === 0) {
    return;
  }

  const collection = `/apps/${req.appId}/catalog-items`;

  const existing = await req.swell.get(collection, {
    catalog_variant_id: { $in: rows.map((row) => row.catalog_variant_id) },
    limit: rows.length,
    fields: ["catalog_variant_id"],
  });

  const idByVariant = new Map<number, string>(
    (existing?.results ?? []).map((row: any) => [
      Number(row.catalog_variant_id),
      row.id,
    ]),
  );

  const ops = rows.map((row) => {
    const id = idByVariant.get(row.catalog_variant_id);

    return id
      ? { method: "put" as const, url: `${collection}/${id}`, data: row }
      : { method: "post" as const, url: collection, data: row };
  });

  for (let i = 0; i < ops.length; i += TRANSACTION_SIZE) {
    await req.swell.transaction(ops.slice(i, i + TRANSACTION_SIZE));
  }
}

/**
 * Reports `complete: false` when the budget ran out partway through the
 * product, and writes nothing in that case. Persisting a half-fetched product
 * would mark rows fresh while carrying no pricing, so nothing would ever
 * refetch them.
 *
 * The same rule applies per variant once the fetches did finish: only variants
 * the prices response actually priced are written. `synced` counts rows written,
 * not variants seen.
 *
 * `truncated` means the product has more variants or prices than the per-product
 * page cap reads. The rows written are correct; there are simply more.
 */
async function syncProduct(
  req: SwellRequest,
  printful: Printful,
  budget: Budget,
  productId: number,
): Promise<{ synced: number; complete: boolean; truncated: boolean }> {
  const {
    variants,
    exhausted: variantsExhausted,
    truncated: variantsTruncated,
  } = await fetchVariants(printful, budget, productId);

  if (variantsExhausted) {
    return { synced: 0, complete: false, truncated: false };
  }

  if (variants.length === 0) {
    return { synced: 0, complete: true, truncated: false };
  }

  const {
    costByVariant,
    placementPrices,
    currency,
    exhausted: pricesExhausted,
    truncated: pricesTruncated,
  } = await fetchPrices(printful, budget, productId);

  if (pricesExhausted) {
    return { synced: 0, complete: false, truncated: false };
  }

  const date_synced = new Date().toISOString();

  // A variant the prices response did not price is not synced, whatever the
  // fetch reported. That covers both the prices endpoint answering with an
  // empty or unrecognised shape and a variant simply missing from an otherwise
  // populated response.
  //
  // These costs are what the merchant pays Printful. Nothing in this app reads
  // them — rates come from Printful live and submission keys off
  // catalog_variant_id — so they exist for margin work in the admin. That is
  // exactly why an unpriced row must not be written: it would be marked fresh,
  // never refetched, and show a variant that appears to cost nothing. Leaving
  // it unwritten also preserves any costs an existing row already holds, which
  // the upsert would otherwise clobber with an empty map.
  const rows = variants
    .filter((variant) => variant?.id)
    .map((variant) => ({
      catalog_variant_id: Number(variant.id),
      catalog_product_id: productId,
      size: variant.size,
      color: variant.color,
      base_cost_by_technique: costByVariant.get(Number(variant.id)) ?? {},
      placement_prices: placementPrices,
      currency,
      stale: false,
      date_synced,
    }))
    .filter((row) => Object.keys(row.base_cost_by_technique).length > 0);

  await upsertCatalogItems(req, rows);

  return {
    synced: rows.length,
    complete: true,
    truncated: variantsTruncated || pricesTruncated,
  };
}

/**
 * Takes a product out of the stale set after it failed. A product withdrawn
 * from Printful 404s on every attempt, and `getStaleProductIds` reads it back
 * first on every run, so the sync would spend its whole budget failing on the
 * same ids forever. The reason is kept on the run's `last_error`.
 *
 * This fires on any failure, not only a permanent one — a Printful 429, a 500
 * or a failed Swell write also clears the flag. That is deliberate: a transient
 * failure costs one delayed resync when the nightly walk reaches the product
 * again, whereas keeping the flag risks the wedge above. The tradeoff is that a
 * price change flagged by webhook can be missed if the retry happens to fail.
 */
async function clearStale(req: SwellRequest, productId: number) {
  const collection = `/apps/${req.appId}/catalog-items`;

  const result = await req.swell.get(collection, {
    catalog_product_id: productId,
    stale: true,
    limit: MAX_STALE_ROWS,
    fields: ["id"],
  });

  const rows = result?.results ?? [];

  for (let i = 0; i < rows.length; i += TRANSACTION_SIZE) {
    await req.swell.transaction(
      rows.slice(i, i + TRANSACTION_SIZE).map((row: any) => ({
        method: "put" as const,
        url: `${collection}/${row.id}`,
        data: { stale: false },
      })),
    );
  }
}

/** Products whose prices or stock a webhook flagged since the last run. */
async function getStaleProductIds(req: SwellRequest): Promise<number[]> {
  const result = await req.swell.get(`/apps/${req.appId}/catalog-items`, {
    stale: true,
    limit: 100,
    fields: ["catalog_product_id"],
  });

  return [
    ...new Set(
      (result?.results ?? [])
        .map((row: any) => Number(row.catalog_product_id))
        .filter((id: number) => Number.isFinite(id) && id > 0),
    ),
  ] as number[];
}

async function getRun(req: SwellRequest, requestBudget: number) {
  const paused = await req.swell.get(`/apps/${req.appId}/sync-runs`, {
    state: "paused",
    limit: 1,
    sort: "date_started desc",
  });

  const run = paused?.results?.[0];

  if (run) {
    return run;
  }

  return req.swell.post(`/apps/${req.appId}/sync-runs`, {
    state: "running",
    request_budget: requestBudget,
  });
}

/**
 * Pulls the Printful catalog into `apps/<app>/catalog-items`, spending at most
 * `request_budget` Printful calls and `TIME_BUDGET_MS` of wall clock. When the
 * budget runs out the run is parked with its cursor and the next tick resumes
 * from there rather than starting over.
 */
export async function runCatalogSync(
  req: SwellRequest,
  settings: PrintfulSettings,
  options: { budget?: number } = {},
): Promise<SyncStatus> {
  const run = await getRun(req, options.budget ?? DEFAULT_REQUEST_BUDGET);

  const budget: Budget = {
    used: 0,
    limit: options.budget ?? run.request_budget ?? DEFAULT_REQUEST_BUDGET,
    deadline: Date.now() + TIME_BUDGET_MS,
  };

  const printful = new Printful(settings.api_token as string, settings.store_id);

  let offset = run.product_offset ?? 0;
  let synced = 0;
  let complete = false;
  let error: string | null = null;
  const truncated: number[] = [];

  try {
    for (const productId of await getStaleProductIds(req)) {
      if (!hasBudget(budget, MIN_PRODUCT_COST)) {
        break;
      }

      try {
        const outcome = await syncProduct(req, printful, budget, productId);
        synced += outcome.synced;
        if (outcome.truncated) {
          truncated.push(productId);
        }
      } catch (err) {
        // A product that was withdrawn from the catalog would otherwise wedge
        // every future run at the same row, since it stays flagged stale.
        error = err instanceof Error ? err.message : String(err);
        await clearStale(req, productId);
      }
    }

    while (hasBudget(budget, MIN_PRODUCT_COST + 1)) {
      budget.used++;
      const result = await printful.listCatalogProducts(PRODUCT_PAGE, offset);

      const products = pageOf(result);

      if (products.length === 0) {
        complete = true;
        break;
      }

      for (const product of products) {
        if (!hasBudget(budget, MIN_PRODUCT_COST)) {
          break;
        }

        const outcome = await syncProduct(
          req,
          printful,
          budget,
          Number(product.id),
        );
        synced += outcome.synced;

        if (outcome.truncated) {
          truncated.push(Number(product.id));
        }

        // Advancing the cursor past a product the budget cut short would leave
        // it unsynced until the cursor wrapped the whole catalog.
        if (!outcome.complete) {
          break;
        }

        offset++;
      }

      if (products.length < PRODUCT_PAGE) {
        complete = true;
        break;
      }
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const state = error ? "failed" : complete ? "complete" : "paused";

  // A product with more variants than the page cap reads is recorded, not
  // swallowed. Otherwise a partially synced catalog reports as a complete one
  // and the missing variants are quoted by native carriers forever.
  const truncationNote =
    truncated.length > 0
      ? `Page cap reached on Printful product(s) ${truncated.join(", ")} — not all variants were read.`
      : null;

  const values = {
    state,
    product_offset: complete ? 0 : offset,
    requests_used: (run.requests_used ?? 0) + budget.used,
    items_synced: (run.items_synced ?? 0) + synced,
    last_error: [error, truncationNote].filter(Boolean).join(" ") || null,
    date_finished: state === "paused" ? null : new Date().toISOString(),
  };

  await req.swell.put(`/apps/${req.appId}/sync-runs/${run.id}`, values);

  return { id: run.id, ...values };
}
