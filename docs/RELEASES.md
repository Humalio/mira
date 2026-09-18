# GitHub releases

GitHub CI verifies every public main commit and pull request. Release publication is manual.

1. Review and update `CHANGELOG.md` under `## [Unreleased]` with public, user-facing changes. Archive the previous approved release under its version heading before preparing the next one. Keep private operations and credentials out of notes.
2. On GitHub main, open Actions → GitHub Docker release → Run workflow. Enter a new stable version such as `0.1.0`.
3. The workflow validates the exact public source, smoke-tests its production image, and publishes `ghcr.io/humalio/mira:VERSION` and a full commit SHA tag for `linux/amd64`.
4. Review the draft GitHub Release and its notes. Publish the draft when ready. The release includes the Compose file, environment example, and a versioned changelog snapshot.
5. Copy approved notes into the canonical changelog before the next public source export. GitHub never writes back into the source repository.

Use a version or digest for deployment. There is no mutable `latest` tag and no automatic live deployment. Tags must never be reused. Keep a copy of the previous release's image digest and back up persistent data before updating; an old image alone does not undo a database change.

The repository and GHCR package must be public for anonymous downloads. Public repositories use GitHub's free standard hosted runners; private repositories consume the account's Actions allowance. The first GHCR publication may require an owner to set package visibility to public and confirm repository access in package settings. No personal registry token is needed: the workflow uses its short-lived GitHub token.

Source publication, repository visibility, private builds and live deployment remain separate operations.
