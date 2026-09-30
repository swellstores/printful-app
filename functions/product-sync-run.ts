import { getSettings } from "./lib/settings";
import { runProductSync } from "./lib/products";
import {
  ALREADY_RUNNING,
  FUNCTION_LEASE_SECONDS,
  releaseLease,
  takeLease,
} from "./lib/lease";

export const config: SwellConfig = {
  description: "Run the Printful product sync now",
  route: {
    methods: ["post"],
    public: false,
  },
};

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError("Printful API token is not configured", {
      status: 400,
    });
  }

  const budget = Number(req.data.budget);

  // Two syncs at once could both create the same product
  const owner = `script:${new Date().toISOString()}`;

  if (!(await takeLease(req, owner, FUNCTION_LEASE_SECONDS)).taken) {
    throw new SwellError(ALREADY_RUNNING, { status: 409 });
  }

  try {
    return await runProductSync(req, settings, {
      budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
    });
  } finally {
    // The lease runs out on its own, so failing to let go of it must not fail
    // the run
    await releaseLease(req, owner).catch((err) =>
      console.log("Could not release the Printful sync lease", err),
    );
  }
}
