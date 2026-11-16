import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Cloud Native Craft',
  description: 'Practical infrastructure, Terraform, CI/CD, and observability guides for DevOps engineers.',
  ignoreDeadLinks: true,
  srcExclude: ['business/**'],
  markdown: {
    config(md) {
      // Mark affiliate/referral links as rel="sponsored" (see the Affiliate Disclosure page).
      const defaultRender =
        md.renderer.rules.link_open ||
        ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options))
      md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const html = defaultRender(tokens, idx, options, env, self)
        const href = tokens[idx].attrGet('href') || ''
        if (!/[?&](ref|aff|affiliate|aff_id)=|awin1\.com\/cread\.php/i.test(href)) return html
        const rel = 'sponsored noopener noreferrer'
        return /\srel="[^"]*"/.test(html)
          ? html.replace(/(\srel=")[^"]*(")/, `$1${rel}$2`)
          : html.replace(/^<a/, `<a rel="${rel}"`)
      }
    }
  },
  sitemap: {
    hostname: 'https://cloudnativecraft.com'
  },
  head: [
    ['meta', { name: 'google-site-verification', content: 'fwyKlyeNRyzY5nPrCs6tpvdjhO8ghfy7Oll4bHRHseI' }],
    ['meta', { name: 'google-site-verification', content: 'P5SR0wJajXYmB2WQUZhu-ZLjtqKrbxi4LGRyQqGiZb8' }],
    ['meta', { name: 'theme-color', content: '#ffffff' }]
  ],
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Terraform & IaC', link: '/terraform-cloud-alternative-gitlab-ci' },   
      { text: 'Observability', link: '/datadog-alternative-grafana-loki-prometheus' },
      { text: 'About', link: '/about' },
      { text: 'Advertising & Affiliate Disclosure', link: '/affiliate-disclosure' },
      { text: 'Contact', link: '/contact' }
    ],
    sidebar: [
      {
        text: 'Infrastructure as Code',
        items: [
          {
            text: 'Terraform Cloud Alternative with GitLab CI',
            link: '/terraform-cloud-alternative-gitlab-ci'
          }
        ]
      },
      {
        text: 'Observability & Operations',
        items: [
          {
            text: 'Datadog Alternative with Grafana, Loki, and Prometheus',
            link: '/datadog-alternative-grafana-loki-prometheus'
          },
          {
            text: 'How Much Does Datadog Really Cost at Scale?',
            link: '/datadog-cost-at-scale'
          }
        ]
      },
      {
        text: 'About this site',
        items: [
          { text: 'About', link: '/about' },
          { text: 'Advertising & Affiliate Disclosure', link: '/affiliate-disclosure' },
          { text: 'Contact', link: '/contact' }
        ]
      }
    ],
    outline: {
      level: [2, 3],
      label: 'On this page'
    },
    socialLinks: [
      { icon: 'github', link: 'https://github.com/Retishif/devops-affiliate-blog' }
    ],
    footer: {
      message: 'Advertising Disclosure: Cloud Native Craft is reader-supported. When you buy or sign up through links on this site, we may earn an affiliate commission or advertising fee at no additional cost to you. Opinions and technical evaluations remain our own.',
      copyright: 'Copyright © 2026 Cloud Native Craft'
    }
  }
})
