/**
 * Shared types for pi-project-db.
 *
 * SQLite is the source of truth. Markdown files in the project root are
 * materializations for humans and git (strategy A).
 *
 * STATE is a structured macro snapshot: goals, completed work (with why),
 * next plan (with why), and subgoal lists. Not a per-tool log (pi-tool-wal).
 */

export type HandoffStatus = "open" | "consumed" | "superseded";

/** Completed work unit with an explicit link to the main/current goal. */
export interface CompletedWorkItem {
	/** What was finished (coarse, durable). */
	text: string;
	/** Why it matters for main_goal and/or current_subgoal. */
	why: string;
	/** Optional date label, e.g. 2026-07-17 */
	date?: string;
}

/** A subgoal entry (completed or still open). */
export interface SubgoalItem {
	text: string;
	date?: string;
}

/**
 * Macro project situation.
 *
 * Answers: two weeks later, what is the goal tree and where are we on it?
 */
export interface ProjectState {
	projectKey: string;
	updatedAt: number;
	sessionId: string | null;
	/** Top-level project goal. */
	mainGoal: string;
	/** Active subgoal under mainGoal (empty if idle / fully done). */
	currentSubgoal: string;
	/** Finished work items, each with why it serves the goal(s). */
	completedWork: CompletedWorkItem[];
	/** Next concrete plan; empty if nothing planned or work is complete. */
	nextPlan: string;
	/** How nextPlan serves mainGoal / currentSubgoal (empty if nextPlan empty). */
	nextPlanWhy: string;
	/** Subgoals already finished. */
	completedSubgoals: SubgoalItem[];
	/** Subgoals not finished yet (includes current and queued). */
	openSubgoals: SubgoalItem[];
	/** Shortest commands to build/test/run (practical pickup, not narrative). */
	howToRun: string;
	/** Revision id of this snapshot */
	revisionId: string;
}

export interface StateUpdateInput {
	mainGoal?: string;
	currentSubgoal?: string;
	completedWork?: CompletedWorkItem[];
	nextPlan?: string;
	nextPlanWhy?: string;
	completedSubgoals?: SubgoalItem[];
	openSubgoals?: SubgoalItem[];
	howToRun?: string;
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
