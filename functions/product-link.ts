import { getSettings } from "./lib/settings";
import { linkProduct, unlinkProduct } from "./lib/products";
import {
  ALREADY_RUNNING,
  FUNCTION_LEASE_SECONDS,
  releaseLease,
  takeLease,
} from "./lib/lease";

export const config: SwellConfig = {
  description:
    "Link a product made in Swell to its Printful product, or unlink it, from its page in the Swell admin",
  action: {},
};

export async function post(req: SwellRequest) {
  const settings = await getSettings(req);

  if (!settings.api_token) {
    throw new SwellError("Add your Printful API token in the app settings first.", {
      status: 400,
    });
  }

  const action = req.data.$action ?? {};

  // A sync running at the same time writes the same links
  const owner = `link:${new Date().toISOString()}`;

  if (!(await takeLease(req, owner, FUNCTION_LEASE_SECONDS)).taken) {
    throw new SwellError(ALREADY_RUNNING, { status: 409 });
  }

  try {
    const message =
      action.id === "unlink"
        ? await unlinkProduct(req, action.record_id)
        : await linkProduct(req, settings, action.record_id, req.data.printful_product);

    return { message };
  } catch (err) {
    throw new SwellError(err instanceof Error ? err.message : String(err), {
      status: 400,
    });
  } finally {
    // The lease runs out on its own, so failing to let go of it must not fail
    // the action
    await releaseLease(req, owner).catch((err) =>
      console.log("Could not release the Printful sync lease", err),
    );
  }
}
