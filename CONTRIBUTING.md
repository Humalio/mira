# Contributing to Mira

## Development

Requires Docker (or Node 24 with a local Postgres).

Before opening a pull request:

```sh
npm ci
npm run lint
npm run check
npm test
```

Changes that touch the database, uploads or downloads should also pass the database
tests. They need a disposable PostgreSQL server and never use `DATABASE_URL`: each run
creates its own database and media folder there and removes both afterwards.

```sh
TEST_DATABASE_URL=postgres://user:password@localhost:5432/postgres npm run test:integration
TEST_DATABASE_URL=postgres://user:password@localhost:5432/postgres npm run test:database
```

[Development](docs/DEVELOPMENT.md#tests) describes each suite.

After building the production image, `sh scripts/image-smoke.sh <image:tag>`
checks database initialization, HTTP startup, and termination on singleton-lock loss against
a throwaway database. Run `sh scripts/verify-release.sh` for the complete release validation.

```sh
docker compose -f compose.dev.yaml up   # http://localhost:5180, hot reload
```

`vite dev` does not run the production adapter-node server, so it cannot catch
boot-time issues. Before pushing, run the production boot smoke test:

```sh
docker compose -f compose.dev.yaml up -d db
./scripts/smoke.sh                       # builds and boots `node scripts/start.mjs`, asserts GET / -> 200
```

## Dependencies

`@auth/sveltekit` does not yet declare SvelteKit 3 support. `package.json` overrides its
peer requirement on `@sveltejs/kit`, and `vite.config.ts` rewrites the two places it still
relies on SvelteKit 2 (the removed `base` import from `$app/paths`, and redirects to the
sign-in service, which SvelteKit 3 only allows when marked external); remove both once a
release supports SvelteKit 3. adapter-node no longer reads `ORIGIN`, so the production
server starts through `scripts/start.mjs`, which applies it.

Dependabot proposes minor and patch updates weekly. TypeScript majors and Node.js
majors for the image are left for deliberate review; after updating dependencies, run
`sh scripts/verify-release.sh`.

## Commit messages

Commit messages become part of the public history, so write them for someone reading
the log later:

- **Subject:** what the change does, in the imperative mood and plain words, at most
  72 characters, no trailing period, for example `Keep the original beside the small
video copy`. No type prefix is needed.
- **Body** (optional): one blank line, then the _why_: motivation and non-obvious
  decisions, wrapped at about 72 columns. The diff shows the _what_; don't narrate it.
- One logical change per commit.

Example:

```
Explain the fresh-database requirement

Link the public setup guide from the error an occupied database prints.
```

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).
