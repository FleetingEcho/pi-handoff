import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HANDOFF_SECTIONS, HandoffStore } from "../store";
import { runRefresh } from "../summarizer";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pi 1.5 model runtime integration", () => {
	test("uses ModelRegistry.complete as a standalone request", async () => {
		const parent = mkdtempSync(join(tmpdir(), "pi-handoff-model-"));
		roots.push(parent);
		const store = new HandoffStore(join(parent, "main"), parent, "main", "test");
		store.initSync();
		store.appendEvent({
			sessionId: "session",
			turn: 0,
			type: "turn_end",
			excerpts: [{ role: "user", text: "Make the handoff fast and reliable" }],
			changedFiles: ["index.ts"],
		});

		const document = HANDOFF_SECTIONS.map((section) => `# ${section}\n- updated`).join("\n\n");
		let requestOptions: Record<string, unknown> | undefined;
		let calls = 0;
		const model = { provider: "test", id: "model", name: "Model", maxTokens: 16_384 };
		const ctx = {
			model,
			modelRegistry: {
				find: () => undefined,
				complete: async (_model: unknown, _context: unknown, options: Record<string, unknown>) => {
					calls++;
					requestOptions = options;
					return {
						stopReason: "stop",
						content: [{ type: "text", text: `<document>\n${document}\n</document>` }],
						usage: { input: 100, output: 50, totalTokens: 150 },
					};
				},
			},
		};

		const result = await runRefresh(store, ctx as never, 5_000);

		expect(calls).toBe(1);
		expect(requestOptions?.disableContinuation).toBe(true);
		expect(requestOptions?.cacheRetention).toBe("none");
		expect(result.remaining).toBe(false);
		expect(store.readHandoff()).toContain("# Next Steps\n- updated");
		expect(store.meta.lastRefreshedSeq).toBe(1);
	});
});
