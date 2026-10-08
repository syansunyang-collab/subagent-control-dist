import assert from "node:assert/strict";
import { test } from "node:test";
import { HeldSession, Turn } from "../src/session.ts";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BATCH = 220; // a little over the 150 ms batching window

class FakeRun {
	constructor({ steer } = {}) {
		this.events = [];
		this.waiters = [];
		this.ended = undefined;
		this.cancelled = false;
		this.steered = [];
		if (steer) {
			this.steer = async (text) => {
				this.steered.push(text);
				if (steer === "throw") throw new Error("steer transport error");
				return steer;
			};
		}
		this.done = new Promise((resolve) => {
			this.resolveDone = resolve;
		});
	}
	emit(event) {
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value: event, done: false });
		else this.events.push(event);
	}
	end(result = { status: "finished", usage: { inputTokens: 100, outputTokens: 5 } }) {
		this.ended = result;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
		this.resolveDone(result);
	}
	stream() {
		const self = this;
		return {
			[Symbol.asyncIterator]() {
				return this;
			},
			next() {
				if (self.events.length) return Promise.resolve({ value: self.events.shift(), done: false });
				if (self.ended) return Promise.resolve({ value: undefined, done: true });
				return new Promise((resolve) => self.waiters.push(resolve));
			},
		};
	}
	wait() {
		return this.done;
	}
	async cancel() {
		this.cancelled = true;
		if (!this.ended) this.end({ status: "cancelled" });
	}
}

class FakeAgent {
	constructor(runOptions = []) {
		this.runOptions = runOptions;
		this.sent = [];
		this.runs = [];
		this.closed = false;
		this.agentId = "agent-fake";
	}
	async send(message, options) {
		this.sent.push({ message, options });
		const run = new FakeRun(this.runOptions[this.runs.length]);
		this.runs.push(run);
		return run;
	}
	close() {
		this.closed = true;
	}
}

function newTurn() {
	const output = { role: "assistant", content: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, timestamp: Date.now() };
	const events = [];
	const turn = new Turn(output, { push: (event) => events.push(event) }, { value: false });
	return { turn, output, events };
}

async function started(runOptions) {
	const agent = new FakeAgent(runOptions);
	const closed = [];
	const session = new HeldSession("k", "sig", true, (s) => closed.push(s));
	session.agent = agent;
	const first = newTurn();
	session.attach(first.turn);
	await session.startRun({ text: "go", images: [] }, { id: "m" });
	return { agent, session, first, closed, run: agent.runs[0] };
}

const text = (t) => ({ type: "assistant", message: { content: [{ type: "text", text: t }] } });
const piResult = (id, body) => ({ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: body }] });

test("a tool call ends the Pi message with toolUse, the result resumes the same run", async () => {
	const { agent, session, first, run } = await started();
	run.emit(text("Reading. "));
	await sleep(5);
	const pending = session.propose({ id: "c1", name: "read", args: { path: "a" } });
	assert.equal(await first.turn.done, "toolUse");
	session.detach(first.turn);
	assert.deepEqual(first.output.content.map((b) => b.type), ["text", "toolCall"]);
	assert.deepEqual(session.pendingIds, ["c1"]);
	assert.equal(session.hasLiveRun, true);

	const second = newTurn();
	session.attach(second.turn);
	session.resolveResults([piResult("c1", "file body")]);
	assert.deepEqual(await pending, { content: [{ type: "text", text: "file body" }], isError: false });
	run.emit(text("Done."));
	run.end({ status: "finished", usage: { inputTokens: 300, cacheReadTokens: 100, outputTokens: 7 } });
	assert.equal(await second.turn.done, "stop");
	assert.equal(second.output.content[0].text, "Done.");
	assert.equal(second.output.usage.input, 200); // Cursor's 300 includes the 100 read from cache
	assert.equal(second.output.usage.cacheRead, 100);
	assert.equal(agent.sent.length, 1, "no second send: the run was held");
	assert.equal(session.hasLiveRun, false);
	session.dispose();
});

test("parallel calls inside the window share one message; a straggler waits for the next one", async () => {
	const { session, first } = await started();
	session.propose({ id: "c1", name: "read", args: {} });
	session.propose({ id: "c2", name: "read", args: {} });
	assert.equal(await first.turn.done, "toolUse");
	session.detach(first.turn);
	assert.equal(first.output.content.length, 2);

	session.propose({ id: "late", name: "bash", args: {} }); // arrives while Pi runs c1 and c2
	assert.deepEqual(session.pendingIds.sort(), ["c1", "c2"], "Pi does not owe a result for a call it never saw");

	const second = newTurn();
	session.attach(second.turn);
	session.resolveResults([piResult("c1", "1"), piResult("c2", "2")]);
	assert.equal(await second.turn.done, "toolUse");
	assert.deepEqual(second.output.content.map((b) => b.id), ["late"]);
	assert.deepEqual(session.pendingIds, ["late"]);
	session.dispose();
});

test("the same call id delivered twice is surfaced once and shares one promise", async () => {
	const { session, first } = await started();
	const a = session.propose({ id: "dup", name: "edit", args: { n: 1 } });
	const b = session.propose({ id: "dup", name: "edit", args: { n: 1 } });
	assert.equal(a, b);
	assert.equal(await first.turn.done, "toolUse");
	assert.equal(first.output.content.filter((block) => block.type === "toolCall").length, 1);
	session.dispose();
	await assert.rejects(a);
});

test("a call replayed after its result was delivered gets that result again and never reaches Pi twice", async () => {
	const { session, first, run } = await started();
	const original = session.propose({ id: "c1", name: "bash", args: { command: "rm x" } });
	await first.turn.done;
	session.detach(first.turn);
	const second = newTurn();
	session.attach(second.turn);
	session.resolveResults([piResult("c1", "removed")]);
	const delivered = await original;

	// The connection dropped before the backend saved the result; the SDK resumes and calls execute again.
	const replayed = await Promise.race([session.propose({ id: "c1", name: "bash", args: { command: "rm x" } }), sleep(500).then(() => "still waiting")]);
	assert.deepEqual(replayed, delivered);
	assert.deepEqual(session.pendingIds, []);
	await sleep(BATCH);
	assert.equal(second.output.content.filter((block) => block.type === "toolCall").length, 0);

	run.emit(text("Done."));
	run.end();
	assert.equal(await second.turn.done, "stop");
	session.dispose();
});

test("dispose fails the attached request, rejects waiting calls, closes the agent and refuses new calls", async () => {
	const { agent, session, first, closed, run } = await started();
	const pending = session.propose({ id: "c1", name: "read", args: {} });
	await first.turn.done;
	session.detach(first.turn);
	const second = newTurn();
	session.attach(second.turn);
	session.dispose(new Error("history changed"));
	await assert.rejects(second.turn.done, /history changed/);
	await assert.rejects(pending, /history changed/);
	assert.equal(agent.closed, true);
	assert.equal(run.cancelled, true);
	assert.deepEqual(closed, [session]);
	await assert.rejects(session.propose({ id: "after", name: "read", args: {} }), /closed/);
});

test("a run that finishes with a call still waiting fails the request instead of hanging the next resume", async () => {
	const { session, first, run } = await started();
	session.propose({ id: "c1", name: "read", args: {} });
	await first.turn.done;
	session.detach(first.turn);
	const second = newTurn();
	session.attach(second.turn);
	run.end(); // backend gave up without the result
	await assert.rejects(second.turn.done, /still waiting for a result/);
	assert.equal(session.alive, false);
});

test("a run that ends while no request is attached releases the session", async () => {
	const { agent, session, first, run } = await started();
	run.emit(text("hello"));
	await sleep(5);
	session.detach(first.turn);
	run.end();
	await sleep(5);
	assert.equal(session.alive, false);
	assert.equal(agent.closed, true);
});

test("a cancelled run is an error, not a user abort", async () => {
	const { first, run } = await started();
	await run.cancel();
	await assert.rejects(first.turn.done, (error) => {
		assert.match(error.message, /cancelled/);
		assert.equal(error.stopReason, undefined);
		return true;
	});
});

test("a second request cannot take over a session that is serving one", async () => {
	const { session } = await started();
	assert.equal(session.busy, true);
	assert.throws(() => session.attach(newTurn().turn), /another request/);
	session.dispose();
});

for (const [name, steer, expectDeferred] of [
	["delivered steering stays inside the run", "complete_delivered", false],
	["steering Cursor hands back becomes the next run of the same request", "revert_to_followup", true],
	["a failed steer call is not lost either", "throw", true],
	["a run without steer support defers the message", undefined, true],
]) {
	test(name, async () => {
		const { agent, session, first, run } = await started([{ steer }]);
		const pending = session.propose({ id: "c1", name: "read", args: {} });
		await first.turn.done;
		session.detach(first.turn);

		const second = newTurn();
		session.attach(second.turn);
		session.steer({ text: "also do X", images: [] });
		session.resolveResults([piResult("c1", "body")]);
		await pending;
		if (steer) assert.deepEqual(run.steered, ["also do X"]);
		await sleep(5);
		run.emit(text("first answer. "));
		run.end();
		await sleep(10);

		if (!expectDeferred) {
			assert.equal(await second.turn.done, "stop");
			assert.equal(agent.sent.length, 1);
			return;
		}
		assert.equal(agent.sent.length, 2, "the steered text goes out as a follow-up run");
		assert.equal(agent.sent[1].message.text, "also do X");
		agent.runs[1].emit(text("second answer."));
		agent.runs[1].end();
		assert.equal(await second.turn.done, "stop");
		assert.equal(second.output.content[0].text, "first answer. second answer.");
		session.dispose();
	});
}

test("every completed thinking block counts as a model call when the run's usage is turned into a context size", async () => {
	const { first, run } = await started();
	const thinking = (t, done) => ({ type: "thinking", text: t, ...(done ? { thinking_duration_ms: 40 } : {}) });
	run.emit(thinking("looking up ", false));
	run.emit(thinking("the tool schema", true));
	run.emit(thinking("now answering", true));
	run.emit(text("ONE"));
	run.end({ status: "finished", usage: { inputTokens: 30000, cacheReadTokens: 29000, outputTokens: 10 } });
	assert.equal(await first.turn.done, "stop");
	assert.equal(first.output.usage.totalTokens, 15000 + 10);
	assert.equal(first.output.usage.input, 1000);
});

for (const outcome of ["complete_delivered", "revert_to_followup", "failure"]) {
	test(`run completion waits for late ${outcome} steering receipt`, async (t) => {
		const { agent, session, first, run } = await started();
		t.after(() => session.dispose());
		const pending = session.propose({ id: "c1", name: "read", args: {} });
		await first.turn.done;
		session.detach(first.turn);
		const second = newTurn();
		session.attach(second.turn);
		let resolveReceipt, rejectReceipt;
		run.steer = text => {
			run.steered.push(text);
			return new Promise((resolve, reject) => { resolveReceipt = resolve; rejectReceipt = reject; });
		};
		session.steer({ text: "late instruction", images: [] });
		session.resolveResults([piResult("c1", "body")]);
		await pending;
		let stopped = false;
		second.turn.done.then(() => { stopped = true; }, () => {});
		run.emit({ type: "thinking", text: "", thinking_duration_ms: 1 });
		run.end({ status: "finished", usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 30 } });
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(stopped, false);
		assert.equal(agent.sent.length, 1);
		if (outcome === "failure") rejectReceipt(new Error("late transport failure"));
		else resolveReceipt(outcome);
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(run.steered, ["late instruction"]);
		if (outcome === "complete_delivered") {
			assert.equal(await second.turn.done, "stop");
			assert.equal(agent.sent.length, 1);
			return;
		}
		assert.equal(stopped, false);
		assert.equal(agent.sent.length, 2);
		assert.equal(agent.sent[1].message.text, "late instruction");
		agent.runs[1].emit({ type: "thinking", text: "", thinking_duration_ms: 1 });
		agent.runs[1].end({ status: "finished", usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 50 } });
		assert.equal(await second.turn.done, "stop");
		assert.deepEqual(second.output.usage, { input: 2400, output: 300, cacheRead: 600, cacheWrite: 80, totalTokens: 2200 });
		assert.equal(agent.sent.length, 2, "returned instruction is sent exactly once");
	});
}

test("late steering receipts after dispose cannot start another run", async () => {
	const { agent, session, first, run } = await started();
	let receipt;
	run.steer = () => new Promise(resolve => { receipt = resolve; });
	session.steer({ text: "discard after cancellation", images: [] });
	run.end();
	await new Promise(resolve => setImmediate(resolve));
	session.dispose(new Error("cancelled request"));
	await assert.rejects(first.turn.done, /cancelled request/);
	receipt("revert_to_followup");
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(agent.sent.length, 1);
	assert.equal(session.hasLiveRun, false);
	assert.throws(() => session.attach(newTurn().turn), /closed/);
});

test("the batching timer of a finished run does not leak into the next one", async () => {
	const { session, first, run } = await started();
	session.propose({ id: "c1", name: "read", args: {} });
	await first.turn.done;
	await sleep(BATCH);
	session.detach(first.turn);
	const second = newTurn();
	session.attach(second.turn);
	session.resolveResults([piResult("c1", "x")]);
	run.end({ status: "finished", usage: { inputTokens: 1000, outputTokens: 0 } });
	assert.equal(await second.turn.done, "stop");
	assert.equal(second.output.usage.input, 1000);
	session.dispose();
});
