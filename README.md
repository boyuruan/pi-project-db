# pi-project-db

SQLite-backed **project governance records** for [Pi](https://pi.dev).

| Record | Role | Root file (export) |
|--------|------|--------------------|
| **STATE** | Operation log: status, how to run, done / in progress / shelved / waiting | `STATE.md` |
| **DECISIONS** | User-approved choices only | `DECISIONS.md` |
| **HANDOFF** | Current open handoff for the next session/person | `HANDOFF.md` |

**Strategy A:** SQLite is the source of truth. Markdown files are materializations for humans and git. Handoff **history** stays in the DB; `HANDOFF.md` only reflects the current **open** handoff (removed when none).

This is separate from Pi’s example `/handoff` command (session-to-session prompt transfer). Use `/project-handoff` for project records.

## Install

Requires **Node.js ≥ 22.5** (`node:sqlite`) and `typebox` (Pi peer).

```bash
pi install npm:pi-project-db
# or
pi install git:github.com/boyuruan/pi-project-db
# or local
pi install /absolute/path/to/pi-project-db
```

Then `/reload` or restart pi.

## Storage

```text
~/.pi/agent/project-db/project.db
```

Scoped by stable `project_key` (same scheme as pi-tool-wal):

1. `TOOL_WAL_PROJECT_ID` / `.pi/wal-project-id` / `.pi/tool-wal.json` (shared explicit id files)
2. Git `origin` remote + path relative to toplevel
3. cwd encoding fallback

> Explicit id env/file names currently match tool-wal (`TOOL_WAL_PROJECT_ID`, `wal-project-id`) so one id covers both packages. A dedicated `TOOL_PROJECT_DB_PROJECT_ID` can be added later if needed.

## Agent tools

| Tool | Purpose |
|------|---------|
| `project_state_get` | Read current STATE |
| `project_state_update` | Update STATE + export `STATE.md` |
| `project_decision_add` | Append approved decision + export `DECISIONS.md` |
| `project_decision_list` | List decisions (DB history) |
| `project_handoff_get` | Current open handoff |
| `project_handoff_create` | Create open handoff + export `HANDOFF.md` (supersedes previous open) |
| `project_handoff_close` | Mark consumed/superseded; remove `HANDOFF.md` |
| `project_handoff_list` | Handoff history from DB |

Call `project_state_update` at the end of each accepted task. Call `project_decision_add` only after explicit user approval.

## Commands

| Command | Description |
|---------|-------------|
| `/pdb status` | Summary |
| `/pdb export` | Rewrite markdown exports |
| `/pdb path` | DB path + project identity |
| `/state` | Show STATE |
| `/decisions` | List decisions |
| `/project-handoff` | Show open handoff |
| `/project-handoff list` | History from DB |
| `/project-handoff close` | Close open handoff |

## AGENTS.md snippet

```markdown
## Records (pi-project-db)

- Update project state via `project_state_update` at the end of each accepted task
  (exports STATE.md). Do not hand-edit STATE.md structure.
- Record user-approved long-term choices via `project_decision_add` (exports DECISIONS.md).
- For cross-session project handoff notes, use `project_handoff_create` (exports HANDOFF.md).
  History is in the DB (`project_handoff_list`); HANDOFF.md is only the current open item.
```

## Development

```bash
cd pi-project-db
npm test
pi install "$PWD"
```

## License

MIT
