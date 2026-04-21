// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://gruntbooks.gruntwork.io',
	integrations: [
		starlight({
			title: 'Gruntwork Gruntbooks',
			logo: {
				src: './src/assets/gruntbooks_logo.svg',
				replacesTitle: true,
			},
			description: 'Documentation and guides for Gruntwork Gruntbooks',
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
						content: 'Gruntwork Gruntbooks Documentation',
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
				label: 'Authoring Gruntbooks',
				collapsed: true,
				items: [
					'authoring/overview',
					'authoring/gruntbook-structure',
					'authoring/markdown',
					'authoring/inputs-and-outputs',
					'authoring/opening-gruntbooks',
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
					label: 'Gruntbooks Pro',
					autogenerate: { directory: 'pro' },
					collapsed: true,
				},
			],
		}),
	],
});
