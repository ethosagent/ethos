// archcheck-fixture: place-at plugins/archcheck-fixture/src/index.ts
//
// l3-wiring-composes carries `catchesUnlayered`, so the violation it owns is a file no layer
// declares. plugins/*/src is inside the root tsconfig include but matches no layer — a new
// top-level folder nobody placed in the layer model.
export const unlayered = true;
