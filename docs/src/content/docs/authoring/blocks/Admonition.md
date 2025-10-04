---
title: <Admonition>
---

# `<Admonition>` Block

The `<Admonition>` block creates callout boxes to highlight important information, warnings, notes, or tips. It helps draw the user's attention to critical information in your runbook.

## Basic Usage

```mdx
<Admonition 
    type="info" 
    title="Important Note" 
    description="Make sure you have AWS credentials configured before proceeding." 
/>
```

## Props

### Required Props

- `type` (string) - Type of admonition: `"note"`, `"info"`, `"warning"`, or `"danger"`

### Optional Props

- `title` (string) - Title for the callout box (defaults based on type)
- `description` (string) - Content/message to display
- `children` (ReactNode) - Alternative to description for more complex content
- `closable` (boolean) - Whether users can close the admonition (default: false)
- `confirmationText` (string) - If provided, shows a checkbox that users must check to dismiss
- `allowPermanentHide` (boolean) - When true with confirmationText, adds "Don't show again" option
- `storageKey` (string) - Unique key for localStorage (required with allowPermanentHide)
- `className` (string) - Additional CSS classes

## Types

### Note (Gray)

For general information or notes:

```mdx
<Admonition 
    type="note" 
    title="Note" 
    description="This is a general note for additional context." 
/>
```

### Info (Blue)

For helpful information or tips:

```mdx
<Admonition 
    type="info" 
    title="Helpful Tip" 
    description="You can use environment variables instead of hardcoding values." 
/>
```

### Warning (Yellow)

For warnings or cautions:

```mdx
<Admonition 
    type="warning" 
    title="Caution" 
    description="This operation cannot be undone. Make sure you have backups." 
/>
```

### Danger (Red)

For critical warnings or errors:

```mdx
<Admonition 
    type="danger" 
    title="Danger" 
    description="This will delete all data in your production database!" 
/>
```

## With Children

Instead of using the `description` prop, you can provide richer content as children:

```mdx
<Admonition type="info" title="Prerequisites">
Before proceeding, ensure you have:
- AWS CLI installed
- Terraform v1.0+
- Valid AWS credentials configured
</Admonition>
```

The content supports inline markdown:

```mdx
<Admonition type="warning" title="Important">
Make sure to review the [deployment guide](https://example.com/guide) before running these commands. **Do not** run this in production without testing first!
</Admonition>
```

## Closable Admonitions

Allow users to dismiss the admonition:

```mdx
<Admonition 
    type="info" 
    title="Did you know?" 
    description="You can skip optional checks using the Skip checkbox."
    closable={true}
/>
```

## Confirmation Checkbox

Require users to acknowledge before dismissing:

```mdx
<Admonition 
    type="danger" 
    title="Destructive Operation" 
    description="This will permanently delete all resources."
    confirmationText="I understand this cannot be undone"
/>
```

## Don't Show Again

Allow users to permanently hide the admonition:

```mdx
<Admonition 
    type="info" 
    title="Welcome!" 
    description="This is your first time running this runbook."
    confirmationText="I've read the introduction"
    allowPermanentHide={true}
    storageKey="welcome-message"
/>
```

## Common Use Cases

### Prerequisites Section

```mdx
## Prerequisites

<Admonition 
    type="info" 
    title="Before You Begin" 
    description="Ensure you have the following tools installed: Git, Terraform, and AWS CLI."
/>

<Check id="check-git" command="git --version" ... />
<Check id="check-terraform" command="terraform --version" ... />
```

### Warning Before Destructive Action

```mdx
<Admonition 
    type="danger" 
    title="Destructive Operation" 
    description="The following command will delete all resources in the dev environment."
/>

<Command id="destroy" command="terraform destroy" ... />
```

### Helpful Tips

```mdx
<Admonition 
    type="info" 
    title="Pro Tip" 
    description="You can reference variables from BoilerplateInputs in any Command or Check block using {{ .VariableName }} syntax."
/>
```

### Important Notes

```mdx
<Admonition 
    type="note" 
    title="Note" 
    description="This step is optional. Skip it if you've already configured your environment."
/>
```

### Section Introductions

```mdx
## Deployment

<Admonition type="info" title="What You'll Do">
In this section, you'll deploy your application to AWS using Terraform. This will create:
- An ECS cluster
- A load balancer
- Security groups
- IAM roles
</Admonition>
```

## Styling and Appearance

Each type has its own color scheme:

| Type | Background | Border | Icon |
|------|-----------|--------|------|
| note | Gray | Gray | CheckCircle |
| info | Light Blue | Blue | Info |
| warning | Light Yellow | Yellow | AlertTriangle |
| danger | Light Red | Red | AlertCircle |

## Best Practices

### 1. Use Appropriate Types

Match the type to the severity of the message:
- **note**: General information
- **info**: Helpful tips or guidance
- **warning**: Something to be careful about
- **danger**: Critical warnings or destructive operations

### 2. Keep It Concise

Admonitions should be brief and to the point:

```mdx
<!-- Good -->
<Admonition type="warning" description="This will delete data. Make sure you have backups." />

<!-- Too verbose -->
<Admonition type="warning" description="Please be aware that the following operation will result in the permanent deletion of all data from your database. It is highly recommended that you create a backup copy of your data before proceeding with this operation. To create a backup, you should use the backup command..." />
```

### 3. Position Strategically

Place admonitions just before the relevant action:

```mdx
<Admonition type="danger" description="This is a destructive operation!" />

<Command id="destroy" command="terraform destroy" ... />
```

### 4. Don't Overuse

Too many admonitions can make your runbook feel cluttered. Use them sparingly for truly important information.

### 5. Use Confirmation for Critical Actions

For destructive operations, use confirmationText to ensure users acknowledge the risk:

```mdx
<Admonition 
    type="danger" 
    title="Delete Production Database" 
    description="This will permanently delete the production database."
    confirmationText="I understand this will delete production data"
/>
```

## Examples in Context

### Complete Deployment Flow

```mdx
# Deploy Application

<Admonition 
    type="info" 
    title="What You'll Do" 
    description="This runbook will deploy your application to production. The process takes about 10 minutes."
/>

## Prerequisites

<Admonition type="note" description="Ensure you have production AWS credentials configured." />

<Check id="check-aws" command="aws sts get-caller-identity" ... />

## Configuration

<BoilerplateInputs id="deploy-config" templatePath="templates/deploy" />

## Deploy

<Admonition 
    type="warning" 
    title="Production Deployment" 
    description="You're about to deploy to production. Ensure you've reviewed the changes."
/>

<Command id="deploy" path="scripts/deploy-prod.sh" ... />

<Admonition 
    type="info" 
    title="Success!" 
    description="Your application has been deployed. It may take a few minutes to become available."
/>
```

### Danger Zone

```mdx
## Danger Zone

<Admonition 
    type="danger" 
    title="Destructive Operations" 
    description="The commands in this section cannot be undone."
    confirmationText="I understand these operations are irreversible"
/>

<Command id="delete-database" command="aws rds delete-db-instance ..." ... />
```

## Accessibility

Admonitions are designed with accessibility in mind:
- Semantic HTML structure
- ARIA labels for screen readers
- Keyboard-accessible close buttons
- Color is not the only indicator (icons are used as well)

## See Also

- Use admonitions alongside [Check blocks](/authoring/blocks/check) for prerequisites
- Combine with [Command blocks](/authoring/blocks/command) to warn before destructive operations
