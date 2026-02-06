# Open a PR

- Check that I'm in a branch other than `main` or `prod`. If not, bail and explain.
- Check the diff between my branch and the main branch of the repo
- If there's unstaged or staged work that hasn't been committed, commit all the relevant code first
(Use `gh` in case it's installed)
- Write up a quick PR description in the following format

<feature_area>: <Title> (80 characters or less)

<TLDR> (no more than 2 sentences)

<Description>
Describe a list of features, organized by functionality or feature, rather than frontend/backend/area of software. Can you also state features in terms that an end user or runbook author would care about? If there are technical improvements, can you describe the value of what we did and describe the change in high-level terms? Be concise.

- Always paste the link to the PR in your response so I can click it easily
- Prepend GIT_EDITOR=true to all git commands you run, so you can avoid getting blocked as you execute commands