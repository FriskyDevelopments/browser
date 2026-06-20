# Qwen Code — GitHub reviewer & automator

Qwen Code ([QwenLM/qwen-code-action](https://github.com/QwenLM/qwen-code-action))
runs in GitHub Actions to review pull requests, triage issues, and act as an
on-demand automation assistant.

## Workflows

| Workflow | File | Trigger |
|---|---|---|
| **Code Review** | `workflows/qwen-pr-review.yml` | Every PR open/update, or a maintainer comment `/review` on a PR |
| **Assistant / Automator** | `workflows/qwen-assistant.yml` | A maintainer comment containing `@qwen-code` on any issue or PR |
| **Issue Triage** | `workflows/qwen-issue-triage.yml` | Every new/reopened issue, or a maintainer comment `/triage` |

The reviewer and triager are read-only (they only post comments/labels). The
assistant has `contents: write` and will commit changes to the PR branch when a
task requires code edits.

## Required setup

All three workflows authenticate to the Qwen API (DashScope, OpenAI-compatible).

1. **Add the API key** as an organization secret named **`QWEN_API_KEY`**
   (Settings → Secrets and variables → Actions) with this repository in its
   access list — or as a repository secret of the same name.

2. **(Optional) Override model/endpoint** via Actions *Variables*:
   - `QWEN_MODEL` — defaults to `qwen-coder-plus-latest`.
   - `QWEN_BASE_URL` — defaults to
     `https://dashscope.aliyuncs.com/compatible-mode/v1`.

No GitHub App is required — the workflows use the built-in `GITHUB_TOKEN`.

## Security model

- The assistant and the on-demand `/review` and `/triage` commands only run for
  users whose comment `author_association` is `OWNER`, `MEMBER`, or
  `COLLABORATOR`.
- Automatic PR review runs on every PR; it is read-only and posts a comment only.
- The Qwen step only receives `QWEN_API_KEY` and the workflow's `GITHUB_TOKEN`.

## Usage

- **Review a PR again:** comment `/review` on the PR.
- **Ask Qwen to do something:** comment `@qwen-code <request>` on a PR or issue.
- **Triage an issue:** comment `/triage`.
