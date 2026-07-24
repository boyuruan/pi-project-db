/**
 * Materialize SQLite records to project-root markdown files (strategy A).
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BulletItem, Decision, Handoff, ProjectState } from "./types.ts";

export const STATE_FILENAME = "STATE.md";
export const DECISIONS_FILENAME = "DECISIONS.md";
export const HANDOFF_FILENAME = "HANDOFF.md";

function formatDate(ms: number): string {
	if (!ms) return "never";
	const d = new Date(ms);
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${y}-${m}-${day}`;
}

function bulletLines(items: BulletItem[], empty = "None."): string {
	if (!items.length) return `- ${empty}`;
	return items
		.map((item) => {
			if (item.date) return `- [${item.date}] ${item.text}`;
			return `- ${item.text}`;
		})
		.join("\n");
}

export function renderStateMarkdown(state: ProjectState): string {
	const updated = formatDate(state.updatedAt);
	const howToRun = state.howToRun.trim()
		? state.howToRun.trim()
		: "[add shortest build / test / run commands]";
	const status = state.oneLineStatus.trim() || "[one-line status]";

	return `# Project state

<!--
  Managed by pi-project-db. Macro situation only (not a per-tool log).
  Prefer project_state_update; do not hand-edit structure.
-->

Updated: ${updated}

## One-line status

${status}

## How to run

\`\`\`
${howToRun}
\`\`\`

## Recently done

${bulletLines(state.recentlyDone)}

## In progress

${bulletLines(state.inProgress)}

## Shelved or abandoned

${bulletLines(state.shelved)}

## Waiting on the user

${bulletLines(state.waitingOnUser)}
`;
}

export function renderDecisionsMarkdown(decisions: Decision[]): string {
	const body =
		decisions.length === 0
			? "\n_No decisions recorded yet._\n"
			: decisions
					.map((d) => {
						const lines = [
							`## ${d.decidedOn} ${d.title}`,
							"",
							`- Decision: ${d.decision}`,
						];
						if (d.alternatives) lines.push(`- Alternatives: ${d.alternatives}`);
						if (d.reason) lines.push(`- Reason: ${d.reason}`);
						if (d.impact) lines.push(`- Impact: ${d.impact}`);
						return lines.join("\n");
					})
					.join("\n\n");

	return `# Decisions

<!-- Managed by pi-project-db. Record only choices the user explicitly approved. -->
${body}
`;
}

export function renderHandoffMarkdown(handoff: Handoff): string {
	const files =
		handoff.files.length === 0
			? "- (none)"
			: handoff.files.map((f) => `- ${f}`).join("\n");

	return `# Handoff

<!-- Managed by pi-project-db. Current open handoff only; history lives in the DB. -->

Updated: ${formatDate(handoff.updatedAt)}
Status: ${handoff.status}
Id: ${handoff.id}

## Goal

${handoff.goal.trim() || "[goal]"}

## Context

${handoff.context.trim() || "[context]"}

## Files

${files}

## Next task

${handoff.nextTask.trim() || "[next task]"}
`;
}

function writeFileAtomic(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content, "utf8");
}

export interface ExportResult {
	statePath: string;
	decisionsPath: string;
	handoffPath: string | null;
	handoffRemoved: boolean;
}

/**
 * Write STATE.md + DECISIONS.md always; HANDOFF.md only when an open handoff exists.
 */
export function exportProjectMarkdown(
	projectRoot: string,
	args: {
		state: ProjectState;
		decisions: Decision[];
		openHandoff: Handoff | null;
	},
): ExportResult {
	const statePath = join(projectRoot, STATE_FILENAME);
	const decisionsPath = join(projectRoot, DECISIONS_FILENAME);
	const handoffPath = join(projectRoot, HANDOFF_FILENAME);

	writeFileAtomic(statePath, renderStateMarkdown(args.state));
	writeFileAtomic(decisionsPath, renderDecisionsMarkdown(args.decisions));

	let handoffRemoved = false;
	if (args.openHandoff && args.openHandoff.status === "open") {
		writeFileAtomic(handoffPath, renderHandoffMarkdown(args.openHandoff));
		return { statePath, decisionsPath, handoffPath, handoffRemoved: false };
	}

	if (existsSync(handoffPath)) {
		unlinkSync(handoffPath);
		handoffRemoved = true;
	}
	return { statePath, decisionsPath, handoffPath: null, handoffRemoved };
}
