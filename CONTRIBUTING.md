# Contributing

Lightpanda accepts pull requests through GitHub.

---

## Contributor License Agreement (CLA)

You must sign our [CLA](CLA.md) on your **first pull request**.
Without a signed CLA we cannot accept your contribution.

Signing is done by posting a **single comment** on your PR with this exact text:

```
I have read the CLA Document and I hereby sign the CLA
```

The [CLA Assistant](https://github.com/marketplace/actions/cla-assistant-lite) bot
will detect the comment and record your signature automatically.
You can see an example of this process in
[#303](https://github.com/lightpanda-io/browser/pull/303).

> **Important for bot-assisted contributions** — automated tools (GitHub Copilot,
> CodeRabbit, Dependabot, etc.) may commit or comment on your behalf, but the
> **human contributor** opening the PR is the legal author and must sign the CLA.
> The CLA comment must come from a human GitHub account, not a bot.

---

## Pull Request Flow

1. **Fork and branch** — fork the repository and create a feature branch from `main`.
   Use a descriptive branch name, e.g. `fix/participant-key-collision` or
   `feat/camera-reminder`.

2. **Commit your changes** — write clear, atomic commits.
   See [Commit messages](#commit-messages) below.

3. **Open a pull request** — target the `main` branch.
   Fill in the PR template checklist before requesting review.

4. **Sign the CLA** (first PR only) — the CLA Assistant bot will prompt you.
   Post the required comment if you haven't signed before (see above).

5. **Respond to reviews** — address reviewer comments and push updates to your
   branch. Automated review tools (Copilot, CodeRabbit) may leave suggestions;
   treat them as advisory. **You** are responsible for the final state of the code.

6. **Squash merge** — all PRs are merged via **squash merge** so that the final
   commit on `main` carries the human contributor's identity cleanly, regardless
   of any intermediate bot-generated commits on the PR branch.

---

## Commit Messages

- Use the imperative mood in the subject line: `fix: correct selector fallback logic`
- Keep the subject line under 72 characters
- Reference related issues or PRs in the body when relevant: `Closes #123`
- Prefix with a type following [Conventional Commits](https://www.conventionalcommits.org/):
  `feat`, `fix`, `docs`, `chore`, `refactor`, `test`

---

## Branches and PRs

- Branch off `main`; keep branches short-lived
- One logical change per PR where possible
- Update relevant documentation and tests when behaviour changes
- Do not include unrelated changes in a PR

---

## Automation Tools (Copilot, CodeRabbit, etc.)

This project uses automated review and coding assistants.
Their role is **advisory**:

- They may comment, suggest code changes, or open auto-fix commits on PR branches
- The **human contributor** is the legal author and remains responsible for
  reviewing, approving, and submitting all changes
- Bot-generated commits that land on the PR branch are fine — they will be
  squash-merged under the human author's identity at merge time
- Never accept auto-generated code without reviewing it yourself

---

## Merge Strategy

The preferred merge strategy for this repository is **squash merge**.

Benefits:
- Each feature or fix lands as a single, well-described commit on `main`
- The commit author reflects the human contributor, regardless of bot commits
  made during the PR lifecycle
- The `main` branch history stays clean and bisectable

When maintainers merge your PR they will use "Squash and merge" in the GitHub UI
and edit the commit message to match the PR title and description if needed.
