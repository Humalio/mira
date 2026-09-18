# Development

Use Node 24 and PostgreSQL 18, or the supplied Docker development stack.
See [contributing](../CONTRIBUTING.md) for commands and commit conventions.

## Initial database

`npm run db:init` creates the day-zero schema on an empty database. It executes
`database/schema.sql` atomically, including constraints, indexes and the storage
counter triggers. A schema fingerprint identifies completed setup; repeat startup
is a no-op. Setup refuses unrelated or older development databases and never
rewrites or deletes existing application records.

`src/lib/server/schema.ts` provides Drizzle's runtime types and query definitions.
Keep it consistent with `database/schema.sql`. There is no generated schema journal
or historical change chain. Changes to the baseline require a fresh development
database, never a reset of someone else's data.

## Tests

| Command                    | What it covers                                                                                                  | Needs                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `npm test`                 | Unit tests next to the code (`src/**/*.test.ts`): names, formats, storage, video handling, i18n, sign-in rules. | Nothing (video tests also need ffmpeg)  |
| `npm run test:integration` | Database tests (`src/**/*.db.test.ts`): accounts, albums, uploads, recovery, downloads, storage counters.       | `TEST_DATABASE_URL`                     |
| `npm run test:database`    | `scripts/init-db.test.mjs`: concurrent first start, restart, refusal of incompatible databases.                 | `TEST_DATABASE_URL` (creates databases) |
| `npm run test:smoke`       | `scripts/smoke.sh`: builds and boots the production server against `DATABASE_URL`.                              | A development database                  |

The database tests never use `DATABASE_URL`. `src/test/database.ts` creates a randomly
named database on the `TEST_DATABASE_URL` server, initializes it from
`database/schema.sql`, gives the run an empty media folder, and removes both at the
end. Test files run one after another because restart recovery and the deletion sweep
act on the whole database. Video tests skip without ffmpeg; set
`TEST_REQUIRE_FFMPEG=1` to make that an error, as the release check does.

## Verification

Run `sh scripts/verify-release.sh` from the repository root. It builds and checks
the source, runs all database tests on disposable PostgreSQL, audits production
dependencies, and boots the production image. Startup and repeated initialization
must work without changing stored records. OAuth callbacks need a separate test
with your configured provider.

The public version is defined in `package.json`, and the default image in
`deploy/compose.prod.yaml` names the same version (a unit test checks that they agree,
and the release workflow refuses a version the Compose file does not name). 0.1.0 is
the first release.
Dependency versions and npm's lockfile-format version describe tooling, not Mira.
