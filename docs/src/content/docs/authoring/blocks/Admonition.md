---
title: <Admonition>
---

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