/**
 * Denylist-based secret redaction.
 *
 * Runs at three points (per plan):
 *  1. At append (collector) — before excerpts ever touch disk.
 *  2. Before any LLM call — over the documents being sent out.
 *  3. After the LLM call — over the produced documents before writing.
 *
 * This is a denylist, not a guarantee: the summarizer prompts also
 * instruct the model to never emit secrets.
 */

const PATTERNS: Array<[RegExp, string]> = [
	// Private key blocks
	[/-----BEGIN [A-Z ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----/g, "[REDACTED-PRIVATE-KEY]"],
	// AWS
	[/\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]"],
	// OpenAI / Anthropic / generic sk-*
	[/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
	[/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED]"],
	// GitHub
	[/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, "[REDACTED-GH-TOKEN]"],
	[/\bgithub_pat_[A-Za-z0-9_]{22,}\b/g, "[REDACTED-GH-TOKEN]"],
	// Slack
	[/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED-SLACK-TOKEN]"],
	// Google API
	[/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED-GCP-KEY]"],
	// Bearer tokens
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/g, "Bearer [REDACTED]"],
	// JWTs
	[/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED-JWT]"],
	// Generic assignments-ish: KEY/SECRET/TOKEN/PASSWORD values in env/config style
	[/(\b(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)\b\s*[=:]\s*["']?)[^\s"',]{8,}/gi, "$1[REDACTED]"],
	[/(\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY)[A-Z0-9_]*\b\s*[=:]\s*["']?)[^\s"',]{8,}/g, "$1[REDACTED]"],
	[/(\b(?:api[_-]?key|secret|password|passwd|access[_-]?token)\b\s*[=:]\s*["']?)[^\s"',]{8,}/gi, "$1[REDACTED]"],
];

export function redact(text: string): string {
	let out = text;
	for (const [re, replacement] of PATTERNS) {
		out = out.replace(re, replacement);
	}
	return out;
}
