import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const projectRootCache = new Map<string, string>();
const gitDirCache = new Map<string, string | null>();

/** Nearest ancestor containing a .git directory or worktree/submodule file. */
function findGitRoot(cwd: string): string | null {
	let dir = resolve(cwd);
	for (;;) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** Resolve the actual git directory for an ordinary checkout or linked worktree. */
function findGitDir(cwd: string): string | null {
	const root = findGitRoot(cwd);
	if (!root) return null;
	const cached = gitDirCache.get(root);
	if (cached !== undefined) return cached;
	const dotGit = join(root, ".git");
	try {
		if (statSync(dotGit).isDirectory()) {
			gitDirCache.set(root, dotGit);
			return dotGit;
		}
		const match = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/im);
		const dir = match ? resolve(root, match[1]) : null;
		gitDirCache.set(root, dir);
		return dir;
	} catch {
		gitDirCache.set(root, null);
		return null;
	}
}

/** Repo/worktree top level, or cwd outside Git. */
export function resolveProjectRoot(cwd: string): string {
	const hit = projectRootCache.get(cwd);
	if (hit) return hit;
	const gitRoot = findGitRoot(cwd);
	let root = gitRoot ?? cwd;
	if (!gitRoot) {
		try {
			const top = execSync("git rev-parse --show-toplevel", {
				cwd,
				stdio: ["ignore", "pipe", "ignore"],
				encoding: "utf8",
				timeout: 2_000,
			}).trim();
			if (top) root = top;
		} catch {
			// Not a repository.
		}
	}
	projectRootCache.set(cwd, root);
	return root;
}

/** Current branch, with a subprocess fallback only for unusual repository layouts. */
export function detectBranch(cwd: string, fallback = "default"): string {
	const gitDir = findGitDir(cwd);
	if (gitDir) {
		try {
			const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
			if (head.startsWith("ref: refs/heads/")) return head.slice("ref: refs/heads/".length);
			if (head.startsWith("ref: refs/")) return head.slice("ref: refs/".length);
			if (/^[0-9a-f]{7,64}$/i.test(head)) return `detached-${head.slice(0, 7)}`;
		} catch {
			// Fall through to git.
		}
	}
	const run = (args: string) =>
		execSync(args, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8", timeout: 2_000 }).trim();
	try {
		let ref = "";
		try { ref = run("git symbolic-ref -q HEAD"); } catch { /* detached */ }
		if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
		if (ref) return ref.replace(/^refs\//, "");
		try {
			const sha = run("git rev-parse --short HEAD");
			return sha ? `detached-${sha}` : fallback;
		} catch {
			return fallback;
		}
	} catch {
		return fallback;
	}
}

/** Local and remote branch names. Null means Git could not provide safe evidence. */
export function activeGitBranches(cwd: string): Set<string> | null {
	try {
		const refs = execSync("git for-each-ref --format=%(refname) refs/heads refs/remotes", {
			cwd,
			stdio: ["ignore", "pipe", "ignore"],
			encoding: "utf8",
			timeout: 3_000,
		});
		const branches = new Set<string>();
		for (const ref of refs.split("\n").map((line) => line.trim()).filter(Boolean)) {
			if (ref.startsWith("refs/heads/")) branches.add(ref.slice("refs/heads/".length));
			else if (ref.startsWith("refs/remotes/")) {
				const name = ref.slice("refs/remotes/".length).replace(/^[^/]+\//, "");
				if (name && name !== "HEAD") branches.add(name);
			}
		}
		return branches;
	} catch {
		return null;
	}
}
