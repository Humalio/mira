# Project website

The introduction and hosting walkthrough live in `site/`. GitHub Pages hosts these
static files; the album application runs separately with PostgreSQL and media storage.

In `Humalio/mira`, choose **GitHub Actions** under **Settings → Pages**, then run
**Publish Mira website** or push a site change to main. Use the URL reported by
the workflow's environment. The workflow uploads only `site/`.

Preview the site at both `/` and `/mira/`. Check mobile and desktop widths,
keyboard navigation and relative asset links. Public setup instructions link to
[the deployment guide](DEPLOYMENT.md). Photography/font credits are in
[site/credits.html](../site/credits.html).
