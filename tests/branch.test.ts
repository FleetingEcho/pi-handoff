import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectBranch, resolveProjectRoot } from "../git";

const roots: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-handoff-"));
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("fast git discovery", () => {
	test("reads a normal checkout and follows branch changes without spawning git", () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
		const nested = join(root, "packages", "app");
		mkdirSync(nested, { recursive: true });

		expect(resolveProjectRoot(nested)).toBe(root);
		expect(detectBranch(nested)).toBe("main");

		writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feature/fast\n");
		expect(detectBranch(nested)).toBe("feature/fast");
	});

	test("resolves a linked worktree gitdir file", () => {
		const parent = tempRoot();
		const root = join(parent, "worktree");
		const gitDir = join(parent, "admin", "worktrees", "w1");
		mkdirSync(root, { recursive: true });
		mkdirSync(gitDir, { recursive: true });
		writeFileSync(join(root, ".git"), "gitdir: ../admin/worktrees/w1\n");
		writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/topic\n");

		expect(resolveProjectRoot(root)).toBe(root);
		expect(detectBranch(root)).toBe("topic");
	});

	test("uses a stable short name for detached HEAD", () => {
		const root = tempRoot();
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, ".git", "HEAD"), "0123456789abcdef0123456789abcdef01234567\n");

		expect(detectBranch(root)).toBe("detached-0123456");
	});
});
