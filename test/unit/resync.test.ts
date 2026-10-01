import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";

vi.mock("../../functions/lib/products", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../functions/lib/products")>();
  return {
    ...actual,
    // The real ones are tested on their own below; the workflow's tests use these
    findSelectedProducts: vi.fn(actual.findSelectedProducts),
    resyncOne: vi.fn(actual.resyncOne),
  };
});

vi.mock("../../functions/lib/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/lease")>()),
  takeLease: vi.fn(),
  releaseLease: vi.fn(),
}));

import ResyncProducts, { NONE_FROM_PRINTFUL } from "../../functions/resync-products";
import { findSelectedProducts, resyncOne } from "../../functions/lib/products";
import { LEASE_LOST } from "../../functions/lib/workflow";
import { PrintfulError } from "../../functions/lib/printful";
import { releaseLease, takeLease } from "../../functions/lib/lease";

const actual = await vi.importActual<typeof import("../../functions/lib/products")>(
  "../../functions/lib/products",
);

/** Runs every step straight away and records its name. */
function fakeStep() {
  const names: string[] = [];

  const step = {
    async do(name: string, optionsOrFn: any, maybeFn?: any) {
      names.push(name);
      return (maybeFn ?? optionsOrFn)();
    },
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  } as unknown as SwellWorkflowStep;

  return { step, names };
}

const SELECTION = { all: false, ids: ["p1", "p2"], count: 5, query: {} };

function workflowRequest(data: object = {}) {
  return {
    id: "req_1",
    appId: "printful",
    store: { id: "test" },
    data: { $action: { id: "resync_selected", source: "bulk", selection: SELECTION }, ...data },
    workflow: { trigger: "action", workflow_instance_id: "wf_1" },
    isLocalDev: false,
    swell: {
      get: vi.fn(),
      put: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
      settings: vi.fn(async () => ({ printful: { api_token: "t" } })),
    },
  } as unknown as SwellWorkflowRequest;
}

const FOUND = {
  selected: 5,
  products: [
    { id: "p1", name: "Tee" },
    { id: "p2", name: "Mug" },
  ],
};

beforeEach(() => {
  vi.mocked(findSelectedProducts).mockReset().mockResolvedValue(FOUND);
  vi.mocked(resyncOne).mockReset().mockResolvedValue("updated");
  vi.mocked(takeLease).mockReset().mockResolvedValue({ taken: true });
  vi.mocked(releaseLease).mockReset().mockResolvedValue(undefined);
});

describe("resync-products workflow", () => {
  it("resyncs the selected Printful products one per step, under the sync lease", async () => {
    const { step, names } = fakeStep();
    const request = workflowRequest({ replace_images: true });

    const result = await new ResyncProducts().run(request, step);

    expect(names).toEqual([
      "Read the app settings",
      "Check for another Printful sync",
      "Find the selected Printful products",
      "Resync Tee (1 of 2)",
      "Resync Mug (2 of 2)",
      "Release the sync lease",
    ]);
    expect(vi.mocked(findSelectedProducts).mock.calls[0][1]).toEqual(SELECTION);
    expect(vi.mocked(resyncOne).mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["p1", { replaceImages: true }],
      ["p2", { replaceImages: true }],
    ]);
    // 5 selected, 2 of them from Printful
    expect(result).toEqual({
      message: "Resynced 2 products from Printful. 3 products not from Printful, skipped.",
    });
    expect(vi.mocked(releaseLease).mock.calls[0][1]).toBe("wf_1");
  });

  it("keeps photos unless asked to replace them", async () => {
    const { step } = fakeStep();

    await new ResyncProducts().run(workflowRequest(), step);

    expect(vi.mocked(resyncOne).mock.calls[0][3]).toEqual({ replaceImages: false });
  });

  it("counts products taken off sale, skipped and failed, and carries on", async () => {
    vi.mocked(findSelectedProducts).mockResolvedValue({
      selected: 3,
      products: [
        { id: "p1", name: "Tee" },
        { id: "p2", name: "Mug" },
        { id: "p3", name: "Cap" },
      ],
    });
    vi.mocked(resyncOne)
      .mockResolvedValueOnce("retired")
      .mockResolvedValueOnce("skipped")
      .mockRejectedValueOnce(new Error("2 variant(s) could not be matched"));
    const { step } = fakeStep();

    const result = await new ResyncProducts().run(workflowRequest(), step);

    expect(result).toEqual({
      message:
        "Resynced 0 products from Printful. 1 product no longer in Printful, taken off sale. " +
        "1 product not from Printful, skipped. Errors: Cap: 2 variant(s) could not be matched",
    });
  });

  it("stops, and lets go of the lease, when no selected product came from Printful", async () => {
    vi.mocked(findSelectedProducts).mockResolvedValue({ selected: 2, products: [] });
    const { step } = fakeStep();

    await expect(new ResyncProducts().run(workflowRequest(), step)).rejects.toThrow(
      NONE_FROM_PRINTFUL,
    );
    expect(resyncOne).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("lets Printful's rate limit reach the step so it is retried, and lets go of the lease", async () => {
    vi.mocked(resyncOne).mockRejectedValue(new PrintfulError("Too many requests", 429, "429", 60));
    const { step } = fakeStep();

    await expect(new ResyncProducts().run(workflowRequest(), step)).rejects.toBeInstanceOf(
      PrintfulError,
    );
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("stops before a product when another sync has taken the lease over", async () => {
    vi.mocked(takeLease)
      .mockResolvedValueOnce({ taken: true })
      .mockResolvedValueOnce({ taken: false, lease: { owner: "wf_2", until: "2026-10-01T00:00:00.000Z" } });
    const { step } = fakeStep();

    await expect(new ResyncProducts().run(workflowRequest(), step)).rejects.toThrow(LEASE_LOST);
    expect(resyncOne).not.toHaveBeenCalled();
  });
});

describe("findSelectedProducts", () => {
  it("keeps the selection's query whole, narrows it to Printful products and reads every page", async () => {
    const queries: any[] = [];
    const page = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({ id: `p${start + i}`, name: `Product ${start + i}` }));
    const get = vi.fn(async (_url: string, query: any) => {
      queries.push(query);
      return query.page === 1
        ? { count: 101, results: page(100, 1) }
        : { count: 101, results: page(1, 101) };
    });
    const req = createMockRequest({ swell: { get } });

    // Select all in a filtered list, with one row unchecked: the list's own
    // query, and a top-level $and that excludes the unchecked row
    const found = await actual.findSelectedProducts(req, {
      count: 120,
      query: {
        search: "tee",
        categories: "c1",
        where: { active: true },
        $and: [{ id: { $nin: ["p9"] } }],
      },
    });

    expect(queries[0]).toEqual({
      search: "tee",
      categories: "c1",
      $and: [{ id: { $nin: ["p9"] } }],
      where: {
        $and: [{ active: true }, { "$app.printful.sync_product_id": { $exists: true } }],
      },
      fields: ["name"],
      sort: "$app.printful.date_synced asc",
      limit: 100,
      page: 1,
    });
    expect(queries.map((query) => query.page)).toEqual([1, 2]);
    expect(found.selected).toBe(120);
    expect(found.products).toHaveLength(101);
    expect(found.products[100]).toEqual({ id: "p101", name: "Product 101" });
  });
});

describe("resyncOne", () => {
  it("skips a product that is gone or did not come from Printful, without asking Printful", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const settings = { api_token: "t" };

    for (const product of [{}, { id: "p1", name: "Mug", $app: {} }]) {
      const req = createMockRequest({ swell: { get: vi.fn(async () => product) } });
      await expect(actual.resyncOne(req, settings, "p1")).resolves.toBe("skipped");
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
