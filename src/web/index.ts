// Remote (HTTP+SSE) taskgraph execution — framework-agnostic core.
//
// - `shared.ts`: protocol types (`RunId`, snapshots, ordered events).
// - `transport.ts`: `Requester` / `EventStream` abstractions + SSE codec.
// - `backend.ts`: `RemoteRunnerRegistry` (non-singleton runner management).
// - `http.ts`: `handleRemoteRequest` (standard `Request`/`Response` mapping).
// - `client.ts`: `RemoteRunnerClient` (workstatuses + evolution).

export * from './shared.js'
export * from './transport.js'
export * from './backend.js'
export * from './http.js'
export * from './client.js'
