import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'Cloud Native & DevOps Architecture',
  description: 'Practical infrastructure, Terraform, CI/CD, and observability guides for DevOps engineers.',
  ignoreDeadLinks: true,
  head: [
    ['meta', { name: 'google-site-verification', content: 'fwyKlyeNRyzY5nPrCs6tpvdjhO8ghfy7Oll4bHRHseI' }],
    ['meta', { name: 'theme-color', content: '#ffffff' }]
  ],
  themeConfig: {
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Terraform & IaC', link: '/terraform-cloud-alternative-gitlab-ci' },
      { text: 'About', link: '/about' },
      { text: 'Disclosure', link: '/affiliate-disclosure' },
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
        text: 'About this site',
        items: [
          { text: 'About', link: '/about' },
          { text: 'Affiliate Disclosure', link: '/affiliate-disclosure' },
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
      message: 'Independent technical content. Verify provider documentation and pricing before production use.',
      copyright: 'Copyright © 2026 Cloud Native & DevOps Architecture'
    }
  }
})
