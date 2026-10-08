import type { SDKCustomTool, SDKCustomToolResult, SDKJsonValue } from "@cursor/sdk";
import type { Tool } from "@earendil-works/pi-ai";

export type ToolProposal = {
	id: string;
	name: string;
	args: Record<string, unknown>;
};

/** Receives a tool call proposed by the model and settles once Pi has executed it. */
export type ProposalHandler = (proposal: ToolProposal) => Promise<SDKCustomToolResult>;

const LEAKED_HOST_TOOLS = new Set([
	"shell",
	"read",
	"edit",
	"write",
	"grep",
	"glob",
	"ls",
	"delete",
	"task",
	"semsearch",
	"webfetch",
	"websearch",
	"applyagentdiff",
	"readlints",
	"updatetodos",
	"readtodos",
	"askquestion",
	"await",
	"generateimage",
]);

function jsonSchemaOf(parameters: unknown): Record<string, SDKJsonValue> {
	if (!parameters || typeof parameters !== "object") {
		return { type: "object", properties: {} };
	}
	// JSON round trip drops TypeBox symbol keys and keeps descriptions, enums and additionalProperties.
	const schema = JSON.parse(JSON.stringify(parameters)) as Record<string, SDKJsonValue>;
	return { ...schema, type: "object", properties: schema.properties ?? {} };
}

export function asArgumentRecord(value: unknown): Record<string, unknown> {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return { value };
}

export function leakedHostTools(offered: string[] | undefined): string[] {
	if (!offered) return [];
	return offered.filter((name) => LEAKED_HOST_TOOLS.has(name.trim().toLowerCase()));
}

let fallbackCallId = 0;

/**
 * Pi names and schemas only. `execute` never runs the tool: it hands the proposal to Pi and stays
 * pending until Pi's own tool result comes back, which then becomes the result Cursor sees.
 */
export function toCustomTools(tools: Tool[] | undefined, propose: ProposalHandler): Record<string, SDKCustomTool> {
	const customTools: Record<string, SDKCustomTool> = {};
	for (const tool of tools ?? []) {
		const name = tool.name;
		customTools[name] = {
			description: tool.description || `Pi tool ${name}`,
			inputSchema: jsonSchemaOf(tool.parameters),
			execute: (args, context) =>
				propose({
					id: context?.toolCallId || `pi-cursor-host-${++fallbackCallId}`,
					name,
					args: asArgumentRecord(args),
				}),
		};
	}
	return customTools;
}
