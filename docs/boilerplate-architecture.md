# How boilerplate templates are rendered

## Overview

Runbooks provides dynamic boilerplate template rendering with live variable substitution in runbook MDX files. It consists of three React components working together with a coordinator pattern to support inline templates, file-based templates, or a combination of both.

## Core Components

### 1. `<BoilerplateInputs>`

**Location:** `web/src/components/mdx/BoilerplateInputs/`

**Purpose:** Renders a dynamic form based on a `boilerplate.yml` configuration file.

**Props:**
```tsx
interface BoilerplateInputsProps {
  id: string                              // Unique identifier (required)
  templatePath?: string                   // Path to templates directory
  prefilledVariables?: Record<string, unknown>
  onGenerate?: (variables: Record<string, unknown>) => void
  children?: ReactNode                    // Inline boilerplate.yml content
}
```

**Key Responsibilities:**
- Load `boilerplate.yml` from disk (`templatePath`) or inline (`children`)
- Render dynamic form based on variable definitions
- Publish variables to `BoilerplateVariablesContext`
- Trigger coordinator for inline templates
- Trigger file-based rendering if `templatePath` exists
- Handle auto-rendering on form changes (debounced)

### 2. `<BoilerplateTemplate>`

**Location:** `web/src/components/mdx/BoilerplateTemplate/`

**Purpose:** Renders an inline template with variable substitution.

**Props:**
```tsx
interface BoilerplateTemplateProps {
  boilerplateInputsId: string    // Links to BoilerplateInputs.id
  outputPath?: string             // Path for generated file
  children?: ReactNode            // Template content with {{ .var }} syntax
}
```

**Key Responsibilities:**
- Register with coordinator on mount
- Extract template variables from content
- Render template via `/api/boilerplate/render-inline`
- Auto-update when variables change (debounced)
- Display "waiting" state until first render

**Lifecycle States:**
- `waiting` - Initial state, shows placeholder message
- `rendered` - After first render, enables reactive auto-updates

### 3. `BoilerplateRenderCoordinator`

**Location:** `web/src/contexts/BoilerplateRenderCoordinator.tsx`

**Purpose:** Orchestrates atomic rendering across multiple template components.

**API:**
```tsx
interface BoilerplateRenderCoordinatorContextValue {
  registerTemplate: (registration: TemplateRegistration) => () => void
  renderAllForInputsId: (inputsId: string, variables: Record<string, unknown>) => Promise<void>
}

interface TemplateRegistration {
  templateId: string   // Unique ID (e.g., "myform-/output.hcl")
  inputsId: string     // BoilerplateInputs ID
  renderFn: (variables: Record<string, unknown>) => Promise<FileTreeNode[]>
}
```

**Key Responsibilities:**
- Maintain registry of active templates
- Render all templates for an inputsId atomically
- Merge file trees from multiple templates
- Isolate errors (one template failure doesn't break others)

## Rendering Modes

### Mode 1: Inline-Only Templates

Load YAML from inline content, render inline templates.

```tsx
<BoilerplateInputs id="myform">
  {`
variables:
  - name: region
    type: string
  `}
</BoilerplateInputs>

<BoilerplateTemplate boilerplateInputsId="myform" outputPath="/config.hcl">
  region = "{{ .region }}"
</BoilerplateTemplate>
```

**Flow:**
1. YAML parsed from `children`
2. Form rendered with variables
3. Click Generate → coordinator renders inline template
4. No file-based rendering

### Mode 2: File-Based Templates

Load YAML and templates from disk.

```tsx
<BoilerplateInputs id="myform" templatePath="./terraform-templates" />
```

**Flow:**
1. Load `./terraform-templates/boilerplate.yml`
2. Form rendered with variables
3. Click Generate → `/api/boilerplate/render` processes all templates in directory
4. No coordinator involvement (no inline templates)

### Mode 3: Mixed Mode

Load YAML from disk, render both file-based and inline templates.

```tsx
<BoilerplateInputs id="myform" templatePath="." />

<BoilerplateTemplate boilerplateInputsId="myform" outputPath="/config.hcl">
  region = "{{ .region }}"
</BoilerplateTemplate>
```

**Flow:**
1. Load `./boilerplate.yml` from disk
2. Form rendered with variables
3. Click Generate → coordinator renders inline template(s)
4. Also call `/api/boilerplate/render` for file-based templates
5. Both file trees merged

## Rendering Flow

### Initial Render (Click "Generate")

```
┌─────────────────────────────────────────────────────┐
│ 1. User clicks Generate button                     │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 2. BoilerplateInputs.handleGenerate()              │
│    - Publishes variables to context                │
│    - Calls renderAllForInputsId()                  │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 3. Coordinator finds registered templates          │
│    - Filters by inputsId                           │
│    - Returns early if none found                   │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 4. Render templates in parallel (Promise.all)      │
│    - Each calls POST /api/boilerplate/render-inline│
│    - Returns FileTreeNode[] per template           │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 5. Coordinator merges file trees atomically        │
│    - Uses functional update for safety             │
│    - Updates FileTreeContext                       │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 6. If templatePath exists                          │
│    - Call POST /api/boilerplate/render             │
│    - Merge file-based templates                    │
└─────────────────────────────────────────────────────┘
```

### Auto-Update Flow (Type in Form)

```
┌─────────────────────────────────────────────────────┐
│ 1. User types in form field                        │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 2. BoilerplateInputs.handleAutoRender()            │
│    - Debounce 200ms                                │
│    - Publishes variables to context                │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 3. BoilerplateTemplate.useEffect detects change    │
│    - Only if renderState === 'rendered'            │
│    - Check variables actually changed (JSON.stringify)│
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 4. Template auto-update                            │
│    - Debounce 300ms                                │
│    - Call POST /api/boilerplate/render-inline      │
│    - Mark as auto-update (no loading spinner)      │
└────────────────────┬────────────────────────────────┘
                     ↓
┌─────────────────────────────────────────────────────┐
│ 5. Update file tree atomically                     │
│    - Functional update avoids stale closure        │
│    - UI updates with new values                    │
└─────────────────────────────────────────────────────┘
```

## Context Architecture

### BoilerplateVariablesContext

**Location:** `web/src/contexts/BoilerplateVariablesContext.tsx`

**Purpose:** Share variables, configs, and YAML content across components.

**State:**
```tsx
{
  variablesByInputsId: Record<string, Record<string, unknown>>
  configByInputsId: Record<string, BoilerplateConfig>
  yamlContentByInputsId: Record<string, string>
}
```

**API:**
```tsx
{
  setVariables: (inputsId: string, variables: Record<string, unknown>) => void
  setConfig: (inputsId: string, config: BoilerplateConfig) => void
  setYamlContent: (inputsId: string, yaml: string) => void
}
```

### BoilerplateRenderCoordinator

**Location:** `web/src/contexts/BoilerplateRenderCoordinator.tsx`

**Purpose:** Coordinate atomic rendering across multiple templates.

**State:**
```tsx
{
  registrations: TemplateRegistration[]
}
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

## Backend API

### GET `/api/boilerplate/config`

Load and parse `boilerplate.yml`.

**Request:**
```json
{
  "templatePath": "./templates",        // Load from disk
  "boilerplateContent": "variables..." // OR inline content
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
  "outputDir": "/tmp/boilerplate-output-xyz",
  "templatePath": "/path/to/templates",
  "fileTree": [
    {
      "name": "main.tf",
      "path": "/main.tf",
      "type": "file",
      "content": "...",
      "language": "hcl"
    }
  ]
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
  }
}
```

**Response:**
```json
{
  "renderedFiles": {
    "config.hcl": {
      "name": "config.hcl",
      "path": "/config.hcl",
      "content": "region = \"us-east-1\"",
      "language": "hcl"
    }
  },
  "fileTree": [...]
}
```

## Key Design Patterns

### 1. Publish-Subscribe

**BoilerplateInputs** publishes variables → **BoilerplateTemplate** subscribes.

```tsx
// Publisher
const handleGenerate = (formData) => {
  setVariables(inputsId, formData)  // Publish
  await renderAllForInputsId(inputsId, formData)
}

// Subscriber
useEffect(() => {
  if (renderState === 'rendered' && contextVariables) {
    // Auto-update when variables change
    renderTemplate(contextVariables, true)
  }
}, [contextVariables])
```

### 2. Debouncing

Prevents excessive API calls during rapid user input.

```tsx
// Form changes: 200ms debounce
autoRenderTimerRef.current = setTimeout(() => {
  setVariables(inputsId, formData)
}, 200)

// Template updates: 300ms debounce  
autoUpdateTimerRef.current = setTimeout(() => {
  renderTemplate(contextVariables, true)
}, 300)
```

**Why different delays?**
- Form: 200ms (faster response)
- Template: 300ms (let form settle first)

### 3. Functional State Updates

Avoids stale closure bugs with async operations.

```tsx
// ❌ BAD: Stale closure
setFileTree(mergeFileTrees(fileTree, newTree))

// ✅ GOOD: Functional update
setFileTree(currentTree => mergeFileTrees(currentTree, newTree))
```

### 4. Error Isolation

One template failure doesn't break others.

```tsx
const fileTreePromises = templates.map(async (template) => {
  try {
    return await template.renderFn(variables)
  } catch (error) {
    console.error(`Template ${template.templateId} failed:`, error)
    return []  // Return empty, let others succeed
  }
})
```

### 5. Registration Pattern

Templates register/unregister automatically.

```tsx
useEffect(() => {
  const unregister = registerTemplate({
    templateId: `${boilerplateInputsId}-${outputPath}`,
    inputsId: boilerplateInputsId,
    renderFn: renderTemplate
  })
  
  return unregister  // Cleanup on unmount
}, [boilerplateInputsId, outputPath, registerTemplate, renderTemplate])
```

## Common Patterns & Best Practices

### Adding a New Template Component

1. Import the coordinator hook:
```tsx
import { useBoilerplateRenderCoordinator } from '@/contexts/useBoilerplateRenderCoordinator'
```

2. Register on mount:
```tsx
const { registerTemplate } = useBoilerplateRenderCoordinator()

useEffect(() => {
  const unregister = registerTemplate({
    templateId: uniqueId,
    inputsId: boilerplateInputsId,
    renderFn: async (variables) => {
      // Render logic
      return fileTree
    }
  })
  return unregister
}, [dependencies])
```

### Debugging Rendering Issues

1. **Enable debug logging** - Uncomment `console.log` statements in:
   - `BoilerplateInputs.tsx` → handleGenerate, handleAutoRender
   - `BoilerplateTemplate.tsx` → renderTemplate, auto-update effect
   - `BoilerplateRenderCoordinator.tsx` → renderAllForInputsId

2. **Check registration** - Look for duplicate templateId warnings

3. **Check variables** - Ensure variables published to context

4. **Check render state** - Template must be in 'rendered' state for auto-updates

### Performance Optimization

**Parallel Rendering:**
```tsx
// All templates render simultaneously
const fileTrees = await Promise.all(
  templates.map(t => t.renderFn(variables))
)
```

**Early Exits:**
```tsx
// Coordinator returns early if no templates
if (templatesForInputsId.length === 0) {
  return  // No-op
}
```

**Debouncing:**
- Reduces API calls by ~90% during typing
- Form: 200ms, Templates: 300ms

## Troubleshooting

### Template Stays in "waiting" State

**Cause:** Template not registered or coordinator not called.

**Fix:**
1. Verify `boilerplateInputsId` matches `BoilerplateInputs.id`
2. Check coordinator is called in `handleGenerate()`
3. Ensure YAML loaded before registration

### Variables Don't Auto-Update

**Cause:** Template not in 'rendered' state.

**Fix:**
1. Click Generate button first (transitions to 'rendered')
2. Check `renderState === 'rendered'` in auto-update effect
3. Verify variables actually changed (JSON.stringify comparison)

### Duplicate Template Registrations

**Cause:** useEffect dependencies cause re-registration.

**Fix:**
1. Check console for warnings
2. Ensure dependencies are stable (use useMemo/useCallback)
3. Verify cleanup function (unregister) is returned

### File Tree Not Merging

**Cause:** Non-functional state update or merge logic error.

**Fix:**
1. Use functional updates: `setFileTree(current => merge(current, new))`
2. Check `mergeFileTrees` logic in `lib/mergeFileTrees.ts`
3. Verify API returns valid `fileTree` array

## Testing

### Unit Tests

Test components in isolation:

```tsx
import { render } from '@testing-library/react'
import { BoilerplateTemplate } from './BoilerplateTemplate'

test('registers with coordinator on mount', () => {
  const mockRegister = jest.fn(() => jest.fn())
  
  render(
    <BoilerplateRenderCoordinatorProvider value={{ registerTemplate: mockRegister }}>
      <BoilerplateTemplate boilerplateInputsId="test" outputPath="/test.hcl">
        content
      </BoilerplateTemplate>
    </BoilerplateRenderCoordinatorProvider>
  )
  
  expect(mockRegister).toHaveBeenCalledWith(
    expect.objectContaining({
      templateId: 'test-/test.hcl',
      inputsId: 'test'
    })
  )
})
```

### Integration Tests

Test end-to-end flow:

```tsx
test('renders template when Generate is clicked', async () => {
  const { getByText, getByLabelText } = render(
    <BoilerplateInputsProvider>
      <BoilerplateRenderCoordinatorProvider>
        <BoilerplateInputs id="test" templatePath="." />
        <BoilerplateTemplate boilerplateInputsId="test" outputPath="/config.hcl">
          region = "{{ .region }}"
        </BoilerplateTemplate>
      </BoilerplateRenderCoordinatorProvider>
    </BoilerplateInputsProvider>
  )
  
  // Fill form
  userEvent.type(getByLabelText('Region'), 'us-west-2')
  
  // Click Generate
  userEvent.click(getByText('Generate'))
  
  // Verify API call
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledWith('/api/boilerplate/render-inline', ...)
  })
  
  // Verify rendered output
  expect(getByText('region = "us-west-2"')).toBeInTheDocument()
})
```

## Future Enhancements

### 1. Template Caching

Cache rendered templates to avoid re-rendering unchanged content.

```tsx
const templateCache = useRef<Map<string, FileTreeNode[]>>(new Map())

const getCacheKey = (variables: Record<string, unknown>) => 
  JSON.stringify(variables)

// In renderTemplate:
const cacheKey = getCacheKey(variables)
if (templateCache.current.has(cacheKey)) {
  return templateCache.current.get(cacheKey)!
}
```

### 2. Progressive Rendering

Show partial results as templates complete.

```tsx
// Instead of Promise.all
for (const template of templates) {
  const result = await template.renderFn(variables)
  setFileTree(current => mergeFileTrees(current, result))
}
```

### 3. Template Dependencies

Support templates that depend on other templates.

```tsx
interface TemplateRegistration {
  templateId: string
  inputsId: string
  dependsOn?: string[]  // Other templateIds
  renderFn: (variables, dependencies) => Promise<FileTreeNode[]>
}
```

### 4. Validation Hooks

Pre-render validation for variables.

```tsx
interface TemplateRegistration {
  // ...
  validate?: (variables: Record<string, unknown>) => ValidationResult
}
```

## References

- **Boilerplate Library:** [gruntwork-io/boilerplate](https://github.com/gruntwork-io/boilerplate)
- **Context Pattern:** [React Context Docs](https://react.dev/reference/react/useContext)
- **Debouncing:** [Lodash debounce](https://lodash.com/docs/#debounce)

