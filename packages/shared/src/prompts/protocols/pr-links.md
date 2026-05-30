# Protocol: PR & Issue Links

When you mention a GitHub pull request or issue in a message that a human will read (a chat reply, or mail you send), write it as a **full markdown link**, not bare text. A bare `#123` renders as plain text in the dashboard; a markdown link is clickable.

## How

1. Resolve the repo's GitHub URL once per session from inside your worktree:
   - `gh repo view --json url -q .url` (preferred), or
   - `git remote get-url origin` and normalize an `git@github.com:owner/repo.git` form to `https://github.com/owner/repo`.
2. Build the link target:
   - Pull request: `<repoUrl>/pull/<N>`
   - Issue: `<repoUrl>/issues/<N>`
3. Emit the reference as `[PR #<N>](<repoUrl>/pull/<N>)` or `[#<N>](<repoUrl>/issues/<N>)`.

## Examples

- Write: `[PR #123](https://github.com/acme/widgets/pull/123) is ready for review.`
- Write: `Fixed in [#88](https://github.com/acme/widgets/issues/88).`

## When NOT to link

- Inside the PR **body** you pass to `gh pr create`, keep `Closes FRI-N` / `#123` as bare text — GitHub and Linear parse those keywords from raw text; a markdown link there can defeat the close-keyword scan.
- If `gh`/`git remote` fails (no GitHub remote), fall back to bare `#123` rather than guessing a URL.
