import { getSettings } from "./lib/settings";
import { resyncProducts, ResyncResult } from "./lib/products";

// A run reaches only a few products before its time budget, so only the
// oldest-synced few are read; running it again continues with the next.
const BATCH = 10;

export const config: SwellConfig = {
  description: "Resync products from Printful from an action in the Swell admin",
  action: {},
};

/**
 * The products an action ran on: the Printful products in a bulk selection,
 * oldest-synced first, or the one product a record action ran on.
 */
async function getProducts(req: SwellRequest, action: any) {
  const field = `$app.${req.appId}`;

  if (!action.selection) {
    const product = action.record_id
      ? await req.swell.get(`/products/${action.record_id}`)
      : null;

    return product?.$app?.[req.appId as string]?.sync_product_id
      ? { products: [product], total: 1 }
      : { products: [], total: 0 };
  }

  const { query = {} } = action.selection;

  const result = await req.swell.get("/products", {
    ...query,
    // The selection may hold products that did not come from Printful
    where: {
      $and: [
        ...(query.where ? [query.where] : []),
        { [`${field}.sync_product_id`]: { $ne: null } },
      ],
    },
    sort: `${field}.date_synced asc`,
    limit: BATCH,
  });

  return {
    products: result?.results ?? [],
    total: Number(result?.count) || 0,
  };
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function describe(result: ResyncResult, remaining: number, skipped: number) {
  const parts = [`Resynced ${plural(result.resynced, "product")} from Printful.`];

  if (result.retired > 0) {
    parts.push(
      `${plural(result.retired, "product")} no longer in Printful, taken off sale.`,
    );
  }

  if (remaining > 0) {
    parts.push(`${remaining} more to go; run it again to continue.`);
  }

  if (skipped > 0) {
    parts.push(`${plural(skipped, "product")} not from Printful, skipped.`);
  }

  if (result.errors.length > 0) {
    parts.push(`Errors: ${result.errors.join("; ")}`);
  }

  return parts.join(" ");
}

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError(
      "Add your Printful API token in the app settings first.",
      { status: 400 },
    );
  }

  const action = req.data.$action ?? {};
  const { products, total } = await getProducts(req, action);

  if (total === 0) {
    throw new SwellError("None of these products came from Printful.", {
      status: 400,
    });
  }

  const result = await resyncProducts(req, settings, products, {
    replaceImages: Boolean(req.data.replace_images),
  });

  const selected = action.selection ? Number(action.selection.count) || total : 1;
  const message = describe(
    result,
    result.remaining + (total - products.length),
    Math.max(0, selected - total) + result.skipped,
  );

  if (result.resynced + result.retired === 0 && result.errors.length > 0) {
    throw new SwellError(message, { status: 400 });
  }

  return { message };
}
