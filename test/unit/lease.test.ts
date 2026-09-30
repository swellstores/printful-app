import { describe, it, expect, vi } from "vitest";
import { createMockRequest } from "../helpers/mock-request";
import { isLive, releaseLease, takeLease } from "../../functions/lib/lease";

const soon = () => new Date(Date.now() + 60_000).toISOString();
const past = () => new Date(Date.now() - 1_000).toISOString();

/**
 * App settings kept in memory, as the settings endpoint keeps them. `onWrite`
 * can change the stored values after a write, like a sync writing at the same
 * moment.
 */
function settingsStore(
  initial: Record<string, any> = {},
  onWrite?: (values: any, stored: Record<string, any>) => void,
) {
  const stored: Record<string, any> = { ...initial };
  const put = vi.fn(async (_url: string, values: any) => {
    Object.assign(stored, values);
    onWrite?.(values, stored);
    return stored;
  });
  const req = createMockRequest({
    swell: { get: vi.fn(async () => ({ ...stored })), put },
  });

  return { req, stored, put };
}

describe("isLive", () => {
  it("is live only while it has an owner and has not run out", () => {
    expect(isLive({ owner: "wf_1", until: soon() })).toBe(true);
    expect(isLive({ owner: "wf_1", until: past() })).toBe(false);
    expect(isLive(null)).toBe(false);
    expect(isLive(undefined)).toBe(false);
  });
});

describe("takeLease", () => {
  it("takes a free lease for the time asked", async () => {
    const { req, stored } = settingsStore();

    await expect(takeLease(req, "wf_1", 150)).resolves.toEqual({ taken: true });
    expect(stored.sync_lease.owner).toBe("wf_1");
    expect(Date.parse(stored.sync_lease.until)).toBeGreaterThan(Date.now() + 140_000);
  });

  it("leaves another sync's live lease alone", async () => {
    const lease = { owner: "wf_1", until: soon() };
    const { req, put } = settingsStore({ sync_lease: lease });

    await expect(takeLease(req, "cron:1", 60)).resolves.toEqual({ taken: false, lease });
    expect(put).not.toHaveBeenCalled();
  });

  it("takes over a lease that has run out", async () => {
    const { req, stored } = settingsStore({ sync_lease: { owner: "wf_1", until: past() } });

    await expect(takeLease(req, "cron:1", 60)).resolves.toEqual({ taken: true });
    expect(stored.sync_lease.owner).toBe("cron:1");
  });

  it("extends its own lease", async () => {
    const until = soon();
    const { req, stored } = settingsStore({ sync_lease: { owner: "wf_1", until } });

    await expect(takeLease(req, "wf_1", 150)).resolves.toEqual({ taken: true });
    expect(Date.parse(stored.sync_lease.until)).toBeGreaterThan(Date.parse(until));
  });

  it("gives way when another sync wrote the lease at the same moment", async () => {
    // Last writer wins, and the read-back shows the other owner
    const { req } = settingsStore({}, (values, stored) => {
      if (values.sync_lease?.owner === "wf_1") {
        stored.sync_lease = { owner: "wf_2", until: soon() };
      }
    });

    await expect(takeLease(req, "wf_1", 150)).resolves.toMatchObject({
      taken: false,
      lease: { owner: "wf_2" },
    });
  });
});

describe("releaseLease", () => {
  it("lets go of its own lease", async () => {
    const { req, stored } = settingsStore({ sync_lease: { owner: "wf_1", until: soon() } });

    await releaseLease(req, "wf_1");

    expect(stored.sync_lease).toBeNull();
  });

  it("leaves a lease another sync has taken since", async () => {
    const { req, put } = settingsStore({ sync_lease: { owner: "cron:1", until: soon() } });

    await releaseLease(req, "wf_1");

    expect(put).not.toHaveBeenCalled();
  });
});
