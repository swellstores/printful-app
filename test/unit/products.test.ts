import { describe, it, expect } from "vitest";
import {
  basePrice,
  chooseDimensions,
  dimensionsFromOptions,
  mergeOptions,
  mockupImages,
  planVariants,
  prioritize,
  sellable,
} from "../../functions/lib/products";
import type {
  SwellOption,
  SwellVariant,
  SyncVariant,
} from "../../functions/lib/products";

function variant(
  id: number,
  color: string,
  size: string,
  price = "25.00",
  extra: Partial<SyncVariant> = {},
): SyncVariant {
  return {
    id,
    name: `Tee / ${color} / ${size}`,
    variant_id: 4000 + id,
    retail_price: price,
    sku: `TEE-${color}-${size}`,
    color,
    size,
    ...extra,
  };
}

// Printful makes five of the six color/size combinations.
const PRINTFUL = [
  variant(1, "Black", "S"),
  variant(2, "Black", "M"),
  variant(3, "Black", "2XL", "27.00"),
  variant(4, "White", "S"),
  variant(5, "White", "M"),
];

// What Swell generated from the Color and Size options: every combination.
const OPTIONS: SwellOption[] = [
  {
    id: "opt_color",
    name: "Color",
    variant: true,
    values: [
      { id: "black", name: "Black" },
      { id: "white", name: "White" },
    ],
  },
  {
    id: "opt_size",
    name: "Size",
    variant: true,
    values: [
      { id: "s", name: "S" },
      { id: "m", name: "M" },
      { id: "xxl", name: "2XL" },
    ],
  },
];

const SWELL: SwellVariant[] = [
  { id: "v_black_s", option_value_ids: ["black", "s"], active: true },
  { id: "v_black_m", option_value_ids: ["black", "m"], active: true },
  { id: "v_black_xxl", option_value_ids: ["black", "xxl"], active: true },
  { id: "v_white_s", option_value_ids: ["white", "s"], active: true },
  { id: "v_white_m", option_value_ids: ["white", "m"], active: true },
  { id: "v_white_xxl", option_value_ids: ["white", "xxl"], active: true },
];

const DIMS = chooseDimensions(PRINTFUL);

describe("sellable", () => {
  it("drops ignored and discontinued variants", () => {
    const kept = sellable([
      variant(1, "Black", "S"),
      variant(2, "Black", "M", "25.00", { is_ignored: true }),
      variant(3, "Black", "L", "25.00", { availability_status: "discontinued" }),
      variant(4, "Black", "XL", "25.00", { availability_status: "out_of_stock" }),
    ]);

    expect(kept.map((v) => v.id)).toEqual([1, 4]);
  });
});

describe("chooseDimensions", () => {
  it("uses Color and Size when they tell every variant apart", () => {
    expect(DIMS.map((dim) => dim.name)).toEqual(["Color", "Size"]);
  });

  it("uses only the attributes a product has", () => {
    const posters = [
      { id: 1, variant_id: 1, size: "12×16" },
      { id: 2, variant_id: 2, size: "18×24" },
    ];

    expect(chooseDimensions(posters).map((dim) => dim.name)).toEqual(["Size"]);
  });

  it("falls back to one option per variant when Color and Size collide", () => {
    const collide = [variant(1, "Black", "S"), variant(2, "Black", "S")];

    expect(chooseDimensions(collide).map((dim) => dim.name)).toEqual([
      "Variant",
    ]);
  });
});

describe("dimensionsFromOptions", () => {
  it("reads the synced options back, ignoring the merchant's own", () => {
    const options = [
      ...OPTIONS,
      { name: "Gift wrap", variant: false, values: [{ name: "Yes" }] },
    ];

    expect(dimensionsFromOptions(options).map((dim) => dim.name)).toEqual([
      "Color",
      "Size",
    ]);
  });
});

describe("mergeOptions", () => {
  it("adds new values and keeps every existing option and value id", () => {
    const giftWrap = {
      id: "opt_gift",
      name: "Gift wrap",
      variant: false,
      values: [{ id: "yes", name: "Yes" }],
    };

    const { options, changed } = mergeOptions(
      [...OPTIONS, giftWrap],
      DIMS,
      [...PRINTFUL, variant(6, "Black", "L")],
    );

    expect(changed).toBe(true);
    expect(options.find((o) => o.name === "Gift wrap")).toEqual(giftWrap);
    expect(options.find((o) => o.name === "Size")?.values).toEqual([
      { id: "s", name: "S" },
      { id: "m", name: "M" },
      { id: "xxl", name: "2XL" },
      { name: "L" },
    ]);
  });

  it("reports no change when every value already exists", () => {
    expect(mergeOptions(OPTIONS, DIMS, PRINTFUL).changed).toBe(false);
  });
});

describe("basePrice", () => {
  it("takes the most common price, so only odd sizes carry their own", () => {
    expect(basePrice(PRINTFUL)).toBe(25);
  });

  it("takes the lower price on a tie", () => {
    expect(basePrice([variant(1, "A", "S", "30.00"), variant(2, "A", "M", "28.00")])).toBe(28);
  });

  it("returns null when Printful has no retail prices", () => {
    expect(basePrice([variant(1, "A", "S", "")])).toBeNull();
  });
});

describe("mockupImages", () => {
  it("collects each color's mockup once", () => {
    const preview = (url: string) => ({
      files: [
        { type: "default", preview_url: "https://files/print-file.png" },
        { type: "preview", preview_url: url },
      ],
    });

    const images = mockupImages({
      sync_product: { id: 1, thumbnail_url: "https://files/thumb.png" },
      sync_variants: [
        { ...variant(1, "Black", "S"), ...preview("https://files/black.png") },
        { ...variant(2, "Black", "M"), ...preview("https://files/black.png") },
        { ...variant(3, "White", "S"), ...preview("https://files/white.png") },
      ],
    });

    expect(images).toEqual(["https://files/black.png", "https://files/white.png"]);
  });

  it("falls back to the product thumbnail", () => {
    expect(
      mockupImages({
        sync_product: { id: 1, thumbnail_url: "https://files/thumb.png" },
        sync_variants: [variant(1, "Black", "S")],
      }),
    ).toEqual(["https://files/thumb.png"]);
  });
});

describe("prioritize", () => {
  it("puts new products first, then changed ones, then the stalest", () => {
    const state = new Map([
      [2, { sync_variant_count: 3, date_synced: "2026-09-02" }],
      [3, { sync_variant_count: 5, date_synced: "2026-09-01" }],
      [4, { sync_variant_count: 5, date_synced: "2026-09-03" }],
      [5, { sync_variant_count: 5, date_synced: "2026-09-04" }],
    ]);

    const { queue, due } = prioritize(
      [
        { id: 5, variants: 5 },
        { id: 4, variants: 5 },
        { id: 3, variants: 5 },
        { id: 2, variants: 4 },
        { id: 1, variants: 2 },
      ],
      state,
    );

    expect(queue.map((p) => p.id)).toEqual([1, 2, 3, 4]);
    expect(due).toBe(2);
  });
});

describe("planVariants", () => {
  it("links a new product and switches off combinations Printful does not make", () => {
    const plan = planVariants({
      dims: DIMS,
      printful: PRINTFUL,
      options: OPTIONS,
      variants: SWELL,
      links: [],
      productPrice: 25,
    });

    expect(plan.unmatched).toEqual([]);
    expect(plan.linkDeletes).toEqual([]);
    expect(
      plan.linkUpserts.map((link) => [link.variant.id, link.variantId]),
    ).toEqual([
      [1, "v_black_s"],
      [2, "v_black_m"],
      [3, "v_black_xxl"],
      [4, "v_white_s"],
      [5, "v_white_m"],
    ]);

    const updates = new Map(plan.variantUpdates.map((u) => [u.id, u]));

    // Only the odd size carries its own price; the rest inherit the product's.
    expect(updates.get("v_black_xxl")).toEqual({
      id: "v_black_xxl",
      sku: "TEE-Black-2XL",
      price: 27,
    });
    expect(updates.get("v_black_s")).toEqual({ id: "v_black_s", sku: "TEE-Black-S" });
    expect(updates.get("v_white_xxl")).toEqual({ id: "v_white_xxl", active: false });
  });

  it("leaves existing links alone and takes removed variants off sale", () => {
    const links = PRINTFUL.map((v, i) => ({
      id: `link_${v.id}`,
      sync_variant_id: v.id,
      variant_id: SWELL[i].id,
    }));

    const swell = SWELL.map((v) =>
      // The merchant stopped selling Black S, and the unmade combination was
      // switched off by the first sync.
      v.id === "v_black_s" || v.id === "v_white_xxl" ? { ...v, active: false } : v,
    );

    // White M was removed in Printful, and Black M's price changed there.
    const printful = PRINTFUL.filter((v) => v.id !== 5).map((v) =>
      v.id === 2 ? { ...v, retail_price: "29.00" } : v,
    );

    const plan = planVariants({
      dims: DIMS,
      printful,
      options: OPTIONS,
      variants: swell,
      links,
      productPrice: 25,
    });

    expect(plan.linkDeletes).toEqual(["link_5"]);
    expect(plan.variantUpdates).toEqual([{ id: "v_white_m", active: false }]);
  });

  it("switches a variant back on when it is linked again", () => {
    const swell = SWELL.map((v) =>
      v.id === "v_white_m" ? { ...v, active: false } : v,
    );

    const plan = planVariants({
      dims: DIMS,
      printful: [variant(5, "White", "M")],
      options: OPTIONS,
      variants: swell.filter((v) => v.id === "v_white_m"),
      links: [],
      productPrice: 25,
    });

    expect(plan.variantUpdates).toEqual([
      { id: "v_white_m", active: true, sku: "TEE-White-M" },
    ]);
  });
});
