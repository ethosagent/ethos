// Minimal observability surface AgentLoop expects — defined locally so core
// does not import the concrete `EthosObservability` adapter (that lives in
// `@ethosagent/wiring`). Any object exposing this method shape is a fit;
// `EthosObservability` satisfies it structurally at the wiring boundary.
export {};
