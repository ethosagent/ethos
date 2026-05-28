// In-session todo list — single-personality working memory. Lives in
// process memory only; no file is ever written. `/new` mints a fresh
// sessionKey so the prior list becomes unreachable without explicit
// cleanup. Durable multi-personality coordination is the kanban surface
// (separate plan); persistent single-agent notes go via memory_write.
export {};
