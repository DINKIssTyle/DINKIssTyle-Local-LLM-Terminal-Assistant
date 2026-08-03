---
name: github-management
description: Manage and synchronize Git and GitHub repositories across operating systems, including push, pull, fetch, merge, rebase, squash, reset, force push, remote recovery, history rewriting, branches, commits, issues, pull requests, releases, and Actions. Use for GitHub, Git Hub, git sync, force push, pull, merge, rebase, reset, squash, local-versus-remote source-of-truth decisions, 깃허브, 깃헙, 깃 동기화, 강제 푸시, 강제 푸쉬, 풀, 병합, 리베이스, 리셋, 커밋 합치기, 히스토리 초기화, 저장소 관리, 이슈, PR, 릴리스, 워크플로, or Actions requests.
---

# GitHub Management

Use `git` for local repository state and `gh` for GitHub-hosted state. Determine whether local or remote history is authoritative before synchronization. Read the current state, preserve a recovery path for destructive history changes, perform the smallest requested mutation, and verify the result.

## Quick operation map

Use this compact map to locate the requested workflow even when the host limits skill context:

```text
Inspect:       git status --short --branch; git log --oneline --graph --decorate --all -n 30
Download:      git fetch --prune origin
Fast-forward:  git merge --ff-only origin/main
Merge:         git merge origin/main
Rebase:        git rebase origin/main
Squash:        git rebase -i HEAD~3
Keep changes:  git reset --soft TARGET_COMMIT
Discard:       git reset --hard TARGET_COMMIT
Local wins:    git push --force-with-lease origin main
Remote wins:   git reset --hard origin/main
Ignored files: git rm -r --cached .; git add .
Issues:        gh issue list; gh issue view ISSUE_NUMBER --comments
Pull requests: gh pr list; gh pr view PR_NUMBER --comments; gh pr checks PR_NUMBER
Actions:       gh run list; gh run view RUN_ID --log-failed
Releases:      gh release list; gh release view TAG
Recovery:      git reflog --date=local
```

Treat this as an index, not permission to mutate. Apply the safety and verification rules below before executing the selected operation.

## Mandatory preflight

Run the relevant read-only checks before push, pull, reset, merge, rebase, or history rewriting:

```text
git rev-parse --show-toplevel
git status --short --branch
git remote -v
git branch -vv
git fetch --prune origin
git rev-list --left-right --count origin/main...main
git log --oneline --graph --decorate --all -n 30
```

- Replace `main` and `origin` only after observing the real branch and remote names.
- Do not assume local or remote is correct merely because one side is newer.
- Preserve unrelated working-tree changes.
- Stop when credentials, branch protection, unresolved conflicts, or an unknown source of truth makes the requested mutation ambiguous.

## Select the source of truth

### Local branch is authoritative

Use when the user explicitly wants the remote branch to become identical to the verified local branch.

```text
git fetch --prune origin
git status --short --branch
git log --oneline --graph --decorate origin/main..main
git branch backup-remote-main origin/main
git push --force-with-lease origin main
git ls-remote --heads origin main
```

Prefer `--force-with-lease` because it refuses to overwrite an unexpected remote update. Use plain `--force` only when the user explicitly intends to overwrite such an update and the exact remote branch has been rechecked.

### Remote branch is authoritative

Use when the user explicitly wants the local branch to become identical to the fetched remote branch.

```text
git fetch --prune origin
git status --short --branch
git branch backup-local-main main
git reset --hard origin/main
git status --short --branch
git log --oneline --decorate -n 10
```

`reset --hard` discards tracked working-tree and index changes but does not remove untracked files. If untracked files must also be removed, preview with `git clean -nd` and run `git clean -fd` only after explicit authorization.

## Create a recovery point

Before reset, rebase, squash, force push, branch replacement, or history consolidation, create at least one appropriate recovery point:

```text
git branch backup-before-rewrite
git tag backup-before-rewrite HEAD
git bundle create ../repository-backup.bundle --all
```

- Choose a unique backup name; never overwrite an existing backup ref.
- Use a Git bundle for repository-wide destructive rewriting.
- Report the backup ref or bundle path before proceeding.

## Reset safely

### Undo commits but keep all changes staged

```text
git rev-parse --verify TARGET_COMMIT^{commit}
git branch backup-before-soft-reset
git reset --soft TARGET_COMMIT
git status --short --branch
```

Use this for combining or recommitting changes while preserving the working tree and index.

### Return completely to a commit

```text
git rev-parse --verify TARGET_COMMIT^{commit}
git branch backup-before-hard-reset
git reset --hard TARGET_COMMIT
git status --short --branch
git log --oneline --decorate -n 10
```

Run a hard reset only when the exact target and loss of tracked changes are explicitly authorized.

## Pull, fast-forward, merge, and rebase

Fetch first, then select the integration strategy deliberately.

### Fast-forward only

```text
git fetch origin
git merge --ff-only origin/main
```

Use this when local has no unique commits. It prevents an accidental merge commit.

### Rebase local commits onto remote

```text
git branch backup-before-rebase
git fetch origin
git rebase origin/main
```

On conflicts, inspect `git status`, resolve only understood files, stage them, and use `git rebase --continue`. Use `git rebase --abort` to return to the pre-rebase state.

### Merge remote history

```text
git branch backup-before-merge
git fetch origin
git merge origin/main
```

Use `git merge --abort` when conflicts cannot be safely resolved. Do not choose rebase versus merge without considering whether published commit identities must remain stable.

## Squash commits

### Interactive rebase

```text
git branch backup-before-squash
git rebase -i HEAD~3
```

Keep the oldest selected commit as `pick` and change later commits to `squash` or `fixup`. After rewriting published commits, push with `--force-with-lease`, not an unqualified force push.

### Recommit everything after a known base

```text
git branch backup-before-squash
git reset --soft BASE_COMMIT
git commit -m "Consolidated changes"
```

Use only when the user wants all commits after `BASE_COMMIT` collapsed into one.

## Consolidate to a single root commit

Prefer an orphan branch over deleting `.git`; it preserves a recovery path and repository configuration.

```text
git status --short --branch
git branch backup-full-history
git bundle create ../repository-before-consolidation.bundle --all
git switch --orphan consolidated-history
git add -A
git commit -m "Initial commit"
git branch -M main
git push --force-with-lease origin main
```

- Verify ignored files before `git add -A`.
- Confirm the remote and default branch before force-pushing the new root.
- Do not delete `.git` unless the user explicitly wants a new repository identity and accepts losing reflog, hooks, local configuration, remotes, and recovery refs.
- Avoid `git update-ref -d HEAD` as the default consolidation method because it removes the current branch reference and is easier to misuse.

## Stop tracking ignored files

After verifying `.gitignore`:

```text
git rm -r --cached .
git add .
git status --short
git commit -m "Remove ignored files from repository"
```

Review the staged diff before committing so required tracked files are not accidentally removed.

## Recover from history changes

```text
git reflog --date=local
git branch recovered-history RECOVERY_COMMIT
git reset --hard RECOVERY_COMMIT
```

- Prefer creating a recovery branch before another reset.
- Restore from the backup branch, tag, or bundle created before rewriting.
- To repair a bad remote force push, verify the recovery commit locally and push it with `--force-with-lease` only after confirming it is the intended remote truth.

## Repository and GitHub inspection

```text
gh auth status
gh repo view --json nameWithOwner,url,defaultBranchRef
gh issue list --limit 30
gh issue view ISSUE_NUMBER --comments
gh pr list --limit 30
gh pr view PR_NUMBER --comments
gh pr diff PR_NUMBER
gh pr checks PR_NUMBER
gh workflow list
gh run list --limit 20
gh run view RUN_ID --log-failed
gh release list
gh release view TAG
```

## GitHub mutations

```text
gh issue create --title "TITLE" --body "BODY"
gh issue comment ISSUE_NUMBER --body "COMMENT"
gh pr create --title "TITLE" --body "BODY" --base BASE_BRANCH
gh pr comment PR_NUMBER --body "COMMENT"
gh workflow run WORKFLOW --ref BRANCH
gh run rerun RUN_ID --failed
gh release create TAG --title "TITLE" --notes "NOTES"
```

Read the target before editing, closing, approving, merging, rerunning, or releasing. Do not perform external mutations that were not requested. After a remote mutation, query GitHub again and report the resulting URL or identifier.

## Cross-platform rules

- Use the same `git` and `gh` subcommands on Windows, macOS, and Linux.
- Adapt quoting and line continuation to the active shell; use PowerShell syntax on Windows.
- Replace placeholders with observed values before execution; never send literal placeholders such as `TARGET_COMMIT` or `ISSUE_NUMBER`.
- Prefer `--body-file` for long Markdown bodies to avoid fragile shell escaping.
- If `gh` is missing or unauthenticated, report the exact blocker rather than inventing remote state.
- Never discard unrelated changes, rewrite history, delete branches, or overwrite remote work merely to make a command succeed.
