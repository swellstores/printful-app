import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../functions/lib/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/products")>()),
  planSync: vi.fn(),
  syncOne: vi.fn(),
  retireRemoved: vi.fn(),
}));

import SyncProducts from "../../functions/sync-products";
import { toSwellRequest } from "../../functions/lib/workflow";
import { PrintfulError } from "../../functions/lib/printful";
import { planSync, retireRemoved, syncOne } from "../../functions/lib/products";

/** Runs every step straight away and records its name. */
function fakeStep() {
  const names: string[] = [];

  const step = {
    do(name: string, optionsOrFn: any, maybeFn?: any) {
      names.push(name);
      return (maybeFn ?? optionsOrFn)();
    },
    sleep: vi.fn(),
    sleepUntil: vi.fn(),
  } as unknown as SwellWorkflowStep;

  return { step, names };
}

/** The runtime answers settings() with every settings file, keyed by name. */
function workflowRequest(settings: object) {
  return {
    id: "req_1",
    appId: "printful",
    store: { id: "test" },
    data: {},
    workflow: { trigger: "action" },
    isLocalDev: false,
    swell: {
      get: vi.fn(),
      put: vi.fn(),
      post: vi.fn(),
      delete: vi.fn(),
      settings: vi.fn(async () => ({ id: "settings_1", printful: settings })),
    },
  } as unknown as SwellWorkflowRequest;
}

const TEE = { summary: { id: 1, name: "Tee", variants: 5 } };

beforeEach(() => {
  vi.mocked(planSync).mockReset();
  vi.mocked(syncOne).mockReset();
  vi.mocked(retireRemoved).mockReset().mockResolvedValue(0);
});

describe("sync-products workflow", () => {
  it("syncs one product per step, with names merchants can follow", async () => {
    vi.mocked(planSync).mockResolvedValue({
      listed: [1, 2, 3],
      queue: [TEE, { summary: { id: 2, name: "Tee", variants: 3 } }],
    });
    vi.mocked(syncOne).mockResolvedValueOnce("created").mockResolvedValueOnce("updated");
    const { step, names } = fakeStep();
    const request = workflowRequest({ api_token: "t" });

    const result = await new SyncProducts().run(request, step);

    // Two products share a name; the counter keeps the step names unique.
    expect(names).toEqual([
      "Read the app settings",
      "List Printful products",
      "Sync Tee (1 of 2)",
      "Sync Tee (2 of 2)",
      "Take removed products off sale",
    ]);
    expect(result).toEqual({
      message: "3 Printful products: 1 created, 1 updated, 0 taken off sale.",
    });
    // The runtime refuses /settings paths, so settings are neither read nor
    // written through them.
    expect(request.swell.get).not.toHaveBeenCalled();
    expect(request.swell.put).not.toHaveBeenCalled();
  });

  it("reports a product that fails and carries on", async () => {
    vi.mocked(planSync).mockResolvedValue({ listed: [1], queue: [TEE] });
    vi.mocked(syncOne).mockRejectedValue(new Error("2 variant(s) could not be matched"));
    const { step } = fakeStep();

    const result = await new SyncProducts().run(workflowRequest({ api_token: "t" }), step);

    expect(result.message).toContain("Errors: Tee: 2 variant(s) could not be matched");
  });

  it("lets Printful's rate limit reach the step so it is retried", async () => {
    vi.mocked(planSync).mockResolvedValue({ listed: [1], queue: [TEE] });
    vi.mocked(syncOne).mockRejectedValue(new PrintfulError("Too many requests", 429, "429", 60));
    const { step } = fakeStep();

    await expect(
      new SyncProducts().run(workflowRequest({ api_token: "t" }), step),
    ).rejects.toBeInstanceOf(PrintfulError);
  });

  it("fails the run, saying why, when Printful cannot be read", async () => {
    vi.mocked(planSync).mockRejectedValue(new Error("The access token provided is invalid."));
    const { step } = fakeStep();

    await expect(
      new SyncProducts().run(workflowRequest({ api_token: "t" }), step),
    ).rejects.toThrow("Could not read your Printful products: The access token provided is invalid.");
    expect(syncOne).not.toHaveBeenCalled();
  });

  it("asks for a token before reading Printful", async () => {
    const { step } = fakeStep();

    await expect(new SyncProducts().run(workflowRequest({}), step)).rejects.toThrow(
      "Add your Printful API token in the app settings first.",
    );
    expect(planSync).not.toHaveBeenCalled();
  });
});

describe("toSwellRequest", () => {
  it("adds appValues and runs transaction operations one by one", async () => {
    const calls: string[] = [];
    const swell = {
      get: vi.fn(),
      post: vi.fn(async (url: string) => calls.push(`post ${url}`)),
      put: vi.fn(async (url: string) => calls.push(`put ${url}`)),
      delete: vi.fn(async (url: string) => calls.push(`delete ${url}`)),
      settings: vi.fn(),
    };
    const req = toSwellRequest({ appId: "printful", swell } as unknown as SwellWorkflowRequest);

    expect(req.appValues({ date_synced: "now" })).toEqual({
      $app: { printful: { date_synced: "now" } },
    });

    await req.swell.transaction([
      { method: "post", url: "/apps/printful/sync-variants", data: {} },
      { method: "put", url: "/apps/printful/sync-variants/1", data: {} },
      { method: "delete", url: "/apps/printful/sync-variants/2" },
    ]);

    expect(calls).toEqual([
      "post /apps/printful/sync-variants",
      "put /apps/printful/sync-variants/1",
      "delete /apps/printful/sync-variants/2",
    ]);
  });
});
