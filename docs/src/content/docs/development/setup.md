---
title: Development Setup
sidebar:
   order: 1
---

If you want to contribute to Runbooks or modify the frontend:

1. Install Bun:
   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

2. Install frontend dependencies:
   ```bash
   cd web
   bun install
   ```

3. Start the frontend dev server:
   ```bash
   bun dev
   ```

4. In a separate terminal, start the backend:
   ```bash
   go run main.go serve /path/to/runbook
   ```

Now you can make changes to the React code in `/web` or to the backend Go code!
