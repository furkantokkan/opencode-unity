# Workspace facts

`opencode-unity init <directory>` discovers a Unity client, Node service,
ASP.NET service, Firebase configuration, or database configuration in a
workspace. Plain Unity projects retain the existing version 1 `project.json`
and 1,600-character brief. Service and mixed workspaces use version 2 with
component IDs, relative paths, status, and a small allowlisted fact summary.

```sh
opencode-unity init ./game-workspace --print
opencode-unity init ./backend --dry-run
opencode-unity init ./game-workspace
opencode-unity init ./game-workspace/client --editor
```

- Node facts include detected frameworks, package manager, TypeScript presence,
  standard script names, entry path, test runner, and route count. Script bodies
  and dependency configuration values are excluded.
- .NET facts include the web SDK, target framework, EF Core presence, and test
  project count. `appsettings*.json` contents are never opened.
- Firebase facts contain recognized product names and counts, without project
  IDs, runtime configuration values, or credentials.
- Database facts contain the tool, recognized dialect, model count, and migration
  count. A migration count does not establish which migrations were applied.
- The default workspace brief is at most 2,600 characters, with at most six
  rendered component blocks. Discovery stops at configured file/read/component
  limits and reports incomplete results. Missing or unreadable facts are not
  replaced with guesses.

The `project` configuration block controls component selection (`auto`,
`unity-only`, or exact component IDs), component count, character budgets, and
scan budgets. These facts do not execute verification scripts, grant backend
write permissions, or configure network access.

`--print` and `--dry-run` write nothing and request no consent. Normal init writes
only to the product home; `--in-project` uses the existing export consent and
install-manifest hash so uninstall can recognize an unchanged export. Ignore
guidance is printed without modifying the repository's ignore file.

Workspace roots have no guessed Unity MCP identity. For editor checks,
initialize the specific Unity client directory with `--editor`. When invoked
inside a Unity project, its existing root identity wins. Explicit workspace
paths remain scoped to the given folder; other service paths use the containing
VCS root or nearest service marker.

Freshness uses the safe component projection and bounded file metadata, including
the nested Unity files read through the same workspace budget. Only the aggregate digest is saved;
secret contents and per-file secret hashes are not published. Changes to file
size or modification time trigger a refresh. A deliberate content rewrite that
preserves both metadata fields requires `init --refresh`.

Implementation checkpoint: the workspace command fixtures cover standalone
Node/database, Unity/Functions/Firebase, and ASP.NET projects; read-only modes,
export ownership, consent, unchanged Unity behavior, bounds, redaction, and
freshness have focused automated checks. Other hardware or operating-system
runtime behavior is outside these filesystem fixture checks.
