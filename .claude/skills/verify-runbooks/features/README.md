# Runbooks feature map

What a user can do in Runbooks that `control-runbooks` can drive, one file per feature. Each says how a user reaches it, which setup brings the app there, the commands that drive it with what to check before the next step, what proves it works, and which automated tests check the exact output.

| Feature | File | Start from |
| --- | --- | --- |
| Filling a TfModule block's form | [tf-module-form.md](tf-module-form.md) | `up testdata/feature-demos/tf-module --simulate`, `setup trust` |
| Planning and applying a unit with TerragruntApply | [terragrunt-apply.md](terragrunt-apply.md) | `setup group-code` |
| Simulation scenarios | [simulation-scenarios.md](simulation-scenarios.md) | `up <runbook> --simulate` |

A proof that drives one convenient path is incomplete when a feature lists others; cover the sub-features the change touches.
