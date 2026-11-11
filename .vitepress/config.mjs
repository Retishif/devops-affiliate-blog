import { defineConfig } from 'vitepress'

export default defineConfig({
  title: "Cloud Native & DevOps Architecture",
  description: "Production-grade infrastructure blueprints, CI/CD pipelines, and observability guides.",
  themeConfig: {
    // Top navigation bar
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Terraform & IaC', link: '/terraform-cloud-alternative-gitlab-ci' }
    ],

    // Left-hand sidebar for easy reading
    sidebar: [
      {
        text: 'Infrastructure as Code',
        items: [
          { 
            text: 'Terraform Cloud Alternative with GitLab CI', 
            link: '/terraform-cloud-alternative-gitlab-ci' 
          }
        ]
      }
    ],

    // Adds an automatic "On this page" table of contents on the right
    outline: {
      level: 2,
      label: 'Architecture Sections'
    }
  }
})
