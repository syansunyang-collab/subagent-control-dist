export const HOST_SETTING_SOURCES = [];

export function hostToolAllowlist(customToolCount) {
	return customToolCount > 0 ? ["mcp"] : [];
}

export function instructionSettingSources(mode) {
	return mode === "project-rules" ? ["project"] : [...HOST_SETTING_SOURCES];
}
