# Grove

Run Codex sessions in Workbox git worktrees.

Grove creates, enters, resumes, lists, and removes Workbox-managed worktrees, then runs the Codex CLI inside the selected worktree.

## Requirements

- Bun 1.3 or newer
- The Codex CLI available as `codex`
- Git

Grove depends on Workbox and invokes it through `wkb`.

## Install

```sh
bun add -g codex-grove
```

## Usage

```sh
grove new my-feature --from main -- "implement the dashboard filters"
grove resume my-feature -- --last
grove enter my-feature
grove list
grove rm my-feature
```

Run `grove --help` for the full command list.

## Development

```sh
bun install
bun run check
bun test
```

## Renovate

Renovate runs daily through GitHub Actions and can also be started manually from the Actions tab.

The workflow expects a repository secret named `RENOVATE_TOKEN`. Use a GitHub personal access token for a bot or maintainer account with repository access. Include the `workflow` scope if Renovate should update GitHub Actions workflow files.
