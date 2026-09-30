import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../functions/lib/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/products")>()),
  planSync: vi.fn(),
  syncOne: vi.fn(),
  retireRemoved: vi.fn(),
  recordSyncResult: vi.fn(),
}));

import SyncProducts from "../../functions/sync-products";
import { toSwellRequest } from "../../functions/lib/workflow";
import { PrintfulError } from "../../functions/lib/printful";
import {
  planSync,
  recordSyncResult,
  retireRemoved,
  syncOne,
} from "../../functions/lib/products";

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
  vi.mocked(recordSyncResult).mockReset().mockResolvedValue("summary");
});

describe("sync-products workflow", () => {
  it("syncs one product per step, with names merchants can follow", async () => {
    vi.mocked(planSync).mockResolvedValue({
      listed: [1, 2, 3],
      queue: [TEE, { summary: { id: 2, name: "Tee", variants: 3 } }],
    });
    vi.mocked(syncOne).mockResolvedValueOnce("created").mockResolvedValueOnce("updated");
    const { step, names } = fakeStep();

    const result = await new SyncProducts().run(workflowRequest({ api_token: "t" }), step);

    // Two products share a name; the counter keeps the step names unique.
    expect(names).toEqual([
      "Read the app settings",
      "List Printful products",
      "Sync Tee (1 of 2)",
      "Sync Tee (2 of 2)",
      "Take removed products off sale",
      "Save the sync result",
    ]);
    expect(vi.mocked(recordSyncResult).mock.calls[0][1]).toEqual({
      products: 3,
      created: 1,
      updated: 1,
      retired: 0,
      complete: true,
      listed: true,
      errors: [],
    });
    expect(result).toEqual({ message: "summary" });
  });

  it("records a product that fails and carries on", async () => {
    vi.mocked(planSync).mockResolvedValue({ listed: [1], queue: [TEE] });
    vi.mocked(syncOne).mockRejectedValue(new Error("2 variant(s) could not be matched"));
    const { step } = fakeStep();

    await new SyncProducts().run(workflowRequest({ api_token: "t" }), step);

    expect(vi.mocked(recordSyncResult).mock.calls[0][1].errors).toEqual([
      "Tee: 2 variant(s) could not be matched",
    ]);
  });

  it("lets Printful's rate limit reach the step so it is retried", async () => {
    vi.mocked(planSync).mockResolvedValue({ listed: [1], queue: [TEE] });
    vi.mocked(syncOne).mockRejectedValue(new PrintfulError("Too many requests", 429, "429", 60));
    const { step } = fakeStep();

    await expect(
      new SyncProducts().run(workflowRequest({ api_token: "t" }), step),
    ).rejects.toBeInstanceOf(PrintfulError);
  });

  it("fails the run, and says why in the settings, when Printful cannot be read", async () => {
    vi.mocked(planSync).mockRejectedValue(new Error("The access token provided is invalid."));
    vi.mocked(recordSyncResult).mockResolvedValue(
      "Could not read your Printful products: The access token provided is invalid.",
    );
    const { step } = fakeStep();

    await expect(
      new SyncProducts().run(workflowRequest({ api_token: "t" }), step),
    ).rejects.toThrow("Could not read your Printful products: The access token provided is invalid.");
    expect(vi.mocked(recordSyncResult).mock.calls[0][1]).toMatchObject({
      listed: false,
      errors: ["The access token provided is invalid."],
    });
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
  it("adds appValues and passes the workflow's client through", () => {
    const swell = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      settings: vi.fn(),
    };
    const req = toSwellRequest({ appId: "printful", swell } as unknown as SwellWorkflowRequest);

    expect(req.appValues({ date_synced: "now" })).toEqual({
      $app: { printful: { date_synced: "now" } },
    });
    expect(req.swell).toBe(swell);
  });
});
