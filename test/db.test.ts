import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { ProjectDbStore } from "../extensions/project-db/db.ts";
import { exportProjectMarkdown } from "../extensions/project-db/markdown.ts";

const tempDirs: string[] = [];

function tempRoot(): { root: string; store: ProjectDbStore } {
	const root = mkdtempSync(join(tmpdir(), "pdb-"));
	tempDirs.push(root);
	const store = new ProjectDbStore(join(root, "project.db"));
	store.open();
	return { root, store };
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

describe("ProjectDbStore", () => {
	it("updates structured state and exports STATE.md", () => {
		const { root, store } = tempRoot();
		const key = "git:example.com/app";
		store.touchProject(key, "git", root);

		const state = store.updateState(key, {
			mainGoal: "Ship hybrid search demo",
			currentSubgoal: "Finish B5 PPR path",
			howToRun: "npm test",
			completedWork: [
				{
					date: "2026-07-24",
					text: "Scaffolded package",
					why: "Unblocks publishing the project-db extension under main goal",
				},
			],
			nextPlan: "Add GDS engine tests",
			nextPlanWhy: "Current subgoal needs GDS path green before closing B5",
			completedSubgoals: [{ text: "Define STATE schema" }],
			openSubgoals: [{ text: "Finish B5 PPR path" }, { text: "Write user docs" }],
		});

		assert.equal(state.mainGoal, "Ship hybrid search demo");
		assert.equal(state.currentSubgoal, "Finish B5 PPR path");
		assert.equal(state.completedWork[0]?.why.includes("main goal"), true);
		assert.equal(store.listStateRevisions(key).length, 1);

		const exported = exportProjectMarkdown(root, {
			state,
			decisions: [],
			openHandoff: null,
		});
		const md = readFileSync(exported.statePath, "utf8");
		assert.match(md, /Main goal/);
		assert.match(md, /Ship hybrid search demo/);
		assert.match(md, /why: Unblocks publishing/);
		assert.match(md, /Open subgoals/);
		assert.equal(existsSync(join(root, "HANDOFF.md")), false);
		store.close();
	});

	it("appends decisions and exports DECISIONS.md", () => {
		const { root, store } = tempRoot();
		const key = "git:example.com/app";
		store.addDecision(key, {
			title: "Use SQLite",
			decision: "Store records in SQLite",
			alternatives: "Markdown only",
			reason: "Queryable history",
			decidedOn: "2026-07-24",
		});
		const list = store.listDecisions(key);
		assert.equal(list.length, 1);

		const exported = exportProjectMarkdown(root, {
			state: store.getState(key),
			decisions: list,
			openHandoff: null,
		});
		const md = readFileSync(exported.decisionsPath, "utf8");
		assert.match(md, /Use SQLite/);
		store.close();
	});

	it("keeps only one open handoff in HANDOFF.md; history in DB", () => {
		const { root, store } = tempRoot();
		const key = "git:example.com/app";

		const h1 = store.createHandoff(key, {
			goal: "First handoff",
			nextTask: "Do A",
		});
		assert.equal(h1.status, "open");

		const h2 = store.createHandoff(key, {
			goal: "Second handoff",
			nextTask: "Do B",
			files: ["src/a.ts"],
		});
		assert.equal(h2.status, "open");
		assert.equal(store.getHandoff(h1.id)?.status, "superseded");
		assert.equal(store.getOpenHandoff(key)?.id, h2.id);

		let exported = exportProjectMarkdown(root, {
			state: store.getState(key),
			decisions: [],
			openHandoff: store.getOpenHandoff(key),
		});
		assert.ok(exported.handoffPath);
		assert.match(readFileSync(exported.handoffPath!, "utf8"), /Second handoff/);

		store.closeHandoff(key, "consumed");
		exported = exportProjectMarkdown(root, {
			state: store.getState(key),
			decisions: [],
			openHandoff: store.getOpenHandoff(key),
		});
		assert.equal(exported.handoffPath, null);
		assert.equal(existsSync(join(root, "HANDOFF.md")), false);
		assert.equal(store.listHandoffs(key).length, 2);
		store.close();
	});

	it("append mode for completed work lists", () => {
		const { store } = tempRoot();
		const key = "p";
		store.updateState(key, {
			completedWork: [{ text: "one", why: "serves main goal step 1" }],
		});
		store.updateState(key, {
			completedWork: [{ text: "two", why: "serves main goal step 2" }],
			replaceLists: false,
		});
		const state = store.getState(key);
		assert.deepEqual(
			state.completedWork.map((b) => b.text),
			["one", "two"],
		);
		store.close();
	});

	it("allows empty next plan when work is complete", () => {
		const { store } = tempRoot();
		const state = store.updateState("p", {
			mainGoal: "Done project",
			currentSubgoal: "",
			nextPlan: "",
			nextPlanWhy: "",
			openSubgoals: [],
			completedSubgoals: [{ text: "Everything" }],
		});
		assert.equal(state.nextPlan, "");
		assert.equal(state.openSubgoals.length, 0);
		store.close();
	});
});
