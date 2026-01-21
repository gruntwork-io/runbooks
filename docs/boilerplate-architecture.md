# How boilerplate templates are rendered

## Overview

Runbooks provides dynamic boilerplate template rendering with live variable substitution in runbook MDX files. It consists of three main components working together with a shared context for variable propagation.

## Core Components

### 1. `<Inputs>`

**Location:** `web/src/components/mdx/Inputs/`

**Purpose:** Renders a dynamic form based on inline `boilerplate.yml` content to collect variable values.

**Props:**
```tsx
interface InputsProps {
  id: string          // Unique identifier (required)
  children?: ReactNode // Inline boilerplate.yml content
}
```

**Key Responsibilities:**
- Parse inline YAML from `children`
- Render dynamic form based on variable definitions
- Publish variables to `RunbookContext`
- Handle auto-updates on form changes (debounced)

### 2. `<Template>`

**Location:** `web/src/components/mdx/Template/`

**Purpose:** Generates files from a boilerplate template directory.

**Props:**
```tsx
interface TemplateProps {
  id: string                    // Unique identifier (required)
  path: string                  // Path to template directory (required)
  inputsId?: string | string[]  // Import variables from Inputs/Template blocks
}
```

**Key Responsibilities:**
- Load `boilerplate.yml` from disk (`path`)
- Render dynamic form for template variables
- Import variables from referenced `inputsId` sources
- Handle three variable categories:
  - **Local-only:** Editable in form
  - **Imported-only:** Passed through to template (not shown in form)
  - **Shared:** Read-only, live-synced from imported sources
- Generate files via `/api/boilerplate/render`
- Auto-render after initial generation (debounced)

### 3. `<TemplateInline>`

**Location:** `web/src/components/mdx/TemplateInline/`

**Purpose:** Renders inline template content with variable substitution, optionally saving to workspace.

**Props:**
```tsx
interface TemplateInlineProps {
  inputsId?: string | string[]  // Import variables from Inputs/Template blocks
  outputPath?: string            // File path for output
  generateFile?: boolean         // Save to workspace (default: false)
  children?: ReactNode           // Template content with {{ .var }} syntax
}
```

**Key Responsibilities:**
- Extract template content from inline code blocks
- Import variables from referenced `inputsId` sources
- Render template via `/api/boilerplate/render-inline`
- Auto-update when variables change (debounced)
- Optionally save rendered files to workspace

## Context Architecture

### RunbookContext

**Location:** `web/src/contexts/RunbookContext.tsx`

**Purpose:** Share variable values, boilerplate configs, and block outputs across components.

**State:**
```tsx
{
  blockInputs: Record<string, {
    values: Record<string, unknown>
    config: BoilerplateConfig
  }>,
  blockOutputs: Record<string, {
    values: Record<string, string>
    timestamp: string
  }>
}
```

**API:**
```tsx
{
  registerInputs: (id, values, config) => void
  getInputs: (inputsId) => InputValue[]
  registerOutputs: (blockId, values) => void
  getOutputs: (blockId) => OutputValue[] | undefined
  getTemplateVariables: (inputsId?) => Record<string, unknown>
}
```

**Hooks:**
```tsx
// Access full context
const { registerInputs, registerOutputs } = useRunbookContext()

// Get inputs for API requests (handles single ID or array)
const inputs = useInputs(inputsId)

// Get template variables (includes _blocks namespace for outputs)
const templateVars = useTemplateVariables(inputsId)

// Get outputs from a specific block
const outputs = useOutputs(blockId)
```

### FileTreeContext

**Location:** `web/src/contexts/FileTreeContext.tsx`

**Purpose:** Global file tree for all generated files.

**State:**
```tsx
{
  fileTree: FileTreeNode[] | null
}
```

## Rendering Flow

### Template File Generation

```
┌─────────────────────────────────────────────────────┐
│ 1. User fills form and clicks Generate             │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 2. Template.handleGenerate()                       │
│    - Merge imported + local variables              │
│    - Register values to RunbookContext             │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 3. POST /api/boilerplate/render                    │
│    - Process template directory with variables     │
│    - Write files to output directory               │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 4. Backend returns complete file tree              │
│    - All files in output directory                 │
│    - Files accumulate across renders               │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 5. setFileTree(response.fileTree)                  │
│    - Simple replace (backend is source of truth)   │
└─────────────────────────────────────────────────────┘
```

### TemplateInline Rendering

```
┌─────────────────────────────────────────────────────┐
│ 1. Inputs block publishes variables to context     │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 2. TemplateInline detects variable change          │
│    - useTemplateVariables(inputsId)                │
│    - Check all required variables present          │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 3. POST /api/boilerplate/render-inline             │
│    - Send template content + variables             │
│    - If generateFile: copy to output directory     │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 4. Display rendered content inline                 │
│    - If generateFile: update file tree             │
└─────────────────────────────────────────────────────┘
```

## Backend API

### GET `/api/boilerplate/config`

Load and parse `boilerplate.yml`.

**Request:**
```json
{
  "templatePath": "./templates",
  "boilerplateContent": "variables..."
}
```

**Response:**
```json
{
  "variables": [
    {
      "name": "region",
      "type": "string",
      "description": "AWS region",
      "default": "us-west-2"
    }
  ],
  "rawYaml": "variables:\n  - name: region\n..."
}
```

### POST `/api/boilerplate/render`

Render file-based templates from disk.

**Request:**
```json
{
  "templatePath": "./templates",
  "variables": {
    "region": "us-east-1"
  }
}
```

**Response:**
```json
{
  "message": "Template rendered successfully",
  "outputDir": "/path/to/output",
  "templatePath": "/path/to/templates",
  "fileTree": [...]
}
```

### POST `/api/boilerplate/render-inline`

Render inline template content.

**Request:**
```json
{
  "templateFiles": {
    "boilerplate.yml": "variables:\n  - name: region\n...",
    "config.hcl": "region = \"{{ .region }}\""
  },
  "variables": {
    "region": "us-east-1"
  },
  "generateFile": true
}
```

**Response:**
```json
{
  "renderedFiles": {
    "config.hcl": {
      "name": "config.hcl",
      "path": "config.hcl",
      "content": "region = \"us-east-1\"",
      "language": "hcl"
    }
  },
  "fileTree": [...]
}
```

## Key Design Patterns

### 1. Simple Replace for File Tree

The backend is the source of truth for the output directory. Files accumulate across renders (not cleared), and the backend returns the complete tree after each render. The frontend simply replaces its state:

```tsx
// Backend returns complete output directory tree
setFileTree(renderResult.fileTree)
```

### 2. Variable Propagation

Components publish variables to context, downstream components subscribe:

```tsx
// Publisher (Inputs, Template)
registerInputs(id, values, config)

// Subscriber (Template, TemplateInline, Command, Check)
const inputs = useInputs(inputsId)
const templateVars = useTemplateVariables(inputsId)
```

### 3. Debouncing

Prevents excessive API calls during rapid user input:

```tsx
// Form changes: 200ms debounce
autoRenderTimerRef.current = setTimeout(() => {
  autoRender(formData)
}, 200)

// Template updates: 300ms debounce  
autoUpdateTimerRef.current = setTimeout(() => {
  renderTemplate(variables)
}, 300)
```

### 4. Referential Stability

Context hooks maintain stable references to prevent infinite loops:

```tsx
// useInputs returns stable EMPTY_INPUTS when no inputsId
const EMPTY_INPUTS: InputValue[] = []

// registerInputs performs shallow comparison before updating state
if (unchanged) return prevState
```

## Variable Categories in Template

When a `<Template>` imports variables via `inputsId`:

| Category | In Template | In Imported | Form Behavior |
|----------|-------------|-------------|---------------|
| Local-only | ✅ | ❌ | Editable |
| Imported-only | ❌ | ✅ | Not shown, passed to engine |
| Shared | ✅ | ✅ | Read-only, live-synced |

## References

- **Boilerplate Library:** [gruntwork-io/boilerplate](https://github.com/gruntwork-io/boilerplate)
- **Block Documentation:** `/docs/src/content/docs/authoring/blocks/`
