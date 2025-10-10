// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'Gruntwork Runbooks',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/gruntwork-io/runbooks' }],
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
