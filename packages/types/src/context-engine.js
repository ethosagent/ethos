// E4 — Per-personality context engine.
//
// Pluggable strategy that decides how to compact a long conversation when it
// approaches the model's context window. Different personalities benefit from
// different policies — a coordinator doing multi-team synthesis cannot afford
// to lose the original task description (drop-oldest is wrong); a coach doing
// short reflection turns is fine with drop-oldest.
//
// Three concrete implementations ship in @ethosagent/core. Plugin authors can
// register custom engines via `EthosPluginApi.registerContextEngine`.
export {};
