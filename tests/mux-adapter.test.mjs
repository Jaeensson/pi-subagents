import assert from "node:assert/strict";
import test from "node:test";
import { createCommandQueue } from "../mux-adapter.ts";

// A queue default is limit=4 active, capacity=32 pending. Only pending work
// counts against capacity; the four running slots are excluded. So 4 active +
// 32 pending = 36 admitted and the 37th schedule is the first to reject. This
// mirrors the boundary asserted by the Herdr adapter's "bounds active work"
// and "same-pane waiters count toward shared32" tests.
const gated = (length) => Array.from({ length }, () => { let open; const p = new Promise(resolve => { open = resolve; }); return { p, open }; });

test("command queue bounds four active and thirty-two pending", async () => {
  const q = createCommandQueue();
  const gates = gated(37);
  let started = 0;
  const calls = gates.map(g => q.schedule([async () => { started++; return g.p; }], () => false));
  await Promise.resolve(); await Promise.resolve();
  assert.equal(started, 4);
  // The 37th schedule (index 36) overflows; the 36th (index 35) is admitted.
  await assert.rejects(() => calls[36], error => error.unavailable === true);
  for (const gate of gates.slice(0, 36)) gate.open();
  assert.equal((await Promise.all(calls.slice(0, 36))).length, 36);
});

test("command queue counts same-key waiters toward shared capacity", async () => {
  const q = createCommandQueue();
  const gates = gated(34);
  let started = 0;
  const calls = gates.map(g => q.schedule([async () => { started++; return g.p; }], () => false, "pane"));
  await Promise.resolve(); await Promise.resolve();
  // One active, 32 pending same-key waiters are admitted; the 34th rejects.
  assert.equal(started, 1);
  await assert.rejects(() => calls[33], error => error.unavailable === true);
  for (const gate of gates.slice(0, 33)) gate.open();
  assert.equal((await Promise.all(calls.slice(0, 33))).length, 33);
});

test("command queue skips stale work at admit and before dispatch", async () => {
  const q = createCommandQueue();
  let stale = true;
  await assert.rejects(() => q.schedule([async () => 1], () => stale), error => error.stale === true);
  stale = false;
  const ran = q.schedule([async () => 42], () => false, "pane-1");
  stale = true;
  assert.deepEqual(await ran, [42]);
});

test("command queue serializes one key and keeps others concurrent", async () => {
  const q = createCommandQueue();
  const order = [];
  const a = q.schedule([async () => { order.push("a1"); await new Promise(resolve => setTimeout(resolve, 5)); order.push("a2"); }], () => false, "p");
  const b = q.schedule([async () => { order.push("b1"); }], () => false, "p");
  const c = q.schedule([async () => { order.push("c1"); }], () => false, "other");
  await Promise.all([a, b, c]);
  assert.deepEqual(order, ["a1", "c1", "a2", "b1"]);
});
