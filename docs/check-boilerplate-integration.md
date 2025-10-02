# Check Component + BoilerplateInputs Integration

## Overview

The `Check` component now supports dynamic script parameterization through integration with `BoilerplateInputs`. This allows runbook authors to create parameterized check scripts that adapt based on user-provided variables.

## Features

### 1. Variable Collection

The Check component can collect variables from two sources:

- **Inline BoilerplateInputs**: A `<BoilerplateInputs>` component rendered as a child of `<Check>`
- **External BoilerplateInputs**: Reference to an existing BoilerplateInputs via `boilerplateInputsId` prop

When both sources are present, inline variables take precedence (they override external variables).

### 2. Template Rendering

Scripts can use Go template syntax for variable substitution:

```bash
#!/bin/bash
echo "Checking KMS key: {{ .KMS_KEY_ID }}"
aws kms describe-key --key-id "{{ .KMS_KEY_ID }}" --region "{{ .REGION }}"
```

The Check component:
1. Extracts template variables from the script using `extractTemplateVariables()`
2. Collects variable values from BoilerplateInputs
3. Renders the script via `/api/boilerplate/render-inline` endpoint
4. Displays the rendered script in the ViewSourceCode component

### 3. Auto-Update Behavior

Similar to `BoilerplateTemplate`, the Check component automatically re-renders the script when variables change:

- Debounced updates (300ms delay)
- No loading spinner for auto-updates (prevents UI flashing)
- Only triggers after initial render

### 4. Error Handling & UI States

The component provides helpful inline status messages:

**Missing Configuration (Early Return):**
```
This check script requires variables (KMS_KEY_ID, REGION) but no 
BoilerplateInputs component is configured.
```

**Waiting for Variables (Inline Message):**
```
⚠ Waiting for variables: KMS_KEY_ID, REGION
```
- Check button is disabled
- BoilerplateInputs form is visible
- Raw script template is shown in ViewSourceCode

**Rendering Script (Inline Message):**
```
⟳ Rendering script with variables...
```
- Check button is disabled
- Form remains visible

**Render Errors (Inline Message):**
```
✕ Script render error: [error details]
```
- Check button remains disabled
- Error is shown inline, not as a blocking screen

### 5. Backwards Compatibility

Scripts without template variables work exactly as before:
- No variable collection
- No rendering step
- Direct display of raw script content

## Usage Patterns

### Pattern 1: Inline BoilerplateInputs

Best for single-use forms:

```mdx
<Check id="kms-check" path="scripts/kms-validation.sh">
  <BoilerplateInputs id="kms-inputs">
    ```yaml
    variables:
      - name: KMS_KEY_ID
        type: string
        description: "KMS Key ID"
        required: true
      - name: REGION
        type: string
        description: "AWS Region"
        default: "us-east-1"
    ```
  </BoilerplateInputs>
</Check>
```

### Pattern 2: External BoilerplateInputs

Best when multiple checks share variables:

```mdx
<BoilerplateInputs id="aws-config">
  ```yaml
  variables:
    - name: REGION
      type: string
      default: "us-east-1"
  ```
</BoilerplateInputs>

<Check id="check-1" path="checks/check1.sh" boilerplateInputsId="aws-config" />
<Check id="check-2" path="checks/check2.sh" boilerplateInputsId="aws-config" />
```

### Pattern 3: Combined (Inline + External)

Inline variables override external ones:

```mdx
<BoilerplateInputs id="shared-config">
  ```yaml
  variables:
    - name: REGION
      type: string
      default: "us-east-1"
  ```
</BoilerplateInputs>

<Check id="special-check" path="checks/special.sh" boilerplateInputsId="shared-config">
  <BoilerplateInputs id="override-config">
    ```yaml
    variables:
      - name: REGION
        type: string
        default: "us-west-2"  # Overrides shared-config
      - name: SPECIAL_VAR
        type: string
        required: true
    ```
  </BoilerplateInputs>
</Check>
```

## Implementation Details

### New Props

```typescript
interface CheckProps {
  id: string
  path?: string
  boilerplateInputsId?: string  // NEW: Reference to external BoilerplateInputs
  successMessage?: string
  warnMessage?: string
  failMessage?: string
  runningMessage?: string
  children?: ReactNode  // Can contain inline BoilerplateInputs
}
```

### Key Files

- **`Check.tsx`**: Main component with integration logic
- **`lib/extractInlineInputsId.ts`**: Helper to extract inline BoilerplateInputs ID
- **Reused**: `extractTemplateVariables()` from BoilerplateTemplate
- **Reused**: `/api/boilerplate/render-inline` endpoint

### Component Flow

```
1. Load script from file (useGetFile)
2. Extract inline BoilerplateInputs ID from children
3. Collect variables from both inline and external sources
4. Merge variables (inline precedence)
5. Extract template variables from script
6. Always show full Check UI with:
   - Descriptive text
   - Inline BoilerplateInputs form (if present)
   - Status messages (waiting/rendering/error)
   - Check button (disabled if not ready)
   - ViewSourceCode (raw template or rendered script)
   - ViewLogs section
7. Check if all required variables available
   - If no: Disable Check button, show waiting message
   - If yes: Render script with variables, enable Check button
8. Listen for variable changes and auto-update
```

### UI Improvements

**Non-Blocking Status Messages:**
- Status messages appear inline between the form and buttons
- Users can see the full Check component structure even when waiting
- The raw script template is visible before rendering (shows what variables are needed)

**Progressive Disclosure:**
- Before variables are filled: Show raw template with `{{ .Variable }}` syntax
- After variables are filled: Show rendered script with actual values
- Check button is disabled until script is ready

**Visual Feedback:**
- Waiting state: Yellow warning icon with missing variable names
- Rendering state: Blue spinner icon with "Rendering..." message  
- Error state: Red X icon with error details
- All states keep the BoilerplateInputs visible for easy editing

### State Management

```typescript
// Variable collection
const collectedVariables = useMemo(() => {
  const externalVars = boilerplateInputsId ? variablesByInputsId[boilerplateInputsId] : undefined;
  const inlineVars = inlineInputsId ? variablesByInputsId[inlineInputsId] : undefined;
  return { ...(externalVars || {}), ...(inlineVars || {}) };
}, [boilerplateInputsId, inlineInputsId, variablesByInputsId]);

// Script content selection
const sourceCode = renderedScript !== null ? renderedScript : rawScriptContent;
```

## Testing

Test examples are available in:
- `/testdata/runbook-with-parameterized-check/`

This includes:
- Inline BoilerplateInputs example
- External BoilerplateInputs reference example
- Non-parameterized check example (backwards compatibility)

## Future Enhancements

The following features are planned but not yet implemented:

1. **Actual Script Execution**: Currently simulated; will connect to backend execution
2. **Live Variable Injection**: Pass rendered script to execution engine
3. **Result Validation**: Match expected outputs against actual results
4. **Retry Logic**: Allow re-running checks with different variable values

## Related Components

- `BoilerplateInputs`: Form generation from boilerplate.yml
- `BoilerplateTemplate`: Inline template rendering (similar pattern)
- `BoilerplateVariablesContext`: Shared variable state management
- `ViewSourceCode`: Displays the rendered script content

