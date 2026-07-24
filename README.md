# pi-project-db

SQLite-backed **project governance records** for [Pi](https://pi.dev).

| Record | Role | Root file (export) |
|--------|------|--------------------|
| **STATE** | Macro project situation (not per-tool noise) | `STATE.md` |
| **DECISIONS** | User-approved long-term choices only | `DECISIONS.md` |
| **HANDOFF** | Current open handoff for the next session/person | `HANDOFF.md` |

### STATE is not a tool log

**STATE** answers: *If I come back in two weeks, what is true about this project?*

Good STATE content (coarse, durable):

- Feature X is implemented and merged
- Experiment B5 still not run
- Waiting on the user to pick storage backend

Bad STATE content (belongs elsewhere):

- Every edit/bash from the last hour → that is **[pi-tool-wal](https://github.com/boyuruan/pi-tool-wal)** audit trail
- A single approved design choice with alternatives → **DECISIONS**
- A one-shot “continue here” packet for the next thread → **HANDOFF**

Update STATE when the **macro picture** changes (milestone landed, blocked, shelved, waiting on user)—not after every tool call or every tiny task slice.

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
| `project_state_get` | Read current macro STATE |
| `project_state_update` | Update macro STATE + export `STATE.md` |
| `project_decision_add` | Append approved decision + export `DECISIONS.md` |
| `project_decision_list` | List decisions (DB history) |
| `project_handoff_get` | Current open handoff |
| `project_handoff_create` | Create open handoff + export `HANDOFF.md` (supersedes previous open) |
| `project_handoff_close` | Mark consumed/superseded; remove `HANDOFF.md` |
| `project_handoff_list` | Handoff history from DB |

Call `project_state_update` when the project’s **overall situation** changed. Call `project_decision_add` only after explicit user approval.

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

- STATE is the macro project situation (what is done / in flight / blocked /
  waiting on the user)—not a per-tool operation log. Update via
  `project_state_update` when that picture changes (exports STATE.md).
- Record user-approved long-term choices via `project_decision_add`
  (exports DECISIONS.md).
- For cross-session project handoff notes, use `project_handoff_create`
  (exports HANDOFF.md). History: `project_handoff_list`.
- Do not hand-edit those markdown structures when the extension is active.
```

## Development

```bash
cd pi-project-db
npm test
pi install "$PWD"
```

## License

MIT
