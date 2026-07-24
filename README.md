# pi-project-db

SQLite-backed **project governance records** for [Pi](https://pi.dev).

| Record | Role | Root file (export) |
|--------|------|--------------------|
| **STATE** | Structured goal snapshot (macro, not per-tool) | `STATE.md` |
| **DECISIONS** | User-approved long-term choices only | `DECISIONS.md` |
| **HANDOFF** | Current open handoff for the next session/person | `HANDOFF.md` |

### STATE shape

STATE answers: *If I come back in two weeks, what is the goal tree and where are we?*

| Field | Meaning |
|-------|---------|
| `mainGoal` | Project main goal |
| `currentSubgoal` | Active subgoal (empty if idle / done) |
| `completedWork[]` | Finished work; each item has `text` + **`why`** (link to main/current goal) |
| `nextPlan` | Next concrete plan (empty if nothing planned or complete) |
| `nextPlanWhy` | How `nextPlan` serves main/current goal |
| `completedSubgoals[]` | Finished subgoals |
| `openSubgoals[]` | Not-yet-finished subgoals |
| `howToRun` | Shortest build/test/run commands |

Not STATE (different tools):

- Per-tool audit → **[pi-tool-wal](https://github.com/boyuruan/pi-tool-wal)**
- A single approved design choice → **DECISIONS**
- One-shot continue-here packet → **HANDOFF**

Update STATE when the **goal tree or progress picture** changes—not after every tool call.

**Strategy A:** SQLite is the source of truth. Markdown files are materializations for humans and git. Handoff **history** stays in the DB; `HANDOFF.md` only reflects the current **open** handoff (removed when none).

Pi’s example `/handoff` is session-to-session prompt transfer. Use `/project-handoff` for project records.

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

1. `TOOL_WAL_PROJECT_ID` / `.pi/wal-project-id` / `.pi/tool-wal.json`
2. Git `origin` remote + path relative to toplevel
3. cwd encoding fallback

## Agent tools

| Tool | Purpose |
|------|---------|
| `project_state_get` | Read structured STATE |
| `project_state_update` | Update STATE + export `STATE.md` |
| `project_decision_add` | Append approved decision + export `DECISIONS.md` |
| `project_decision_list` | List decisions (DB history) |
| `project_handoff_get` | Current open handoff |
| `project_handoff_create` | Create open handoff + export `HANDOFF.md` |
| `project_handoff_close` | Mark consumed/superseded; remove `HANDOFF.md` |
| `project_handoff_list` | Handoff history from DB |

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

- STATE is a structured goal snapshot: mainGoal, currentSubgoal,
  completedWork[{text, why}], nextPlan + nextPlanWhy, completed/open subgoals.
  Update via `project_state_update` when that picture changes.
- Every completedWork item must include why (link to main/current goal).
- nextPlan may be empty if work is complete.
- Record user-approved choices via `project_decision_add`.
- Project handoff notes: `project_handoff_create` (not Pi session /handoff).
```

## Development

```bash
cd pi-project-db
npm test
pi install "$PWD"
```

## License

MIT
