# Runbooks feature map

What a user can do in Runbooks that `control-runbooks` can drive, one file per feature. Each says how a user reaches it, which setup brings the app there, the commands that drive it with what to check before the next step, what proves it works, and which automated tests check the exact output.

| Feature | File | Start from |
| --- | --- | --- |
| Filling a TfModule block's form | [tf-module-form.md](tf-module-form.md) | `up testdata/feature-demos/tf-module --simulate`, `setup trust` |
| The TfModule Code tab | [tf-module-code.md](tf-module-code.md) | `setup group-form` |
| The TfModule PR tab | [tf-module-pull-request.md](tf-module-pull-request.md) | `setup group-form` |
| The TfModule Apply tab | [tf-module-apply.md](tf-module-apply.md) | `setup group-form` |
| Simulation scenarios | [simulation-scenarios.md](simulation-scenarios.md) | `up <runbook> --simulate` |

A proof that drives one convenient path is incomplete when a feature lists others; cover the sub-features the change touches.
