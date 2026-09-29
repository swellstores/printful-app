/**
 * Lets the product sync, written for functions, run inside a workflow. A
 * workflow's request has no `appValues` and its client no `transaction`, so
 * transaction operations run one by one. The sync tolerates that: a step
 * retried after a partial write re-reads what is there before writing again.
 */
export function toSwellRequest(req: SwellWorkflowRequest): SwellRequest {
  const swell = req.swell as Record<string, any>;

  return {
    appId: req.appId,
    store: req.store,
    data: req.data,
    isLocalDev: false,
    appValues: (values: object) => ({ $app: { [req.appId]: values } }),
    swell: {
      ...swell,
      async transaction(ops: Array<{ method: string; url: string; data?: any }>) {
        for (const op of ops) {
          await swell[op.method](op.url, op.data);
        }
      },
    },
  } as unknown as SwellRequest;
}
