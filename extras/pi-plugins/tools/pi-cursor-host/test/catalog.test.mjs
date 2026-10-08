import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fetchCatalog, readCatalogCache } from "../src/catalog.ts";
import { FALLBACK_MODELS, selectCursorModel, toHostModels } from "../src/models.ts";

async function cacheTest(run) {
	const dir = await mkdtemp(join(tmpdir(), "cursor-catalog-"));
	try { await run(join(dir, "catalog.json")); }
	finally { await rm(dir, { recursive: true, force: true }); }
}

const grok = FALLBACK_MODELS.find((entry) => entry.id === "grok-4.7");
const entries = [grok, { id: "composer-test" }];

test("successful catalogs persist variants and produce both Grok scopes", async () => {
	await cacheTest(async (path) => {
		assert.equal(await readCatalogCache(path), undefined);
		await fetchCatalog(path, async () => entries);
		assert.deepEqual(await readCatalogCache(path), entries);
		const hosts = toHostModels(await readCatalogCache(path));
		for (const [id, context] of [["grok-4.7", "256k"], ["grok-4.7-500k", "500k"]]) {
			const host = hosts.find((entry) => entry.id === id);
			assert.ok(host, id);
			assert.equal(host.reasoning, true);
			const params = Object.fromEntries(selectCursorModel(grok, host, "xhigh").params.map((p) => [p.id, p.value]));
			assert.equal(params.context, context);
			assert.equal(params.reasoning_effort, "xhigh");
		}
	});
});

test("failed and empty refreshes retain the last successful catalog", async () => {
	await cacheTest(async (path) => {
		await fetchCatalog(path, async () => entries);
		await assert.rejects(fetchCatalog(path, async () => { throw new Error("network down"); }), /network down/);
		await assert.rejects(fetchCatalog(path, async () => []), /empty model catalog/);
		assert.deepEqual(await readCatalogCache(path), entries);
		const replacement = [{ id: "new-model" }];
		await fetchCatalog(path, async () => replacement);
		assert.deepEqual(await readCatalogCache(path), replacement);
	});
});

test("timed-out requests cannot overwrite the cache when they finish late", async () => {
	await cacheTest(async (path) => {
		await fetchCatalog(path, async () => entries);
		let complete;
		await assert.rejects(fetchCatalog(path, () => new Promise((resolve) => { complete = resolve; }), 5), /catalog timeout/);
		complete([{ id: "late-model" }]);
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(await readCatalogCache(path), entries);
	});
});

test("truncated or malformed caches are ignored at startup", async () => {
	await cacheTest(async (path) => {
		for (const content of ["{", "[]", '[{"name":"no id"}]']) {
			await writeFile(path, content);
			assert.equal(await readCatalogCache(path), undefined);
		}
	});
});

test("new Pi processes load cached scopes offline, isolating accounts", async () => {
	const home = await mkdtemp(join(tmpdir(), "cursor-catalog-home-"));
	const runtime = new URL("../src/runtime.ts", import.meta.url).href;
	const sdk = new URL("../node_modules/@cursor/sdk/dist/esm/index.js", import.meta.url).href;
	const run = (body) => {
		const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
			import assert from 'node:assert/strict';
			import {Cursor} from ${JSON.stringify(sdk)};
			import {loadCatalog,listLiveModels,toProviderModels} from ${JSON.stringify(runtime)};
			${body}
		`], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: "utf8", timeout: 15000 });
		assert.equal(result.status, 0, result.stderr || result.error?.message);
	};
	try {
		run(`Cursor.models.list=async()=>${JSON.stringify(entries)}; await listLiveModels('account-one');`);
		run(`
			Cursor.models.list=async()=>{throw new Error('offline');};
			const cached=await loadCatalog('account-one');
			assert.deepEqual(cached,${JSON.stringify(entries)});
			const fresh=await loadCatalog('account-two');
			assert.ok(!fresh.some(m=>m.id==='composer-test'));
			assert.ok(toProviderModels(fresh).some(m=>m.id==='grok-4.7-500k'));
		`);
		run(`Cursor.models.list=async()=>[{id:'new-model'}]; assert.deepEqual(await loadCatalog('account-one'),[{id:'new-model'}]);`);
		run(`Cursor.models.list=async()=>{throw new Error('offline');}; assert.deepEqual(await loadCatalog('account-one'),[{id:'new-model'}]);`);
	} finally { await rm(home, { recursive: true, force: true }); }
});
