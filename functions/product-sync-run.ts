import { getSettings } from "./lib/settings";
import { runProductSync } from "./lib/products";

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

  return runProductSync(req, settings, {
    budget: Number.isFinite(budget) && budget > 0 ? budget : undefined,
  });
}
