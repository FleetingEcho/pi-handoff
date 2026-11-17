export interface CommandCompletion {
	value: string;
	label: string;
	description: string;
}

const SUBCOMMANDS: Array<readonly [string, string]> = [
	["status", "Show handoff statistics"],
	["flush", "Force a handoff.md refresh now"],
	["pin", "Record a standing project rule"],
	["unpin", "Remove a pinned rule by substring match"],
	["project", "Manage project-wide knowledge"],
	["clear", "Start a fresh handoff while keeping project knowledge and pins"],
	["pause", "Stop recording for this session"],
	["resume", "Start recording again"],
	["help", "Show command help"],
];

const PROJECT_SUBCOMMANDS: Array<readonly [string, string]> = [
	["status", "Show shared knowledge and pending suggestions"],
	["refresh", "Scan changed branch handoffs for durable knowledge"],
	["review", "Accept or reject queued suggestions"],
	["add", "Add shared knowledge directly"],
	["forget", "Remove one shared fact by substring match"],
];

export function parseHandoffArguments(args: string): { sub: string; rest: string[] } {
	const parts = args.trim() ? args.trim().split(/\s+/) : [];
	const [sub = "status", ...rest] = parts;
	return { sub, rest };
}

/** Pi passes the complete command argument text, so nested values replace all arguments. */
export function completeHandoffArguments(prefix: string): CommandCompletion[] | null {
	if (prefix.startsWith("project ")) {
		const nested = prefix.slice("project ".length);
		if (nested.startsWith("refresh ")) {
			const value = "project refresh all";
			return value.startsWith(prefix)
				? [{ value, label: "all", description: "Include archived or deleted branch stores" }]
				: null;
		}
		if (/\s/.test(nested.trim())) return null;
		const matches = PROJECT_SUBCOMMANDS.filter(([name]) => name.startsWith(nested));
		return matches.length
			? matches.map(([name, description]) => ({ value: `project ${name}`, label: name, description }))
			: null;
	}
	const matches = SUBCOMMANDS.filter(([name]) => name.startsWith(prefix));
	return matches.length
		? matches.map(([value, description]) => ({ value, label: value, description }))
		: null;
}

export const HANDOFF_HELP = [
	"pi-handoff commands:",
	"  /pi-handoff [status]                  Show store, queue, usage, and suggestions",
	"  /pi-handoff flush                     Refresh the current branch handoff now",
	"  /pi-handoff pin <rule>                Add a protected project-wide rule",
	"  /pi-handoff unpin <substring>         Remove one pin (ambiguous matches are safe no-ops)",
	"  /pi-handoff clear                     Start a fresh branch handoff",
	"  /pi-handoff pause | resume            Pause or resume session recording",
	"  /pi-handoff project [review]          Review shared-knowledge suggestions",
	"  /pi-handoff project status",
	"  /pi-handoff project refresh [all]     Scan changed branches; optionally include archived stores",
	"  /pi-handoff project add [Section:] <fact>",
	"  /pi-handoff project forget <substring>",
].join("\n");
