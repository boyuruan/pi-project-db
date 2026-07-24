/**
 * pi-project-db — project governance records in SQLite (strategy A).
 *
 * Source of truth: ~/.pi/agent/project-db/project.db
 * Materialized files (project root): STATE.md, DECISIONS.md, HANDOFF.md
 *
 * STATE = structured goal snapshot (main/current goal, completed work+why,
 * next plan+why, subgoal lists). Not a per-tool log (pi-tool-wal).
 *
 * HANDOFF.md reflects only the current open handoff. History is queried from DB.
 *
 * Tools (for the agent):
 *   project_state_get / project_state_update
 *   project_decision_add / project_decision_list
 *   project_handoff_get / project_handoff_create / project_handoff_close / project_handoff_list
 *
 * Commands:
 *   /pdb status | export | path
 *   /state [show]
 *   /decisions [list]
 *   /project-handoff [show|list|close]
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { ProjectDbStore } from "./db.ts";
import { exportProjectMarkdown } from "./markdown.ts";
import {
	clearProjectIdentityCache,
	resolveProjectIdentity,
} from "./project-id.ts";
import type {
	CompletedWorkItem,
	Decision,
	Handoff,
	ProjectMeta,
	ProjectState,
	SubgoalItem,
} from "./types.ts";

const CompletedWorkSchema = Type.Object({
	text: Type.String({ description: "What was finished (coarse, durable)" }),
	why: Type.String({
		description: "Why this serves main_goal and/or current_subgoal",
	}),
	date: Type.Optional(Type.String({ description: "Optional date, e.g. 2026-07-17" })),
});

const SubgoalSchema = Type.Object({
	text: Type.String({ description: "Subgoal text" }),
	date: Type.Optional(Type.String({ description: "Optional date label" })),
});

function metaFromCtx(ctx: ExtensionContext): ProjectMeta {
	const identity = resolveProjectIdentity(ctx.cwd);
	const sm = ctx.sessionManager;
	return {
		projectKey: identity.projectKey,
		projectKeySource: identity.source,
		cwd: identity.cwd,
		sessionId: sm.getSessionId?.() ?? null,
		sessionFile: sm.getSessionFile?.() ?? null,
	};
}

function ensureStore(store: ProjectDbStore): boolean {
	if (store.isOpen) return true;
	try {
		store.open();
		return true;
	} catch (err) {
		console.error("[project-db] open failed:", err);
		return false;
	}
}

function touch(store: ProjectDbStore, meta: ProjectMeta): void {
	store.touchProject(meta.projectKey, meta.projectKeySource, meta.cwd);
}

function exportAll(store: ProjectDbStore, meta: ProjectMeta) {
	const state = store.getState(meta.projectKey);
	const decisions = store.listDecisions(meta.projectKey);
	const openHandoff = store.getOpenHandoff(meta.projectKey);
	return exportProjectMarkdown(meta.cwd, { state, decisions, openHandoff });
}

function textResult(text: string) {
	return {
		content: [{ type: "text" as const, text }],
	};
}

function formatState(state: ProjectState): string {
	const lines = [
		`project: ${state.projectKey}`,
		`updated: ${state.updatedAt ? new Date(state.updatedAt).toISOString() : "never"}`,
		`revision: ${state.revisionId || "(none)"}`,
		"",
		`main goal: ${state.mainGoal || "(empty)"}`,
		`current subgoal: ${state.currentSubgoal || "(none)"}`,
		"",
		`completed work (${state.completedWork.length}):`,
		...state.completedWork.map(
			(b) =>
				`  - ${b.date ? `[${b.date}] ` : ""}${b.text}\n    why: ${b.why || "(missing)"}`,
		),
		"",
		`next plan: ${state.nextPlan || "(none)"}`,
		`next plan why: ${state.nextPlanWhy || "(n/a)"}`,
		"",
		`completed subgoals (${state.completedSubgoals.length}):`,
		...state.completedSubgoals.map(
			(b) => `  - ${b.date ? `[${b.date}] ` : ""}${b.text}`,
		),
		`open subgoals (${state.openSubgoals.length}):`,
		...state.openSubgoals.map((b) => `  - ${b.date ? `[${b.date}] ` : ""}${b.text}`),
		"",
		"how to run:",
		state.howToRun || "(empty)",
	];
	return lines.join("\n");
}

function formatDecision(d: Decision): string {
	return [
		`${d.decidedOn}  ${d.title}  (${d.id.slice(0, 8)})`,
		`  decision: ${d.decision}`,
		d.alternatives ? `  alternatives: ${d.alternatives}` : "",
		d.reason ? `  reason: ${d.reason}` : "",
		d.impact ? `  impact: ${d.impact}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function formatHandoff(h: Handoff): string {
	return [
		`[${h.status}] ${h.id.slice(0, 8)}  ${new Date(h.createdAt).toISOString().slice(0, 10)}`,
		`  goal: ${h.goal}`,
		h.nextTask ? `  next: ${h.nextTask}` : "",
		h.files.length ? `  files: ${h.files.join(", ")}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function notify(ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") {
	if (!ctx.hasUI) {
		console.log(`[project-db] ${msg}`);
		return;
	}
	try {
		ctx.ui.notify(msg, level);
	} catch {
		// ignore
	}
}

export default function (pi: ExtensionAPI) {
	const store = new ProjectDbStore();

	pi.on("session_start", async (_event, ctx) => {
		try {
			clearProjectIdentityCache();
			store.open();
			const meta = metaFromCtx(ctx);
			touch(store, meta);
		} catch (err) {
			console.error("[project-db] session_start:", err);
		}
	});

	pi.on("session_shutdown", async () => {
		try {
			store.close();
		} catch (err) {
			console.error("[project-db] session_shutdown:", err);
		}
	});

	// ---- tools ----

	pi.registerTool({
		name: "project_state_get",
		label: "Project State Get",
		description:
			"Read structured project STATE: main goal, current subgoal, completed work (with why), next plan (with why), completed/open subgoals, how to run. Not a per-tool log.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const state = store.getState(meta.projectKey);
			return textResult(formatState(state));
		},
	});

	pi.registerTool({
		name: "project_state_update",
		label: "Project State Update",
		description:
			"Update structured project STATE in SQLite and export STATE.md. Fields: mainGoal, currentSubgoal, completedWork[{text,why}], nextPlan, nextPlanWhy, completedSubgoals, openSubgoals, howToRun. Use when the goal tree or progress picture changes—not after every tool call. Each completedWork item must include why (link to main/current goal). nextPlan may be empty if work is done. Omitting a field leaves it unchanged. Lists replace by default; replaceLists=false appends.",
		parameters: Type.Object({
			mainGoal: Type.Optional(
				Type.String({ description: "Top-level project goal" }),
			),
			currentSubgoal: Type.Optional(
				Type.String({ description: "Active subgoal under mainGoal" }),
			),
			completedWork: Type.Optional(Type.Array(CompletedWorkSchema)),
			nextPlan: Type.Optional(
				Type.String({
					description: "Next concrete plan; empty if nothing planned or complete",
				}),
			),
			nextPlanWhy: Type.Optional(
				Type.String({
					description: "How nextPlan serves mainGoal / currentSubgoal",
				}),
			),
			completedSubgoals: Type.Optional(Type.Array(SubgoalSchema)),
			openSubgoals: Type.Optional(Type.Array(SubgoalSchema)),
			howToRun: Type.Optional(
				Type.String({ description: "Shortest build/test/run commands" }),
			),
			replaceLists: Type.Optional(
				Type.Boolean({
					description: "Default true: replace list fields. false: append items.",
				}),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const state = store.updateState(
				meta.projectKey,
				{
					mainGoal: params.mainGoal,
					currentSubgoal: params.currentSubgoal,
					completedWork: params.completedWork as CompletedWorkItem[] | undefined,
					nextPlan: params.nextPlan,
					nextPlanWhy: params.nextPlanWhy,
					completedSubgoals: params.completedSubgoals as SubgoalItem[] | undefined,
					openSubgoals: params.openSubgoals as SubgoalItem[] | undefined,
					howToRun: params.howToRun,
					replaceLists: params.replaceLists,
				},
				meta.sessionId,
			);
			const exported = exportAll(store, meta);
			return textResult(
				`${formatState(state)}\n\nexported: ${exported.statePath}`,
			);
		},
	});

	pi.registerTool({
		name: "project_decision_add",
		label: "Project Decision Add",
		description:
			"Record a user-approved decision in SQLite and export DECISIONS.md. Only call after explicit user approval.",
		parameters: Type.Object({
			title: Type.String({ description: "Short decision title" }),
			decision: Type.String({ description: "What was decided" }),
			alternatives: Type.Optional(Type.String()),
			reason: Type.Optional(Type.String()),
			impact: Type.Optional(Type.String()),
			decidedOn: Type.Optional(
				Type.String({ description: "YYYY-MM-DD (default: today)" }),
			),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const d = store.addDecision(
				meta.projectKey,
				{
					title: params.title,
					decision: params.decision,
					alternatives: params.alternatives,
					reason: params.reason,
					impact: params.impact,
					decidedOn: params.decidedOn,
				},
				meta.sessionId,
			);
			const exported = exportAll(store, meta);
			return textResult(`${formatDecision(d)}\n\nexported: ${exported.decisionsPath}`);
		},
	});

	pi.registerTool({
		name: "project_decision_list",
		label: "Project Decision List",
		description: "List decisions for this project from SQLite (history).",
		parameters: Type.Object({
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const list = store.listDecisions(meta.projectKey, params.limit ?? 50);
			if (!list.length) return textResult("No decisions recorded.");
			return textResult(list.map(formatDecision).join("\n\n"));
		},
	});

	pi.registerTool({
		name: "project_handoff_get",
		label: "Project Handoff Get",
		description: "Get the current open project handoff, if any.",
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const h = store.getOpenHandoff(meta.projectKey);
			if (!h) return textResult("No open handoff.");
			return textResult(
				[
					formatHandoff(h),
					"",
					"context:",
					h.context || "(empty)",
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: "project_handoff_create",
		label: "Project Handoff Create",
		description:
			"Create an open project handoff in SQLite and export HANDOFF.md. Supersedes any previous open handoff by default. History remains in the DB.",
		parameters: Type.Object({
			goal: Type.String(),
			context: Type.Optional(Type.String()),
			files: Type.Optional(Type.Array(Type.String())),
			nextTask: Type.Optional(Type.String()),
			supersedeOpen: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const h = store.createHandoff(
				meta.projectKey,
				{
					goal: params.goal,
					context: params.context,
					files: params.files,
					nextTask: params.nextTask,
					supersedeOpen: params.supersedeOpen,
				},
				meta.sessionId,
			);
			const exported = exportAll(store, meta);
			return textResult(
				`${formatHandoff(h)}\n\nexported: ${exported.handoffPath ?? "(no file)"}`,
			);
		},
	});

	pi.registerTool({
		name: "project_handoff_close",
		label: "Project Handoff Close",
		description:
			"Close the open handoff (consumed or superseded) and remove HANDOFF.md. History stays in the DB.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.String({
					description: '"consumed" (default) or "superseded"',
				}),
			),
			id: Type.Optional(Type.String({ description: "Handoff id; default: current open" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const status =
				params.status === "superseded" ? "superseded" : "consumed";
			const h = store.closeHandoff(meta.projectKey, status, params.id);
			if (!h) return textResult("No matching open handoff.");
			const exported = exportAll(store, meta);
			return textResult(
				`${formatHandoff(h)}\n\nHANDOFF.md ${exported.handoffRemoved ? "removed" : "updated"}`,
			);
		},
	});

	pi.registerTool({
		name: "project_handoff_list",
		label: "Project Handoff List",
		description: "List handoff history for this project from SQLite.",
		parameters: Type.Object({
			status: Type.Optional(
				Type.String({ description: 'Filter: "open" | "consumed" | "superseded"' }),
			),
			limit: Type.Optional(Type.Number()),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!ensureStore(store)) return textResult("project-db unavailable");
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const statusFilter =
				params.status === "open" ||
				params.status === "consumed" ||
				params.status === "superseded"
					? params.status
					: undefined;
			const list = store.listHandoffs(meta.projectKey, {
				status: statusFilter,
				limit: params.limit ?? 20,
			});
			if (!list.length) return textResult("No handoffs recorded.");
			return textResult(list.map(formatHandoff).join("\n"));
		},
	});

	// ---- commands ----

	const print = (ctx: ExtensionContext, text: string) => {
		console.log(`[project-db]\n${text}`);
		notify(
			ctx,
			text.length > 1500 ? `${text.slice(0, 1500)}\n…(see console)` : text,
		);
	};

	pi.registerCommand("pdb", {
		description: "Project DB: status | export | path | help",
		handler: async (args, ctx) => {
			if (!ensureStore(store)) {
				notify(ctx, "project-db unavailable", "error");
				return;
			}
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const cmd = (args ?? "").trim().split(/\s+/)[0] || "status";

			switch (cmd.toLowerCase()) {
				case "status":
				case "s": {
					const state = store.getState(meta.projectKey);
					const decisions = store.listDecisions(meta.projectKey, 5);
					const open = store.getOpenHandoff(meta.projectKey);
					const handoffCount = store.listHandoffs(meta.projectKey, { limit: 500 }).length;
					print(
						ctx,
						[
							`project: ${meta.projectKey}  [${meta.projectKeySource}]`,
							`cwd:     ${meta.cwd}`,
							`main:    ${state.mainGoal || "(empty)"}`,
							`current: ${state.currentSubgoal || "(none)"}`,
							`next:    ${state.nextPlan || "(none)"}`,
							`decisions: ${store.listDecisions(meta.projectKey, 500).length} (showing ${decisions.length} latest titles)`,
							...decisions.map((d) => `  - ${d.decidedOn} ${d.title}`),
							`handoff open: ${open ? open.goal : "(none)"}`,
							`handoff history: ${handoffCount}`,
							`db: ${store.dbPath}`,
						].join("\n"),
					);
					return;
				}
				case "export": {
					const exported = exportAll(store, meta);
					print(
						ctx,
						[
							"Exported:",
							`  ${exported.statePath}`,
							`  ${exported.decisionsPath}`,
							exported.handoffPath
								? `  ${exported.handoffPath}`
								: `  HANDOFF.md ${exported.handoffRemoved ? "removed" : "(no open handoff)"}`,
						].join("\n"),
					);
					return;
				}
				case "path":
				case "db": {
					print(
						ctx,
						[
							`db:      ${store.dbPath}`,
							`project: ${meta.projectKey}`,
							`source:  ${meta.projectKeySource}`,
							`cwd:     ${meta.cwd}`,
						].join("\n"),
					);
					return;
				}
				case "help":
				default: {
					print(
						ctx,
						[
							"pi-project-db commands:",
							"  /pdb status     summary",
							"  /pdb export     rewrite STATE.md DECISIONS.md HANDOFF.md",
							"  /pdb path       database + project identity",
							"  /state          show current state",
							"  /decisions      list decisions",
							"  /project-handoff [show|list|close]",
							"",
							"Agent tools: project_state_* (macro situation), project_decision_*, project_handoff_*",
							"STATE ≠ tool-wal: no per-operation noise in STATE.",
						].join("\n"),
					);
				}
			}
		},
	});

	pi.registerCommand("state", {
		description: "Show macro project STATE (situation, not tool log)",
		handler: async (_args, ctx) => {
			if (!ensureStore(store)) {
				notify(ctx, "project-db unavailable", "error");
				return;
			}
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			print(ctx, formatState(store.getState(meta.projectKey)));
		},
	});

	pi.registerCommand("decisions", {
		description: "List project decisions from pi-project-db",
		handler: async (args, ctx) => {
			if (!ensureStore(store)) {
				notify(ctx, "project-db unavailable", "error");
				return;
			}
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const n = Math.max(1, Math.min(Number((args ?? "").trim()) || 30, 200));
			const list = store.listDecisions(meta.projectKey, n);
			print(
				ctx,
				list.length ? list.map(formatDecision).join("\n\n") : "No decisions recorded.",
			);
		},
	});

	pi.registerCommand("project-handoff", {
		description: "Project handoff records: show | list | close (not Pi /handoff)",
		handler: async (args, ctx) => {
			if (!ensureStore(store)) {
				notify(ctx, "project-db unavailable", "error");
				return;
			}
			const meta = metaFromCtx(ctx);
			touch(store, meta);
			const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] || "show").toLowerCase();

			if (sub === "list") {
				const list = store.listHandoffs(meta.projectKey, { limit: 30 });
				print(
					ctx,
					list.length ? list.map(formatHandoff).join("\n") : "No handoffs recorded.",
				);
				return;
			}
			if (sub === "close") {
				const h = store.closeHandoff(meta.projectKey, "consumed");
				exportAll(store, meta);
				print(ctx, h ? `Closed:\n${formatHandoff(h)}` : "No open handoff.");
				return;
			}
			// show
			const h = store.getOpenHandoff(meta.projectKey);
			if (!h) {
				print(ctx, "No open handoff. History: /project-handoff list");
				return;
			}
			print(
				ctx,
				[formatHandoff(h), "", "context:", h.context || "(empty)"].join("\n"),
			);
		},
	});
}
