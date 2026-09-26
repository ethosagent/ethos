// archcheck-fixture: verified-by "the fixture obligation fires when a fixture is missing"
//
// This rule cannot be violated by placing a file: its violation is a manifest declaring an
// error-severity rule with no fixture, a property of the manifest rather than of any file in the
// tree. The named test in packages/types/src/__tests__/archcheck-fixtures.test.ts removes a
// fixture from a scratch copy and asserts this rule fires.
export const verifiedByATestInstead = true;
