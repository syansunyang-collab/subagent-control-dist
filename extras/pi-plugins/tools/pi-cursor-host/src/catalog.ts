import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { CatalogModel } from "./models.ts";

/** Successful SDK catalogs survive new Pi processes and temporary network failures. */
export async function readCatalogCache(path: string): Promise<CatalogModel[] | undefined> {
	try {
		const entries: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!Array.isArray(entries) || !entries.length || !entries.every((entry) =>
			typeof entry?.id === "string" && entry.id.length > 0,
		)) return undefined;
		return entries;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** Failed, empty or late responses never replace a previously usable catalog. */
export async function fetchCatalog(
	path: string,
	list: () => Promise<CatalogModel[]>,
	timeoutMs = 8000,
): Promise<CatalogModel[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let entries: CatalogModel[];
	try {
		entries = await Promise.race([
			list(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("cursor-host catalog timeout")), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
	if (!entries.length) throw new Error("Cursor SDK returned an empty model catalog");
	await mkdir(dirname(path), { recursive: true });
	const pending = `${path}.${randomUUID()}.tmp`;
	await writeFile(pending, JSON.stringify(entries), "utf8");
	await rename(pending, path);
	return entries;
}
