// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://runbooks.gruntwork.io',
	// This redirect is kept as a fallback in case the CDN-level redirect (configured in vercel.json)
	// fails or is not applied. For optimal performance, CDN-level redirecting is preferred.
	redirects: {
		'/': '/intro/overview/',
	},
	integrations: [
		starlight({
			title: 'Gruntwork Runbooks',
			logo: {
				src: './src/assets/runbooks_logo.svg',
				replacesTitle: true,
			},
			description: 'Documentation and guides for Gruntwork Runbooks',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/gruntwork-io/runbooks' }],
			customCss: [
				'./src/styles/custom.css',
			],
			defaultLocale: 'root',
			locales: {
				root: {
					label: 'English',
					lang: 'en',
				},
			},
		components: {
			Head: './src/components/Head.astro',
		},
			head: [
				{
					tag: 'meta',
					attrs: {
						property: 'og:title',
						content: 'Gruntwork Runbooks Documentation',
					},
				},
			],
			editLink: {
				baseUrl: 'https://github.com/gruntwork-io/runbooks/edit/main/docs/',
			},
			sidebar: [
				{
					label: 'Intro',
					autogenerate: { directory: 'intro' },
				},
				{
					label: 'CLI',
					autogenerate: { directory: 'commands' },
					collapsed: true,
				},
			{
				label: 'Authoring Runbooks',
				collapsed: true,
				items: [
					'authoring/overview',
					'authoring/runbook-structure',
					'authoring/markdown',
					'authoring/inputs-and-outputs',
					'authoring/opening-runbooks',
					'authoring/boilerplate',
					'authoring/testing',
					{
						label: 'Blocks',
						autogenerate: { directory: 'authoring/blocks' },
					},
				],
			},
				{
					label: 'Security',
					autogenerate: { directory: 'security' },
					collapsed: true,
				},
				{
					label: 'Development',
					autogenerate: { directory: 'development' },
					collapsed: true,
				},
				{
					label: 'Runbooks Pro',
					autogenerate: { directory: 'pro' },
					collapsed: true,
				},
			],
		}),
	],
});
