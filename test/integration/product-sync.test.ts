import { describe, it, expect, vi, afterAll } from "vitest";
import { env } from "cloudflare:test";
import { createMockRequest } from "../helpers/mock-request";
import { createSwellClient } from "../helpers/swell-client";
import { runProductSync } from "../../functions/lib/products";
import ResyncProducts from "../../functions/resync-products";

// Runs the real sync against the Swell test environment of the logged-in store,
// with Printful answered from fixtures. It creates one draft product and
// deletes it again at the end.
const PRINTFUL = "https://api.printful.com";
const SYNC_PRODUCT_ID = 900000000 + (Date.now() % 1000000);
const NAME = `zz Printful sync test ${SYNC_PRODUCT_ID}`;

function syncVariant(id: number, color: string, size: string, price = "25.00") {
  return {
    id: SYNC_PRODUCT_ID * 10 + id,
    name: `${NAME} / ${color} / ${size}`,
    variant_id: 4000 + id,
    retail_price: price,
    currency: "USD",
    sku: `TEE-${color}-${size}`,
    color,
    size,
    product: { product_id: 71 },
    files: [
      {
        type: "preview",
        preview_url: `https://files.cdn.printful.com/files/test/${color}.png`,
      },
    ],
  };
}

let printfulVariants = [
  syncVariant(1, "Black", "S"),
  syncVariant(2, "Black", "M"),
  syncVariant(3, "Black", "2XL", "27.00"),
  syncVariant(4, "White", "S"),
  syncVariant(5, "White", "M"),
];
let listed = true;

function json(body: object) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function mockPrintful() {
  const realFetch = globalThis.fetch.bind(globalThis);

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);

    if (!url.startsWith(PRINTFUL)) {
      return realFetch(input, init);
    }

    if (url.startsWith(`${PRINTFUL}/store/products?`)) {
      const result = listed
        ? [{ id: SYNC_PRODUCT_ID, name: NAME, variants: printfulVariants.length }]
        : [];
      return json({
        code: 200,
        result,
        paging: { total: result.length, offset: 0, limit: 100 },
      });
    }

    if (url === `${PRINTFUL}/store/products/${SYNC_PRODUCT_ID}`) {
      return json({
        code: 200,
        result: {
          sync_product: { id: SYNC_PRODUCT_ID, name: NAME },
          sync_variants: printfulVariants,
        },
      });
    }

    if (url === `${PRINTFUL}/v2/catalog-products/71`) {
      return json({ data: { id: 71, description: "Soft tee.\n\n• 100% cotton" } });
    }

    throw new Error(`unexpected Printful call: ${url}`);
  });
}

const available = Boolean(env.SWELL_SESSION_ID);

/**
 * The suite runs the real sync against the logged-in store, and a sync takes
 * every product its (faked) Printful listing lacks off sale. So it only runs
 * on a store with nothing synced from Printful except what an earlier run of
 * this suite left behind.
 */
async function syncedFromPrintful(): Promise<string | undefined> {
  const req = createMockRequest({ useRealSwell: true });
  const theirs = (rows: any) =>
    (rows?.results ?? []).filter((row: any) => !String(row.name).startsWith("zz Printful sync test"))
      .length;

  const [products, links] = await Promise.all([
    req.swell.get("/products", {
      [`$app.${req.appId}.sync_product_id`]: { $exists: true },
      fields: ["name"],
      limit: 100,
    }),
    req.swell.get(`/apps/${req.appId}/sync-variants`, { fields: ["name"], limit: 100 }),
  ]);

  if (theirs(products) > 0 || theirs(links) > 0) {
    return (
      `the store has ${theirs(products)} products and ${theirs(links)} variant links ` +
      "synced from Printful, which these tests would take off sale; " +
      "run them against a store with nothing synced from Printful"
    );
  }
}

const synced = available ? await syncedFromPrintful() : undefined;
const suite = synced
  ? `product sync against Swell (skipped: ${synced})`
  : "product sync against Swell";

// Every step makes real Swell API calls; a run that outlives vitest's default
// timeout keeps going in the background and races the next test.
describe.skipIf(!available || Boolean(synced))(suite, { timeout: 60000 }, () => {
  const req = createMockRequest({ useRealSwell: true });
  const settings = { api_token: "test-token" };
  let productId: string | undefined;

  const links = async () =>
    (
      await req.swell.get(`/apps/${req.appId}/sync-variants`, {
        sync_product_id: SYNC_PRODUCT_ID,
        limit: 100,
      })
    )?.results ?? [];

  const variantsByName = async () => {
    const result = await req.swell.get(`/products/${productId}/variants`, {
      limit: 100,
    });
    return new Map<string, any>(
      (result?.results ?? []).map((v: any) => [v.name, v]),
    );
  };

  const swell = createSwellClient();

  // Runs the bulk resync workflow against the store, every step straight away.
  // The test store has no Printful token, so the app settings, and the sync
  // lease kept in them, are held here rather than in the store.
  const run = (data: object) => {
    const stored: Record<string, any> = { ...settings };
    const isSettings = (url: string) => url.startsWith("/settings/");

    return new ResyncProducts().run(
      {
        id: "test",
        appId: req.appId,
        store: req.store,
        data,
        workflow: { workflow_instance_id: "test-run" },
        isLocalDev: false,
        swell: {
          ...swell,
          get: (url: string, query?: any) =>
            isSettings(url) ? Promise.resolve({ ...stored }) : swell.get(url, query),
          put: (url: string, values: any) =>
            isSettings(url) ? Promise.resolve(Object.assign(stored, values)) : swell.put(url, values),
          settings: async () => ({ printful: { ...stored } }),
        },
      } as unknown as SwellWorkflowRequest,
      {
        do: async (_name: string, optionsOrFn: any, maybeFn?: any) =>
          (maybeFn ?? optionsOrFn)(),
        sleep: async () => undefined,
        sleepUntil: async () => undefined,
      } as unknown as SwellWorkflowStep,
    );
  };

  afterAll(async () => {
    vi.restoreAllMocks();

    for (const link of await links()) {
      await req.swell.delete(`/apps/${req.appId}/sync-variants/${link.id}`);
    }

    if (productId) {
      await req.swell.delete(`/products/${productId}`);
    }
  });

  it("creates a draft product with Printful's variants, prices and mockups", async () => {
    mockPrintful();

    const result = await runProductSync(req, settings);

    expect(result.errors).toEqual([]);
    expect(result.created).toBe(1);

    const found = await req.swell.get("/products", {
      [`$app.${req.appId}.sync_product_id`]: SYNC_PRODUCT_ID,
    });
    const product = found?.results?.[0];
    productId = product?.id;

    expect(product).toMatchObject({ name: NAME, active: false, price: 25 });
    expect(product.options.map((o: any) => o.name)).toEqual(["Color", "Size"]);
    expect(product.images.map((i: any) => i.file.url)).toEqual([
      "https://files.cdn.printful.com/files/test/Black.png",
      "https://files.cdn.printful.com/files/test/White.png",
    ]);
    expect(product.description).toContain("<p>Soft tee.</p>");
    expect(product.$app[req.appId].sync_variant_count).toBe(5);

    const variants = await variantsByName();

    expect(variants.size).toBe(6);
    expect(variants.get("White, 2XL")?.active).toBe(false);
    expect(variants.get("Black, 2XL")?.price).toBe(27);
    expect(variants.get("Black, S")).toMatchObject({ active: true, sku: "TEE-Black-S" });

    const rows = await links();
    expect(rows).toHaveLength(5);
    expect(
      rows.every((row: any) => [...variants.values()].some((v) => v.id === row.variant_id)),
    ).toBe(true);
  });

  it("resyncs selected products, replacing photos only when asked", async () => {
    // Two rows checked in an unfiltered list, as the admin sends them: the
    // list's own query, narrowed to the checked rows by a top-level $and.
    // One of the two is not a Printful product.
    const selection = {
      all: false,
      ids: [productId, "000000000000000000000000"],
      count: 2,
      query: {
        where: {},
        $and: [{ id: { $in: [productId, "000000000000000000000000"] } }],
      },
    };
    const photos = async () =>
      ((await req.swell.get(`/products/${productId}`))?.images ?? []).map(
        (image: any) => image.file.url,
      );

    await req.swell.put(`/products/${productId}`, {
      $set: { images: [{ file: { url: "https://cdn.example.com/merchant.jpg" } }] },
    });

    await expect(
      run({ $action: { id: "resync_selected", source: "bulk", selection } }),
    ).resolves.toEqual({
      message:
        "Resynced 1 product from Printful. 1 product not from Printful, skipped.",
    });
    expect(await photos()).toEqual(["https://cdn.example.com/merchant.jpg"]);

    await run({
      replace_images: true,
      $action: { id: "resync_selected", source: "bulk", selection },
    });
    expect(await photos()).toEqual([
      "https://files.cdn.printful.com/files/test/Black.png",
      "https://files.cdn.printful.com/files/test/White.png",
    ]);
  });

  it("resyncs every row of a select-all selection except the unchecked ones", async () => {
    // Select all in a list filtered to the test product. The admin adds an
    // id condition only when rows were unchecked after selecting all.
    const selectAll = (exceptIds: string[]) => ({
      all: true,
      count: 1 - exceptIds.length,
      except_ids: exceptIds,
      query: {
        where: { name: NAME },
        ...(exceptIds.length > 0 && { $and: [{ id: { $nin: exceptIds } }] }),
      },
    });

    await expect(
      run({ $action: { id: "resync_selected", source: "bulk", selection: selectAll([]) } }),
    ).resolves.toEqual({ message: "Resynced 1 product from Printful." });

    await expect(
      run({
        $action: {
          id: "resync_selected",
          source: "bulk",
          selection: selectAll([productId as string]),
        },
      }),
    ).rejects.toThrow("None of these products came from Printful.");
  });

  it("takes a variant removed in Printful off sale", async () => {
    printfulVariants = printfulVariants.filter((v) => v.color !== "White" || v.size !== "M");

    const result = await runProductSync(req, settings);

    expect(result.errors).toEqual([]);
    expect(result.updated).toBe(1);
    expect((await variantsByName()).get("White, M")?.active).toBe(false);
    expect(await links()).toHaveLength(4);
  });

  it("takes a product deleted in Printful off sale", async () => {
    await req.swell.put(`/products/${productId}`, { active: true });
    listed = false;

    const result = await runProductSync(req, settings);

    expect(result.errors).toEqual([]);
    expect(result.retired).toBe(1);
    expect((await req.swell.get(`/products/${productId}`))?.active).toBe(false);
    expect(await links()).toHaveLength(0);
  });
});
