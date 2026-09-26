// archcheck-fixture: place-at apps/ethos/src/commands/archcheck-fixture.ts
//
// A CLI command throwing a raw Error instead of an EthosError with a code and an action.
export function refuse(): never {
  throw new Error('refused');
}
