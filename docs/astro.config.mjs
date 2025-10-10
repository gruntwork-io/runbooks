// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	site: 'https://runbooks.gruntwork.io',
	integrations: [
		starlight({
			title: 'Gruntwork Runbooks',
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
				// Keep default components
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
					'authoring/authoring_workflow',
					'authoring/markdown',
					{
						label: 'Blocks', // Customize this to whatever you want
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
