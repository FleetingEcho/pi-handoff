import { describe, expect, test } from "bun:test";
import { completeHandoffArguments, parseHandoffArguments } from "../command";

describe("pi-handoff command ergonomics", () => {
	test("defaults an empty command to status", () => {
		expect(parseHandoffArguments("")).toEqual({ sub: "status", rest: [] });
		expect(parseHandoffArguments("   ")).toEqual({ sub: "status", rest: [] });
	});

	test("preserves nested project arguments", () => {
		expect(parseHandoffArguments(" project refresh all ")).toEqual({ sub: "project", rest: ["refresh", "all"] });
	});

	test("completes nested project actions with full replacement values", () => {
		expect(completeHandoffArguments("pr")?.map((item) => item.value)).toEqual(["project"]);
		expect(completeHandoffArguments("project r")?.map((item) => item.value)).toEqual(["project refresh", "project review"]);
		expect(completeHandoffArguments("project refresh ")?.map((item) => item.value)).toEqual(["project refresh all"]);
	});

	test("does not suggest commands inside free-form note text", () => {
		expect(completeHandoffArguments("project add Run tests")).toBeNull();
		expect(completeHandoffArguments("pin Always run tests")).toBeNull();
	});
});
