// Test-only stand-in for `$app/env/private`, which only exists inside the SvelteKit
// Vite plugin. Like the real module it carries the private variables declared in
// src/env.ts, read once when first imported (src/test/database-env.ts sets MEDIA_DIR
// before any application module loads). Wired up in vitest.config.ts.
export const MEDIA_DIR: string | undefined = process.env.MEDIA_DIR;
