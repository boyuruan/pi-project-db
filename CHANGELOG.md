# Changelog

## 0.1.1

- Clarify STATE as macro project situation (milestones, blockers, waiting on user)
- Distinguish STATE from per-tool audit logs (pi-tool-wal)
- Tighten tool descriptions and README so agents update STATE only when the overall picture changes

## 0.1.0

- Initial release
- SQLite source of truth for STATE, DECISIONS, and HANDOFF
- Export to project-root `STATE.md`, `DECISIONS.md`, `HANDOFF.md` (open handoff only)
- Stable project identity (git remote / explicit id / cwd fallback)
- Agent tools and `/pdb`, `/state`, `/decisions`, `/project-handoff` commands
