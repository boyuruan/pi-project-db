/**
 * SQLite store for project governance records.
 *
 * DB path: ~/.pi/agent/project-db/project.db
 */

import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
	BulletItem,
	Decision,
	DecisionAddInput,
	Handoff,
	HandoffCreateInput,
	HandoffStatus,
	ProjectState,
	StateUpdateInput,
} from "./types.ts";

const SCHEMA_VERSION = 1;

const TABLES_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_key TEXT PRIMARY KEY,
  project_key_source TEXT,
  cwd TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS state_revisions (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  session_id TEXT,
  one_line_status TEXT NOT NULL DEFAULT '',
  how_to_run TEXT NOT NULL DEFAULT '',
  recently_done_json TEXT NOT NULL DEFAULT '[]',
  in_progress_json TEXT NOT NULL DEFAULT '[]',
  shelved_json TEXT NOT NULL DEFAULT '[]',
  waiting_on_user_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  decided_on TEXT NOT NULL,
  title TEXT NOT NULL,
  decision TEXT NOT NULL,
  alternatives TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  impact TEXT NOT NULL DEFAULT '',
  session_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  status TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  files_json TEXT NOT NULL DEFAULT '[]',
  next_task TEXT NOT NULL DEFAULT '',
  from_session_id TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`;

const INDEXES_SQL = `
CREATE INDEX IF NOT EXISTS idx_state_project_created
  ON state_revisions(project_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_project_created
  ON decisions(project_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_handoffs_project_status
  ON handoffs(project_key, status);
CREATE INDEX IF NOT EXISTS idx_handoffs_project_created
  ON handoffs(project_key, created_at DESC);
`;

export function defaultDbPath(): string {
	return join(homedir(), ".pi", "agent", "project-db", "project.db");
}

function todayLocal(): string {
	const d = new Date();
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function parseBullets(json: string): BulletItem[] {
	try {
		const v = JSON.parse(json) as unknown;
		if (!Array.isArray(v)) return [];
		return v
			.map((item) => {
				if (typeof item === "string") return { text: item };
				if (item && typeof item === "object") {
					const o = item as Record<string, unknown>;
					const text = typeof o.text === "string" ? o.text : "";
					if (!text) return null;
					const date = typeof o.date === "string" ? o.date : undefined;
					return date ? { date, text } : { text };
				}
				return null;
			})
			.filter((x): x is BulletItem => x != null);
	} catch {
		return [];
	}
}

function bulletsJson(items: BulletItem[]): string {
	return JSON.stringify(items ?? []);
}

function parseFiles(json: string): string[] {
	try {
		const v = JSON.parse(json) as unknown;
		if (!Array.isArray(v)) return [];
		return v.filter((x): x is string => typeof x === "string");
	} catch {
		return [];
	}
}

function emptyState(projectKey: string): ProjectState {
	return {
		projectKey,
		updatedAt: 0,
		sessionId: null,
		oneLineStatus: "",
		howToRun: "",
		recentlyDone: [],
		inProgress: [],
		shelved: [],
		waitingOnUser: [],
		revisionId: "",
	};
}

function rowToState(row: Record<string, unknown>): ProjectState {
	return {
		projectKey: String(row.project_key),
		updatedAt: Number(row.created_at),
		sessionId: (row.session_id as string | null) ?? null,
		oneLineStatus: String(row.one_line_status ?? ""),
		howToRun: String(row.how_to_run ?? ""),
		recentlyDone: parseBullets(String(row.recently_done_json ?? "[]")),
		inProgress: parseBullets(String(row.in_progress_json ?? "[]")),
		shelved: parseBullets(String(row.shelved_json ?? "[]")),
		waitingOnUser: parseBullets(String(row.waiting_on_user_json ?? "[]")),
		revisionId: String(row.id),
	};
}

function rowToDecision(row: Record<string, unknown>): Decision {
	return {
		id: String(row.id),
		projectKey: String(row.project_key),
		decidedOn: String(row.decided_on),
		title: String(row.title),
		decision: String(row.decision),
		alternatives: String(row.alternatives ?? ""),
		reason: String(row.reason ?? ""),
		impact: String(row.impact ?? ""),
		sessionId: (row.session_id as string | null) ?? null,
		createdAt: Number(row.created_at),
	};
}

function rowToHandoff(row: Record<string, unknown>): Handoff {
	return {
		id: String(row.id),
		projectKey: String(row.project_key),
		status: String(row.status) as HandoffStatus,
		goal: String(row.goal ?? ""),
		context: String(row.context ?? ""),
		files: parseFiles(String(row.files_json ?? "[]")),
		nextTask: String(row.next_task ?? ""),
		fromSessionId: (row.from_session_id as string | null) ?? null,
		sessionId: (row.session_id as string | null) ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

export class ProjectDbStore {
	readonly dbPath: string;
	private db: DatabaseSync | null = null;

	constructor(dbPath: string = defaultDbPath()) {
		this.dbPath = dbPath;
	}

	get isOpen(): boolean {
		return this.db !== null;
	}

	open(): void {
		if (this.db) return;
		mkdirSync(dirname(this.dbPath), { recursive: true });
		const db = new DatabaseSync(this.dbPath);
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA synchronous = NORMAL;");
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec(TABLES_SQL);
		db.exec(INDEXES_SQL);

		const versionRow = db
			.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
			.get() as { value?: string } | undefined;
		if (!versionRow) {
			db.prepare(
				"INSERT INTO meta(key, value) VALUES ('schema_version', ?), ('created_at', ?)",
			).run(String(SCHEMA_VERSION), String(Date.now()));
		}
		this.db = db;
	}

	close(): void {
		if (!this.db) return;
		try {
			this.db.close();
		} catch {
			// ignore
		}
		this.db = null;
	}

	private requireDb(): DatabaseSync {
		if (!this.db) throw new Error("project-db is not open");
		return this.db;
	}

	touchProject(projectKey: string, source: string, cwd: string): void {
		const db = this.requireDb();
		const now = Date.now();
		db.prepare(
			`INSERT INTO projects(project_key, project_key_source, cwd, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_key) DO UPDATE SET
         project_key_source = excluded.project_key_source,
         cwd = excluded.cwd,
         updated_at = excluded.updated_at`,
		).run(projectKey, source, cwd, now);
	}

	getState(projectKey: string): ProjectState {
		const db = this.requireDb();
		const row = db
			.prepare(
				`SELECT * FROM state_revisions
         WHERE project_key = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
			)
			.get(projectKey) as Record<string, unknown> | undefined;
		return row ? rowToState(row) : emptyState(projectKey);
	}

	updateState(
		projectKey: string,
		input: StateUpdateInput,
		sessionId?: string | null,
	): ProjectState {
		const current = this.getState(projectKey);
		const replace = input.replaceLists !== false;

		const mergeList = (
			incoming: BulletItem[] | undefined,
			existing: BulletItem[],
		): BulletItem[] => {
			if (incoming === undefined) return existing;
			if (replace) return incoming;
			return [...existing, ...incoming];
		};

		const next = {
			oneLineStatus:
				input.oneLineStatus !== undefined
					? input.oneLineStatus
					: current.oneLineStatus,
			howToRun: input.howToRun !== undefined ? input.howToRun : current.howToRun,
			recentlyDone: mergeList(input.recentlyDone, current.recentlyDone),
			inProgress: mergeList(input.inProgress, current.inProgress),
			shelved: mergeList(input.shelved, current.shelved),
			waitingOnUser: mergeList(input.waitingOnUser, current.waitingOnUser),
		};

		const db = this.requireDb();
		const id = randomUUID();
		const now = Date.now();
		db.prepare(
			`INSERT INTO state_revisions (
        id, project_key, created_at, session_id,
        one_line_status, how_to_run,
        recently_done_json, in_progress_json, shelved_json, waiting_on_user_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			projectKey,
			now,
			sessionId ?? null,
			next.oneLineStatus,
			next.howToRun,
			bulletsJson(next.recentlyDone),
			bulletsJson(next.inProgress),
			bulletsJson(next.shelved),
			bulletsJson(next.waitingOnUser),
		);

		return this.getState(projectKey);
	}

	listStateRevisions(projectKey: string, limit = 20): ProjectState[] {
		const db = this.requireDb();
		const rows = db
			.prepare(
				`SELECT * FROM state_revisions
         WHERE project_key = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
			)
			.all(projectKey, Math.max(1, Math.min(limit, 200))) as Array<
			Record<string, unknown>
		>;
		return rows.map(rowToState);
	}

	addDecision(
		projectKey: string,
		input: DecisionAddInput,
		sessionId?: string | null,
	): Decision {
		const db = this.requireDb();
		const id = randomUUID();
		const now = Date.now();
		const decidedOn = input.decidedOn?.trim() || todayLocal();
		db.prepare(
			`INSERT INTO decisions (
        id, project_key, decided_on, title, decision,
        alternatives, reason, impact, session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			projectKey,
			decidedOn,
			input.title.trim(),
			input.decision.trim(),
			(input.alternatives ?? "").trim(),
			(input.reason ?? "").trim(),
			(input.impact ?? "").trim(),
			sessionId ?? null,
			now,
		);
		return this.getDecision(id)!;
	}

	getDecision(id: string): Decision | null {
		const db = this.requireDb();
		const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToDecision(row) : null;
	}

	listDecisions(projectKey: string, limit = 100): Decision[] {
		const db = this.requireDb();
		const rows = db
			.prepare(
				`SELECT * FROM decisions
         WHERE project_key = ?
         ORDER BY decided_on DESC, created_at DESC, rowid DESC
         LIMIT ?`,
			)
			.all(projectKey, Math.max(1, Math.min(limit, 500))) as Array<
			Record<string, unknown>
		>;
		return rows.map(rowToDecision);
	}

	getOpenHandoff(projectKey: string): Handoff | null {
		const db = this.requireDb();
		const row = db
			.prepare(
				`SELECT * FROM handoffs
         WHERE project_key = ? AND status = 'open'
         ORDER BY created_at DESC, rowid DESC
         LIMIT 1`,
			)
			.get(projectKey) as Record<string, unknown> | undefined;
		return row ? rowToHandoff(row) : null;
	}

	createHandoff(
		projectKey: string,
		input: HandoffCreateInput,
		sessionId?: string | null,
	): Handoff {
		const db = this.requireDb();
		const now = Date.now();
		const supersede = input.supersedeOpen !== false;

		if (supersede) {
			db.prepare(
				`UPDATE handoffs
         SET status = 'superseded', updated_at = ?
         WHERE project_key = ? AND status = 'open'`,
			).run(now, projectKey);
		}

		const id = randomUUID();
		db.prepare(
			`INSERT INTO handoffs (
        id, project_key, status, goal, context, files_json, next_task,
        from_session_id, session_id, created_at, updated_at
      ) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			projectKey,
			input.goal.trim(),
			(input.context ?? "").trim(),
			JSON.stringify(input.files ?? []),
			(input.nextTask ?? "").trim(),
			sessionId ?? null,
			sessionId ?? null,
			now,
			now,
		);
		return this.getHandoff(id)!;
	}

	getHandoff(id: string): Handoff | null {
		const db = this.requireDb();
		const row = db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id) as
			| Record<string, unknown>
			| undefined;
		return row ? rowToHandoff(row) : null;
	}

	closeHandoff(
		projectKey: string,
		status: "consumed" | "superseded" = "consumed",
		id?: string,
	): Handoff | null {
		const db = this.requireDb();
		const target =
			id != null
				? this.getHandoff(id)
				: this.getOpenHandoff(projectKey);
		if (!target || target.projectKey !== projectKey) return null;
		if (target.status !== "open") return target;

		const now = Date.now();
		db.prepare(
			`UPDATE handoffs SET status = ?, updated_at = ? WHERE id = ?`,
		).run(status, now, target.id);
		return this.getHandoff(target.id);
	}

	listHandoffs(
		projectKey: string,
		options: { status?: HandoffStatus; limit?: number } = {},
	): Handoff[] {
		const db = this.requireDb();
		const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
		if (options.status) {
			const rows = db
				.prepare(
					`SELECT * FROM handoffs
           WHERE project_key = ? AND status = ?
           ORDER BY created_at DESC, rowid DESC
           LIMIT ?`,
				)
				.all(projectKey, options.status, limit) as Array<Record<string, unknown>>;
			return rows.map(rowToHandoff);
		}
		const rows = db
			.prepare(
				`SELECT * FROM handoffs
         WHERE project_key = ?
         ORDER BY created_at DESC, rowid DESC
         LIMIT ?`,
			)
			.all(projectKey, limit) as Array<Record<string, unknown>>;
		return rows.map(rowToHandoff);
	}
}
