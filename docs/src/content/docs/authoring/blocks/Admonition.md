---
title: <Admonition>
---

The `<Admonition>` block renders a callout box for a note, info, warning, or danger message.

## Basic usage

```mdx
<Admonition 
    type="info" 
    title="Important Note" 
    description="Make sure you have AWS credentials configured before proceeding." 
/>
```

## Props

### Required props

- `type` (string): `"note"`, `"info"`, `"warning"`, or `"danger"`

### Optional props

- `title` (string): title for the callout box. Defaults based on type. Supports inline markdown (bold, italic, links, code).
- `description` (string): the message to display. Supports inline markdown.
- `inputsId` (string | string[]): ID of one or more [Inputs](/authoring/blocks/inputs/) blocks. `title`, `description`, and `confirmationText` resolve `{{ .inputs.VarName }}` expressions against those inputs, so a callout can name the value the user entered.
- `closable` (boolean): whether users can close the admonition. Default `false`.
- `confirmationText` (string): if set, shows a confirmation button with this label that users must click to dismiss the admonition.
- `allowPermanentHide` (boolean): with `confirmationText`, adds a "Don't show me this again" checkbox.
- `storageKey` (string): unique key for localStorage. Required with `allowPermanentHide`.

## Types

### Note (gray)

```mdx
<Admonition 
    type="note" 
    title="Note" 
    description="This is a general note for additional context." 
/>
```

### Info (blue)

```mdx
<Admonition 
    type="info" 
    title="Helpful Tip" 
    description="You can use environment variables instead of hardcoding values." 
/>
```

### Warning (yellow)

```mdx
<Admonition 
    type="warning" 
    title="Caution" 
    description="This operation cannot be undone. Make sure you have backups." 
/>
```

### Danger (red)

```mdx
<Admonition 
    type="danger" 
    title="Danger" 
    description="This will delete all data in your production database!" 
/>
```

## Markdown content

You can pass the content as children in place of the `description` prop. Children support full markdown, such as lists, code blocks, and links:

````mdx
<Admonition type="info" title="Prerequisites">
Before proceeding, you need:

- AWS CLI installed
- OpenTofu v1.6+
- Valid AWS credentials configured

Check your credentials with:

```bash
aws sts get-caller-identity
```
</Admonition>
````

Put the content on lines of its own, between the opening and closing tags. Content that starts on the same line as the opening tag must end on that line too, and is read as inline markdown:

```mdx
<Admonition type="warning">**Do not** run this in production without testing first.</Admonition>
```

## Closable admonitions

```mdx
<Admonition 
    type="info" 
    title="Did you know?" 
    description="You can skip optional checks using the Skip checkbox."
    closable={true}
/>
```

## Confirmation button

Require users to acknowledge before dismissing:

```mdx
<Admonition 
    type="danger" 
    title="Destructive Operation" 
    description="This will permanently delete all resources."
    confirmationText="I understand this cannot be undone"
/>
```

## Don't show again

Let users hide the admonition permanently:

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

:::tip[See it in action]
The [admonition feature demo](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/admonition) shows each type, an admonition written in markdown, and both ways to dismiss one.
:::
