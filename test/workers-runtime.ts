// Node unit tests do not run inside workerd. Runtime integration is checked
// separately with wrangler; these are inert stand-ins, not Workers emulation.
export class RpcTarget {}
export class DurableObject {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {}
export const env = {}
