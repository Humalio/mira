// Test-only stand-in for `$app/env/public`: the public variables declared in
// src/env.ts. Tests that change one between cases mock this module with a getter.
export const PUBLIC_ORIGIN: string | undefined = process.env.PUBLIC_ORIGIN;
