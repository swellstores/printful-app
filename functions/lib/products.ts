import Printful, { PrintfulError } from "./printful";
import { putSettings, PrintfulSettings } from "./settings";

const LIST_PAGE = 100;

// Products whose Printful list entry did not change are still re-read now and
// then, oldest first, so an edit the list does not reveal (a variant swapped
// for another) reaches Swell within a day or so.
const REFRESH_PER_RUN = 2;

const DEFAULT_REQUEST_BUDGET = 30;

// The function is killed at 10s, and creating a large product takes a few
// seconds, so no new product is started after this.
const TIME_BUDGET_MS = 5000;

const MAX_IMAGES = 10;
const MAX_ROWS = 1000;

export interface SyncVariant {
  id: number;
  name?: string;
  variant_id?: number;
  retail_price?: string;
  sku?: string;
  size?: string;
  color?: string;
  is_ignored?: boolean;
  availability_status?: string;
  files?: Array<{ type?: string; preview_url?: string }>;
  product?: { product_id?: number };
}

export interface SyncProductSummary {
  id: number;
  name?: string;
  variants?: number;
  is_ignored?: boolean;
}

export interface SyncProductDetail {
  sync_product: { id: number; name?: string; thumbnail_url?: string };
  sync_variants: SyncVariant[];
}

export interface SwellOption {
  id?: string;
  name: string;
  variant?: boolean;
  values: Array<{ id?: string; name: string }>;
  [key: string]: any;
}

export interface SwellVariant {
  id: string;
  option_value_ids?: string[];
  active?: boolean;
}

export interface LinkRow {
  id?: string;
  sync_variant_id: number;
  variant_id?: string;
}

export interface Dimension {
  name: string;
  value: (variant: SyncVariant) => string | undefined;
}

const COLOR: Dimension = { name: "Color", value: (v) => v.color || undefined };
const SIZE: Dimension = { name: "Size", value: (v) => v.size || undefined };
const NAME: Dimension = {
  name: "Variant",
  value: (v) => v.name || String(v.id),
};

const DIMENSIONS = [COLOR, SIZE, NAME];

/** Variants Printful can still print. Ignored and discontinued ones are not sold. */
export function sellable(variants: SyncVariant[]): SyncVariant[] {
  return variants.filter(
    (v) =>
      v?.id &&
      v.variant_id &&
      !v.is_ignored &&
      v.availability_status !== "discontinued",
  );
}

function keyOf(dims: Dimension[], variant: SyncVariant): string | null {
  const values = dims.map((dim) => dim.value(variant));
  return values.every(Boolean) ? values.join("\u0000") : null;
}

/**
 * Color and Size become Swell options when together they tell every variant
 * apart, which covers most products. Anything else gets one option naming each
 * variant, so every Printful variant has exactly one Swell variant.
 */
export function chooseDimensions(variants: SyncVariant[]): Dimension[] {
  const dims = [COLOR, SIZE].filter((dim) => variants.some((v) => dim.value(v)));
  const keys = variants.map((v) => keyOf(dims, v));

  if (
    dims.length > 0 &&
    keys.every(Boolean) &&
    new Set(keys).size === variants.length
  ) {
    return dims;
  }

  return [NAME];
}

/** The dimensions an existing product was created with, read off its options. */
export function dimensionsFromOptions(options: SwellOption[] = []): Dimension[] {
  return options
    .filter((option) => option.variant)
    .map((option) => DIMENSIONS.find((dim) => dim.name === option.name))
    .filter(Boolean) as Dimension[];
}

function valuesOf(dim: Dimension, variants: SyncVariant[]): string[] {
  return [
    ...new Set(variants.map((v) => dim.value(v)).filter(Boolean) as string[]),
  ];
}

/**
 * Adds the option values new Printful variants need, keeping every existing
 * option and value id. Swell regenerates variants from options, so dropping or
 * re-creating a value would archive the variants built on it, and leaving out
 * an option the merchant added would delete it.
 */
export function mergeOptions(
  existing: SwellOption[] = [],
  dims: Dimension[],
  variants: SyncVariant[],
): { options: SwellOption[]; changed: boolean } {
  let changed = false;
  const options = existing.map((option) => ({
    ...option,
    values: [...(option.values ?? [])],
  }));

  for (const dim of dims) {
    let option = options.find((o) => o.variant && o.name === dim.name);

    if (!option) {
      option = { name: dim.name, variant: true, values: [] };
      options.push(option);
      changed = true;
    }

    for (const name of valuesOf(dim, variants)) {
      if (!option.values.some((value) => value.name === name)) {
        option.values.push({ name });
        changed = true;
      }
    }
  }

  return { options, changed };
}

export function toPrice(value?: string): number | null {
  const price = Number.parseFloat(String(value));
  return Number.isFinite(price) ? price : null;
}

/** The most common retail price, so only the odd sizes carry their own price. */
export function basePrice(variants: SyncVariant[]): number | null {
  const counts = new Map<number, number>();

  for (const variant of variants) {
    const price = toPrice(variant.retail_price);
    if (price !== null) {
      counts.set(price, (counts.get(price) ?? 0) + 1);
    }
  }

  let best: number | null = null;

  for (const [price, count] of counts) {
    const bestCount = best === null ? 0 : (counts.get(best) as number);
    if (count > bestCount || (count === bestCount && price < (best as number))) {
      best = price;
    }
  }

  return best;
}

/** Printful's mockups, one per color. Linked, not copied — they stay on Printful's CDN. */
export function mockupImages(detail: SyncProductDetail): string[] {
  const urls: string[] = [];

  for (const variant of detail.sync_variants ?? []) {
    for (const file of variant.files ?? []) {
      if (file.type === "preview" && file.preview_url) {
        urls.push(file.preview_url);
      }
    }
  }

  if (urls.length === 0 && detail.sync_product.thumbnail_url) {
    urls.push(detail.sync_product.thumbnail_url);
  }

  return [...new Set(urls)].slice(0, MAX_IMAGES);
}

export interface VariantPlan {
  variantUpdates: Array<{
    id: string;
    active?: boolean;
    price?: number;
    sku?: string;
  }>;
  linkUpserts: Array<{ id?: string; variant: SyncVariant; variantId: string }>;
  linkDeletes: string[];
  unmatched: SyncVariant[];
}

/**
 * Decides every write for one product. Printful owns which variants exist;
 * Swell owns names, prices and photos once a variant is linked, so an existing
 * link is never re-priced or re-activated. Only a variant that is linked for
 * the first time is switched on and given its Printful price and SKU.
 */
export function planVariants(input: {
  dims: Dimension[];
  printful: SyncVariant[];
  options: SwellOption[];
  variants: SwellVariant[];
  links: LinkRow[];
  productPrice: number | null;
}): VariantPlan {
  const valueNames = new Map<string, { option: string; value: string }>();

  for (const option of input.options) {
    for (const value of option.values ?? []) {
      if (value.id) {
        valueNames.set(String(value.id), {
          option: option.name,
          value: value.name,
        });
      }
    }
  }

  const swellByKey = new Map<string, SwellVariant>();

  for (const variant of input.variants) {
    const names = (variant.option_value_ids ?? [])
      .map((id) => valueNames.get(String(id)))
      .filter(Boolean) as Array<{ option: string; value: string }>;

    const values = input.dims.map(
      (dim) => names.find((name) => name.option === dim.name)?.value,
    );

    if (values.every(Boolean)) {
      swellByKey.set(values.join("\u0000"), variant);
    }
  }

  const linkBySync = new Map(
    input.links.map((link) => [Number(link.sync_variant_id), link]),
  );

  const updates = new Map<string, VariantPlan["variantUpdates"][number]>();
  const update = (id: string, values: object) =>
    updates.set(id, { ...updates.get(id), id, ...values });

  const plan: VariantPlan = {
    variantUpdates: [],
    linkUpserts: [],
    linkDeletes: [],
    unmatched: [],
  };

  const linkedVariantIds = new Set<string>();
  const seenSync = new Set<number>();

  for (const variant of input.printful) {
    const key = keyOf(input.dims, variant);
    const swell = key ? swellByKey.get(key) : undefined;

    if (!swell) {
      plan.unmatched.push(variant);
      continue;
    }

    const link = linkBySync.get(Number(variant.id));

    if (!link || String(link.variant_id) !== String(swell.id)) {
      const price = toPrice(variant.retail_price);
      const values = {
        ...(swell.active === false ? { active: true } : {}),
        ...(variant.sku ? { sku: variant.sku } : {}),
        ...(price !== null && price !== input.productPrice ? { price } : {}),
      };

      if (Object.keys(values).length > 0) {
        update(swell.id, values);
      }
    }

    plan.linkUpserts.push({ id: link?.id, variant, variantId: swell.id });
    linkedVariantIds.add(String(swell.id));
    seenSync.add(Number(variant.id));
  }

  for (const link of input.links) {
    if (!seenSync.has(Number(link.sync_variant_id)) && link.id) {
      plan.linkDeletes.push(link.id);
    }
  }

  // A Swell variant with no Printful variant behind it cannot be fulfilled:
  // a combination Printful does not make, or one whose Printful variant was
  // removed or discontinued.
  for (const variant of input.variants) {
    if (!linkedVariantIds.has(String(variant.id)) && variant.active !== false) {
      update(variant.id, { active: false });
    }
  }

  plan.variantUpdates = [...updates.values()];

  return plan;
}

interface Budget {
  used: number;
  limit: number;
  deadline: number;
}

function hasBudget(budget: Budget, cost = 1): boolean {
  return budget.used + cost <= budget.limit && Date.now() < budget.deadline;
}

export interface SwellProductState {
  id: string;
  price?: number | null;
  options?: SwellOption[];
  sync_variant_count?: number;
  date_synced?: string;
}

async function listSyncProducts(printful: Printful, budget: Budget) {
  const products: SyncProductSummary[] = [];

  for (let offset = 0; ; offset += LIST_PAGE) {
    if (!hasBudget(budget, 2)) {
      return { products, complete: false };
    }

    budget.used++;
    const result = await printful.listSyncProducts(LIST_PAGE, offset);
    const page: SyncProductSummary[] = Array.isArray(result?.result)
      ? result.result
      : [];

    products.push(...page);

    const total = Number(result?.paging?.total);

    if (
      page.length < LIST_PAGE ||
      (Number.isFinite(total) && products.length >= total)
    ) {
      return { products, complete: true };
    }
  }
}

/** A Swell product's link to Printful, read off its app values. */
function productState(req: SwellRequest, product: any) {
  const values = product.$app?.[req.appId as string] ?? {};

  return {
    syncProductId: Number(values.sync_product_id) || undefined,
    state: {
      id: product.id,
      price: product.price,
      options: product.options,
      sync_variant_count: values.sync_variant_count,
      date_synced: values.date_synced,
    } as SwellProductState,
  };
}

/** Swell products already created from Printful, keyed by Printful product id. */
async function getLinkedProducts(
  req: SwellRequest,
  syncProductIds: number[],
): Promise<Map<number, SwellProductState>> {
  const linked = new Map<number, SwellProductState>();

  for (let i = 0; i < syncProductIds.length; i += 100) {
    const ids = syncProductIds.slice(i, i + 100);

    const result = await req.swell.get("/products", {
      [`$app.${req.appId}.sync_product_id`]: { $in: ids },
      limit: ids.length,
    });

    for (const product of result?.results ?? []) {
      const { syncProductId, state } = productState(req, product);

      if (syncProductId) {
        linked.set(syncProductId, state);
      }
    }
  }

  return linked;
}

/**
 * New products first, then changed ones, then the stalest few. `due` counts
 * the new and changed ones: the run is only complete once it reached them all.
 */
export function prioritize(
  products: SyncProductSummary[],
  state: Map<number, { sync_variant_count?: number; date_synced?: string }>,
): { queue: SyncProductSummary[]; due: number } {
  const fresh: SyncProductSummary[] = [];
  const changed: SyncProductSummary[] = [];
  const unchanged: SyncProductSummary[] = [];

  for (const product of products) {
    const existing = state.get(Number(product.id));

    if (!existing) {
      fresh.push(product);
    } else if (existing.sync_variant_count !== product.variants) {
      changed.push(product);
    } else {
      unchanged.push(product);
    }
  }

  const syncedAt = (product: SyncProductSummary) =>
    String(state.get(Number(product.id))?.date_synced ?? "");

  unchanged.sort((a, b) => syncedAt(a).localeCompare(syncedAt(b)));

  return {
    queue: [...fresh, ...changed, ...unchanged.slice(0, REFRESH_PER_RUN)],
    due: fresh.length + changed.length,
  };
}

/** Printful's catalog descriptions are plain text; Swell renders HTML. */
function toHtml(text: string): string {
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  return text
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escape(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

async function catalogDescription(
  printful: Printful,
  budget: Budget,
  catalogProductId?: number,
): Promise<string | undefined> {
  if (!catalogProductId || !hasBudget(budget)) {
    return undefined;
  }

  budget.used++;

  try {
    const product = await printful.getCatalogProduct(catalogProductId);
    return product?.description ? toHtml(product.description) : undefined;
  } catch {
    // A description is a convenience; the product is created without one.
    return undefined;
  }
}

async function getLinks(req: SwellRequest, where: object) {
  const result = await req.swell.get(`/apps/${req.appId}/sync-variants`, {
    ...where,
    limit: MAX_ROWS,
  });

  return result?.results ?? [];
}

interface LinkOp {
  method: "post" | "put" | "delete";
  url: string;
  data?: object;
}

/**
 * Writes link changes one call at a time. A run cut off partway leaves some
 * of them written; the next run reads the links again before writing, so it
 * picks up where this one stopped instead of repeating it.
 */
async function runOps(req: SwellRequest, ops: LinkOp[]) {
  for (const op of ops) {
    await req.swell[op.method](op.url, op.data);
  }
}

/**
 * Takes a product off sale when it is gone from Printful or has nothing left
 * Printful can print. The product itself is kept for order history.
 */
async function retireProduct(req: SwellRequest, productId: string, links: any[]) {
  const collection = `/apps/${req.appId}/sync-variants`;

  // The merchant may have deleted the product in Swell already; its links
  // still have to go, or every run would retire it again.
  if (await req.swell.get(`/products/${productId}`, { fields: ["id"] })) {
    await req.swell.put(`/products/${productId}`, { active: false });
  }

  await runOps(
    req,
    links.map((link) => ({
      method: "delete" as const,
      url: `${collection}/${link.id}`,
    })),
  );
}

async function syncProduct(
  req: SwellRequest,
  printful: Printful,
  budget: Budget,
  summary: SyncProductSummary,
  existing: SwellProductState | undefined,
  options: { replaceImages?: boolean } = {},
): Promise<"created" | "updated" | "retired" | "skipped"> {
  budget.used++;
  let detail: SyncProductDetail | null;

  try {
    detail = await printful.getSyncProduct(summary.id);
  } catch (err) {
    // Deleted in Printful since it was listed, or since a resync was asked for
    if (err instanceof PrintfulError && err.status === 404) {
      detail = null;
    } else {
      throw err;
    }
  }

  const syncProductId = Number(summary.id);
  const variants = sellable(detail?.sync_variants ?? []);
  const collection = `/apps/${req.appId}/sync-variants`;

  if (!detail || variants.length === 0) {
    if (!existing) {
      return "skipped";
    }

    await retireProduct(
      req,
      existing.id,
      await getLinks(req, { sync_product_id: syncProductId }),
    );
    return "retired";
  }

  let product: any = existing;
  let dims: Dimension[];

  if (!product) {
    dims = chooseDimensions(variants);

    // A manual run can overlap the cron. Re-checking right before the create
    // narrows the window in which both create the same product.
    const [description, again] = await Promise.all([
      catalogDescription(printful, budget, variants[0]?.product?.product_id),
      getLinkedProducts(req, [syncProductId]),
    ]);

    if (again.has(syncProductId)) {
      return "skipped";
    }

    // Created as a draft, so the merchant can review the name, description and
    // prices before it goes on sale.
    product = await req.swell.post("/products", {
      name: detail.sync_product.name,
      active: false,
      price: basePrice(variants) ?? undefined,
      description,
      stock_tracking: false,
      options: dims.map((dim) => ({
        name: dim.name,
        variant: true,
        values: valuesOf(dim, variants).map((name) => ({ name })),
      })),
      images: mockupImages(detail).map((url) => ({ file: { url } })),
      ...req.appValues({ sync_product_id: syncProductId }),
    });
  } else {
    dims = dimensionsFromOptions(product.options);

    if (dims.length === 0) {
      throw new Error(
        "its Color, Size or Variant option was renamed or removed in Swell, so its variants can't be matched",
      );
    }

    const merged = mergeOptions(product.options, dims, variants);

    if (merged.changed) {
      product = await req.swell.put(`/products/${product.id}`, {
        options: merged.options,
      });
    }
  }

  // A product created a moment ago has no links yet.
  const [swellVariants, links] = await Promise.all([
    req.swell.get(`/products/${product.id}/variants`, {
      archived: { $ne: true },
      limit: MAX_ROWS,
    }),
    existing ? getLinks(req, { sync_product_id: syncProductId }) : [],
  ]);

  const plan = planVariants({
    dims,
    printful: variants,
    options: product.options ?? [],
    variants: swellVariants?.results ?? [],
    links,
    productPrice: product.price ?? null,
  });

  // Before the links: a variant is only set up (price, SKU, switched on) while
  // it is still unlinked, so a run cut off after linking must not have skipped
  // this.
  if (plan.variantUpdates.length > 0) {
    await req.swell.put(`/products/${product.id}`, {
      variants: plan.variantUpdates,
    });
  }

  const date_synced = new Date().toISOString();

  await runOps(req, [
    ...plan.linkUpserts.map(({ id, variant, variantId }) => {
      const data = {
        sync_variant_id: Number(variant.id),
        sync_product_id: syncProductId,
        catalog_variant_id: Number(variant.variant_id),
        product_id: product.id,
        variant_id: variantId,
        name: variant.name,
        size: variant.size,
        color: variant.color,
        sku: variant.sku,
        date_synced,
      };

      return id
        ? { method: "put" as const, url: `${collection}/${id}`, data }
        : { method: "post" as const, url: collection, data };
    }),
    ...plan.linkDeletes.map((id) => ({
      method: "delete" as const,
      url: `${collection}/${id}`,
    })),
  ]);

  // Only when the merchant asks for it: after the first sync the photos are
  // theirs. `$set` replaces them; a plain array write merges by position.
  const mockups = mockupImages(detail);

  if (options.replaceImages && existing && mockups.length > 0) {
    await req.swell.put(`/products/${product.id}`, {
      $set: { images: mockups.map((url) => ({ file: { url } })) },
    });
  }

  // Written last: a run cut off before this point leaves the count unset, so
  // the next run treats the product as changed and finishes it. A resync has
  // no list entry to count from, so it counts the variants it just read.
  // The Printful id goes with them: an app's write of its values can replace
  // the ones it wrote before, and the next run finds the product by that id.
  await req.swell.put(
    `/products/${product.id}`,
    req.appValues({
      sync_product_id: syncProductId,
      sync_variant_count: summary.variants ?? detail.sync_variants.length,
      date_synced,
    }),
  );

  if (plan.unmatched.length > 0) {
    throw new Error(
      `${plan.unmatched.length} variant(s) could not be matched to a Swell variant`,
    );
  }

  return existing ? "updated" : "created";
}

/** Products that disappeared from Printful, found through their links. */
async function retireMissing(req: SwellRequest, listed: Set<number>) {
  const rows = await getLinks(req, {
    sync_product_id: { $nin: [...listed] },
  });

  const byProduct = new Map<string, any[]>();

  for (const row of rows) {
    byProduct.set(String(row.product_id), [
      ...(byProduct.get(String(row.product_id)) ?? []),
      row,
    ]);
  }

  for (const [productId, links] of byProduct) {
    await retireProduct(req, productId, links);
  }

  return byProduct.size;
}

export interface SyncResult {
  products: number;
  created: number;
  updated: number;
  retired: number;
  requests_used: number;
  complete: boolean;
  /** False when the Printful product list could not be read at all */
  listed: boolean;
  summary: string;
  errors: string[];
}

type SyncTally = Omit<SyncResult, "summary" | "requests_used">;

function summarize(result: SyncTally): string {
  if (!result.listed) {
    return `Could not read your Printful products: ${result.errors.join("; ")}`.slice(
      0,
      1000,
    );
  }

  const parts = [
    `${result.products} Printful products: ${result.created} created, ` +
      `${result.updated} updated, ${result.retired} taken off sale.`,
  ];

  if (!result.complete) {
    parts.push("More to sync; the next run continues.");
  }

  if (result.errors.length > 0) {
    parts.push(`Errors: ${result.errors.join("; ")}`);
  }

  return parts.join(" ").slice(0, 1000);
}

/** Shows what a sync did in the app settings, and returns that summary. */
export async function recordSyncResult(
  req: SwellRequest,
  result: SyncTally,
): Promise<string> {
  const summary = summarize(result);

  await putSettings(req, {
    last_sync_at: new Date().toISOString(),
    last_sync_result: summary,
  });

  return summary;
}

// A workflow step has minutes rather than seconds, and Printful's rate limit
// is handled by retrying the step, so a workflow sync runs without a budget.
function unlimited(): Budget {
  return { used: 0, limit: Infinity, deadline: Infinity };
}

export interface PlannedProduct {
  summary: SyncProductSummary;
  existing?: SwellProductState;
}

/**
 * The whole Printful listing and the products to sync from it, new and
 * changed ones first. Plain data, so a workflow step can record it.
 */
export async function planSync(
  req: SwellRequest,
  settings: PrintfulSettings,
): Promise<{ listed: number[]; queue: PlannedProduct[] }> {
  const printful = new Printful(settings.api_token as string);
  const { products: listing } = await listSyncProducts(printful, unlimited());
  const products = listing.filter((product) => !product.is_ignored);
  const state = await getLinkedProducts(
    req,
    products.map((product) => Number(product.id)),
  );

  return {
    listed: products.map((product) => Number(product.id)),
    queue: prioritize(products, state).queue.map((product) => ({
      summary: { id: product.id, name: product.name, variants: product.variants },
      existing: state.get(Number(product.id)),
    })),
  };
}

/** Syncs one planned product; see `planSync`. */
export function syncOne(
  req: SwellRequest,
  settings: PrintfulSettings,
  product: PlannedProduct,
) {
  return syncProduct(
    req,
    new Printful(settings.api_token as string),
    unlimited(),
    product.summary,
    product.existing,
  );
}

/** Takes products gone from a complete Printful listing off sale. */
export function retireRemoved(req: SwellRequest, listed: number[]) {
  return retireMissing(req, new Set(listed));
}

/**
 * Creates and updates Swell products from the products designed in Printful.
 * Each run spends at most `budget` Printful calls and a few seconds, handling
 * new products first; whatever it does not reach is picked up by the next run.
 */
export async function runProductSync(
  req: SwellRequest,
  settings: PrintfulSettings,
  options: { budget?: number } = {},
): Promise<SyncResult> {
  const printful = new Printful(settings.api_token as string);

  const budget: Budget = {
    used: 0,
    limit: options.budget ?? DEFAULT_REQUEST_BUDGET,
    deadline: Date.now() + TIME_BUDGET_MS,
  };

  const result: SyncResult = {
    products: 0,
    created: 0,
    updated: 0,
    retired: 0,
    requests_used: 0,
    complete: false,
    listed: false,
    summary: "",
    errors: [],
  };

  try {
    const listing = await listSyncProducts(printful, budget);
    result.listed = true;
    const products = listing.products.filter((product) => !product.is_ignored);
    const state = await getLinkedProducts(
      req,
      products.map((product) => Number(product.id)),
    );

    result.products = products.length;

    const { queue, due } = prioritize(products, state);
    let reached = 0;

    for (const product of queue) {
      if (!hasBudget(budget)) {
        break;
      }

      reached++;

      try {
        const outcome = await syncProduct(
          req,
          printful,
          budget,
          product,
          state.get(Number(product.id)),
        );

        if (outcome === "created") result.created++;
        if (outcome === "updated") result.updated++;
        if (outcome === "retired") result.retired++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result.errors.push(`${product.name ?? product.id}: ${message}`);
      }
    }

    // Retiring needs the whole list: a product missing from a partial listing
    // is not gone, just not read yet.
    if (listing.complete) {
      result.retired += await retireMissing(
        req,
        new Set(products.map((product) => Number(product.id))),
      );
    }

    result.complete = listing.complete && reached >= due;
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : String(err));
  }

  result.requests_used = budget.used;
  result.summary = await recordSyncResult(req, result);

  return result;
}

export interface ResyncResult {
  resynced: number;
  retired: number;
  /** Printful products the time budget did not reach */
  remaining: number;
  /** Selected products that were not synced from Printful */
  skipped: number;
  errors: string[];
}

/**
 * Re-reads the given Swell products from Printful now, whether or not
 * Printful's list shows a change. Oldest-synced first, so running it again on
 * the same products continues where the time budget stopped it.
 */
export async function resyncProducts(
  req: SwellRequest,
  settings: PrintfulSettings,
  products: any[],
  options: { replaceImages?: boolean } = {},
): Promise<ResyncResult> {
  const printful = new Printful(settings.api_token as string);

  const budget: Budget = {
    used: 0,
    limit: DEFAULT_REQUEST_BUDGET,
    deadline: Date.now() + TIME_BUDGET_MS,
  };

  const linked = products
    .map((product) => ({ product, ...productState(req, product) }))
    .filter(({ syncProductId }) => syncProductId)
    .sort((a, b) =>
      String(a.state.date_synced ?? "").localeCompare(
        String(b.state.date_synced ?? ""),
      ),
    );

  const result: ResyncResult = {
    resynced: 0,
    retired: 0,
    remaining: 0,
    skipped: products.length - linked.length,
    errors: [],
  };

  for (const { product, syncProductId, state } of linked) {
    if (!hasBudget(budget)) {
      result.remaining++;
      continue;
    }

    try {
      const outcome = await syncProduct(
        req,
        printful,
        budget,
        { id: syncProductId as number, name: product.name },
        state,
        options,
      );

      if (outcome === "retired") {
        result.retired++;
      } else {
        result.resynced++;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`${product.name ?? product.id}: ${message}`);
    }
  }

  return result;
}
