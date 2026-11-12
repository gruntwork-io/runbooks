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

- `id` (string): makes the confirmation an output that later blocks can wait on. Needs `confirmationText`. See [Waiting on a confirmation](#waiting-on-a-confirmation).
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

## Waiting on a confirmation

Some steps happen outside the runbook, and a later block should run only once the user says they're done. For example, a runbook maintainer might want the user to check that a test email reached a new mailing list before the runbook goes on. Give the admonition an `id`, and clicking its confirmation button sets its `CONFIRMED` output to `true`:

```mdx
<Admonition
    id="mail-arrived"
    type="info"
    title="Check your inbox"
    description="Send a test email to the new list and wait for it to arrive."
    confirmationText="The test email arrived"
/>

<Command
    id="announce"
    command='echo "The list works (confirmed: $CONFIRMED)"'
    env={{ CONFIRMED: "{{ .outputs.mail_arrived.CONFIRMED }}" }}
/>
```

The `<Command>` stays blocked until the admonition is confirmed, as it would for any [output](/authoring/inputs-and-outputs/) it reads. Templates refer to the admonition by its id with hyphens turned into underscores, so `mail-arrived` becomes `mail_arrived`.

An admonition with an `id`:

- needs `confirmationText`, the label of the button that confirms it;
- can't be `closable` or use `allowPermanentHide`, since a closed or hidden admonition could never be confirmed;
- stays shown once confirmed, with a "Confirmed" mark in place of the button, and stays confirmed when the user resumes the session;
- needs an id no other block on the page has.

### Block outputs

| Output | Value |
|--------|-------|
| `CONFIRMED` | `true`, once the confirmation button is clicked. Not set before then. |

:::tip[See it in action]
The [admonition feature demo](https://github.com/gruntwork-io/runbooks/tree/main/testdata/feature-demos/admonition) shows each type, an admonition written in markdown, and both ways to dismiss one.
:::
