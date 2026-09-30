/**
 * Lets the product sync, written for functions, run inside a workflow, whose
 * request has no `appValues`.
 */
export function toSwellRequest(req: SwellWorkflowRequest): SwellRequest {
  return {
    appId: req.appId,
    store: req.store,
    data: req.data,
    isLocalDev: false,
    appValues: (values: object) => ({ $app: { [req.appId]: values } }),
    swell: req.swell,
  } as unknown as SwellRequest;
}
