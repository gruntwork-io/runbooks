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
					label: 'Setup & installation',
					autogenerate: { directory: 'setup' },
				},
				{
					label: 'CLI',
					autogenerate: { directory: 'commands' },
				},
			{
				label: 'Authoring Runbooks',
				items: [
					'authoring/overview',
					'authoring/markdown',
					'authoring/workflow',
					{
						label: 'Blocks', // Customize this to whatever you want
						autogenerate: { directory: 'authoring/blocks' },
					},
				],
			},
				{
					label: 'Development',
					autogenerate: { directory: 'development' },
				},
				{
					label: 'Runbooks Pro',
					autogenerate: { directory: 'pro' },
				},
			],
		}),
	],
});
