import { getSettings } from "./lib/settings";
import { runProductSync } from "./lib/products";

// Printful allows 120 requests a minute across the whole app, and checkout
// quotes share them, so a run asked for by hand stays well under that too.
const MAX_BUDGET = 60;

export const config: SwellConfig = {
  description: "Run the Printful product sync from an action in the Swell admin",
  action: {},
};

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError(
      "Add your Printful API token in the app settings first.",
      { status: 400 },
    );
  }

  // Only the Products list action asks for a budget; the others use the default.
  const budget = Number(req.data.budget);

  const result = await runProductSync(req, settings, {
    budget:
      Number.isFinite(budget) && budget > 0
        ? Math.min(budget, MAX_BUDGET)
        : undefined,
  });

  if (!result.listed) {
    throw new SwellError(result.summary, { status: 400 });
  }

  return { message: result.summary };
}
