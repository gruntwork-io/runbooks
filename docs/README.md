# Runbooks docs

Runbooks docs are built on [Starlight](https://starlight.astro.build/).

## Running docs locally

We use [bun](https://bun.com/) as the Node runtime, so install bun first. Then run:

```
bun install
bun start
```

## Building docs

We build the docs site when we want to deploy it. It can also be helpful to build docs before you git commit to avoid test failures.

```
bun run build
```
