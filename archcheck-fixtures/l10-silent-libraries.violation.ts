// archcheck-fixture: place-at packages/config/src/archcheck-fixture.ts
//
// Library code printing to the console instead of using the injected Logger.
export function warnLoudly(message: string): void {
  console.warn(message);
}
