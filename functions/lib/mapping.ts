// Placement used when a product configures a single print file without saying
// where it goes. Printful requires a placement id on every layer.
const DEFAULT_PLACEMENT = "front";

export interface SwellItem {
  id?: string;
  product_id?: string;
  variant_id?: string;
  quantity?: number;
  product?: {
    $app?: { printful?: PrintfulProductConfig };
  };
}

export interface PrintfulProductConfig {
  technique?: string;
  artwork_url?: string;
  artwork_hash?: string;
  placements?: Array<{
    placement?: string;
    technique?: string;
    artwork_url?: string;
    artwork_hash?: string;
  }>;
}

export interface CatalogItem {
  id: string;
  variant_id: string;
  catalog_variant_id: number;
  catalog_product_id?: number;
}

export interface RateItem {
  source: "catalog";
  catalog_variant_id: number;
  quantity: number;
}

/** Catalog rows for the variants in a cart, keyed by Swell variant id. */
export async function getCatalogItems(
  req: SwellRequest,
  items: SwellItem[],
): Promise<Map<string, CatalogItem>> {
  const variantIds = [
    ...new Set(items.map((item) => item.variant_id).filter(Boolean)),
  ];

  if (variantIds.length === 0) {
    return new Map();
  }

  const result = await req.swell.get(`/apps/${req.appId}/catalog-items`, {
    variant_id: { $in: variantIds },
    limit: variantIds.length,
    fields: ["variant_id", "catalog_variant_id", "catalog_product_id"],
  });

  return new Map(
    (result?.results ?? []).map((row: CatalogItem) => [
      String(row.variant_id),
      row,
    ]),
  );
}

export function toRateItems(
  items: SwellItem[],
  catalog: Map<string, CatalogItem>,
): RateItem[] {
  const rateItems: RateItem[] = [];

  for (const item of items) {
    const catalogItem = catalog.get(String(item.variant_id));

    if (catalogItem) {
      rateItems.push({
        source: "catalog",
        catalog_variant_id: catalogItem.catalog_variant_id,
        quantity: item.quantity || 1,
      });
    }
  }

  return rateItems;
}

/**
 * Printful caches print files by URL and serves the cached copy without
 * refetching, so a URL whose contents changed prints the old design. Carrying
 * the content hash in the URL is what forces a refetch.
 */
function artworkUrl(url?: string, hash?: string): string | null {
  if (!url) {
    return null;
  }

  if (!hash || url.includes(hash)) {
    return url;
  }

  return `${url}${url.includes("?") ? "&" : "?"}v=${hash}`;
}

/**
 * A placement the merchant listed but gave no print file to is a configuration
 * error, not a placement to leave out. Dropping it still produces a non-empty
 * placements array, so it clears the zero-placement guard and Printful prints
 * and charges for a garment missing that print. Report it instead.
 *
 * Only explicitly listed placements are reported. A product with no placements
 * and no artwork at all resolves to zero placements, which the caller already
 * reports as an unconfigured product.
 */
function toPlacements(config: PrintfulProductConfig, missing: string[]) {
  const explicit = Boolean(config.placements?.length);

  const configured = config.placements?.length
    ? config.placements
    : [
        {
          placement: DEFAULT_PLACEMENT,
          technique: config.technique,
          artwork_url: config.artwork_url,
          artwork_hash: config.artwork_hash,
        },
      ];

  const placements = [];

  for (const entry of configured) {
    const placement = entry.placement || DEFAULT_PLACEMENT;
    const url = artworkUrl(entry.artwork_url, entry.artwork_hash);

    if (!url) {
      if (explicit) {
        missing.push(placement);
      }
      continue;
    }

    placements.push({
      placement,
      technique: entry.technique || config.technique,
      layers: [{ type: "file", url }],
    });
  }

  return placements;
}

/** A placement listed on a product with no print file behind it. */
export interface MissingArtwork {
  external_id?: string;
  placement: string;
}

/**
 * Order items for `POST /v2/orders`. `external_id` is the Swell order item id,
 * which is what makes shipment items matchable back to Swell line items later.
 * Items require `product` expanded to read their print configuration.
 *
 * `missingArtwork` is returned alongside rather than thrown: it is a merchant
 * configuration error, and the caller reports it on the job instead of retrying.
 */
export function toOrderItems(
  items: SwellItem[],
  catalog: Map<string, CatalogItem>,
) {
  const orderItems = [];
  const missingArtwork: MissingArtwork[] = [];

  for (const item of items) {
    const catalogItem = catalog.get(String(item.variant_id));

    if (!catalogItem) {
      continue;
    }

    const config = item.product?.$app?.printful ?? {};
    const missing: string[] = [];

    orderItems.push({
      source: "catalog",
      catalog_variant_id: catalogItem.catalog_variant_id,
      quantity: item.quantity || 1,
      external_id: item.id,
      placements: toPlacements(config, missing),
    });

    for (const placement of missing) {
      missingArtwork.push({ external_id: item.id, placement });
    }
  }

  return { orderItems, missingArtwork };
}

/** Undefined keys drop out of the JSON body, so this shape serves both the
 * quote request (which only needs the destination) and order creation. */
export function toRecipient(shipping: Record<string, any> = {}, email?: string) {
  return {
    name: shipping.name,
    address1: shipping.address1,
    address2: shipping.address2,
    city: shipping.city,
    state_code: shipping.state,
    country_code: shipping.country,
    zip: shipping.zip,
    phone: shipping.phone,
    email,
  };
}
