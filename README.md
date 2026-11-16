# Cloud Native Craft

Source for [cloudnativecraft.com](https://cloudnativecraft.com): engineering guides on replacing expensive DevOps platforms with open, self-hosted tooling. Each guide ships with commands and pipeline code you can copy.

| Guide | What it covers |
|---|---|
| [Terraform Cloud alternative with GitLab CI](https://cloudnativecraft.com/terraform-cloud-alternative-gitlab-ci) | GitLab-managed state, OIDC auth, encrypted plans, gated apply, drift detection |
| [Migrating from HCP Terraform to GitLab CI](https://cloudnativecraft.com/migrating-hcp-terraform-to-gitlab-ci) | State, workspace, and variable migration with verification and rollback |
| [Datadog alternative with Grafana, Loki, and Prometheus](https://cloudnativecraft.com/datadog-alternative-grafana-loki-prometheus) | Self-hosted observability stack and trade-offs |
| [What Datadog costs at scale](https://cloudnativecraft.com/datadog-cost-at-scale) | Cost model for host, log, and custom-metric pricing |

## Repository layout

```text
.
├── *.md                          # Site pages and guides (VitePress, one file per URL)
├── index.md                      # Home page
├── .vitepress/
│   └── config.mjs                # Site config: nav, sidebar, sitemap, link rules
├── public/                       # Static files copied as-is (robots.txt, ...)
├── blueprints/
│   └── gitlab-terraform/         # Copy-paste pipeline from the Terraform guides
│       ├── .gitlab-ci.yml
│       ├── ci/observability.gitlab-ci.yml
│       └── README.md
├── package.json                  # docs:dev, docs:build, docs:preview
└── package-lock.json
```

### `blueprints/`

Standalone, working files that the guides explain. They are not part of the website. The folder is excluded from the site build, so nothing in it is published as a page. See [`blueprints/gitlab-terraform/README.md`](blueprints/gitlab-terraform/README.md) for setup and the CI/CD variables it needs.

### VitePress configuration

[`.vitepress/config.mjs`](.vitepress/config.mjs) holds the site's behavior:

- **Navigation and sidebar:** a new guide appears on the site once its page is added to the sidebar group.
- **Sitemap:** generated at build time for `https://cloudnativecraft.com`.
- **`srcExclude`:** excludes `blueprints/` from the site.
- **Affiliate links:** a markdown rule adds `rel="sponsored noopener noreferrer"` to affiliate URLs (Awin and `?ref=` referral links) automatically, so authors don't tag them by hand.

## Run locally

Requires Node.js 18 or newer.

```bash
npm ci
npm run docs:dev        # dev server with hot reload
npm run docs:build      # production build into .vitepress/dist
npm run docs:preview    # serve the production build locally
```

Before pushing, build once with dead-link checking on. Set `ignoreDeadLinks: false` in the config temporarily and confirm `npm run docs:build` finishes without errors.

## Deployment

The site is hosted on Cloudflare Pages, connected to this GitHub repository. A push to the default branch triggers a production build and deploy. Pull request branches get preview deployments if enabled in the Pages project.

| Setting | Value |
|---|---|
| Build command | `npm run docs:build` |
| Output directory | `.vitepress/dist` |
| Node.js | 18 or newer |

Treat this as a checklist for the Pages project settings. Those settings live in the Cloudflare dashboard, not in this repository.

## Editorial and affiliate policy

Some guides contain affiliate links to DigitalOcean and Vultr. Every page with such links opens with a disclosure, each link is labelled "(affiliate)", and links carry `rel="sponsored"`. Technical conclusions are written independently of any commission. Full policy: [Advertising & Affiliate Disclosure](https://cloudnativecraft.com/affiliate-disclosure).

## Using the code

The blueprints are meant to be copied into your own repositories. A license has not been added yet; until one is, the default is all rights reserved. Open an issue if you want to reuse the code beyond your own infrastructure.

## Contact

Questions or corrections: see the [contact page](https://cloudnativecraft.com/contact) or [open an issue](https://github.com/Retishif/devops-affiliate-blog/issues).
