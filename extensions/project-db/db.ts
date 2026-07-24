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
	CompletedWorkItem,
	Decision,
	DecisionAddInput,
	Handoff,
	HandoffCreateInput,
	HandoffStatus,
	ProjectState,
	StateUpdateInput,
	SubgoalItem,
} from "./types.ts";

const SCHEMA_VERSION = 2;

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
  main_goal TEXT NOT NULL DEFAULT '',
  current_subgoal TEXT NOT NULL DEFAULT '',
  completed_work_json TEXT NOT NULL DEFAULT '[]',
  next_plan TEXT NOT NULL DEFAULT '',
  next_plan_why TEXT NOT NULL DEFAULT '',
  completed_subgoals_json TEXT NOT NULL DEFAULT '[]',
  open_subgoals_json TEXT NOT NULL DEFAULT '[]',
  how_to_run TEXT NOT NULL DEFAULT ''
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

function parseJsonArray(json: string): unknown[] {
	try {
		const v = JSON.parse(json) as unknown;
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

function parseCompletedWork(json: string): CompletedWorkItem[] {
	return parseJsonArray(json)
		.map((item) => {
			if (typeof item === "string") {
				return { text: item, why: "" };
			}
			if (item && typeof item === "object") {
				const o = item as Record<string, unknown>;
				const text =
					typeof o.text === "string"
						? o.text
						: typeof o.title === "string"
							? o.title
							: "";
				if (!text) return null;
				const why = typeof o.why === "string" ? o.why : "";
				const date = typeof o.date === "string" ? o.date : undefined;
				return date ? { text, why, date } : { text, why };
			}
			return null;
		})
		.filter((x): x is CompletedWorkItem => x != null);
}

function parseSubgoals(json: string): SubgoalItem[] {
	return parseJsonArray(json)
		.map((item) => {
			if (typeof item === "string") return { text: item };
			if (item && typeof item === "object") {
				const o = item as Record<string, unknown>;
				const text = typeof o.text === "string" ? o.text : "";
				if (!text) return null;
				const date = typeof o.date === "string" ? o.date : undefined;
				return date ? { text, date } : { text };
			}
			return null;
		})
		.filter((x): x is SubgoalItem => x != null);
}

function parseFiles(json: string): string[] {
	return parseJsonArray(json).filter((x): x is string => typeof x === "string");
}

function emptyState(projectKey: string): ProjectState {
	return {
		projectKey,
		updatedAt: 0,
		sessionId: null,
		mainGoal: "",
		currentSubgoal: "",
		completedWork: [],
		nextPlan: "",
		nextPlanWhy: "",
		completedSubgoals: [],
		openSubgoals: [],
		howToRun: "",
		revisionId: "",
	};
}

function rowToState(row: Record<string, unknown>): ProjectState {
	// v2 columns
	if ("main_goal" in row || "completed_work_json" in row) {
		return {
			projectKey: String(row.project_key),
			updatedAt: Number(row.created_at),
			sessionId: (row.session_id as string | null) ?? null,
			mainGoal: String(row.main_goal ?? ""),
			currentSubgoal: String(row.current_subgoal ?? ""),
			completedWork: parseCompletedWork(String(row.completed_work_json ?? "[]")),
			nextPlan: String(row.next_plan ?? ""),
			nextPlanWhy: String(row.next_plan_why ?? ""),
			completedSubgoals: parseSubgoals(String(row.completed_subgoals_json ?? "[]")),
			openSubgoals: parseSubgoals(String(row.open_subgoals_json ?? "[]")),
			howToRun: String(row.how_to_run ?? ""),
			revisionId: String(row.id),
		};
	}

	// Legacy v1 row shape (pre-migration read path)
	const legacyDone = parseJsonArray(String(row.recently_done_json ?? "[]"));
	const legacyInProgress = parseJsonArray(String(row.in_progress_json ?? "[]"));
	return {
		projectKey: String(row.project_key),
		updatedAt: Number(row.created_at),
		sessionId: (row.session_id as string | null) ?? null,
		mainGoal: "",
		currentSubgoal: String(row.one_line_status ?? ""),
		completedWork: parseCompletedWork(JSON.stringify(legacyDone)),
		nextPlan: "",
		nextPlanWhy: "",
		completedSubgoals: [],
		openSubgoals: parseSubgoals(JSON.stringify(legacyInProgress)),
		howToRun: String(row.how_to_run ?? ""),
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

function tableColumns(db: DatabaseSync, table: string): Set<string> {
	const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
	return new Set(cols.map((c) => c.name));
}

function setSchemaVersion(db: DatabaseSync, version: number): void {
	db.prepare(
		`INSERT INTO meta(key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
	).run(String(version));
}

function migrate(db: DatabaseSync): void {
	const versionRow = db
		.prepare("SELECT value FROM meta WHERE key = 'schema_version'")
		.get() as { value?: string } | undefined;
	let version = versionRow?.value ? Number(versionRow.value) : 0;
	if (!Number.isFinite(version)) version = 0;

	if (!versionRow) {
		db.prepare(
			"INSERT INTO meta(key, value) VALUES ('schema_version', ?), ('created_at', ?)",
		).run(String(SCHEMA_VERSION), String(Date.now()));
		return;
	}

	if (version < 2) {
		const cols = tableColumns(db, "state_revisions");
		const add = (name: string, decl: string) => {
			if (!cols.has(name)) db.exec(`ALTER TABLE state_revisions ADD COLUMN ${decl}`);
		};
		add("main_goal", "main_goal TEXT NOT NULL DEFAULT ''");
		add("current_subgoal", "current_subgoal TEXT NOT NULL DEFAULT ''");
		add("completed_work_json", "completed_work_json TEXT NOT NULL DEFAULT '[]'");
		add("next_plan", "next_plan TEXT NOT NULL DEFAULT ''");
		add("next_plan_why", "next_plan_why TEXT NOT NULL DEFAULT ''");
		add("completed_subgoals_json", "completed_subgoals_json TEXT NOT NULL DEFAULT '[]'");
		add("open_subgoals_json", "open_subgoals_json TEXT NOT NULL DEFAULT '[]'");
		// how_to_run already exists on v1

		// Best-effort backfill from v1 columns when present.
		const legacyCols = tableColumns(db, "state_revisions");
		if (legacyCols.has("one_line_status")) {
			db.exec(`
        UPDATE state_revisions
        SET current_subgoal = CASE
              WHEN TRIM(COALESCE(current_subgoal, '')) = '' THEN COALESCE(one_line_status, '')
              ELSE current_subgoal
            END
        WHERE TRIM(COALESCE(current_subgoal, '')) = ''
          AND TRIM(COALESCE(one_line_status, '')) != ''
      `);
		}
		if (legacyCols.has("recently_done_json")) {
			db.exec(`
        UPDATE state_revisions
        SET completed_work_json = recently_done_json
        WHERE (completed_work_json IS NULL OR completed_work_json = '' OR completed_work_json = '[]')
          AND recently_done_json IS NOT NULL
          AND recently_done_json != ''
          AND recently_done_json != '[]'
      `);
		}
		if (legacyCols.has("in_progress_json")) {
			db.exec(`
        UPDATE state_revisions
        SET open_subgoals_json = in_progress_json
        WHERE (open_subgoals_json IS NULL OR open_subgoals_json = '' OR open_subgoals_json = '[]')
          AND in_progress_json IS NOT NULL
          AND in_progress_json != ''
          AND in_progress_json != '[]'
      `);
		}

		version = 2;
		setSchemaVersion(db, version);
	}
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
		migrate(db);
		db.exec(INDEXES_SQL);
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

		const mergeWork = (
			incoming: CompletedWorkItem[] | undefined,
			existing: CompletedWorkItem[],
		): CompletedWorkItem[] => {
			if (incoming === undefined) return existing;
			if (replace) return incoming;
			return [...existing, ...incoming];
		};

		const mergeSubgoals = (
			incoming: SubgoalItem[] | undefined,
			existing: SubgoalItem[],
		): SubgoalItem[] => {
			if (incoming === undefined) return existing;
			if (replace) return incoming;
			return [...existing, ...incoming];
		};

		const next = {
			mainGoal: input.mainGoal !== undefined ? input.mainGoal : current.mainGoal,
			currentSubgoal:
				input.currentSubgoal !== undefined
					? input.currentSubgoal
					: current.currentSubgoal,
			completedWork: mergeWork(input.completedWork, current.completedWork),
			nextPlan: input.nextPlan !== undefined ? input.nextPlan : current.nextPlan,
			nextPlanWhy:
				input.nextPlanWhy !== undefined ? input.nextPlanWhy : current.nextPlanWhy,
			completedSubgoals: mergeSubgoals(
				input.completedSubgoals,
				current.completedSubgoals,
			),
			openSubgoals: mergeSubgoals(input.openSubgoals, current.openSubgoals),
			howToRun: input.howToRun !== undefined ? input.howToRun : current.howToRun,
		};

		// Normalize empty next plan -> clear why
		if (!next.nextPlan.trim()) {
			next.nextPlan = "";
			if (input.nextPlan !== undefined || !next.nextPlanWhy.trim()) {
				next.nextPlanWhy = input.nextPlanWhy !== undefined ? input.nextPlanWhy : "";
			}
		}

		const db = this.requireDb();
		const id = randomUUID();
		const now = Date.now();
		db.prepare(
			`INSERT INTO state_revisions (
        id, project_key, created_at, session_id,
        main_goal, current_subgoal, completed_work_json,
        next_plan, next_plan_why,
        completed_subgoals_json, open_subgoals_json,
        how_to_run
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			id,
			projectKey,
			now,
			sessionId ?? null,
			next.mainGoal.trim(),
			next.currentSubgoal.trim(),
			JSON.stringify(next.completedWork),
			next.nextPlan.trim(),
			next.nextPlanWhy.trim(),
			JSON.stringify(next.completedSubgoals),
			JSON.stringify(next.openSubgoals),
			next.howToRun,
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
			id != null ? this.getHandoff(id) : this.getOpenHandoff(projectKey);
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
