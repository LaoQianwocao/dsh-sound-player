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

// Every gain write reaches the graph here, tagged with the node it belongs to:
// the FIRST gain created in a window is the voice gain (carries the volume and
// the fade ramp), later ones are per-note envelopes of a synth recipe.
let GAIN_OPS = []; // { gid, op: 'value'|'set'|'ramp'|'lin', v }
let GAIN_SEQ = 0;
const takeGains = () => { const g = GAIN_OPS; GAIN_OPS = []; return g; };
/** 本次窗口里最先建立的增益节点 = 声部增益。 */
const voiceGid = (ops) => (ops.length ? Math.min(...ops.map((o) => o.gid)) : -1);
/** 合成音效的音符包络峰值（排除声部增益）。 */
const notePeaks = (ops) => {
  const gid = voiceGid(ops);
  return ops.filter((o) => o.op === "ramp" && o.gid !== gid).map((o) => o.v).filter((v) => v > 0.0002);
};
/** 声部增益上写入的音量值。 */
const voiceLevels = (ops) => {
  const gid = voiceGid(ops);
  return ops.filter((o) => o.op === "value" && o.gid === gid).map((o) => o.v);
};
/** 声部增益上的渐弱斜坡终点（渐弱消失特效会留下 linearRamp）。 */
const fadeRamps = (ops) => ops.filter((o) => o.op === "lin").map((o) => o.v);
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
    this.gid = ++GAIN_SEQ;
    const gid = this.gid;
    this.gain = {
      _v: 1,
      get value() { return this._v; },
      set value(v) { this._v = v; GAIN_OPS.push({ gid, op: "value", v }); },
      setValueAtTime(v) { GAIN_OPS.push({ gid, op: "set", v }); },
      exponentialRampToValueAtTime(v) { GAIN_OPS.push({ gid, op: "ramp", v }); },
      linearRampToValueAtTime(v) { GAIN_OPS.push({ gid, op: "lin", v }); },
    };
  }
  connect() {}
  disconnect() {}
}
class OscStub {
  constructor() { this.type = "sine"; this.frequency = { value: 0 }; }
  connect() {}
  start(t) { PLAYED.push({ kind: "synth", f: this.frequency.value, t, stopT: null }); }
  // stop() 无参 = 立即掐断（引擎换音/停声时调用）；带时间 = 配方自己排的收尾。
  stop(t) {
    if (t === undefined) { KILLED += 1; return; }
    const rec = PLAYED[PLAYED.length - 1];
    if (rec && rec.kind === "synth" && rec.stopT === null) rec.stopT = t;
  }
}
class SrcStub {
  connect() {}
  start(when, offset, duration) { PLAYED.push({ kind: "file", startArgs: [when, offset, duration] }); }
  stop() { KILLED += 1; }
}
class AudioContextStub {
  constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
  resume() { this.state = "running"; return Promise.resolve(); }
  createGain() { return new GainStub(); }
  createOscillator() { return new OscStub(); }
  createBufferSource() { return new SrcStub(); }
  decodeAudioData() { return Promise.resolve({ duration: 2.5 }); }
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

// —— 先把宿主端接上：捕获它注册的两种 handler ——
const hostModPromise = import(pathToFileURL(path.join(__dirname, "..", "lib", "index.js")).href);
let hostHandleHandler = null;   // rpc.handle("soundPlayer", …) 注册的（endpoint 不带前缀）
let hostInterceptHandler = null; // rpc.intercept("/api", …) 注册的（endpoint 带前缀）
let hostHandleChannel = null;
let lastRpcChannel = null;      // 客户端最后一次实际使用的通道
let hostHandler = (endpoint, payload) => {
  // 兼容旧断言用的直接调用：优先专用通道，退回拦截通道。
  if (hostHandleHandler) return hostHandleHandler(endpoint.replace(/^soundPlayer\//, ""), payload);
  if (hostInterceptHandler) return hostInterceptHandler(endpoint, payload);
  return Promise.resolve({ ok: false, error: { code: "x", message: "no host handler", details: {} } });
};

// Minimal element tree instead of null, so the rendered settings page can be
// asserted structurally (function components are invoked by renderNodes below).
// FORCE_FALSE_COUNT forces that many false-initial useState calls per component:
// 1 opens the 【设置】 panel (试听 处于未播放态)，2 再打开 playing 以渲染停止键。
let FORCE_FALSE_COUNT = 0;
let FORCE_LEFT = 0;
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => {
    const initial = typeof v === "function" ? v() : v;
    let value = initial;
    if (FORCE_LEFT > 0 && initial === false) {
      value = true;
      FORCE_LEFT -= 1;
    }
    return [value, () => {}];
  },
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
  // 音效库走真实的宿主端点：按通道分发到宿主注册的两种 handler 之一，
  // 这样客户端测试读的是 sounds/ 里真实的文件。
  rpc: {
    call: async (channel, endpoint, payload) => {
      lastRpcChannel = channel;
      if (channel === "soundPlayer") {
        if (!hostHandleHandler) throw new Error("专用通道未注册");
        return hostHandleHandler(endpoint, payload);
      }
      if (!hostInterceptHandler) throw new Error("共享通道未注册");
      return hostInterceptHandler(endpoint, payload);
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
  const got = notePeaks(takeGains());
  const good = got.length === want.length && got.every((v, i) => near(v, want[i]));
  if (good) ok(label + " -> [" + got.join(", ") + "]");
  else fail(label + " -> [" + got.join(", ") + "] (want [" + want.join(", ") + "])");
}
/** 文件音效：音量写在声部增益上。 */
async function expectVoiceLevel(label, want) {
  await delay(30);
  const got = voiceLevels(takeGains());
  const good = got.length === want.length && got.every((v, i) => near(v, want[i]));
  if (good) ok(label + " -> [" + got.join(", ") + "]");
  else fail(label + " -> [" + got.join(", ") + "] (want [" + want.join(", ") + "])");
}
/** 音符序列（含各自时长，用于裁剪区间断言）。 */
const sigDur = (p) => p.map((x) => (x.kind === "file" ? "FILE" : x.f + "@" + x.t + "/" + (x.stopT == null ? "?" : Math.round((x.stopT - x.t - 0.05) * 1000)))).join(",");

function report() {
  console.warn = origWarn;
  console.log("=== " + target + " ===");
  for (const r of results) console.log("  " + r);
  if (warns.length) console.log("  (console.warn: " + warns.join(" | ") + ")");
  console.log(failed === 0 ? "RESULT: all passed" : "RESULT: " + failed + " failed");
  process.exit(0);
}

(async () => {
  // 先把宿主端挂上并捕获它的两种注册，再 apply 客户端。
  const hostMod = await hostModPromise;
  hostMod.apply({
    get: (k) => (k === "connection" ? {
      rpc: {
        // 专用通道：endpoint 不带前缀（tree / read / …）
        handle: (channel, h) => { hostHandleChannel = channel; hostHandleHandler = h; return async () => {}; },
        // 共享通道拦截：endpoint 形如 soundPlayer/tree
        intercept: (channel, matches, h) => { hostInterceptHandler = h; return async () => {}; },
      },
    } : undefined),
    on: () => {},
  });
  if (typeof hostHandleHandler === "function" && typeof hostInterceptHandler === "function") {
    ok("宿主端同时注册专用通道与 /api 拦截（channel=" + hostHandleChannel + "）");
  } else fail("宿主端注册不完整: handle=" + typeof hostHandleHandler + " intercept=" + typeof hostInterceptHandler);

  mod.apply(ctx);
  await delay(60); // 等 refreshLibrary() 完成
  if (lastRpcChannel === "soundPlayer") ok("客户端优先走专用通道 soundPlayer");
  else fail("客户端首选通道 = " + lastRpcChannel);

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
  await expectVoiceLevel("file sound at its own volume 0.3", [0.3]);
  board.setVolume(0.6); // legacy call must not reintroduce a global volume
  if (board.listSituations().every((s) => near(s.volume, 0.6))) ok("legacy setVolume(v) bulk-writes all situations");
  else fail("legacy setVolume(v) did not bulk-apply to every situation");

  // 6c) 播放区间（起点/终点）与「渐弱消失」特效
  board.setSituationVolume("conversation-complete", 0.8);
  board.setSituation("conversation-complete", { clipStart: 100, clipEnd: null, effect: null });
  take(); takeGains();
  await board.triggerSituation("conversation-complete");
  await delay(30);
  const clipped = take();
  // 起点 100ms：第一个音符(0..200)被切到 100..200 -> 0ms 起、100ms 长；
  // 第二(100..300)/第三(200..400)/第四(300..700) 依次平移。
  const wantClip = "523.25@0/100,659.25@0/200,783.99@0.1/200,1046.5@0.2/400";
  if (sigDur(clipped) === wantClip) ok("clip start 100ms -> " + sigDur(clipped));
  else fail("clip start -> " + sigDur(clipped) + " (want " + wantClip + ")");

  board.setSituation("conversation-complete", { clipStart: 0, clipEnd: 500, effect: null });
  take(); takeGains();
  await board.triggerSituation("conversation-complete");
  await delay(30);
  const cut = take();
  // 终点 500ms：最后一个音符(300..700)被截到 300..500 -> 200ms 长
  const wantCut = "523.25@0/200,659.25@0.1/200,783.99@0.2/200,1046.5@0.3/200";
  if (sigDur(cut) === wantCut) ok("clip end 500ms -> " + sigDur(cut));
  else fail("clip end -> " + sigDur(cut) + " (want " + wantCut + ")");

  board.setSituation("conversation-complete", { clipStart: 0, clipEnd: null, effect: "fade-out" });
  take(); takeGains();
  await board.triggerSituation("conversation-complete");
  await delay(30);
  const fadeRamp = fadeRamps(takeGains());
  if (fadeRamp.length && near(fadeRamp[0], 0.0001)) ok("effect fade-out schedules a gain ramp to 0");
  else fail("fade-out did not schedule a ramp: [" + fadeRamp.join(", ") + "]");

  // 文件音效的区间：起点作为 offset、终点决定 duration
  board.setSituation("user-ask", { clipStart: 200, clipEnd: 1200, effect: null });
  take(); takeGains();
  await fireSessionEvent("user/message", { source: { kind: "user" } });
  await delay(30);
  const fileRec = take().find((x) => x.kind === "file");
  const args = fileRec ? fileRec.startArgs : [];
  if (args.length === 3 && near(args[1], 0.2) && near(args[2], 1)) ok("file clip -> offset " + args[1] + "s, duration " + args[2] + "s");
  else fail("file clip args = " + JSON.stringify(args) + " (want offset 0.2s / duration 1s)");

  // 6d) 试听可被停止（防止导入整首歌被迫放完）
  board.setSituation("conversation-complete", { clipStart: 0, clipEnd: null, effect: null });
  take(); KILLED = 0;
  const voice = await board.previewSituation("conversation-complete");
  await delay(20);
  if (voice && typeof voice.stop === "function") ok("previewSituation returns a stoppable voice");
  else fail("previewSituation did not return a voice");
  let ended = false;
  if (voice) voice.ended.then(() => { ended = true; });
  const stopped = board.stopPreview();
  await delay(20);
  if (stopped && KILLED >= 4) ok("stopPreview stops the sounding voice (killed " + KILLED + ")");
  else fail("stopPreview did not stop playback (killed=" + KILLED + ")");
  await delay(20);
  if (ended) ok("stopped voice resolves its ended promise (试听按键可复位)");
  else fail("ended promise not resolved after stop");

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
    if (typeof node.type === "function") {
      FORCE_LEFT = FORCE_FALSE_COUNT;
      const el = node.type(node.props);
      FORCE_LEFT = 0;
      return renderNodes(el, out);
    }
    out.push(node);
    for (const c of node.children || []) renderNodes(c, out);
    return out;
  }
  function renderTexts(node, out) {
    if (node == null || node === false || node === true) return out;
    if (typeof node === "string" || typeof node === "number") { out.push(String(node)); return out; }
    if (Array.isArray(node)) { for (const n of node) renderTexts(n, out); return out; }
    if (typeof node !== "object") return out;
    if (typeof node.type === "function") {
      FORCE_LEFT = FORCE_FALSE_COUNT;
      const el = node.type(node.props);
      FORCE_LEFT = 0;
      return renderTexts(el, out);
    }
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
    if (sliders.length === 0) ok("UI: 调整项默认收起（行上不再常驻音量滑块）");
    else fail("UI: " + sliders.length + " sliders visible while panels are collapsed");
    if (texts.includes("总开关") && !texts.some((t) => t.indexOf("总开关与音量") >= 0)) ok("UI: global volume row removed from the switch section");
    else fail("UI: switch section title still mentions volume");

    // 音效选择器：每条绑定一个，按钮上显示当前绑定的短名
    const pickers = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.indexOf("dsp-picker") === 0);
    if (pickers.length === count) ok("UI: " + count + " cascading sound pickers");
    else fail("UI: " + pickers.length + " pickers (expect " + count + ")");
    const pickerBtns = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.indexOf("dsp-picker-btn") >= 0);
    const firstLabel = pickerBtns.length ? renderTexts({ type: "div", props: {}, children: pickerBtns[0].children || [] }, []) : [];
    if (firstLabel.join("").indexOf("完成音（上扬）") >= 0) ok("UI: picker button shows the bound sound short name");
    else fail("UI: picker button label = " + JSON.stringify(firstLabel.join("")));

    // 行上应有【设置】按钮
    const btnTexts = nodes
      .filter((n) => n.type === "button")
      .map((n) => renderTexts({ type: "div", props: {}, children: n.children || [] }, []).join(""));
    const settingsBtns = btnTexts.filter((t) => t.indexOf("设置") >= 0).length;
    if (settingsBtns === count) ok("UI: " + count + " 【设置】buttons");
    else fail("UI: " + settingsBtns + " 【设置】buttons (expect " + count + ")");

    // 音效库导入区不再列出音效，改为三个按钮
    const sndRows = nodes.filter((n) => typeof n.props.className === "string" && n.props.className.indexOf("dsp-snd-row") >= 0);
    if (sndRows.length === 0) ok("UI: import section no longer lists sounds");
    else fail("UI: import section still renders " + sndRows.length + " sound rows");
    for (const want of ["导入音效", "导入文件夹", "打开音效库"]) {
      if (btnTexts.some((t) => t.indexOf(want) >= 0)) ok("UI: import section has 「" + want + "」");
      else fail("UI: import section missing 「" + want + "」");
    }

    // 展开【设置】后的面板：音量 / 起点 / 终点 / 特效 / 试听
    // （必须在渲染期间保持 FORCE_FALSE_COUNT：createElement 是惰性的，
    //   renderNodes 才真正调用组件。）
    FORCE_FALSE_COUNT = 1;
    const openTree = React.createElement(REGISTERED[0].component, { board });
    const openNodes = renderNodes(openTree, []);
    const openTexts = renderTexts(openTree, []);
    FORCE_FALSE_COUNT = 0;
    const panels = openNodes.filter((n) => n.props.className === "dsp-panel");
    if (panels.length === count) ok("UI: 【设置】展开出 " + count + " 个调整面板");
    else fail("UI: " + panels.length + " panels (expect " + count + ")");
    const openRanges = openNodes.filter((n) => n.type === "input" && n.props.type === "range");
    if (openRanges.length === count) ok("UI: 面板里有 " + count + " 个音量滑块");
    else fail("UI: " + openRanges.length + " volume sliders in panels (expect " + count + ")");
    const numInputs = openNodes.filter((n) => n.type === "input" && n.props.type === "number");
    if (numInputs.length === count * 2) ok("UI: 每条绑定两个毫秒输入（起点 / 终点）");
    else fail("UI: " + numInputs.length + " number inputs (expect " + count * 2 + ")");
    if (numInputs.length && numInputs[0].props.step === 1) ok("UI: 时间输入精确到 1 毫秒");
    else fail("UI: 时间输入 step = " + (numInputs[0] && numInputs[0].props.step));
    for (const want of ["播放起点", "特效", "渐弱消失", "试听"]) {
      if (openTexts.some((t) => t.indexOf(want) >= 0)) ok("UI: 面板含「" + want + "」");
      else fail("UI: 面板缺少「" + want + "」");
    }

    // 播放中：试听按钮变成红色方形停止键（状态位由 FORCE_FALSE_COUNT=2 打开）
    FORCE_FALSE_COUNT = 2;
    const playingTree = React.createElement(REGISTERED[0].component, { board });
    const playingNodes = renderNodes(playingTree, []);
    FORCE_FALSE_COUNT = 0;
    const stopBtns = playingNodes.filter((n) => n.type === "button" && typeof n.props.className === "string" && n.props.className.indexOf("dsp-stop") >= 0);
    const stopLabels = stopBtns.map((n) => renderTexts({ type: "div", props: {}, children: n.children || [] }, []).join(""));
    if (stopBtns.length === count && stopLabels.every((t) => t.indexOf("■") >= 0)) ok("UI: 播放中显示 " + count + " 个红色方形停止键（■ 停止）");
    else fail("UI: 停止键 " + stopBtns.length + " 个，标签 " + JSON.stringify(stopLabels.slice(0, 2)));
  }

  // 12) 专用通道不可用时，退回 /api 拦截通道（宿主只注册了一种的情况）
  const savedHandle = hostHandleHandler;
  const mod2 = factory((n) => { if (n === "react") return React; throw new Error("unexpected require: " + n); });
  hostHandleHandler = null;
  lastRpcChannel = null;
  mod2.apply(ctx);
  await delay(60);
  const tree2 = globalThis.window.__dshSoundPlayer__.getLibraryTree();
  if (tree2 && tree2.children.length === 3) ok("专用通道不可用时退回 /api 拦截通道");
  else fail("回退后仍读不到库: " + (tree2 ? tree2.children.length : "null"));
  if (lastRpcChannel === "/api") ok("回退确实走了共享通道 /api（lastRpcChannel=" + lastRpcChannel + "）");
  else fail("回退通道 = " + lastRpcChannel);
  hostHandleHandler = savedHandle;

  report();
})();
