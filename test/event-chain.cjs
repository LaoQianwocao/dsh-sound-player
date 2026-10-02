/* Headless verification of dsh-sound-player's 7 trigger paths.
 *
 * Stubs the real DSH client runtime contracts:
 *   sessions.list    = SnapshotStore, snapshot { byId, phase } (no `current`)
 *   sessions.binding = { eventSource: ObservableSnapshot<SessionEventWindow> }
 *   connection       = { generation, state } ObservableSnapshots
 *   ctx.remote.$on   = host-forwarded waterfall events
 * and asserts which built-in sound the engine actually plays.
 *
 * Usage:
 *   node test/event-chain.cjs client.js
 *
 * Regression control (the committed revision must fail the event paths, since
 * it read a nonexistent `current` field and the old envelope stream):
 *   git show HEAD:client.js > /tmp/head.js
 *   node test/event-chain.cjs /tmp/head.js
 *
 * Exit code is always 0; read the RESULT line (per-check ok/FAIL above it).
 */
const fs = require("fs");
const vm = require("vm");

const target = process.argv[2];
const code = fs.readFileSync(target, "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let PLAYED = [];
const take = () => { const p = PLAYED; PLAYED = []; return p; };
const sig = (p) => p.map((x) => (x.kind === "file" ? "FILE" : x.f + "@" + x.t)).join(",");

const SYNTH = {
  "prompt-ding": "1046.5@0",
  "complete": "523.25@0,659.25@0.1,783.99@0.2,1046.5@0.3",
  "success": "523.25@0,659.25@0,783.99@0,1046.5@0",
  "question": "659.25@0,783.99@0.16,880@0.32",
  "warn": "392@0,392@0.26",
  "stop": "659.25@0,523.25@0.18,392@0.36",
};
const nameOf = (p) => {
  const s = sig(p);
  if (s === "FILE") return "sys-ding(file)";
  for (const [n, v] of Object.entries(SYNTH)) if (v === s) return n;
  return "?" + s;
};
const SIG2NAME = Object.fromEntries(Object.entries(SYNTH).map(([n, v]) => [v, n]));

class GainStub {
  constructor() { this.gain = { value: 1, setValueAtTime() {}, exponentialRampToValueAtTime() {} }; }
  connect() {}
}
class OscStub {
  constructor() { this.type = "sine"; this.frequency = { value: 0 }; }
  connect() {}
  start(t) { PLAYED.push({ kind: "synth", f: this.frequency.value, t }); }
  stop() {}
}
class SrcStub { connect() {} start() { PLAYED.push({ kind: "file" }); } stop() {} }
class AudioContextStub {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = "running"; return Promise.resolve(); }
  createGain() { return new GainStub(); }
  createOscillator() { return new OscStub(); }
  createBufferSource() { return new SrcStub(); }
  decodeAudioData() { return Promise.resolve({}); }
}
const req = (result) => {
  const r = { result, onsuccess: null, onerror: null, onupgradeneeded: null };
  setTimeout(() => { if (r.onsuccess) r.onsuccess(); }, 0);
  return r;
};
const indexedDBStub = {
  open() {
    const db = {
      objectStoreNames: { contains: () => true },
      createObjectStore() {},
      transaction() {
        return {
          objectStore: () => ({
            put: (rec) => req(rec.id),
            getAll: () => req([]),
            delete: () => req(undefined),
          }),
        };
      },
    };
    return req(db);
  },
};
const localStorageStub = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); },
};

let factory = null;
globalThis.window = {
  __ModuleLoader__: { load: (m) => { factory = m.factory; } },
  addEventListener() {},
  AudioContext: AudioContextStub,
};
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ id: "", textContent: "" }),
  head: { appendChild() {} },
};
globalThis.localStorage = localStorageStub;
globalThis.indexedDB = indexedDBStub;
globalThis.fetch = () => Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
const origWarn = console.warn;
const warns = [];
console.warn = (...a) => { warns.push(a.join(" ")); };

vm.runInThisContext(code, { filename: target });

const React = {
  createElement: () => null,
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};
const mod = factory((n) => { if (n === "react") return React; throw new Error("unexpected require: " + n); });

const listState = { byId: {}, phase: "ready" };
const esState = { entries: [], change: { kind: "append", entries: [] } };
let esListener = null, genListener = null, stateListener = null, questionListener = null;
let listListeners = []; // both watchers subscribe independently
const callList = () => { for (const cb of listListeners.slice()) cb(); };
let gen = { id: 1 }, connState = "connected";
let boundIds = [];

const sessions = {
  list: {
    getSnapshot: () => listState,
    subscribe: (cb) => { listListeners.push(cb); return () => { listListeners = listListeners.filter((x) => x !== cb); }; },
  },
  binding(id) {
    boundIds.push(id);
    return {
      sessionId: id,
      eventSource: {
        getSnapshot: () => esState,
        subscribe: (cb) => { esListener = cb; return () => { esListener = null; }; },
      },
    };
  },
};
const connection = {
  generation: { getSnapshot: () => gen, subscribe: (cb) => { genListener = cb; return () => {}; } },
  state: { getSnapshot: () => connState, subscribe: (cb) => { stateListener = cb; return () => {}; } },
};
const ctx = {
  sessions,
  provide() {},
  get: (k) => (k === "connection" ? connection : undefined),
  on() {},
  remote: {
    $on: (ev, l) => { if (ev === "user-questions/request") questionListener = l; return () => { questionListener = null; }; },
  },
  slots: { inject: (k, cb) => { try { cb(); } catch (e) {} return () => {}; }, register: () => () => {} },
};

mod.apply(ctx);

const results = [];
let failed = 0;
const fail = (msg) => { failed += 1; results.push("FAIL  " + msg); };
const ok = (msg) => results.push("ok    " + msg);

let seq = 0;
async function fireSessionEvent(type, data) {
  seq += 1;
  esState.change = { kind: "append", entries: [{ type: "event", event: { type, seq, data } }] };
  if (!esListener) return fail("eventSource not subscribed -> attach failed");
  esListener();
  await delay(30);
}
async function expect(label, wantSig) {
  await delay(30);
  const p = take();
  const gotSig = p.length ? sig(p) : "(no sound)";
  if (gotSig === wantSig) ok(label + " -> " + nameOf(p));
  else fail(label + " -> " + (p.length ? nameOf(p) : "(no sound)") + " (want " + (SIG2NAME[wantSig] || wantSig) + ")");
}

function report() {
  console.warn = origWarn;
  console.log("=== " + target + " ===");
  for (const r of results) console.log("  " + r);
  if (warns.length) console.log("  (console.warn: " + warns.join(" | ") + ")");
  console.log(failed === 0 ? "RESULT: all passed" : "RESULT: " + failed + " failed");
  process.exit(0);
}

(async () => {
  // 0) no session yet -> must not attach
  callList();
  if (boundIds.length === 0) ok("no current session -> no attach"); else fail("attached without session: " + boundIds.join(","));

  // 1) mainView-retained row becomes the current session
  listState.byId = { "sess-main": { id: "sess-main", retainedBy: { mainView: 1 }, running: false } };
  callList();
  if (boundIds.includes("sess-main")) ok("current session = retainedBy.mainView row");
  else fail("current session not resolved (esListener will stay unsubscribed)");

  // 2) turn end
  await fireSessionEvent("turn/end", { turn: 1, reason: { kind: "completed" } });
  await expect("turn-end", SYNTH.complete);

  // 3) user message (file-audio path)
  await fireSessionEvent("user/message", { source: { kind: "user" } });
  await expect("user-message", "FILE");

  // 4) approval asked
  await fireSessionEvent("approval/asked", {});
  await expect("approval-requested", SYNTH.warn);

  // 5) question via session-event fallback (tool/call)
  await fireSessionEvent("tool/call", { name: "ask_user_question", callId: "c1" });
  await expect("question-requested (tool/call)", SYNTH.question);

  // 6) question via forwarded waterfall + must delegate with next()
  await delay(1600);
  let nextCalled = false;
  take();
  if (typeof questionListener === "function") {
    const r = questionListener({ agent: { id: "sess-main" }, questions: [] }, () => { nextCalled = true; return Promise.resolve({ answers: [] }); });
    if (r && typeof r.then === "function") await r;
    await expect("question-requested (user-questions/request)", SYNTH.question);
    if (nextCalled) ok("waterfall delegated via next()"); else fail("next() not called -> would break the ask chain");
  } else fail("user-questions/request listener not registered");

  // 7) subagent completion + last subagent completion
  listState.byId = {
    "sess-main": { id: "sess-main", retainedBy: { mainView: 1 }, running: true },
    "sub-1": { id: "sub-1", origin: "subagent", parentSessionId: "sess-main", running: true },
  };
  callList(); // wave starts
  take();
  listState.byId = {
    "sess-main": { id: "sess-main", retainedBy: { mainView: 1 }, running: true },
    "sub-1": { id: "sub-1", origin: "subagent", parentSessionId: "sess-main", running: false },
  };
  callList();
  await delay(40);
  const wave = take();
  const chunks = [];
  for (let i = 0; i < wave.length; i += 4) chunks.push(nameOf(wave.slice(i, i + 4)));
  if (chunks.includes(SIG2NAME[SYNTH.complete]) && chunks.includes(SIG2NAME[SYNTH.success])) {
    ok("subagent-complete + last-subagent-complete -> " + chunks.join(" + "));
  } else fail("subagent chain -> " + (chunks.join(" + ") || "(no sound)"));

  // 8) service stop via generation disappearing
  take();
  if (typeof genListener === "function") {
    gen = undefined;
    genListener();
    await expect("stream-end (generation -> undefined)", SYNTH.stop);
  } else fail("connection.generation not subscribed");

  // 9) service stop via state, suppressed by the 5s debounce
  take();
  if (typeof stateListener === "function") {
    connState = "disconnected";
    stateListener();
    await delay(40);
    const dup = take();
    if (dup.length === 0) ok("stream-end debounced within 5s"); else fail("debounce failed: " + nameOf(dup));
  } else fail("connection.state not subscribed");

  report();
})();
