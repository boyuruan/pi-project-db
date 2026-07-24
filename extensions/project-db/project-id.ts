/**
 * Stable project identity for the tool WAL.
 *
 * cwd-based keys break across machines (/Users/a/proj vs /home/b/proj).
 * Resolution order (first match wins):
 *
 *   1. explicit override
 *      - env TOOL_WAL_PROJECT_ID
 *      - <cwd>/.pi/wal-project-id   (first non-empty line)
 *      - <cwd>/.pi/tool-wal.json    ({ "projectId": "..." })
 *   2. git identity
 *      - normalized origin remote + path relative to git toplevel
 *        e.g. git:github.com/org/repo#packages/api
 *      - remote only when cwd is the repo root: git:github.com/org/repo
 *      - no remote: gitlocal:<toplevel-basename>#<rel>
 *   3. cwd fallback (Pi session-dir encoding) — machine-local only
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

export type ProjectIdSource = "explicit" | "git" | "cwd";

export interface ProjectIdentity {
	/** Stable key used for WAL scoping. */
	projectKey: string;
	/** How the key was derived. */
	source: ProjectIdSource;
	/** Resolved absolute cwd. */
	cwd: string;
	/** Extra detail for /wal path (remote, rel path, file used, ...). */
	detail?: string;
}

const EXPLICIT_ENV = "TOOL_WAL_PROJECT_ID";
const EXPLICIT_FILE = "wal-project-id";
const EXPLICIT_JSON = "tool-wal.json";

/** Cache by resolved cwd for the process lifetime. */
const cache = new Map<string, ProjectIdentity>();

/**
 * Encode a cwd the same way Pi names session directories.
 * Machine-local; only used as last-resort fallback.
 */
export function projectKeyFromCwd(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * Normalize git remote URLs so HTTPS/SSH/scps forms collapse:
 *   git@github.com:org/repo.git
 *   ssh://git@github.com/org/repo.git
 *   https://user:token@github.com/org/repo.git
 *   https://github.com/org/repo
 * all → github.com/org/repo
 */
export function normalizeGitRemote(raw: string): string | null {
	let url = raw.trim();
	if (!url) return null;

	// git@host:path
	const scp = /^git@([^:]+):(.+)$/.exec(url);
	if (scp) {
		url = `ssh://${scp[1]}/${scp[2]}`;
	}

	// ssh://git@host/path or git://host/path
	url = url.replace(/^git\+/, "");

	try {
		// Ensure URL parser accepts ssh://
		const withProtocol = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)
			? url
			: `https://${url}`;
		const parsed = new URL(withProtocol);
		const host = parsed.hostname.toLowerCase();
		let path = parsed.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
		if (path.endsWith(".git")) path = path.slice(0, -4);
		if (!host || !path) return null;
		return `${host}/${path}`;
	} catch {
		// Last-ditch strip
		let s = raw.trim();
		s = s.replace(/^https?:\/\//i, "");
		s = s.replace(/^git@/i, "");
		s = s.replace(/:/, "/");
		s = s.replace(/\.git$/i, "");
		s = s.replace(/\/+$/, "");
		return s || null;
	}
}

function readExplicitFromDir(dir: string): { id: string; detail: string } | null {
	const idFile = join(dir, ".pi", EXPLICIT_FILE);
	if (existsSync(idFile)) {
		try {
			const line = readFileSync(idFile, "utf8")
				.split(/\r?\n/)
				.map((l) => l.trim())
				.find((l) => l && !l.startsWith("#"));
			if (line) {
				return { id: sanitizeExplicitId(line), detail: idFile };
			}
		} catch {
			// ignore
		}
	}

	const jsonFile = join(dir, ".pi", EXPLICIT_JSON);
	if (existsSync(jsonFile)) {
		try {
			const parsed = JSON.parse(readFileSync(jsonFile, "utf8")) as {
				projectId?: unknown;
				project_id?: unknown;
				id?: unknown;
			};
			const value = parsed.projectId ?? parsed.project_id ?? parsed.id;
			if (typeof value === "string" && value.trim()) {
				return { id: sanitizeExplicitId(value.trim()), detail: jsonFile };
			}
		} catch {
			// ignore
		}
	}

	return null;
}

function readExplicitId(cwd: string): { id: string; detail: string } | null {
	const env = process.env[EXPLICIT_ENV]?.trim();
	if (env) {
		return { id: sanitizeExplicitId(env), detail: `env:${EXPLICIT_ENV}` };
	}

	const resolvedCwd = resolve(cwd);
	// Prefer the nearest project dir, then the git toplevel (monorepo root).
	// Do not walk to $HOME — ~/.pi must not become a global project id.
	const candidates = [resolvedCwd];
	const toplevel = gitCapture(resolvedCwd, ["rev-parse", "--show-toplevel"]);
	if (toplevel) {
		const top = realpathOrResolve(toplevel);
		if (top !== realpathOrResolve(resolvedCwd)) candidates.push(top);
	}

	for (const dir of candidates) {
		const hit = readExplicitFromDir(dir);
		if (hit) return hit;
	}

	return null;
}

function sanitizeExplicitId(id: string): string {
	// Keep readable; collapse path-hostile chars.
	const cleaned = id.trim().replace(/[/\\:\s]+/g, "-").replace(/-+/g, "-");
	return cleaned.startsWith("explicit:") ? cleaned : `explicit:${cleaned}`;
}

function gitCapture(cwd: string, args: string[]): string | null {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const trimmed = out.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

function realpathOrResolve(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function resolveGitIdentity(cwd: string): ProjectIdentity | null {
	const toplevel = gitCapture(cwd, ["rev-parse", "--show-toplevel"]);
	if (!toplevel) return null;

	// realpath avoids /var vs /private/var (and similar) symlink skew on macOS.
	const resolvedTop = realpathOrResolve(toplevel);
	const resolvedCwd = realpathOrResolve(cwd);
	let rel = relative(resolvedTop, resolvedCwd);
	// If cwd somehow escapes toplevel, fall back to root identity.
	if (!rel || rel.startsWith("..")) rel = ".";
	if (rel === "") rel = ".";
	// Normalize separators for cross-OS stability.
	rel = rel.split(sep).join("/");

	const remoteRaw =
		gitCapture(cwd, ["remote", "get-url", "origin"]) ??
		gitCapture(cwd, ["config", "--get", "remote.origin.url"]);
	const remote = remoteRaw ? normalizeGitRemote(remoteRaw) : null;

	if (remote) {
		const projectKey =
			rel === "." ? `git:${remote}` : `git:${remote}#${rel}`;
		return {
			projectKey,
			source: "git",
			cwd: resolvedCwd,
			detail: remoteRaw ?? remote,
		};
	}

	// Local-only repo: basename of toplevel is weak but better than full path
	// when the folder name is stable across clones.
	const base = basename(resolvedTop) || "repo";
	const projectKey =
		rel === "." ? `gitlocal:${base}` : `gitlocal:${base}#${rel}`;
	return {
		projectKey,
		source: "git",
		cwd: resolvedCwd,
		detail: `no-remote toplevel=${resolvedTop}`,
	};
}

/**
 * Resolve the project identity for a working directory.
 * Results are cached per resolved cwd for the process lifetime.
 */
export function resolveProjectIdentity(cwd: string): ProjectIdentity {
	const resolvedCwd = resolve(cwd);
	const hit = cache.get(resolvedCwd);
	if (hit) return hit;

	const explicit = readExplicitId(resolvedCwd);
	if (explicit) {
		const identity: ProjectIdentity = {
			projectKey: explicit.id,
			source: "explicit",
			cwd: resolvedCwd,
			detail: explicit.detail,
		};
		cache.set(resolvedCwd, identity);
		return identity;
	}

	const git = resolveGitIdentity(resolvedCwd);
	if (git) {
		cache.set(resolvedCwd, git);
		return git;
	}

	const identity: ProjectIdentity = {
		projectKey: projectKeyFromCwd(resolvedCwd),
		source: "cwd",
		cwd: resolvedCwd,
		detail: "fallback (no git / no explicit id)",
	};
	cache.set(resolvedCwd, identity);
	return identity;
}

/** Test helper / reload: drop cached identities. */
export function clearProjectIdentityCache(): void {
	cache.clear();
}
