// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://runbooks.gruntwork.io',
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
			Header: './src/components/Header.astro',
			Footer: './src/components/Footer.astro',
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
					items: [{ autogenerate: { directory: 'intro' } }],
				},
				{
					label: 'App & CLI',
					collapsed: true,
					items: [{ autogenerate: { directory: 'commands' } }],
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
						items: [{ autogenerate: { directory: 'authoring/blocks' } }],
					},
				],
			},
				{
					label: 'Security',
					collapsed: true,
					items: [{ autogenerate: { directory: 'security' } }],
				},
				{
					label: 'Development',
					collapsed: true,
					items: [{ autogenerate: { directory: 'development' } }],
				},
				{
					label: 'Runbooks Pro',
					collapsed: true,
					items: [{ autogenerate: { directory: 'pro' } }],
				},
			],
		}),
	],
});
