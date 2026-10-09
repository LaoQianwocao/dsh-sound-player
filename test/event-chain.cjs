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
const path = require("node:path");
const vm = require("vm");
const { pathToFileURL } = require("node:url");

const target = process.argv[2];
const code = fs.readFileSync(target, "utf8");
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let PLAYED = [];
const take = () => { const p = PLAYED; PLAYED = []; return p; };
const sig = (p) => p.map((x) => (x.kind === "file" ? "FILE" : x.f + "@" + x.t)).join(",");

// Every gain write reaches the graph here: `value =` for file sounds, the attack
// ramp for synth notes (release tails ramp to 0.0001 and are filtered out).
let GAINS = [];
const takeGains = () => { const g = GAINS; GAINS = []; return g; };
const peaks = (g) => g.filter((v) => v > 0.0002);
let KILLED = 0; // immediate-voice kills (engine replacing a still-playing sound)

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
  constructor() {
    this.gain = {
      _v: 1,
      get value() { return this._v; },
      set value(v) { this._v = v; GAINS.push(v); },
      setValueAtTime() {},
      exponentialRampToValueAtTime(v) { GAINS.push(v); },
    };
  }
  connect() {}
}
class OscStub {
  constructor() { this.type = "sine"; this.frequency = { value: 0 }; }
  connect() {}
  start(t) { PLAYED.push({ kind: "synth", f: this.frequency.value, t }); }
  // stop() 无参 = 立即掐断（引擎在换音/停声时调用）；带时间 = 配方自己排的收尾。
  stop(t) { if (t === undefined) KILLED += 1; }
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
// Pre-seed a v2 config: the old GLOBAL volume (0.5) must migrate into every
// situation's own volume, and the global field must disappear.
localStorageStub.setItem("dsh-sound-player:config:v1", JSON.stringify({
  v: 2,
  enabled: true,
  volume: 0.5,
  onlyCurrentSession: true,
  situations: [
    { id: "conversation-complete", label: "旧名", trigger: "turn-end", enabled: true, audioId: "synth-complete", builtin: true },
  ],
}));
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

// —— 先把宿主端接上：捕获它注册的 soundPlayer/* handler ——
const hostModPromise = import(pathToFileURL(path.join(__dirname, "..", "lib", "index.js")).href);
let hostHandler = null;

// Minimal element tree instead of null, so the rendered settings page can be
// asserted structurally (function components are invoked by renderNodes below).
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
};
const mod = factory((n) => { if (n === "react") return React; throw new Error("unexpected require: " + n); });

const listState = { byId: {}, phase: "ready" };
const esState = { entries: [], change: { kind: "append", entries: [] } };
let esListeners = [], genListener = null, stateListener = null, questionListener = null;
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
        // 真实实现是 Set<listener>，支持多个订阅者，桩必须照此实现，
        // 否则「旧实例未收」这类重复播放根本复现不出来。
        subscribe: (cb) => {
          esListeners.push(cb);
          return () => { esListeners = esListeners.filter((x) => x !== cb); };
        },
      },
    };
  },
};
const connection = {
  generation: { getSnapshot: () => gen, subscribe: (cb) => { genListener = cb; return () => {}; } },
  state: { getSnapshot: () => connState, subscribe: (cb) => { stateListener = cb; return () => {}; } },
  // 音效库走真实的宿主端点：把 hostHandler 当作 RPC 传输层接上，
  // 这样客户端测试读的是 sounds/ 里真实的文件。
  rpc: {
    call: async (channel, endpoint, payload) => {
      if (!hostHandler) throw new Error("host handler 未注册");
      return hostHandler(endpoint, payload);
    },
  },
};
const REGISTERED = []; // settings.section registrations, for the UI assertions
const ctx = {
  sessions,
  provide() {},
  get: (k) => (k === "connection" ? connection : undefined),
  on() {},
  remote: {
    $on: (ev, l) => { if (ev === "user-questions/request") questionListener = l; return () => { questionListener = null; }; },
  },
  slots: {
    inject: (k, cb) => { try { cb(); } catch (e) {} return () => {}; },
    register: (spec, component) => { REGISTERED.push({ spec, component }); return () => {}; },
  },
};

// apply 必须在宿主端 handler 就绪之后再调用（库树是从宿主端拉的），
// 因此挪进下面的异步主体里。

const results = [];
let failed = 0;
const fail = (msg) => { failed += 1; results.push("FAIL  " + msg); };
const ok = (msg) => results.push("ok    " + msg);

let seq = 0;
const notifyEventSource = () => { for (const cb of esListeners.slice()) cb(); };
async function fireSessionEvent(type, data) {
  seq += 1;
  esState.change = { kind: "append", entries: [{ type: "event", event: { type, seq, data } }] };
  if (!esListeners.length) return fail("eventSource not subscribed -> attach failed");
  notifyEventSource();
  await delay(30);
}
async function expect(label, wantSig) {
  await delay(30);
  const p = take();
  const gotSig = p.length ? sig(p) : "(no sound)";
  if (gotSig === wantSig) ok(label + " -> " + nameOf(p));
  else fail(label + " -> " + (p.length ? nameOf(p) : "(no sound)") + " (want " + (SIG2NAME[wantSig] || wantSig) + ")");
}
const near = (a, b) => Math.abs(a - b) < 1e-6;
async function expectGains(label, want) {
  await delay(30);
  const got = peaks(takeGains());
  const good = got.length === want.length && got.every((v, i) => near(v, want[i]));
  if (good) ok(label + " -> [" + got.join(", ") + "]");
  else fail(label + " -> [" + got.join(", ") + "] (want [" + want.join(", ") + "])");
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
  // 先把宿主端挂上并捕获它的 soundPlayer/* handler，再 apply 客户端。
  const hostMod = await hostModPromise;
  hostMod.apply({
    get: (k) => (k === "connection" ? {
      rpc: { intercept: (channel, matches, h) => { hostHandler = h; return async () => { hostHandler = null; }; } },
    } : undefined),
    on: () => {},
  });
  if (typeof hostHandler !== "function") { fail("宿主端 handler 未注册"); report(); return; }
  ok("宿主端 soundPlayer/* handler 已接到客户端 RPC 传输层");

  mod.apply(ctx);
  await delay(60); // 等 refreshLibrary() 完成

  // 0) no session yet -> must not attach
  callList();
  if (boundIds.length === 0) ok("no current session -> no attach"); else fail("attached without session: " + boundIds.join(","));

  // 1) mainView-retained row becomes the current session
  listState.byId = { "sess-main": { id: "sess-main", retainedBy: { mainView: 1 }, running: false } };
  callList();
  if (boundIds.includes("sess-main")) ok("current session = retainedBy.mainView row");
  else fail("current session not resolved (esListener will stay unsubscribed)");

  // 1a) v2 -> v3 migration of the pre-seeded config
  const board = globalThis.window.__dshSoundPlayer__;
  const sitById = (id) => board.listSituations().find((s) => s.id === id);
  const conv = sitById("conversation-complete");
  const perm = sitById("permission-request");
  if (conv && near(conv.volume, 0.5)) ok("migration: legacy global volume 0.5 -> per-situation volume");
  else fail("migration: conversation-complete volume = " + (conv && conv.volume));
  if (perm && near(perm.volume, 0.8)) ok("migration: merged built-in gets default volume 0.8");
  else fail("migration: permission-request volume = " + (perm && perm.volume));
  if (board.getState().volume === undefined) ok("no global volume exposed in getState()");
  else fail("getState() still exposes volume = " + board.getState().volume);
  if (board.getState().onlyCurrentSession === undefined) ok("no session filtering exposed in getState()");
  else fail("getState() still exposes onlyCurrentSession = " + board.getState().onlyCurrentSession);
  if (board.setOnlyCurrentSession === undefined) ok("setOnlyCurrentSession removed from the API");
  else fail("setOnlyCurrentSession is still part of the public API");
  // v4 -> v5：内置 id 迁移成库内路径
  if (conv && conv.audioId === "默认音效库/合成音效/完成音（上扬）.json") ok("migration: builtin id -> library path");
  else fail("migration: conversation-complete audioId = " + (conv && conv.audioId));

  // 1b) 音效库（真实文件，经宿主端 handler 读回）
  const tree = board.getLibraryTree();
  const libNames = tree ? tree.children.map((d) => d.name) : [];
  if (["默认音效库", "自定义音效库", "神人音效库"].every((n) => libNames.includes(n))) ok("库树含三个库: " + libNames.join(" / "));
  else fail("库树缺库: " + libNames.join(" / "));
  const flatten = (nodes, out) => {
    const acc = out || [];
    for (const n of nodes || []) { if (n.type === "dir") flatten(n.children, acc); else acc.push(n); }
    return acc;
  };
  const tops = tree ? tree.children : [];
  const shenCount = flatten(tops.filter((d) => d.name === "神人音效库")).length;
  const defLib = tops.find((d) => d.name === "默认音效库");
  const defSounds = flatten(defLib ? [defLib] : []);
  const synthCount = defSounds.filter((n) => n.type === "synth").length;
  const audioCount = defSounds.filter((n) => n.type === "audio").length;
  const cusCount = flatten(tops.filter((d) => d.name === "自定义音效库")).length;
  if (shenCount === 34) ok("神人音效库 34 个音效可读");
  else fail("神人音效库条目数 = " + shenCount);
  if (synthCount === 8 && audioCount === 3) ok("默认音效库 = 8 个合成配方 + 3 个系统提示音");
  else fail("默认音效库结构异常: synth=" + synthCount + " audio=" + audioCount);
  if (cusCount === 0) ok("自定义音效库初始为空");
  else fail("自定义音效库初始应为空，实际 " + cusCount);
  const multiLevel = tops.find((d) => d.name === "默认音效库");
  if (multiLevel && multiLevel.children.every((c) => c.type === "dir")) ok("默认音效库是多级结构（合成音效 / Windows 系统提示音）");
  else fail("默认音效库不是多级结构");

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

  // 6b) per-situation volume reaches the graph, and items are independent
  board.setSituationVolume("conversation-complete", 0.25);
  board.setSituationVolume("permission-request", 0.5);
  take(); takeGains();
  await fireSessionEvent("turn/end", { turn: 2, reason: { kind: "completed" } });
  // 完成音 recipe gains 0.4/0.4/0.4/0.45 × 0.25
  await expectGains("turn-end at its own volume 0.25", [0.1, 0.1, 0.1, 0.1125]);
  take(); takeGains();
  await fireSessionEvent("approval/asked", {});
  await expectGains("approval at its own volume 0.5", [0.175, 0.175]); // 警告音 0.35 × 0.5
  take(); takeGains();
  await fireSessionEvent("turn/end", { turn: 3, reason: { kind: "completed" } });
  await expectGains("turn-end unaffected by edits to another item", [0.1, 0.1, 0.1, 0.1125]);
  board.setSituationVolume("user-ask", 0.3);
  take(); takeGains();
  await fireSessionEvent("user/message", { source: { kind: "user" } });
  await expectGains("file sound at its own volume 0.3", [0.3]);
  board.setVolume(0.6); // legacy call must not reintroduce a global volume
  if (board.listSituations().every((s) => near(s.volume, 0.6))) ok("legacy setVolume(v) bulk-writes all situations");
  else fail("legacy setVolume(v) did not bulk-apply to every situation");

  // 7) subagents are no longer scoped to the current session tree
  listState.byId = {
    "sess-main": { id: "sess-main", retainedBy: { mainView: 1 }, running: true },
    "sub-1": { id: "sub-1", origin: "subagent", parentSessionId: "sess-main", running: true },
    "other-sess": { id: "other-sess", running: false }, // 另一个顶层会话，不在当前会话树内
    "sub-bg": { id: "sub-bg", origin: "subagent", parentSessionId: "other-sess", running: true },
  };
  callList(); // wave starts with sub-1 + sub-bg
  take();
  // 后台会话的子代理先完成，而当前会话树的 sub-1 仍在运行
  listState.byId["sub-bg"] = { id: "sub-bg", origin: "subagent", parentSessionId: "other-sess", running: false };
  callList();
  await delay(40);
  let subPlay = take();
  const subName = subPlay.length ? nameOf(subPlay) : "(no sound)";
  if (subName === SIG2NAME[SYNTH.complete]) ok("background-session subagent completion rings (no session filter)");
  else fail("background subagent -> " + subName + " (want " + SIG2NAME[SYNTH.complete] + ")");

  // 最后一个还在跑的（sub-1）完成后：完成音 + 波结束的成功音
  listState.byId["sub-1"] = { id: "sub-1", origin: "subagent", parentSessionId: "sess-main", running: false };
  callList();
  await delay(40);
  subPlay = take();
  const subChunks = [];
  for (let i = 0; i + 4 <= subPlay.length; i += 4) subChunks.push(nameOf(subPlay.slice(i, i + 4)));
  if (subChunks.includes(SIG2NAME[SYNTH.complete]) && subChunks.includes(SIG2NAME[SYNTH.success])) {
    ok("subagent-complete + last-subagent-complete -> " + subChunks.join(" + "));
  } else fail("subagent chain -> " + (subChunks.join(" + ") || "(no sound)"));

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

  // 10) duplicate delivery and stale runtimes must not double-play
  // 10a) the same seq delivered again -> must stay silent
  take(); takeGains();
  notifyEventSource(); // same change object, same seq as the previous append
  await delay(40);
  if (take().length === 0) ok("re-delivering the same seq stays silent");
  else fail("same seq replayed a sound");

  // 10b) a stale runtime (HMR / generation remount) is disposed on re-apply
  mod.apply(ctx);
  await delay(40);
  if (esListeners.length === 1) ok("re-apply disposes the stale runtime (1 event subscription)");
  else fail("stale runtimes still subscribed: " + esListeners.length);
  callList();
  take(); takeGains();
  await fireSessionEvent("turn/end", { turn: 9, reason: { kind: "completed" } });
  await delay(30);
  const afterReapply = take();
  if (afterReapply.length === 4) ok("one event after re-apply -> exactly one sound");
  else fail("one event after re-apply -> " + afterReapply.length + " voices (want 4)");

  // 10c) the same sound never stacks onto itself
  take(); KILLED = 0;
  await board.triggerSituation("conversation-complete");
  await delay(20);
  await board.triggerSituation("conversation-complete");
  await delay(20);
  if (KILLED >= 4) ok("re-triggering one sound stops the previous voice (no stacking)");
  else fail("previous voice not stopped: killed=" + KILLED);

  // 11) rendered settings page: one volume slider per binding item, no global one
  function renderNodes(node, out) {
    if (node == null || node === false || node === true) return out;
    if (Array.isArray(node)) { for (const n of node) renderNodes(n, out); return out; }
    if (typeof node !== "object") return out;
    if (typeof node.type === "function") return renderNodes(node.type(node.props), out);
    out.push(node);
    for (const c of node.children || []) renderNodes(c, out);
    return out;
  }
  function renderTexts(node, out) {
    if (node == null || node === false || node === true) return out;
    if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
    if (Array.isArray(node)) { for (const n of node) renderTexts(n, out); return out; }
    if (typeof node !== "object") return out;
    if (typeof node.type === "function") return renderTexts(node.type(node.props), out);
    for (const c of node.children || []) renderTexts(c, out);
    return out;
  }
  if (!REGISTERED.length) fail("settings.section was never registered");
  else {
    const uiTree = React.createElement(REGISTERED[0].component, { board });
    const nodes = renderNodes(uiTree, []);
    const texts = renderTexts(uiTree, []);
    const count = board.listSituations().length;
    const sliders = nodes.filter((n) => n.type === "input" && n.props.type === "range");
    const perItem = sliders.filter((n) => typeof n.props.title === "string" && n.props.title.indexOf("这条情况") >= 0);
    if (sliders.length === count && perItem.length === count) ok("UI: " + count + " per-item volume sliders and no global slider");
    else fail("UI: " + sliders.length + " sliders / " + perItem.length + " per-item (expect " + count + ")");
    if (texts.includes("总开关") && !texts.some((t) => t.indexOf("总开关与音量") >= 0)) ok("UI: global volume row removed from the switch section");
    else fail("UI: switch section title still mentions volume");

    // 音效选择器：每条绑定一个，按钮上显示当前绑定的短名
    const pickers = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.indexOf("dsp-picker") === 0);
    if (pickers.length === count) ok("UI: " + count + " cascading sound pickers");
    else fail("UI: " + pickers.length + " pickers (expect " + count + ")");
    const pickerBtns = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.indexOf("dsp-picker-btn") >= 0);
    if (pickerBtns.length === count) ok("UI: picker buttons rendered per binding");
    else fail("UI: " + pickerBtns.length + " picker buttons (expect " + count + ")");
    const firstLabel = pickerBtns.length ? renderTexts(pickerBtns[0].children ? { type: "div", props: {}, children: pickerBtns[0].children } : null, []) : [];
    if (firstLabel.join("").indexOf("完成音（上扬）") >= 0) ok("UI: picker button shows the bound sound short name");
    else fail("UI: picker button label = " + JSON.stringify(firstLabel.join("")));

    // 音效库导入区不再列出音效，改为三个按钮
    const sndRows = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.indexOf("dsp-snd-row") >= 0);
    if (sndRows.length === 0) ok("UI: import section no longer lists sounds");
    else fail("UI: import section still renders " + sndRows.length + " sound rows");
    const btnTexts = nodes
      .filter((n) => n.type === "button")
      .map((n) => renderTexts({ type: "div", props: {}, children: n.children || [] }, []).join(""));
    for (const want of ["导入音效", "导入文件夹", "打开音效库"]) {
      if (btnTexts.some((t) => t.indexOf(want) >= 0)) ok("UI: import section has 「" + want + "」");
      else fail("UI: import section missing 「" + want + "」");
    }
  }

  report();
})();
