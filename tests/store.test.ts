import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffStore, recordPinnedNote } from "../store";

const roots: string[] = [];

function tempStore(): HandoffStore {
	const parent = mkdtempSync(join(tmpdir(), "pi-handoff-store-"));
	roots.push(parent);
	const store = new HandoffStore(join(parent, "main"), parent, "main", "test");
	store.initSync();
	return store;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned note recording", () => {
	test("uses the same redacted note in project.md and events.jsonl", () => {
		const store = tempStore();
		const rawNote = "Never print TOKEN=supersecretvalue during deployment";

		expect(recordPinnedNote(store, rawNote)).toBe(true);
		expect(recordPinnedNote(store, rawNote)).toBe(false); // duplicate pins add no event

		const pins = store.readEventsSince(-1).filter((event) => event.type === "pin");
		expect(pins).toHaveLength(1);
		expect(pins[0].note).toContain("TOKEN=[REDACTED]");
		expect(pins[0].note).not.toContain("supersecretvalue");
		expect(store.readProjectDoc()).toContain("TOKEN=[REDACTED]");
		expect(store.readProjectDoc()).not.toContain("supersecretvalue");
	});

	test("yields while a write lock is held, then persists the event", async () => {
		const store = tempStore();
		const lockPath = join(store.root, ".write-lock");
		mkdirSync(lockPath);
		let completed = false;
		const pending = store.appendEventAsync({
			sessionId: "session",
			turn: 0,
			type: "turn_end",
			excerpts: [{ role: "user", text: "Work accumulated during lock contention" }],
		}).then((event) => {
			completed = true;
			return event;
		});

		try {
			await new Promise((resolve) => setTimeout(resolve, 40));
			expect(completed).toBe(false);
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
		}

		const event = await pending;
		expect(event.seq).toBe(1);
		expect(store.readEventsSince(-1)).toHaveLength(1);
		expect(store.meta.eventLineCount).toBe(1);
	});

	test("serializes concurrent async writers without losing or reusing sequence numbers", async () => {
		const first = tempStore();
		const second = new HandoffStore(first.root, first.projectPath, first.branch, first.cwdSlug);
		second.initSync();
		const lockPath = join(first.root, ".write-lock");
		mkdirSync(lockPath);
		const count = 24;
		const pending = Promise.all(Array.from({ length: count }, (_, index) => {
			const store = index % 2 === 0 ? first : second;
			return store.appendEventAsync({
				sessionId: index % 2 === 0 ? "first" : "second",
				turn: index,
				type: "turn_end",
				excerpts: [{ role: "user", text: `Concurrent event ${index}` }],
			});
		}));
		try {
			await new Promise((resolve) => setTimeout(resolve, 30));
		} finally {
			rmSync(lockPath, { recursive: true, force: true });
		}

		const written = await pending;
		expect(new Set(written.map((event) => event.seq)).size).toBe(count);
		const events = first.readEventsSince(-1);
		expect(events).toHaveLength(count);
		expect(new Set(events.map((event) => event.seq)).size).toBe(count);
		expect(first.loadMeta().nextSeq).toBe(count + 1);
	});

	test("ignores null, primitive, and malformed JSONL records", () => {
		const store = tempStore();
		writeFileSync(store.eventsPath, [
			"null",
			"42",
			'"text"',
			"[]",
			JSON.stringify({ schemaVersion: 2, seq: 7, sessionId: "old", turn: -1, timestamp: new Date().toISOString(), type: "snapshot", doc: "recovered" }),
			"{broken",
		].join("\n") + "\n");

		expect(() => store.initSync()).not.toThrow();
		expect(store.readEventsSince(-1).map((event) => event.seq)).toEqual([7]);
		expect(store.readSnapshots()[0]?.doc).toBe("recovered");
	});

	test("keeps cached candidate status isolated from mutable command results", () => {
		const store = tempStore();
		store.saveProjectCandidates([{
			id: "candidate-1",
			section: "Conventions",
			statement: "Run the complete test suite before publishing",
			evidence: "Durable release convention",
			branches: ["main"],
			createdAt: new Date().toISOString(),
			status: "suggested",
			action: "add",
		}]);
		expect(store.suggestedProjectCandidateCount()).toBe(1);

		const mutable = store.readProjectCandidates();
		mutable[0].status = "rejected";
		mutable[0].branches.push("unpersisted");
		expect(store.suggestedProjectCandidateCount()).toBe(1);
		expect(store.readProjectCandidates()[0].branches).toEqual(["main"]);

		store.saveProjectCandidates(mutable);
		expect(store.suggestedProjectCandidateCount()).toBe(0);
	});
});
