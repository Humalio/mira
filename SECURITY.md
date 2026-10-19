# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through
[GitHub's private vulnerability reporting](https://github.com/Humalio/mira/security/advisories/new)
with the steps to reproduce, the affected version or commit, and what an attacker could do.

You should get an answer within a week. Once a fix is released, the advisory is published
with credit to the reporter unless you ask otherwise.

## Supported versions

Only the latest [release](https://github.com/Humalio/mira/releases) receives security
fixes. Update to it before reporting, if you can.

## Scope

Mira is self-hosted: each copy is run by its own operator. Reports about the application
itself (sign-in, guest access, another album's photos and videos, uploads and downloads, the
administrator screen and the Docker image) are in scope. The security of a particular installation —
its reverse proxy, HTTPS, media storage, database backups and secrets — belongs to whoever runs it;
[the installation guide](docs/DEPLOYMENT.md) describes a safe setup.
