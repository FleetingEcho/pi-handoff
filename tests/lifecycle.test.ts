import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import piHandoff from "../index";
import { HandoffStore } from "../store";

type Handler = (event: any, ctx: any) => unknown;

test("shutdown drains a collector write held by a contested lock", async () => {
	const parent = mkdtempSync(join(tmpdir(), "pi-handoff-lifecycle-"));
	const previousDir = process.env.PI_HANDOFF_DIR;
	const previousExitClear = process.env.PI_HANDOFF_EXIT_CLEAR_LINES;
	process.env.PI_HANDOFF_DIR = join(parent, "store");
	process.env.PI_HANDOFF_EXIT_CLEAR_LINES = "0";
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
			return () => {};
		},
		registerCommand() {},
		registerTool() {},
	};
	const ctx = {
		cwd: parent,
		mode: "print",
		hasUI: false,
		model: null,
		ui: { notify() {}, setStatus() {} },
		sessionManager: { getSessionId: () => "session" },
	};
	const emit = async (name: string, event: unknown) => {
		for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
	};

	try {
		piHandoff(pi as never);
		await emit("session_start", { reason: "startup" });
		const store = HandoffStore.forCwdAndBranch(parent, "default");
		store.initSync();
		const lockPath = join(store.root, ".write-lock");
		mkdirSync(lockPath);

		let turnSettled = false;
		const turn = emit("turn_end", {
			turnIndex: 0,
			outcome: "completed",
			message: { role: "assistant", content: [] },
			toolResults: [],
		}).then(() => { turnSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(turnSettled).toBe(false);

		let shutdownSettled = false;
		const shutdown = emit("session_shutdown", { reason: "quit" }).then(() => { shutdownSettled = true; });
		await new Promise((resolve) => setTimeout(resolve, 40));
		expect(shutdownSettled).toBe(false);

		rmSync(lockPath, { recursive: true, force: true });
		await Promise.all([turn, shutdown]);
		expect(store.readEventsSince(-1).filter((event) => event.type === "turn_end")).toHaveLength(1);
	} finally {
		if (previousDir === undefined) delete process.env.PI_HANDOFF_DIR;
		else process.env.PI_HANDOFF_DIR = previousDir;
		if (previousExitClear === undefined) delete process.env.PI_HANDOFF_EXIT_CLEAR_LINES;
		else process.env.PI_HANDOFF_EXIT_CLEAR_LINES = previousExitClear;
		rmSync(parent, { recursive: true, force: true });
	}
});
