# Google group

## What

Creates a Google group in a Google Workspace or Cloud Identity organization, and
gives each owner, manager, and member their roles.

## Why

Give a shared address to something many people need mail for, such as the root
user of a new AWS account, and keep who receives it in code.

## How

Supply `id`, the group's email address, and exactly one of `domain` or
`customer_id`. List people in `owners`, `managers`, and `members`; each must
already exist. Set `types` for a security, dynamic, or external group. See
[inputs](variables.tf) and [outputs](outputs.tf).

The Google provider needs a credential that can create groups, such as a Groups
Admin, and the Cloud Identity API enabled in its project. User credentials also
need a quota project: set the provider's `billing_project` and `user_project_override`.

[`runbooks.yml`](runbooks.yml) tells a Runbooks `<TfModule>` block how to show
the inputs. OpenTofu ignores it. How a runbook uses the module, such as a
Terragrunt unit or a plain OpenTofu configuration, is up to the runbook.

Adapted from
[terraform-google-modules/terraform-google-group](https://github.com/terraform-google-modules/terraform-google-group)
(Apache License 2.0). It uses the `google` provider instead of `google-beta`,
requires exactly one of `domain` and `customer_id`, validates inputs, and
outputs `email` instead of `id` and `name`.

## Failure modes

- Creating a group whose email already exists fails. Import it, or pick another address.
- A member who doesn't exist yet fails that membership. Create them first.
- Google doesn't let a group lose the `security` type once it has it.
- Changing `id` or the organization replaces the group, and its email archive goes with it.

## Security

Owners and managers can change the group's membership and settings. The group's
email permissions, such as whether outsiders can send to it, come from the
organization's defaults; this module doesn't manage them. Members of a security
group gain whatever access its policies grant, so review membership changes as
access changes.
