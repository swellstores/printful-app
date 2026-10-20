import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";

vi.mock("../../functions/lib/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/lease")>()),
  takeLease: vi.fn(async () => ({ taken: true })),
  releaseLease: vi.fn(async () => undefined),
}));

import { post as productLink } from "../../functions/product-link";
import {
  normalizeValue,
  parsePrintfulId,
  planLinkedVariants,
  swellIdIn,
  syncOne,
  SyncVariant,
} from "../../functions/lib/products";
import { getVariantLinks, toOrderItems } from "../../functions/lib/mapping";

const PRINTFUL = "https://api.printful.com";
const PRINT_ID = "64b0c0ffee0000000000aaaa";

function size(id: number, value: string, extra: Partial<SyncVariant> = {}): SyncVariant {
  return {
    id,
    variant_id: 3000 + id,
    name: `Sunset Print / ${value}`,
    size: value,
    retail_price: "45.00",
    sku: `PRINT-${id}`,
    ...extra,
  };
}

/** A print the merchant made in Swell, sold in three sizes. */
function merchantPrint() {
  return {
    id: PRINT_ID,
    name: "Sunset Print",
    price: 40,
    options: [
      {
        id: "o1",
        name: "Size",
        variant: true,
        values: [
          { id: "s1", name: "12x16" },
          { id: "s2", name: "18x24" },
          { id: "s3", name: "A3" },
        ],
      },
    ],
    images: [{ file: { url: "https://cdn.example.com/sunset.jpg" } }],
    $app: {} as Record<string, any>,
    variants: [
      { id: "v1", option_value_ids: ["s1"], active: true, price: 40 },
      { id: "v2", option_value_ids: ["s2"], active: true, price: 60 },
      { id: "v3", option_value_ids: ["s3"], active: true, price: 50 },
    ],
  };
}

function matches(row: any, query: Record<string, any>) {
  return Object.entries(query).every(([key, wanted]) => {
    if (["limit", "fields", "sort", "page", "archived"].includes(key)) return true;
    const value = key.startsWith("$app.")
      ? key.split(".").slice(1).reduce((o, k) => o?.[k], row.$app)
      : row[key];
    if (wanted && typeof wanted === "object") {
      if ("$in" in wanted) return wanted.$in.map(String).includes(String(value));
      if ("$nin" in wanted) return !wanted.$nin.map(String).includes(String(value));
    }
    return String(value) === String(wanted);
  });
}

/** Products, variants and links kept in memory, the way the API keeps them. */
function fakeStore(products: any[], links: any[] = []) {
  const posts: Array<{ url: string; data: any }> = [];
  let nextLink = 1;
  const find = (id: string) => products.find((product) => product.id === id);

  const get = vi.fn(async (url: string, query: any = {}) => {
    if (url.startsWith("/settings/")) return { api_token: "token" };

    let m = url.match(/^\/products\/([^/]+)\/variants$/);
    if (m) {
      const variants = find(m[1])?.variants ?? [];
      return { count: variants.length, results: variants };
    }

    m = url.match(/^\/products\/([^/]+)$/);
    if (m) {
      const product = find(m[1]);
      return product ? structuredClone(product) : null;
    }

    if (url === "/products") {
      const results = products.filter((product) => matches(product, query));
      return { count: results.length, results: structuredClone(results) };
    }

    if (url === "/apps/printful/sync-variants") {
      const results = links.filter((link) => matches(link, query));
      return { count: results.length, results: structuredClone(results) };
    }

    throw new Error(`unexpected get: ${url}`);
  });

  const put = vi.fn(async (url: string, data: any) => {
    let m = url.match(/^\/products\/([^/]+)$/);
    if (m) {
      const product = find(m[1]);
      if (data.$app) {
        for (const [app, values] of Object.entries<any>(data.$app)) {
          product.$app[app] = { ...product.$app[app], ...values };
        }
      }
      for (const update of data.variants ?? []) {
        Object.assign(product.variants.find((v: any) => v.id === update.id), update);
      }
      if (data.options) product.options = data.options;
      if (data.active !== undefined) product.active = data.active;
      return structuredClone(product);
    }

    m = url.match(/^\/apps\/printful\/sync-variants\/(.+)$/);
    if (m) {
      Object.assign(links.find((link) => link.id === m![1]), data);
      return {};
    }

    throw new Error(`unexpected put: ${url}`);
  });

  const post = vi.fn(async (url: string, data: any) => {
    posts.push({ url, data });
    if (url === "/apps/printful/sync-variants") {
      const link = { id: `L${nextLink++}`, ...data };
      links.push(link);
      return link;
    }
    throw new Error(`unexpected post: ${url}`);
  });

  const del = vi.fn(async (url: string) => {
    const id = url.split("/").pop();
    links.splice(links.findIndex((link) => link.id === id), 1);
    return {};
  });

  return { swell: { get, put, post, delete: del }, products, links, posts };
}

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Printful answers for one product, 900, and a store listing. */
function mockPrintful(variants: SyncVariant[], listing: object[] = []) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${PRINTFUL}/store/products/900`) {
      return json(200, {
        code: 200,
        result: { sync_product: { id: 900, name: "Sunset Print" }, sync_variants: variants },
      });
    }
    if (url.startsWith(`${PRINTFUL}/store/products/`)) {
      return json(404, { code: 404, result: "Not found" });
    }
    if (url.startsWith(`${PRINTFUL}/store/products?`)) {
      return json(200, { code: 200, result: listing, paging: { total: listing.length } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

function action(id: "link" | "unlink", values: object = {}) {
  return { ...values, $action: { id, source: "record", record_id: PRINT_ID } };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("normalizeValue", () => {
  it("compares sizes across inch marks, the times sign, spacing and case", () => {
    expect(normalizeValue("12″×16″")).toBe("12x16");
    expect(normalizeValue("12 in x 16 in")).toBe("12x16");
    expect(normalizeValue(' 18" x 24" ')).toBe("18x24");
    expect(normalizeValue("A3")).toBe("a3");
  });
});

describe("parsePrintfulId", () => {
  it("reads the id itself or a Printful dashboard link", () => {
    expect(parsePrintfulId("123456789")).toBe(123456789);
    expect(parsePrintfulId("https://www.printful.com/dashboard/sync/update?id=123456789")).toBe(
      123456789,
    );
    expect(parsePrintfulId("sunset print")).toBeNull();
  });
});

describe("swellIdIn", () => {
  it("reads a Swell id bare or after a prefix, and nothing else", () => {
    expect(swellIdIn(PRINT_ID)).toBe(PRINT_ID);
    expect(swellIdIn(`swell:${PRINT_ID}`)).toBe(PRINT_ID);
    expect(swellIdIn("PRINT-12x16")).toBeUndefined();
    expect(swellIdIn(undefined)).toBeUndefined();
  });
});

describe("planLinkedVariants", () => {
  const options = merchantPrint().options;
  const variants = merchantPrint().variants;

  it("links by external id, then by matching values, and changes nothing else", () => {
    const plan = planLinkedVariants({
      printful: [
        size(101, "12″×16″"),
        size(102, "18″×24″"),
        size(103, "11.7″×16.5″", { external_id: "v3" }),
        size(104, "24″×36″"),
      ],
      options,
      variants,
      links: [],
    });

    expect(plan.linkUpserts.map(({ variant, variantId }) => [variant.id, variantId])).toEqual([
      [101, "v1"],
      [102, "v2"],
      [103, "v3"],
    ]);
    expect(plan.unmatched.map((variant) => variant.id)).toEqual([104]);
    // No price, SKU or activation writes, and nothing taken off sale
    expect(plan.variantUpdates).toEqual([]);
    expect(plan.linkDeletes).toEqual([]);
  });

  it("keeps earlier links, and takes a variant off sale only when Printful dropped it", () => {
    const plan = planLinkedVariants({
      printful: [size(101, "12″×16″")],
      options,
      variants,
      links: [
        { id: "L1", sync_variant_id: 101, variant_id: "v1" },
        { id: "L9", sync_variant_id: 109, variant_id: "v2" },
      ],
    });

    expect(plan.linkUpserts).toMatchObject([{ id: "L1", variantId: "v1" }]);
    expect(plan.linkDeletes).toEqual(["L9"]);
    expect(plan.variantUpdates).toEqual([{ id: "v2", active: false }]);
  });

  it("matches the size alone when the Swell product sells one of Printful's colors", () => {
    const plan = planLinkedVariants({
      printful: [size(101, "12″×16″", { color: "Black" })],
      options,
      variants,
      links: [],
    });

    expect(plan.linkUpserts.map(({ variantId }) => variantId)).toEqual(["v1"]);
  });

  it("links a product without variants as a whole", () => {
    const plan = planLinkedVariants({
      printful: [size(101, "12″×16″")],
      options: [],
      variants: [],
      links: [],
    });

    expect(plan.linkUpserts.map(({ variantId }) => variantId)).toEqual([null]);
  });

  it("leaves a Printful variant unmatched when two Swell variants fit it", () => {
    const plan = planLinkedVariants({
      printful: [size(101, "12″×16″")],
      options: [
        ...options,
        { id: "o2", name: "Frame", variant: true, values: [{ id: "f1", name: "Oak" }, { id: "f2", name: "Black" }] },
      ],
      variants: [
        { id: "v1", option_value_ids: ["s1", "f1"] },
        { id: "v1b", option_value_ids: ["s1", "f2"] },
      ],
      links: [],
    });

    expect(plan.unmatched.map((variant) => variant.id)).toEqual([101]);
  });
});

describe("Link to Printful product", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("links by ID or link, keeps the product as it was, and links the variants that match", async () => {
    mockPrintful([size(101, "12″×16″"), size(102, "18″×24″"), size(104, "24″×36″")]);
    const store = fakeStore([merchantPrint()]);
    const req = createMockRequest({
      data: action("link", { printful_product: "https://www.printful.com/dashboard/sync/update?id=900" }),
      swell: store.swell,
    });

    const { message } = await productLink(req);

    expect(message).toBe(
      'Linked to the Printful product "Sunset Print": 2 of 3 variants linked. ' +
        "1 Printful variant matched no Swell variant (24″×36″), so orders for them can't be sent to Printful.",
    );
    const [product] = store.products;
    expect(product.$app.printful).toMatchObject({ sync_product_id: 900, linked: true });
    expect(product.options).toEqual(merchantPrint().options);
    expect(product.images).toEqual(merchantPrint().images);
    expect(product.variants).toEqual(merchantPrint().variants);
    expect(store.links.map((link) => [link.sync_variant_id, link.variant_id])).toEqual([
      [101, "v1"],
      [102, "v2"],
    ]);
  });

  it("finds the Printful product by name when no ID is given", async () => {
    mockPrintful(
      [size(101, "12″×16″")],
      [
        { id: 899, name: "Sunrise Print" },
        { id: 900, name: "sunset print" },
      ],
    );
    const store = fakeStore([merchantPrint()]);

    await productLink(createMockRequest({ data: action("link"), swell: store.swell }));

    expect(store.products[0].$app.printful.sync_product_id).toBe(900);
  });

  it("refuses a product that is already linked", async () => {
    const fetchSpy = mockPrintful([]);
    const print = merchantPrint();
    print.$app.printful = { sync_product_id: 777 };
    const store = fakeStore([print]);

    await expect(
      productLink(createMockRequest({ data: action("link", { printful_product: "900" }), swell: store.swell })),
    ).rejects.toMatchObject({
      status: 400,
      message: "This product is already linked to Printful product 777.",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a Printful product another Swell product is linked to", async () => {
    mockPrintful([size(101, "12″×16″")]);
    const other = { ...merchantPrint(), id: "64b0c0ffee0000000000bbbb", $app: { printful: { sync_product_id: 900 } } };
    const store = fakeStore([merchantPrint(), other]);

    await expect(
      productLink(createMockRequest({ data: action("link", { printful_product: "900" }), swell: store.swell })),
    ).rejects.toMatchObject({
      status: 400,
      message: 'The Printful product "Sunset Print" is already linked to another Swell product.',
    });
    expect(store.products[0].$app.printful).toBeUndefined();
  });

  it("says when Printful has no such product", async () => {
    mockPrintful([]);
    const store = fakeStore([merchantPrint()]);

    await expect(
      productLink(createMockRequest({ data: action("link", { printful_product: "555" }), swell: store.swell })),
    ).rejects.toMatchObject({
      status: 400,
      message: "Printful has no product 555 in the store your token is for.",
    });
  });
});

describe("Unlink from Printful", () => {
  it("removes the product's links and its Printful values", async () => {
    const print = merchantPrint();
    print.$app.printful = { sync_product_id: 900, linked: true, sync_variant_count: 2 };
    const store = fakeStore(
      [print],
      [
        { id: "L1", sync_product_id: 900, product_id: PRINT_ID, variant_id: "v1" },
        { id: "L2", sync_product_id: 900, product_id: PRINT_ID, variant_id: "v2" },
      ],
    );

    const { message } = await productLink(createMockRequest({ data: action("unlink"), swell: store.swell }));

    expect(message).toBe(
      "Unlinked from Printful. Orders for this product are no longer sent to Printful.",
    );
    expect(store.links).toEqual([]);
    expect(store.products[0].$app.printful).toMatchObject({ sync_product_id: null, linked: null });
  });

  it("keeps a product created from Printful linked", async () => {
    const print = merchantPrint();
    print.$app.printful = { sync_product_id: 900 };
    const store = fakeStore([print]);

    await expect(
      productLink(createMockRequest({ data: action("unlink"), swell: store.swell })),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.products[0].$app.printful.sync_product_id).toBe(900);
  });
});

describe("syncing a Printful product no Swell product is linked to", () => {
  it("links the Swell product its external id names instead of creating one", async () => {
    mockPrintful([size(101, "12″×16″"), size(102, "18″×24″")]);
    const store = fakeStore([merchantPrint()]);
    const req = createMockRequest({ swell: store.swell });

    const outcome = await syncOne(req, { api_token: "token" }, {
      summary: { id: 900, external_id: PRINT_ID, name: "Sunset Print", variants: 2 },
    });

    expect(outcome).toBe("linked");
    expect(store.posts.filter((post) => post.url === "/products")).toEqual([]);
    expect(store.products[0].$app.printful).toMatchObject({
      sync_product_id: 900,
      linked: true,
      sync_variant_count: 2,
    });
    expect(store.links).toHaveLength(2);
  });

  it("links a product copied into Printful by another integration, variant by variant", async () => {
    // Product external id "swell:{product id}", each variant's the Swell variant id
    const ids = ["64b0c0ffee00000000000001", "64b0c0ffee00000000000002", "64b0c0ffee00000000000003"];
    const print = merchantPrint();
    print.options[0].values = [
      { id: "s1", name: "12×16" },
      { id: "s2", name: "18×24" },
      { id: "s3", name: "24×36" },
    ];
    print.variants = print.variants.map((variant, i) => ({ ...variant, id: ids[i] }));
    mockPrintful([
      size(101, "12″×16″", { external_id: ids[0] }),
      size(102, "18″×24″", { external_id: ids[1] }),
      size(103, "24″×36″", { external_id: ids[2] }),
    ]);
    const store = fakeStore([print]);
    const req = createMockRequest({ swell: store.swell });

    const outcome = await syncOne(req, { api_token: "token", product_source: "swell" }, {
      summary: { id: 900, external_id: `swell:${PRINT_ID}`, name: "Sunset Print", variants: 3 },
    });

    expect(outcome).toBe("linked");
    expect(store.links.map((link) => [link.sync_variant_id, link.variant_id])).toEqual([
      [101, ids[0]],
      [102, ids[1]],
      [103, ids[2]],
    ]);
    expect(store.products[0].variants.every((variant: any) => variant.active)).toBe(true);
  });

  it("creates nothing, and asks Printful nothing, when products start in Swell", async () => {
    const fetchSpy = mockPrintful([]);
    const store = fakeStore([merchantPrint()]);
    const req = createMockRequest({ swell: store.swell });

    const outcome = await syncOne(req, { api_token: "token", product_source: "swell" }, {
      summary: { id: 900, name: "Sunset Print", variants: 2 },
    });

    expect(outcome).toBe("unlinked");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.posts).toEqual([]);
  });
});

describe("orders for a product without variants", () => {
  it("find the link made for the whole product", async () => {
    const store = fakeStore(
      [],
      [{ id: "L1", product_id: "p1", sync_variant_id: 5, catalog_variant_id: 50 }],
    );
    const req = createMockRequest({ swell: store.swell });
    const items = [{ id: "item_1", product_id: "p1", quantity: 2 }];

    const links = await getVariantLinks(req, items);

    expect(toOrderItems(items, links)).toEqual([
      { sync_variant_id: 5, quantity: 2, external_id: "item_1" },
    ]);
  });
});
