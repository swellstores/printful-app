import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockRequest } from "../helpers/mock-request";

vi.mock("../../functions/lib/products", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/products")>()),
  runProductSync: vi.fn(),
}));

vi.mock("../../functions/lib/lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../functions/lib/lease")>()),
  takeLease: vi.fn(),
  releaseLease: vi.fn(),
}));

import productSync, { SKIPPED } from "../../functions/product-sync";
import { runProductSync, SyncResult } from "../../functions/lib/products";
import { releaseLease, takeLease } from "../../functions/lib/lease";

const RESULT = { summary: "3 Printful products: 1 created, 0 updated, 0 taken off sale." };

function request() {
  const writes: any[] = [];
  const req = createMockRequest({
    swell: {
      get: vi.fn(async () => ({ api_token: "token" })),
      put: vi.fn(async (_url: string, values: any) => writes.push(values)),
    },
  });

  return { req, writes };
}

beforeEach(() => {
  vi.mocked(runProductSync).mockReset().mockResolvedValue(RESULT as SyncResult);
  vi.mocked(takeLease).mockReset().mockResolvedValue({ taken: true });
  vi.mocked(releaseLease).mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("hourly product sync", () => {
  it("skips while another sync holds the lease, and says so in the settings", async () => {
    vi.mocked(takeLease).mockResolvedValue({
      taken: false,
      lease: { owner: "wf_1", until: new Date(Date.now() + 60_000).toISOString() },
    });
    const { req, writes } = request();

    await productSync(req);

    expect(runProductSync).not.toHaveBeenCalled();
    expect(writes).toEqual([{ last_sync_at: expect.any(String), last_sync_result: SKIPPED }]);
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("syncs under a short lease of its own and lets go of it", async () => {
    const { req } = request();

    await productSync(req);

    const [, owner, seconds] = vi.mocked(takeLease).mock.calls[0];
    expect(owner).toMatch(/^cron:/);
    expect(seconds).toBe(60);
    expect(runProductSync).toHaveBeenCalledTimes(1);
    expect(vi.mocked(releaseLease).mock.calls[0][1]).toBe(owner);
  });

  it("lets go of the lease when the sync throws", async () => {
    vi.mocked(runProductSync).mockRejectedValue(new Error("Printful is down"));
    const { req } = request();

    await expect(productSync(req)).rejects.toThrow("Printful is down");
    expect(releaseLease).toHaveBeenCalledTimes(1);
  });

  it("does not fail the run when letting go of the lease fails", async () => {
    vi.mocked(releaseLease).mockRejectedValue(new Error("settings unavailable"));
    const { req } = request();

    await expect(productSync(req)).resolves.toBeUndefined();
  });
});
