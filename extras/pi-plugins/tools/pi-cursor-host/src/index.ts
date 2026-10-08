import { Cursor } from "@cursor/sdk";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CatalogModel } from "./models.ts";
import {
	PROVIDER,
	createCursorHostStream,
	currentCatalog,
	disposeSession,
	registerSessionDirectory,
	listLiveModels,
	loadCatalog,
	toProviderModels,
} from "./runtime.ts";

export function bindSessionLifecycle(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		registerSessionDirectory(ctx.sessionManager.getSessionId(), ctx.cwd);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		disposeSession(ctx.sessionManager.getSessionId());
	});
}

export default async function piCursorHost(pi: ExtensionAPI): Promise<void> {
	const register = (entries: readonly CatalogModel[]) => {
		pi.registerProvider(PROVIDER, {
			name: "Cursor SDK",
			baseUrl: "cursor-host://local",
			apiKey: "cursor-sdk",
			api: "cursor-host-sdk",
			models: toProviderModels(entries),
			streamSimple: createCursorHostStream(),
			oauth: {
				name: "Cursor SDK",
				isSubscription: true,
				async login(callbacks) {
					const result = await Cursor.auth.login({
						openBrowser: true,
						apiKeyName: "pi-cursor-host",
						onLoginUrl: (url) => {
							callbacks.onAuth({ url });
						},
					});
					return {
						access: result.apiKey,
						refresh: "cursor-sdk",
						expires: result.apiKeyExpiresAtMs,
					};
				},
				async refreshToken(credentials) {
					if (credentials.expires > Date.now()) return credentials;
					throw new Error("Cursor SDK API key expired. Run /login cursor-host.");
				},
				getApiKey(credentials) {
					return credentials.access;
				},
			},
			async refreshModels() {
				try {
					return toProviderModels(await listLiveModels());
				} catch {
					return toProviderModels(currentCatalog());
				}
			},
		});
	};

	register(await loadCatalog());

	// Release only this Pi session: SDK hosts may have several sessions in the same process.
	bindSessionLifecycle(pi);

	pi.registerCommand("cursor-host-status", {
		description: "Show Cursor SDK login status",
		handler: async (_args, ctx) => {
			const status = await Cursor.auth.status();
			if (status.status === "logged-out") {
				ctx.ui.notify("Cursor SDK: logged out. Use /login cursor-host.", "warning");
				return;
			}
			const expires = status.apiKeyExpiresAtMs
				? new Date(status.apiKeyExpiresAtMs).toISOString()
				: "unknown";
			ctx.ui.notify(
				`Cursor SDK: logged in${status.email ? ` as ${status.email}` : ""}. key expires ${expires}`,
				"info",
			);
		},
	});
}
