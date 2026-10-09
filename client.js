/* dsh-sound-player — DSH Web 音效播放器（浏览器端）。
 * 功能：
 *   1. 设置页音效播放器：所有操作（总开关 / 音量 / 情况绑定 / 音效导入）都在设置菜单完成。
 *   2. 内置情况：对话完成、发送消息、权限请求、被提问、服务终止、子代理运行完成、最后一个子代理运行完成。
 *   3. 供其他插件使用的 API：导入音频、增添情况、触发情况并播放音效。
 * 通过 window.__ModuleLoader__.load 注册；exports.inject / exports.apply 为 cordis 客户端插件契约。
 */
window.__ModuleLoader__.load({
	id: "dsh-sound-player",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let React = require("react");

		// #region 常量
		const CONFIG_KEY = "dsh-sound-player:config:v1";
		const DB_NAME = "dsh-sound-player";
		const DB_STORE = "sounds";
		// 不再有全局音量：每条情况各自持有一份音量，这里是「该条没写音量」时的兜底。
		const DEFAULT_VOLUME = 0.8;
		const TRIGGER_LABELS = {
			"turn-end": "对话完成",
			"user-message": "发送消息时",
			"approval-requested": "权限请求时",
			"question-requested": "被提问时",
			"stream-end": "服务终止时",
			"subagent-complete": "子代理运行完成",
			"last-subagent-complete": "最后一个子代理运行完成",
			"manual": "手动触发（插件调用）"
		};
		// #endregion

		// #region 音效库（宿主端提供的真实文件夹）
		// 三个库都是插件包内的真实目录（sounds/），由宿主端 lib/index.js 通过
		// ctx.connection.rpc.intercept("/api", …) 提供，客户端只读取与写入：
		//   默认音效库  内置合成音效（*.json 配方）+ Windows 系统提示音（*.wav）
		//   神人音效库  内置 meme / 游戏音效
		//   自定义音效库 使用者导入的音效
		// 一条情况绑定的是「库内相对路径」，例如 "神人音效库/哈基米.mp3"。
		const RPC_CHANNEL = "/api";
		const RPC_PREFIX = "soundPlayer/";
		const CUSTOM_LIB = "自定义音效库";
		const LIBRARY_ROOT = "音效库";
		/** 内置音效在库内的路径。同时充当旧版（v4 及以前）内置 id → 路径的迁移表。 */
		const BUILTIN_AUDIO_PATH = {
			"synth-ding": "默认音效库/合成音效/提示音1（叮）.json",
			"synth-ding2": "默认音效库/合成音效/提示音2（双叮）.json",
			"synth-complete": "默认音效库/合成音效/完成音（上扬）.json",
			"synth-bell": "默认音效库/合成音效/通知音（钟声）.json",
			"synth-question": "默认音效库/合成音效/询问音.json",
			"synth-success": "默认音效库/合成音效/成功音（和弦）.json",
			"synth-warn": "默认音效库/合成音效/警告音.json",
			"synth-stop": "默认音效库/合成音效/停止音（下行）.json",
			"sys-ding": "默认音效库/Windows 系统提示音/叮.wav",
			"sys-startup": "默认音效库/Windows 系统提示音/启动.wav",
			"sys-default": "默认音效库/Windows 系统提示音/默认.wav"
		};
		/** 显示一条绑定时用的短名：取路径最后一段并去掉扩展名。 */
		function shortName(pathOrId) {
			if (!pathOrId) return "（无）";
			const base = String(pathOrId).split("/").pop();
			return base.replace(/\.(json|mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i, "");
		}
		// #endregion

		// #region 工具
		function uid(prefix) {
			return (prefix || "id") + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
		}
		function clamp(v, min, max) {
			return Math.min(max, Math.max(min, v));
		}
		function deepClone(x) {
			return JSON.parse(JSON.stringify(x));
		}
		// #endregion

		// #region 配置（localStorage）
		const DEFAULT_SITUATIONS = [
			{ id: "conversation-complete", label: "对话完成提示", trigger: "turn-end", enabled: true, audioId: BUILTIN_AUDIO_PATH["synth-complete"], volume: 0.8, builtin: true },
			{ id: "user-ask", label: "发送消息时提示", trigger: "user-message", enabled: true, audioId: BUILTIN_AUDIO_PATH["sys-ding"], volume: 0.8, builtin: true },
			{ id: "permission-request", label: "权限请求时提示", trigger: "approval-requested", enabled: true, audioId: BUILTIN_AUDIO_PATH["synth-warn"], volume: 0.8, builtin: true },
			{ id: "agent-question", label: "被提问时提示", trigger: "question-requested", enabled: true, audioId: BUILTIN_AUDIO_PATH["synth-question"], volume: 0.8, builtin: true },
			{ id: "service-stop", label: "服务终止时提示", trigger: "stream-end", enabled: true, audioId: BUILTIN_AUDIO_PATH["synth-stop"], volume: 0.8, builtin: true },
			{ id: "subagent-done", label: "子代理运行完成", trigger: "subagent-complete", enabled: true, audioId: BUILTIN_AUDIO_PATH["synth-complete"], volume: 0.8, builtin: true },
			{ id: "last-subagent-done", label: "最后一个子代理运行完成", trigger: "last-subagent-complete", enabled: true, audioId: BUILTIN_AUDIO_PATH["synth-success"], volume: 0.8, builtin: true }
		];
		function defaultConfig() {
			return {
				v: 5,
				enabled: true,
				situations: deepClone(DEFAULT_SITUATIONS)
			};
		}
		function loadConfig() {
			const base = defaultConfig();
			try {
				const raw = localStorage.getItem(CONFIG_KEY);
				if (!raw) return base;
				const parsed = JSON.parse(raw);
				if (!parsed || typeof parsed !== "object") return base;
				const cfg = Object.assign(base, parsed);
				if (!Array.isArray(cfg.situations)) cfg.situations = base.situations;
				// 按 id 去重（防御性：重复的自定义项只保留第一条）
				const seen = new Set();
				cfg.situations = cfg.situations.filter((s) => {
					if (!s || typeof s.id !== "string" || seen.has(s.id)) return false;
					seen.add(s.id);
					return true;
				});
				// 确保内置情况都在（合并新增的内置情况；名称/触发以默认值为准，自动迁移改名）
				for (const def of DEFAULT_SITUATIONS) {
					const exist = cfg.situations.find((s) => s.id === def.id);
					if (!exist) {
						cfg.situations.push(deepClone(def));
					} else {
						exist.label = def.label;
						exist.trigger = def.trigger;
						exist.builtin = true;
						if (exist.audioId == null && def.audioId) exist.audioId = def.audioId; // 迁移：老配置自动补默认音效
					}
				}
				// 迁移 v2 -> v3：音量从「全局一份」改为「每条情况一份」。
				// 老配置的全局 volume 作为每条情况音量的初值，保证升级后响度不变，
				// 随后丢弃全局字段——播放时不再读任何全局音量。
				const legacyVolume = typeof cfg.volume === "number" ? clamp(cfg.volume, 0, 1) : DEFAULT_VOLUME;
				for (const s of cfg.situations) {
					s.volume = typeof s.volume === "number" ? clamp(s.volume, 0, 1) : legacyVolume;
				}
				delete cfg.volume;
				// 迁移 v3 -> v4：取消「仅当前会话响铃」，不再按会话过滤事件。
				delete cfg.onlyCurrentSession;
				// 迁移 v4 -> v5：音效身份从内置 id 改为「库内路径」（内置音效现在
				// 是包内 sounds/ 下的真实文件）。旧 id 一律换成对应路径。
				for (const s of cfg.situations) {
					if (s.audioId && BUILTIN_AUDIO_PATH[s.audioId]) s.audioId = BUILTIN_AUDIO_PATH[s.audioId];
				}
				cfg.v = base.v;
				return cfg;
			} catch (err) {
				return base;
			}
		}
		let config = loadConfig();
		function saveConfig() {
			try {
				localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
			} catch (err) {
				/* 存储失败不阻塞 */
			}
		}
		// #endregion

		// #region 音效库（宿主端提供的真实文件夹）
		let clientConnection = null;
		let libraryTree = null; // { root, children }，来自宿主端
		let libraryError = null;
		/** 已解析的音效缓存：path -> { kind, recipe | buffer }。 */
		const soundCache = new Map();

		/** 调用宿主端音效库端点。失败抛出带可读消息的 Error。 */
		function rpc(endpoint, payload) {
			const face = clientConnection && clientConnection.rpc ? clientConnection.rpc : null;
			if (!face || typeof face.call !== "function") return Promise.reject(new Error("宿主端连接不可用"));
			return face.call(RPC_CHANNEL, RPC_PREFIX + endpoint, payload || {}, undefined).then((result) => {
				if (!result || result.ok !== true) {
					const message = result && result.error && result.error.message ? result.error.message : "音效库调用失败";
					throw new Error(message);
				}
				return result.value;
			});
		}
		function libraryLoaded() {
			return !!(libraryTree && Array.isArray(libraryTree.children));
		}
		async function refreshLibrary() {
			try {
				libraryTree = await rpc("tree");
				libraryError = null;
			} catch (err) {
				libraryError = err;
			}
			emitChange();
			return libraryTree;
		}
		/** 把库树拍平成 path -> 节点，便于按路径查名字与类型。 */
		function flattenLibrary(nodes, acc) {
			const out = acc || new Map();
			for (const node of nodes || []) {
				if (node.type === "dir") flattenLibrary(node.children, out);
				else out.set(node.path, node);
			}
			return out;
		}
		function libraryIndex() {
			return flattenLibrary(libraryTree ? libraryTree.children : []);
		}
		/** 库内所有音效的扁平列表（对外 API 的 listSounds）。 */
		function listLibrarySounds() {
			const out = [];
			for (const node of libraryIndex().values()) {
				out.push({ id: node.path, name: node.name, path: node.path, kind: node.type === "synth" ? "synth" : "file", builtin: node.path.indexOf(CUSTOM_LIB + "/") !== 0 });
			}
			return out;
		}
		function base64ToArrayBuffer(base64) {
			const binary = atob(String(base64 || ""));
			const bytes = new Uint8Array(binary.length);
			for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
			return bytes.buffer;
		}
		/** 取一条音效（配方 JSON 或音频文件），带缓存。 */
		async function loadSound(path) {
			if (soundCache.has(path)) return soundCache.get(path);
			const value = await rpc("read", { path });
			const buffer = base64ToArrayBuffer(value && value.base64);
			let sound;
			if (/\.json$/i.test(path)) {
				const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
				if (!parsed || !Array.isArray(parsed.recipe)) throw new Error("配方文件格式不对: " + path);
				sound = { id: path, kind: "synth", recipe: parsed.recipe };
			} else {
				sound = { id: path, kind: "buffer", buffer: await engine.decode(buffer) };
			}
			soundCache.set(path, sound);
			return sound;
		}
		function invalidateSoundCache(path) {
			if (path) soundCache.delete(path);
			else soundCache.clear();
		}
		function isAudioName(name) {
			return /\.(mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i.test(String(name || ""));
		}
		function fileToBase64(file) {
			return new Promise((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => {
					const result = String(reader.result || "");
					const comma = result.indexOf(",");
					resolve(comma >= 0 ? result.slice(comma + 1) : result);
				};
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(file);
			});
		}
		/**
		 * 导入一批 File 到「自定义音效库」。文件夹导入会保留其相对子目录结构。
		 * @param {FileList|File[]} files - 选中的文件。
		 * @returns {Promise<string[]>} 成功导入的库内路径。
		 */
		async function importFiles(files) {
			const imported = [];
			for (const file of Array.from(files || [])) {
				if (!file || !isAudioName(file.name)) continue;
				// 文件夹选择时 webkitRelativePath 形如 "子目录/文件.mp3"：保留这层结构。
				const relative = String(file.webkitRelativePath || "");
				const parts = relative ? relative.split("/") : [];
				const subDir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
				try {
					const dataBase64 = await fileToBase64(file);
					const value = await rpc("import", { name: file.name, dataBase64, dir: subDir });
					if (value && value.path) imported.push(value.path);
				} catch (err) { /* 单个坏文件不阻塞整批 */ }
			}
			if (imported.length) {
				invalidateSoundCache();
				await refreshLibrary();
			}
			return imported;
		}
		/** 删除自定义音效库里的一个音效（内置库不可删）。 */
		async function deleteLibraryFile(path) {
			if (String(path).indexOf(CUSTOM_LIB + "/") !== 0) throw new Error("内置音效不可删除");
			await rpc("delete", { path });
			invalidateSoundCache(path);
			await refreshLibrary();
			return true;
		}
		/** 在文件管理器里打开音效库位置。 */
		function openLibrary(path) {
			return rpc("open", path ? { path } : {});
		}
		// —— 旧版 IndexedDB 导入音效的一次性迁移 ——
		function listLegacyRecords() {
			return new Promise((resolve, reject) => {
				let req;
				try { req = indexedDB.open(DB_NAME, 1); } catch (err) { reject(err); return; }
				req.onupgradeneeded = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: "id" });
				};
				req.onsuccess = () => {
					const db = req.result;
					if (!db.objectStoreNames.contains(DB_STORE)) { resolve([]); return; }
					try {
						const r = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).getAll();
						r.onsuccess = () => resolve(r.result || []);
						r.onerror = () => reject(r.error);
					} catch (err) { reject(err); }
				};
				req.onerror = () => reject(req.error);
			});
		}
		/** 把旧版存在浏览器 IndexedDB 里的导入音效搬进「自定义音效库」，只做一次。 */
		async function migrateLegacyImports() {
			if (config.legacyImportsMigrated) return;
			let records = [];
			try { records = await listLegacyRecords(); } catch (err) { return; }
			for (const rec of records) {
				try {
					const dataUrl = String(rec && rec.dataUrl ? rec.dataUrl : "");
					const comma = dataUrl.indexOf(",");
					if (comma < 0) continue;
					const value = await rpc("import", { name: rec.name || rec.id, dataBase64: dataUrl.slice(comma + 1) });
					if (value && value.path) {
						for (const s of config.situations) if (s.audioId === rec.id) s.audioId = value.path;
					}
				} catch (err) { /* 单个失败不影响其它 */ }
			}
			config.legacyImportsMigrated = true;
			emitChange();
			await refreshLibrary();
		}
		// #endregion

		// #region 音效引擎
		const engine = {
			audioCtx: null,
			master: null,
			cache: new Map(),
			active: new Map(),
			ensure() {
				if (!this.audioCtx) {
					const AC = window.AudioContext || window.webkitAudioContext;
					if (!AC) return null;
					this.audioCtx = new AC();
					this.master = this.audioCtx.createGain();
					this.master.connect(this.audioCtx.destination);
				}
				return this.audioCtx;
			},
			async resume() {
				try {
					const c = this.ensure();
					if (c && c.state === "suspended") await c.resume();
				} catch (err) {
					/* 忽略 */
				}
			},
			async play(sound, volume) {
				try {
					const c = this.ensure();
					if (!c) return;
					await this.resume();
					if (!sound) return;
					if (sound.kind === "synth" && Array.isArray(sound.recipe)) {
						// 同一个音效只保留一路发声：再次触发先掐掉上一路，
						// 否则两条情况绑同一个音效时会叠成"多重音效"。
						this.stopVoice(sound.id);
						this.playRecipe(sound.recipe, volume, sound.id);
						return;
					}
					if (!sound.buffer) return;
					const soundId = sound.id;
					this.stopVoice(soundId);
					const src = c.createBufferSource();
					src.buffer = sound.buffer;
					const g = c.createGain();
					g.gain.value = clamp(volume == null ? DEFAULT_VOLUME : volume, 0, 1);
					src.connect(g);
					g.connect(this.master);
					const voice = { stop: () => { try { src.stop(); } catch (err) { /* */ } } };
					src.onended = () => { if (this.active.get(soundId) === voice) this.active.delete(soundId); };
					src.start();
					this.active.set(soundId, voice);
				} catch (err) {
					/* 解码或播放失败静默 */
				}
			},
			/** 解码一段音频字节为 AudioBuffer（供音效库按需解码）。 */
			async decode(arrayBuffer) {
				const c = this.ensure();
				if (!c) throw new Error("AudioContext 不可用");
				return c.decodeAudioData(arrayBuffer);
			},
			playRecipe(recipe, volume, soundId) {
				const c = this.ensure();
				if (!c) return;
				const vol = clamp(volume == null ? DEFAULT_VOLUME : volume, 0, 1);
				const now = c.currentTime;
				const nodes = [];
				for (const n of recipe) {
					if (!n || !n.f) continue;
					const t0 = now + (n.t || 0) / 1000;
					const dur = (n.d || 200) / 1000;
					const osc = c.createOscillator();
					osc.type = n.w || "sine";
					osc.frequency.value = n.f;
					const g = c.createGain();
					const peak = Math.max(Math.min((n.g == null ? 0.4 : n.g) * vol, 1), 0.0001);
					g.gain.setValueAtTime(0.0001, t0);
					g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
					g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
					osc.connect(g);
					g.connect(this.master);
					osc.start(t0);
					osc.stop(t0 + dur + 0.05);
					nodes.push(osc);
				}
				if (soundId && nodes.length) {
					this.active.set(soundId, {
						stop: () => { for (const o of nodes) { try { o.stop(); } catch (err) { /* */ } } }
					});
				}
			},
			stopVoice(soundId) {
				const voice = this.active.get(soundId);
				if (!voice) return;
				this.active.delete(soundId);
				try { voice.stop(); } catch (err) { /* */ }
			},
			stopAll() {
				for (const voice of Array.from(this.active.values())) {
					try { voice.stop(); } catch (err) { /* */ }
				}
				this.active.clear();
			}
		};
		function installAutoplayResume() {
			const handler = () => { engine.resume().catch(() => { }); };
			window.addEventListener("pointerdown", handler, { once: true, passive: true });
			window.addEventListener("keydown", handler, { once: true });
		}
		// #endregion

		// #region 状态订阅
		const listeners = new Set();
		function emitChange() {
			saveConfig();
			for (const fn of Array.from(listeners)) {
				try { fn(); } catch (err) { /* */ }
			}
		}
		function subscribe(fn) {
			listeners.add(fn);
			return () => listeners.delete(fn);
		}
		// #endregion

		// #region 触发逻辑
		let sessions = null;
		// 抗重复（跨实例）：页面上只应存在一份运行时，但热更新 / 代际重挂时旧实例可能
		// 没被收掉，于是同一个事件会被多份 watcher 各放一遍。这两个 window 槽位让
		// 「已放过的 (会话, seq)」在整页范围内只算一次。
		const RUNTIME_KEY = "__dshSoundPlayerRuntime__";
		const SEEN_SEQ_KEY = "__dshSoundPlayerSeenSeq__";
		function seenSeqStore() {
			try {
				let store = window[SEEN_SEQ_KEY];
				if (!(store instanceof Map)) { store = new Map(); window[SEEN_SEQ_KEY] = store; }
				if (store.size > 500) store.clear();
				return store;
			} catch (err) {
				return null;
			}
		}
		// 返回 true = 这个 seq 还没放过（可以响），false = 已经放过（丢弃）。
		function claimEventSeq(sessionKey, seq) {
			const store = seenSeqStore();
			if (!store) return true;
			const key = String(sessionKey);
			const handled = store.get(key);
			if (typeof handled === "number" && seq <= handled) return false;
			store.set(key, seq);
			return true;
		}
		// 会话列表快照形如 { byId: { [sessionId]: row }, phase }，**没有 `current` 字段**；
		// DSH 客户端判定「当前会话」的约定是 retainedBy.mainView > 0 的那一行
		// （主视图正在保留它，见 ui-workspace 的实现）。
		function sessionListSnapshot() {
			try {
				const store = sessions && sessions.list;
				return store && typeof store.getSnapshot === "function" ? store.getSnapshot() : null;
			} catch (err) {
				return null;
			}
		}
		function retainedByMainView(row) {
			return !!(row && row.retainedBy && (row.retainedBy.mainView || 0) > 0);
		}
		function currentSessionId() {
			const st = sessionListSnapshot();
			if (!st || !st.byId) return undefined;
			for (const id of Object.keys(st.byId)) {
				if (retainedByMainView(st.byId[id])) return id;
			}
			return undefined;
		}
		// 子代理行：origin === "subagent"；父会话字段在不同版本里可能是
		// parentSessionId（Host 摘要）或 parentId，两个都认。
		function parentSessionOf(row) {
			if (!row) return undefined;
			return row.parentSessionId !== undefined ? row.parentSessionId : row.parentId;
		}
		function isSubagentRow(row) {
			return !!row && (row.origin === "subagent" || (row.origin === undefined && parentSessionOf(row) !== undefined));
		}
		// 被提问有两条信号：宿主转发的 waterfall 事件 user-questions/request，
		// 以及会话事件流里的 ask_user_question 工具调用。两条路径共用这个防抖，
		// 保证同一次提问只响一声。
		let lastQuestionPlay = 0;
		function triggerQuestionOnce() {
			const now = Date.now();
			if (now - lastQuestionPlay < 1500) return;
			lastQuestionPlay = now;
			triggerByEvent("question-requested");
		}
		function situationByTrigger(trigger) {
			if (!config.enabled) return null;
			return config.situations.find((s) => s.trigger === trigger && s.enabled) || null;
		}
		async function triggerByEvent(trigger) {
			// 不再按会话过滤：任何会话（含后台会话）的事件都照常响铃。
			const sit = situationByTrigger(trigger);
			if (!sit || !sit.audioId) return;
			await playSituation(sit.id);
		}
		async function playSituation(sitId) {
			const sit = config.situations.find((s) => s.id === sitId);
			if (!sit || !sit.enabled || !sit.audioId) return false;
			if (!config.enabled) return false;
			try {
				// 绑定的就是库内路径：按需从宿主端取一次并缓存。
				const sound = await loadSound(sit.audioId);
				// 音量只来自这条绑定自身，没有全局音量参与。
				await engine.play(sound, typeof sit.volume === "number" ? sit.volume : DEFAULT_VOLUME);
				return true;
			} catch (err) {
				return false; // 文件缺失 / 宿主端不可用：静默降级
			}
		}
		// #endregion

		// #region 事件监听（订阅当前会话的实时事件窗口，只读不干扰）
		// DSH 客户端运行时已用 `sessions` 服务（SessionController）取代旧的
		// connection.api.subscribeEnvelopes 信封流；会话事件改为在
		// `sessions.binding(id).eventSource` 的窗口里持续追加。这里订阅当前会话
		// 的 eventSource，按事件类型映射到内置触发器。
		function startSessionWatcher(sessions, connection) {
			let attachedId = null; // null = 尚未附着；会话 id 是字符串，不会与 null 冲突
			let unbindEvent = null;
			let lastSeenSeq = -1;
			let hadGeneration = false;
			let lastStopPlay = 0;
			let lastConnState;

			const mapEvent = (ev) => {
				if (!ev || typeof ev !== "object" || typeof ev.type !== "string") return;
				switch (ev.type) {
					case "turn/end":
						triggerByEvent("turn-end");
						break;
					case "user/message":
						if (ev.data && ev.data.source && ev.data.source.kind === "user") triggerByEvent("user-message");
						break;
					case "approval/asked":
						triggerByEvent("approval-requested");
						break;
					case "tool/call":
						// 被提问的底层信号（兜底）：模型调用 ask_user_question 工具。
						if (ev.data && ev.data.name === "ask_user_question") triggerQuestionOnce();
						break;
				}
			};

			// 窗口变化：replace/prepend 是历史回填，仅更新基线 seq；append 是实时事件，才触发音效。
			const scanChange = (change) => {
				if (!change) return;
				const entries = change.entries || [];
				if (change.kind === "append") {
					let max = lastSeenSeq;
					for (const e of entries) {
						const ev = e && e.event;
						if (!ev || typeof ev.seq !== "number" || ev.seq <= lastSeenSeq) continue;
						if (ev.seq > max) max = ev.seq;
						// 跨实例幂等：同一 (会话, seq) 在整页范围内只处理一次。
						if (claimEventSeq(attachedId, ev.seq)) mapEvent(ev);
					}
					lastSeenSeq = Math.max(lastSeenSeq, max);
				} else if (change.kind === "replace" || change.kind === "prepend") {
					let max = lastSeenSeq;
					for (const e of entries) {
						if (e && e.event && typeof e.event.seq === "number" && e.event.seq > max) max = e.event.seq;
					}
					lastSeenSeq = Math.max(lastSeenSeq, max);
				}
			};

			const detach = () => {
				if (unbindEvent) {
					try { unbindEvent(); } catch (err) { /* */ }
					unbindEvent = null;
				}
			};

			const attach = () => {
				const id = currentSessionId();
				// 会话没变且订阅仍然有效时不重建；上次没订阅成功（例如当时还没有
				// 实时窗口）则重试。
				if (id === attachedId && unbindEvent) return;
				detach();
				attachedId = id;
				lastSeenSeq = -1;
				if (id === undefined || !sessions || typeof sessions.binding !== "function") return;
				let binding = null;
				try { binding = sessions.binding(id); } catch (err) { return; }
				if (!binding || !binding.eventSource) return; // 未被保留的会话没有实时事件窗口
				const es = binding.eventSource;
				// 基线：订阅前先记录窗口已有的最大 seq，避免回放历史事件触发音效。
				try {
					const s = es.getSnapshot();
					if (s && s.entries) {
						let max = -1;
						for (const e of s.entries) {
							if (e && e.event && typeof e.event.seq === "number" && e.event.seq > max) max = e.event.seq;
						}
						lastSeenSeq = max;
					}
				} catch (err) { /* 忽略 */ }
				try {
					unbindEvent = es.subscribe(() => {
						let s = null;
						try { s = es.getSnapshot(); } catch (err) { return; }
						if (s && s.change) scanChange(s.change);
					});
				} catch (err) { /* 忽略 */ }
			};

			let listUnsub = null;
			try {
				if (sessions && sessions.list && typeof sessions.list.subscribe === "function") {
					listUnsub = sessions.list.subscribe(attach);
				}
			} catch (err) { /* 忽略 */ }

			// 服务终止：连接代际（generation）从有到无，或连接状态进入 disconnected，
			// 都代表链路断开。两条信号共用 5 秒防抖，避免重连抖动重复响。
			const maybeServiceStop = () => {
				const now = Date.now();
				if (now - lastStopPlay < 5000) return;
				lastStopPlay = now;
				triggerByEvent("stream-end");
			};
			let genUnsub = null;
			try {
				const gen = connection && connection.generation;
				if (gen && typeof gen.subscribe === "function") {
					hadGeneration = gen.getSnapshot() !== undefined;
					genUnsub = gen.subscribe(() => {
						const g = gen.getSnapshot();
						if (hadGeneration && g === undefined) maybeServiceStop();
						hadGeneration = g !== undefined;
					});
				}
			} catch (err) { /* 忽略 */ }
			let stateUnsub = null;
			try {
				const stateSrc = connection && connection.state;
				if (stateSrc && typeof stateSrc.subscribe === "function") {
					lastConnState = stateSrc.getSnapshot();
					stateUnsub = stateSrc.subscribe(() => {
						const s = stateSrc.getSnapshot();
						if (lastConnState === "connected" && s === "disconnected") maybeServiceStop();
						lastConnState = s;
					});
				}
			} catch (err) { /* 忽略 */ }

			attach();
			return () => {
				try { if (listUnsub) listUnsub(); } catch (err) { /* */ }
				try { if (genUnsub) genUnsub(); } catch (err) { /* */ }
				try { if (stateUnsub) stateUnsub(); } catch (err) { /* */ }
				detach();
			};
		}

		// 子代理检测：监听 sessions 列表，origin=subagent 的会话 running 状态翻转。
		// - subagent-complete：任意子代理从运行中变为完成
		// - last-subagent-complete：所有运行中的子代理全部完成（一轮"波"结束）
		// 已取消会话过滤，因此不再限定「当前会话树」：任何会话（含后台会话）的子代理
		// 都会计入并触发，切换会话也不再重置波状态。
		function startSubagentWatcher(sessions) {
			const seen = new Set(); // 上一次快照里处于运行中的子代理
			let waveRunning = false; // 当前是否存在运行中的子代理
			let unsub = null;
			try {
				const list = sessions && sessions.list;
				if (!list || typeof list.subscribe !== "function" || typeof list.getSnapshot !== "function") return null;
				unsub = list.subscribe(() => {
					const st = sessionListSnapshot();
					if (!st || !st.byId) return;
					const runningNow = [];
					for (const [id, row] of Object.entries(st.byId)) {
						if (isSubagentRow(row) && row.running) runningNow.push(id);
					}
					// 检测完成翻转（上一次在跑、这次不在跑）
					for (const id of Array.from(seen)) {
						const row = st.byId[id];
						if (row === undefined) { seen.delete(id); continue; } // 会话消失，不算完成
						if (!row.running) {
							seen.delete(id);
							triggerByEvent("subagent-complete");
						}
					}
					for (const id of runningNow) seen.add(id);
					// 波检测：从"有运行中的子代理"变为"无" → 最后一个完成
					const prevWave = waveRunning;
					waveRunning = runningNow.length > 0;
					if (prevWave && !waveRunning) triggerByEvent("last-subagent-complete");
				});
			} catch (err) {
				return null;
			}
			return () => { try { if (unsub) unsub(); } catch (err) { /* */ } };
		}
		// #endregion

		// #region soundPlayer 服务（供其他插件与 UI 使用）
		const soundPlayer = {
			// —— 导入音频（一律落进「自定义音效库」，文件夹会保留子目录结构）——
			importAudioFile(file) { return importFiles([file]).then((r) => r[0] || null); },
			importAudioFiles(files) { return importFiles(files); },
			importAudioDir(files) { return importFiles(files); },
			// —— 音效库 ——
			refreshLibrary,
			openLibrary,
			getLibraryTree() { return libraryTree; },
			listSounds() { return Promise.resolve(listLibrarySounds()); },
			listSoundsMeta() { return Promise.resolve(listLibrarySounds()); },
			/** 试听库里的某个音效（不动任何绑定）。 */
			previewSound(path) {
				return loadSound(path).then((sound) => engine.play(sound)).catch(() => false);
			},
			deleteSound: async (id) => {
				const path = String(id == null ? "" : id);
				if (path.indexOf(CUSTOM_LIB + "/") !== 0) return false; // 内置音效不可删除
				const ok = await deleteLibraryFile(path);
				if (ok) {
					config.situations.forEach((s) => { if (s.audioId === path) s.audioId = null; });
					emitChange();
				}
				return ok;
			},
			// —— 情况管理 ——
			addSituation({ id, label, trigger, audioId, enabled, volume }) {
				const sitId = id || uid("sit");
				if (config.situations.some((s) => s.id === sitId)) throw new Error("situation id already exists: " + sitId);
				config.situations.push({
					id: sitId,
					label: String(label || sitId),
					trigger: trigger || "manual",
					audioId: audioId || null,
					volume: typeof volume === "number" ? clamp(volume, 0, 1) : DEFAULT_VOLUME,
					enabled: enabled !== false,
					builtin: false
				});
				emitChange();
				return sitId;
			},
			removeSituation(id) {
				const i = config.situations.findIndex((s) => s.id === id);
				if (i >= 0 && !config.situations[i].builtin) {
					config.situations.splice(i, 1);
					emitChange();
				}
			},
			resetSituations() {
				config.situations = deepClone(DEFAULT_SITUATIONS);
				emitChange();
			},
			setSituation(id, patch) {
				const sit = config.situations.find((s) => s.id === id);
				if (!sit) return false;
				if (patch && typeof patch === "object") Object.assign(sit, patch);
				emitChange();
				return true;
			},
			setSituationEnabled(id, enabled) {
				return soundPlayer.setSituation(id, { enabled: !!enabled });
			},
			setSituationAudio(id, audioId) {
				return soundPlayer.setSituation(id, { audioId: audioId || null });
			},
			setSituationVolume(id, volume) {
				return soundPlayer.setSituation(id, { volume: clamp(Number(volume) || 0, 0, 1) });
			},
			listSituations() { return deepClone(config.situations); },
			// —— 触发 ——
			triggerSituation(id) { return playSituation(id); },
			trigger(id) { return playSituation(id); },
			// —— 全局 ——
			setEnabled(v) { config.enabled = !!v; emitChange(); },
			// 兼容旧调用：已无全局音量，改为把同一个音量批量写入所有情况。
			setVolume(v) {
				const vol = clamp(Number(v) || 0, 0, 1);
				config.situations.forEach((s) => { s.volume = vol; });
				emitChange();
			},
			getState() {
				return {
					enabled: config.enabled,
					situations: deepClone(config.situations),
					library: {
						loaded: libraryLoaded(),
						error: libraryError ? String(libraryError.message || libraryError) : null
					}
				};
			},
			subscribe,
			stopAll: () => engine.stopAll()
		};
		// #endregion

		// #region 样式
		// 颜色全部使用 DSH 主题 CSS 变量（--dsw-alias-*），跟随浅色/深色主题；括号内为兜底值
		const CSS = `
.dsp-settings { display: block; max-width: 680px; padding: 2px 4px 16px; color: var(--dsw-alias-label-primary, #e5e7eb); font-family: system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; line-height: 1.5; }
.dsp-settings * { box-sizing: border-box; }
.dsp-settings-head { display: flex; align-items: center; gap: 10px; padding: 6px 2px; font-size: 16px; font-weight: 600; }
.dsp-settings-sub { color: var(--dsw-alias-label-tertiary, #9ca3af); font-size: 12px; padding: 0 2px 12px; }
.dsp-sec { border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.09)); border-radius: 12px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.03)); margin-bottom: 12px; }
.dsp-sec-title { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, #93c5fd); margin-bottom: 8px; letter-spacing: .02em; }
.dsp-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.dsp-toggle { position: relative; width: 34px; height: 19px; flex: none; cursor: pointer; }
.dsp-toggle input { opacity: 0; width: 0; height: 0; }
.dsp-toggle .dsp-knob { position: absolute; inset: 0; border-radius: 999px; background: var(--dsw-alias-border-l3, rgba(255,255,255,.14)); transition: background .15s; }
.dsp-toggle .dsp-knob::after { content: ""; position: absolute; left: 2px; top: 2px; width: 15px; height: 15px; border-radius: 50%; background: var(--dsw-alias-label-primary, #e5e7eb); transition: transform .15s; }
.dsp-toggle input:checked + .dsp-knob { background: var(--dsw-alias-state-business-primary, #3b82f6); }
.dsp-toggle input:checked + .dsp-knob::after { transform: translateX(15px); }
.dsp-label { flex: 1; min-width: 0; }
.dsp-muted { color: var(--dsw-alias-label-tertiary, #9ca3af); font-size: 12px; }
.dsp-sit-block { padding: 6px 0; border-bottom: 1px dashed var(--dsw-alias-border-l2, rgba(255,255,255,.07)); }
.dsp-sit-block:last-child { border-bottom: none; }
.dsp-sit-row { display: flex; align-items: center; gap: 8px; }
.dsp-vol-row { display: flex; align-items: center; gap: 8px; padding: 3px 0 0 42px; }
.dsp-vol-row .dsp-range { max-width: 220px; }
.dsp-sit-label { flex: 1; min-width: 0; line-height: 1.3; }
.dsp-sit-label .dsp-sit-name { display: block; }
.dsp-sit-label .dsp-sit-trigger { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.dsp-select { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.08)); color: var(--dsw-alias-label-primary, #e5e7eb); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); border-radius: 8px; padding: 4px 6px; font-size: 12px; max-width: 130px; }
.dsp-btn { border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14)); background: var(--dsw-alias-bg-layer-2, rgba(255,255,255,.07)); color: var(--dsw-alias-label-primary, #e5e7eb); border-radius: 8px; padding: 5px 10px; cursor: pointer; font-size: 12px; white-space: nowrap; }
.dsp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.14)); }
.dsp-btn.dsp-primary { background: var(--dsw-alias-state-business-primary, #3b82f6); border-color: var(--dsw-alias-state-business-primary, #3b82f6); color: var(--dsw-alias-label-primary-inverted, #fff); }
.dsp-btn.dsp-primary:hover { background: var(--dsw-alias-state-business-primary-strong, #2563eb); }
.dsp-btn.dsp-danger { color: var(--dsw-alias-state-error-primary, #fca5a5); }
.dsp-btn:disabled { opacity: .45; cursor: not-allowed; }
.dsp-input { background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.07)); border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.12)); border-radius: 8px; color: var(--dsw-alias-label-primary, #e5e7eb); padding: 5px 8px; font-size: 12px; }
.dsp-input:focus { outline: 1px solid var(--dsw-alias-state-business-primary, #3b82f6); }
.dsp-range { flex: 1; accent-color: var(--dsw-alias-state-business-primary, #3b82f6); }
.dsp-drop { border: 1.5px dashed var(--dsw-alias-border-l3, rgba(255,255,255,.22)); border-radius: 10px; padding: 14px; text-align: center; color: var(--dsw-alias-label-tertiary, #9ca3af); font-size: 12px; cursor: pointer; transition: border-color .15s, background .15s; }
.dsp-drop.dsp-over { border-color: var(--dsw-alias-state-business-primary, #3b82f6); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #3b82f6) 10%, transparent); color: var(--dsw-alias-label-secondary, #dbeafe); }
.dsp-snd-row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
.dsp-snd-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsp-hint { color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 11px; line-height: 1.5; }
.dsp-scroll { max-height: 180px; overflow-y: auto; }
.dsp-divider { height: 1px; background: var(--dsw-alias-border-l2, rgba(255,255,255,.08)); margin: 4px 0; }
/* —— 级联音效选择器 —— */
.dsp-picker { position: relative; flex: none; }
.dsp-picker-btn { min-width: 132px; max-width: 176px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.dsp-picker-btn .dsp-caret { opacity: .6; margin-left: 4px; }
.dsp-menu { position: fixed; z-index: 60; min-width: 172px; max-height: 340px; overflow-y: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l2, rgba(255,255,255,.14)); border-radius: 10px; background: var(--dsw-alias-bg-layer-3, #1f2430); box-shadow: 0 8px 26px rgba(0,0,0,.38); }
.dsp-menu-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border-radius: 7px; cursor: pointer; font-size: 12px; color: var(--dsw-alias-label-primary, #e5e7eb); white-space: nowrap; }
.dsp-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.12)); }
.dsp-menu-item .dsp-menu-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsp-menu-item .dsp-menu-arrow { opacity: .55; font-size: 11px; }
.dsp-menu-item .dsp-menu-check { opacity: .9; font-size: 11px; color: var(--dsw-alias-state-business-primary, #60a5fa); }
.dsp-menu-item .dsp-menu-del { opacity: 0; font-size: 11px; color: var(--dsw-alias-state-error-primary, #fca5a5); padding: 0 2px; }
.dsp-menu-item:hover .dsp-menu-del { opacity: .85; }
.dsp-menu-empty { padding: 6px 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
`;
		function ensureStyle() {
			if (document.getElementById("dsh-sound-player-style")) return;
			const el = document.createElement("style");
			el.id = "dsh-sound-player-style";
			el.textContent = CSS;
			document.head.appendChild(el);
		}
		// #endregion

		// #region React UI
		const h = React.createElement;

		/**
		 * 级联音效选择器：顶层是三个库，鼠标悬停（或点击）文件夹即在右侧展开其内容，
		 * 子文件夹继续向右展开，支持任意层级。叶子是音效，点击即绑定。
		 */
		function SoundPicker({ value, tree, disabled, onPick, onDelete, onTest }) {
			const [open, setOpen] = React.useState(false);
			const [levels, setLevels] = React.useState([]); // [{ nodes, left, top }]
			const wrapRef = React.useRef(null);
			const rowRects = React.useRef(new Map());

			// 打开时用按钮的位置算出第一级面板锚点；滚动或尺寸变化就收起，避免面板飘走。
			const openMenu = () => {
				if (disabled) return;
				const rect = wrapRef.current ? wrapRef.current.getBoundingClientRect() : null;
				if (!rect) return;
				setLevels([{ nodes: (tree && tree.children) || [], left: rect.left, top: rect.bottom + 4 }]);
				setOpen(true);
			};
			const closeMenu = () => { setOpen(false); setLevels([]); };

			React.useEffect(() => {
				if (!open) return undefined;
				const onDown = (e) => {
					if (!wrapRef.current || !wrapRef.current.contains(e.target)) closeMenu();
				};
				const onKey = (e) => { if (e.key === "Escape") closeMenu(); };
				const onMove = () => closeMenu();
				document.addEventListener("pointerdown", onDown, true);
				document.addEventListener("keydown", onKey);
				window.addEventListener("scroll", onMove, true);
				window.addEventListener("resize", onMove);
				return () => {
					document.removeEventListener("pointerdown", onDown, true);
					document.removeEventListener("keydown", onKey);
					window.removeEventListener("scroll", onMove, true);
					window.removeEventListener("resize", onMove);
				};
			}, [open]);

			/** 展开第 level 级里某个目录：裁掉更深层级，再挂上新面板。 */
			const expandDir = (level, node) => {
				const rect = rowRects.current.get(node.path);
				if (!rect) return;
				setLevels((prev) => prev.slice(0, level + 1).concat([{
					nodes: node.children || [],
					left: Math.round(rect.right + 2),
					top: Math.round(rect.top)
				}]));
			};
			const collapseDeeper = (level) => setLevels((prev) => prev.slice(0, level + 1));

			const renderRow = (level, node) => {
				const isDir = node.type === "dir";
				const picked = !isDir && node.path === value;
				return h("div", {
					key: node.path,
					className: "dsp-menu-item",
					title: node.path,
					ref: (el) => {
						if (el) rowRects.current.set(node.path, el.getBoundingClientRect());
						else rowRects.current.delete(node.path);
					},
					onMouseEnter: () => { if (isDir) expandDir(level, node); else { collapseDeeper(level); if (typeof onTest === "function") onTest(node.path); } },
					onClick: () => {
						if (isDir) { expandDir(level, node); return; }
						onPick(node.path);
						closeMenu();
					}
				},
					h("span", { className: "dsp-menu-name" }, node.name),
					picked ? h("span", { className: "dsp-menu-check" }, "✓") : null,
					isDir ? h("span", { className: "dsp-menu-arrow" }, "›") : null,
					!isDir && typeof onDelete === "function" && node.path.indexOf(CUSTOM_LIB + "/") === 0
						? h("span", {
							className: "dsp-menu-del",
							title: "从自定义音效库删除",
							onClick: (e) => { e.stopPropagation(); onDelete(node.path); }
						}, "✕")
						: null
				);
			};

			const label = value ? shortName(value) : "（无）";
			const parentHint = value && value.indexOf("/") >= 0 ? value.split("/").slice(0, -1).join("/") : "";
			return h("div", { className: "dsp-picker", ref: wrapRef },
				h("button", {
					className: "dsp-btn dsp-picker-btn",
					disabled: !!disabled,
					title: value ? value : "未绑定音效",
					onClick: () => (open ? closeMenu() : openMenu())
				}, label, h("span", { className: "dsp-caret" }, "▾")),
				!open ? null : h("div", { className: "dsp-menu", style: { left: levels[0] ? levels[0].left : 0, top: levels[0] ? levels[0].top : 0 } },
					!levels.length || !levels[0].nodes.length
						? h("div", { className: "dsp-menu-empty" }, "音效库为空")
						: levels[0].nodes.map((n) => renderRow(0, n))
				),
				!open ? null : levels.slice(1).map((level, index) => h("div", {
					key: "lvl-" + (index + 1),
					className: "dsp-menu",
					style: { left: level.left, top: level.top }
				},
					level.nodes.length ? level.nodes.map((n) => renderRow(index + 1, n)) : h("div", { className: "dsp-menu-empty" }, "（空文件夹）")
				)),
				parentHint ? h("span", { className: "dsp-hint", style: { marginLeft: 6 } }, parentHint) : null
			);
		}

		function SituationRow({ sit, tree, onChange, onRemove, onTest, onVolume, onPreview, onDeleteSound }) {
			const vol = typeof sit.volume === "number" ? sit.volume : DEFAULT_VOLUME;
			return h("div", { className: "dsp-sit-block" },
				h("div", { className: "dsp-sit-row" },
					h("label", { className: "dsp-toggle", title: sit.enabled ? "已启用" : "已停用" },
						h("input", {
							type: "checkbox",
							checked: !!sit.enabled,
							onChange: (e) => onChange({ enabled: e.target.checked })
						}),
						h("span", { className: "dsp-knob" })
					),
					h("div", { className: "dsp-sit-label" },
						h("span", { className: "dsp-sit-name" }, (sit.enabled ? "【√】" : "【 】") + sit.label + (sit.builtin ? "" : "（自定义）")),
						h("span", { className: "dsp-sit-trigger" }, "触发：" + (TRIGGER_LABELS[sit.trigger] || sit.trigger))
					),
					h(SoundPicker, {
						value: sit.audioId || "",
						tree,
						onPick: (path) => onChange({ audioId: path || null }),
						onTest: onPreview,
						onDelete: onDeleteSound
					}),
					h("button", { className: "dsp-btn", disabled: !sit.audioId, onClick: onTest }, "听"),
					!sit.builtin ? h("button", { className: "dsp-btn dsp-danger", onClick: onRemove }, "删") : null
				),
				// 每条绑定自己的音量，互不影响；没有绑定音效时无意义，置灰。
				h("div", { className: "dsp-vol-row" },
					h("span", { className: "dsp-muted", style: { flex: "none" } }, "音量"),
					h("input", {
						className: "dsp-range",
						type: "range",
						min: 0,
						max: 1,
						step: 0.05,
						value: vol,
						disabled: !sit.audioId,
						title: "这条情况单独的音量",
						onChange: (e) => onVolume(Number(e.target.value))
					}),
					h("span", { className: "dsp-muted", style: { width: 36, textAlign: "right" } }, Math.round(vol * 100) + "%")
				)
			);
		}

		function App({ board }) {
			const [state, setState] = React.useState(() => board.getState());
			const [adding, setAdding] = React.useState(false);
			const [newLabel, setNewLabel] = React.useState("");
			const [newTrigger, setNewTrigger] = React.useState("manual");
			const [dropOver, setDropOver] = React.useState(false);
			const [tree, setTree] = React.useState(() => board.getLibraryTree());
			const [importing, setImporting] = React.useState(false);
			const fileRef = React.useRef(null);
			const dirRef = React.useRef(null);

			React.useEffect(() => board.subscribe(() => {
				setState(board.getState());
				setTree(board.getLibraryTree());
			}), [board]);

			/** 导入一批文件（文件夹导入保留子目录），完成后刷新库树。 */
			const doImport = (files) => {
				const list = Array.from(files || []);
				if (!list.length) return;
				setImporting(true);
				board.importAudioFiles(list)
					.then(() => setTree(board.getLibraryTree()))
					.catch(() => { /* 单条失败已在内部跳过 */ })
					.then(() => setImporting(false));
			};

			const addSituation = () => {
				const label = newLabel.trim();
				if (!label) return;
				try {
					board.addSituation({ label, trigger: newTrigger });
				} catch (err) {
					alert(err.message);
					return;
				}
				setNewLabel("");
				setNewTrigger("manual");
				setAdding(false);
			};

			return h("div", { className: "dsp-settings" },
				h("div", { className: "dsp-settings-head" }, "🎵 音效播放器"),
				h("div", { className: "dsp-settings-sub" }, "在对话各阶段播放提示音（对话完成、权限请求、子代理完成等）。所有操作都在此设置页完成。"),
				h("div", { className: "dsp-sec" },
					h("div", { className: "dsp-sec-title" }, "总开关"),
					h("div", { className: "dsp-row" },
						h("label", { className: "dsp-toggle" },
							h("input", { type: "checkbox", checked: !!state.enabled, onChange: (e) => board.setEnabled(e.target.checked) }),
							h("span", { className: "dsp-knob" })
						),
						h("span", { className: "dsp-label" }, "启用音效播放器"),
						h("button", { className: "dsp-btn", onClick: () => board.stopAll() }, "停止")
					)
				),
				h("div", { className: "dsp-sec" },
					h("div", { className: "dsp-sec-title" }, "情况与音效绑定"),
					h("div", { className: "dsp-scroll" },
						state.situations.map((sit) => h(SituationRow, {
							key: sit.id,
							sit,
							tree,
							onChange: (patch) => board.setSituation(sit.id, patch),
							onRemove: () => board.removeSituation(sit.id),
							onTest: () => board.triggerSituation(sit.id),
							onVolume: (v) => board.setSituationVolume(sit.id, v),
							onPreview: (path) => board.previewSound(path),
							onDeleteSound: (path) => board.deleteSound(path).then(() => setTree(board.getLibraryTree())).catch(() => { /* 忽略 */ })
						}))
					),
					h("div", { className: "dsp-row", style: { marginTop: 8 } },
						!adding
							? h("button", { className: "dsp-btn dsp-primary", onClick: () => setAdding(true) }, "＋ 增添情况检测项")
							: null,
						h("button", {
							className: "dsp-btn",
							title: "恢复为内置的 7 种默认情况（保留已导入音效）",
							onClick: () => { if (confirm("恢复默认情况？自定义情况将被移除（已导入的音效保留）。")) board.resetSituations(); }
						}, "恢复默认")
					),
					adding
						? h("div", { className: "dsp-sec", style: { marginTop: 4 } },
							h("div", { className: "dsp-row" },
								h("input", { className: "dsp-input", style: { flex: 1 }, placeholder: "情况名称（如：任务完成）", value: newLabel, onChange: (e) => setNewLabel(e.target.value) })
							),
							h("div", { className: "dsp-row" },
								h("span", { className: "dsp-label dsp-muted", style: { flex: "none" } }, "触发方式"),
								h("select", { className: "dsp-select", value: newTrigger, onChange: (e) => setNewTrigger(e.target.value) },
									Object.keys(TRIGGER_LABELS).map((k) => h("option", { key: k, value: k }, TRIGGER_LABELS[k]))
								)
							),
							h("div", { className: "dsp-row" },
								h("button", { className: "dsp-btn dsp-primary", onClick: addSituation }, "保存"),
								h("button", { className: "dsp-btn", onClick: () => setAdding(false) }, "取消")
							)
						)
						: null
				),
				h("div", { className: "dsp-sec" },
					h("div", { className: "dsp-sec-title" }, "导入音效（写入「自定义音效库」）"),
					h("div", { className: "dsp-row" },
						h("button", { className: "dsp-btn", disabled: importing, onClick: () => fileRef.current && fileRef.current.click() }, importing ? "导入中…" : "导入音效"),
						h("button", { className: "dsp-btn", disabled: importing, onClick: () => dirRef.current && dirRef.current.click() }, "导入文件夹"),
						h("button", {
							className: "dsp-btn",
							title: "在文件管理器里打开音效库目录，可直接编辑 / 新增子文件夹",
							onClick: () => board.openLibrary()
						}, "打开音效库")
					),
					h("input", {
						ref: fileRef,
						type: "file",
						accept: "audio/*",
						multiple: true,
						style: { display: "none" },
						onChange: (e) => {
							const files = Array.from(e.target.files || []);
							e.target.value = "";
							doImport(files);
						}
					}),
					h("input", {
						ref: dirRef,
						type: "file",
						webkitdirectory: "",
						multiple: true,
						style: { display: "none" },
						onChange: (e) => {
							const files = Array.from(e.target.files || []);
							e.target.value = "";
							doImport(files);
						}
					}),
					h("div", {
						className: "dsp-drop" + (dropOver ? " dsp-over" : ""),
						onClick: () => fileRef.current && fileRef.current.click(),
						onDragOver: (e) => { e.preventDefault(); setDropOver(true); },
						onDragLeave: () => setDropOver(false),
						onDrop: (e) => {
							e.preventDefault();
							setDropOver(false);
							doImport(e.dataTransfer.files);
						}
					}, "把音频文件拖到这里，或点击选择"),
					state.library && state.library.error
						? h("div", { className: "dsp-hint", style: { color: "var(--dsw-alias-state-error-primary, #fca5a5)" } }, "音效库不可用：" + state.library.error)
						: h("div", { className: "dsp-hint" },
							"音效不在此处列出——在每条绑定的下拉菜单里按文件夹浏览（默认音效库 / 神人音效库 / 自定义音效库）。导入的文件会落到自定义音效库，可用「打开音效库」直接编辑或往里加子文件夹。"
						)
				),
				h("div", { className: "dsp-sec" },
					h("div", { className: "dsp-sec-title" }, "插件 API（供其他插件调用）"),
					h("div", { className: "dsp-hint" },
						"其他插件可注入本插件（inject 加 \"dsh-sound-player\"）后通过 ctx.get(\"soundPlayer\") 调用：importAudioFile(file) / importAudioFiles(files) / importAudioDir(files) / addSituation({label, trigger}) / triggerSituation(id) / setSituation(id, patch) / setSituationVolume(id, v) / listSounds() / refreshLibrary() / openLibrary() 等；也可直接使用 window.__dshSoundPlayer__。"
					),
					h("div", { className: "dsp-hint" }, "提示：桌面端渲染进程沿用 Chromium 自动播放策略，需要界面有过一次鼠标/键盘交互后音效才会出声。")
				)
			);
		}

		function registerSettings(ctx) {
			ensureStyle();
			// 注册到 DSH 设置菜单：设置 → 音效播放器
			const dispose = ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "sound-player",
				order: 30,
				label: () => "音效播放器",
				inject: () => ({ board: soundPlayer })
			}, App));
			return () => { try { dispose(); } catch (err) { /* */ } };
		}
		// #endregion

		// #region apply
		/**
		 * 客户端插件入口。
		 * @param {import('@deepseek-ai/cordis').Context} ctx - 客户端 cordis 根上下文。
		 */
		function apply(ctx) {
			// 单实例：本插件被重新挂载（热更新 / 连接代际重挂）时，先把上一份运行时
			// 收干净。否则旧 watcher 仍订阅着事件窗口，同一个事件会被播放多次。
			try {
				const prev = window[RUNTIME_KEY];
				if (prev && typeof prev.dispose === "function") prev.dispose();
			} catch (err) { /* 忽略 */ }
			sessions = ctx && ctx.sessions ? ctx.sessions : null;
			ctx.provide("soundPlayer", soundPlayer);
			try {
				window.__dshSoundPlayer__ = soundPlayer;
			} catch (err) { /* 非浏览器环境忽略 */ }
			installAutoplayResume();
			let connection = null;
			try {
				connection = ctx.get("connection");
			} catch (err) {
				connection = null;
			}
			// 音效库走宿主端 RPC：先记下连接面，再拉一次目录树。
			clientConnection = connection || null;
			refreshLibrary().then(() => migrateLegacyImports()).catch(() => { /* 库里没有也行 */ });
			let disposeWatchers = null;
			try {
				disposeWatchers = startSessionWatcher(sessions, connection);
			} catch (err) {
				console.warn("[dsh-sound-player] 事件监听启动失败", err);
			}
			let disposeSubagent = null;
			try {
				disposeSubagent = startSubagentWatcher(sessions);
			} catch (err) {
				console.warn("[dsh-sound-player] 子代理监听启动失败", err);
			}
			// 被提问：user-questions/request 是宿主转发的 waterfall 事件，插件只旁听，
			// 必须把请求交还给真正的应答者（return next()），否则会截断提问链路。
			let disposeQuestions = null;
			try {
				const remote = ctx.remote;
				if (remote && typeof remote.$on === "function") {
					disposeQuestions = remote.$on("user-questions/request", (request, next) => {
						triggerQuestionOnce();
						return typeof next === "function" ? next() : undefined;
					});
				}
			} catch (err) {
				console.warn("[dsh-sound-player] 提问监听启动失败", err);
			}
			let disposeSettings = null;
			try {
				disposeSettings = registerSettings(ctx);
			} catch (err) {
				console.warn("[dsh-sound-player] 设置页注册失败", err);
			}
			const dispose = () => {
				try { if (disposeWatchers) disposeWatchers(); } catch (err) { /* */ }
				try { if (disposeSubagent) disposeSubagent(); } catch (err) { /* */ }
				try { if (typeof disposeQuestions === "function") disposeQuestions(); } catch (err) { /* */ }
				try { if (disposeSettings) disposeSettings(); } catch (err) { /* */ }
				try { engine.stopAll(); } catch (err) { /* */ }
				try { if (window[RUNTIME_KEY] === runtime) delete window[RUNTIME_KEY]; } catch (err) { /* */ }
			};
			const runtime = { dispose };
			try { window[RUNTIME_KEY] = runtime; } catch (err) { /* */ }
			try {
				ctx.on("dispose", dispose);
			} catch (err) {
				window.addEventListener("pagehide", dispose, { once: true });
			}
		}
		// #endregion

		exports.inject = ["connection", "sessions", "slots"];
		exports.apply = apply;
		return module.exports;
	}
});
