/**
 * Shared types for pi-project-db.
 *
 * SQLite is the source of truth. Markdown files in the project root are
 * materializations for humans and git (strategy A).
 *
 * STATE holds the macro project situation (milestones, blockers, waiting on
 * the user). It is not a per-tool operation log (see pi-tool-wal).
 */

export type HandoffStatus = "open" | "consumed" | "superseded";

export interface BulletItem {
	/** Optional date label, e.g. 2026-07-17 or 07-12 */
	date?: string;
	text: string;
}

export interface ProjectState {
	projectKey: string;
	updatedAt: number;
	sessionId: string | null;
	oneLineStatus: string;
	howToRun: string;
	recentlyDone: BulletItem[];
	inProgress: BulletItem[];
	shelved: BulletItem[];
	waitingOnUser: BulletItem[];
	/** Revision id of this snapshot */
	revisionId: string;
}

export interface StateUpdateInput {
	oneLineStatus?: string;
	howToRun?: string;
	recentlyDone?: BulletItem[];
	inProgress?: BulletItem[];
	shelved?: BulletItem[];
	waitingOnUser?: BulletItem[];
	/**
	 * When true (default), list fields replace the current lists.
	 * When false, provided list items are appended.
	 */
	replaceLists?: boolean;
}

export interface Decision {
	id: string;
	projectKey: string;
	decidedOn: string;
	title: string;
	decision: string;
	alternatives: string;
	reason: string;
	impact: string;
	sessionId: string | null;
	createdAt: number;
}

export interface DecisionAddInput {
	title: string;
	decision: string;
	alternatives?: string;
	reason?: string;
	impact?: string;
	/** YYYY-MM-DD; defaults to today (local). */
	decidedOn?: string;
}

export interface Handoff {
	id: string;
	projectKey: string;
	status: HandoffStatus;
	goal: string;
	context: string;
	files: string[];
	nextTask: string;
	fromSessionId: string | null;
	sessionId: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface HandoffCreateInput {
	goal: string;
	context?: string;
	files?: string[];
	nextTask?: string;
	/** If true (default), supersede any existing open handoff. */
	supersedeOpen?: boolean;
}

export interface ProjectMeta {
	projectKey: string;
	projectKeySource: string;
	cwd: string;
	sessionId: string | null;
	sessionFile: string | null;
}
