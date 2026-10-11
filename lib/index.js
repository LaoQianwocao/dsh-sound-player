// dsh-sound-player 宿主端（node half）。
//
// 职责：音效库的落地实现。三个音效库都是插件包内的真实文件夹（sounds/），
// 随包分发、可被用户直接用文件管理器编辑：
//
//   sounds/默认音效库/合成音效/*.json          内置合成音效（Web Audio 配方）
//   sounds/默认音效库/Windows 系统提示音/*.wav  内置 Windows 提示音
//   sounds/神人音效库/**                       内置 meme / 游戏音效
//   sounds/自定义音效库/**                     使用者导入的音效
//
// 端点挂载方式（重要，踩过坑）：
// 用 `ctx.connection.fetch.register({ path: "/api/soundPlayer/<name>", methods: ["POST"], … })`
// 注册**精确 Fetch 路由**。共享通道的分发顺序是「精确路由 → 该通道唯一的拦截器 → 404」，
// 而 `ctx.connection.rpc.intercept("/api", …)` 是**单槽位**且已存在时直接抛错：
// 一旦本插件抢到那个槽位，网关自己的 /api 分发就会被顶掉，所有生成式 Remote
// （含桌面端启动时的 welcome settings 读取）都会 404 —— 足以让应用开不起来。
// 精确路由是附加式、优先级更高、不占用拦截器槽位，因此它才是插件暴露端点的正确方式。
//
// 端点（路径 = /api/soundPlayer/<name>，方法固定 POST）：
//   tree   { }                        -> 目录树
//   read   { path }                   -> { path, base64 }
//   import { name, dataBase64, dir? } -> { path }
//   delete { path }                   -> { deleted }（仅自定义音效库）
//   open   { path? }                  -> { opened }
//   status { }                        -> { libRoot, counts, recorded }
//
// 请求/响应与生成式 Remote 完全同形，客户端直接用 connection.rpc.call 即可：
//   请求  { type: "client-request", rpcId, method: "soundPlayer/tree", payload }
//   响应  { type: "server-response", rpcId, result: { ok: true, value } }
// 音频字节以 base64 放在 value 里：客户端一元 RPC 的结果类型只声明了 { ok, value }，
// 没有暴露 attachments，所以不依赖附件通道。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// 必须声明依赖：否则 apply 可能在 connection 服务注册之前就跑，
// ctx.get("connection") 拿到 undefined，端点一个都注册不上（实测踩过）。
const inject = ["connection"];

/** 音效库根目录 = 插件包内的 sounds/。 */
const LIB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "sounds");
const DEFAULT_LIB = "默认音效库";
const CUSTOM_LIB = "自定义音效库";
const ENDPOINT_PREFIX = "soundPlayer/";
/** 单次导入与单次读取的大小上限，避免把超大文件塞进 JSON 字符串。 */
const MAX_BYTES = 32 * 1024 * 1024;

const AUDIO_EXT = new Set([".mp3", ".wav", ".ogg", ".oga", ".m4a", ".aac", ".flac", ".webm", ".opus"]);
const RECIPE_EXT = ".json";

/**
 * 把库内相对路径解析为绝对路径，并确保它没有逃出库根目录。
 * @param {string} relative - 相对库根的路径（可含子目录）。
 * @returns {string} 绝对路径。
 */
function resolveInside(relative) {
	const cleaned = String(relative == null ? "" : relative).replace(/\\/g, "/").replace(/^\/+/, "");
	const abs = path.resolve(LIB_ROOT, cleaned);
	if (abs !== LIB_ROOT && !abs.startsWith(LIB_ROOT + path.sep)) {
		throw new Error("路径超出音效库范围: " + relative);
	}
	return abs;
}

/** 相对库根、以 `/` 分隔的显示路径。 */
function toRelative(abs) {
	return path.relative(LIB_ROOT, abs).split(path.sep).join("/");
}

/** 去掉扩展名的显示名。 */
function stem(name) {
	const ext = path.extname(name);
	return ext ? name.slice(0, name.length - ext.length) : name;
}

/** 中文优先的排序：文件夹在前，各自按名称。 */
function sortEntries(a, b) {
	if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
	return a.name.localeCompare(b.name, "zh-Hans-CN");
}

/**
 * 递归读取一个目录。
 * @param {string} absDir - 绝对目录。
 * @returns {Array<object>} 目录项列表。
 */
function readDir(absDir) {
	let dirents;
	try {
		dirents = fs.readdirSync(absDir, { withFileTypes: true });
	} catch (err) {
		return [];
	}
	const out = [];
	for (const dirent of dirents) {
		const name = dirent.name;
		if (name.startsWith(".")) continue; // .gitkeep / 隐藏文件不进菜单
		const abs = path.join(absDir, name);
		if (dirent.isDirectory()) {
			out.push({ type: "dir", name, path: toRelative(abs), children: readDir(abs) });
			continue;
		}
		const ext = path.extname(name).toLowerCase();
		if (ext === RECIPE_EXT) {
			out.push({ type: "synth", name: stem(name), path: toRelative(abs) });
		} else if (AUDIO_EXT.has(ext)) {
			let size = 0;
			try { size = fs.statSync(abs).size; } catch (err) { /* 忽略 */ }
			out.push({ type: "audio", name: stem(name), path: toRelative(abs), size });
		}
	}
	return out.sort(sortEntries);
}

/** 三个库的整体目录树（缺库时补建空目录，便于客户端稳定渲染）。 */
function readTree() {
	for (const required of [DEFAULT_LIB, CUSTOM_LIB]) {
		const abs = path.join(LIB_ROOT, required);
		if (!fs.existsSync(abs)) {
			try { fs.mkdirSync(abs, { recursive: true }); } catch (err) { /* 忽略 */ }
		}
	}
	const top = [];
	for (const dirent of fs.existsSync(LIB_ROOT) ? fs.readdirSync(LIB_ROOT, { withFileTypes: true }) : []) {
		if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
		const abs = path.join(LIB_ROOT, dirent.name);
		top.push({ type: "dir", name: dirent.name, path: toRelative(abs), children: readDir(abs) });
	}
	return { root: "音效库", children: top.sort(sortEntries) };
}

/** 递归统计一个节点下的文件数（用于状态回报）。 */
function countFiles(node) {
	if (!node) return 0;
	if (node.type !== "dir") return 1;
	let total = 0;
	for (const child of node.children || []) total += countFiles(child);
	return total;
}

/** 目标路径若已存在，追加 -2 / -3 … */
function uniqueTarget(abs) {
	if (!fs.existsSync(abs)) return abs;
	const dir = path.dirname(abs);
	const ext = path.extname(abs);
	const base = path.basename(abs, ext);
	for (let i = 2; i < 1000; i += 1) {
		const candidate = path.join(dir, `${base}-${i}${ext}`);
		if (!fs.existsSync(candidate)) return candidate;
	}
	return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/** 文件名净化：只保留基名，剔除路径分隔与控制字符。 */
function safeFileName(name) {
	const base = path.basename(String(name == null ? "" : name).replace(/\\/g, "/"));
	return base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim() || `sound-${Date.now()}.mp3`;
}

/** 子目录净化：允许 a/b 形式，逐段过滤，禁止 .. 与隐藏段。 */
function safeSubDir(dir) {
	return String(dir == null ? "" : dir)
		.replace(/\\/g, "/")
		.split("/")
		.map((seg) => seg.trim())
		.filter((seg) => seg && seg !== "." && seg !== ".." && !seg.startsWith("."))
		.join("/");
}

/** 打开库位置：Windows 资源管理器 / macOS Finder / Linux xdg-open。 */
function openInFileManager(target) {
	const platform = process.platform;
	const [cmd, args] = platform === "win32"
		? ["explorer.exe", [target]]
		: platform === "darwin"
			? ["open", [target]]
			: ["xdg-open", [target]];
	const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
	child.on("error", () => { /* 打不开就算了，不阻塞调用方 */ });
	child.unref();
	return target;
}

/**
 * 处理一个 `soundPlayer/` 端点。
 * @param {string} endpoint - 完整端点名。
 * @param {unknown} payload - 客户端载荷。
 * @returns {Promise<object>} ConnectionRpcHandlerResult。
 */
async function handle(endpoint, payload) {
	const body = payload && typeof payload === "object" ? payload : {};
	try {
		switch (endpoint) {
			case "tree":
				return { ok: true, value: readTree() };

			case "read": {
				const abs = resolveInside(body.path);
				const stat = fs.statSync(abs);
				if (!stat.isFile()) throw new Error("不是文件: " + body.path);
				if (stat.size > MAX_BYTES) throw new Error("音效文件过大: " + stat.size + " 字节");
				const bytes = fs.readFileSync(abs);
				return { ok: true, value: { path: toRelative(abs), base64: bytes.toString("base64") } };
			}

			case "delete": {
				// 只允许删「自定义音效库」里的文件，内置两库保持只读。
				const abs = resolveInside(body.path);
				const customAbs = path.join(LIB_ROOT, CUSTOM_LIB);
				if (abs !== customAbs && !abs.startsWith(customAbs + path.sep)) {
					throw new Error("只能删除自定义音效库里的音效");
				}
				const stat = fs.statSync(abs);
				if (!stat.isFile()) throw new Error("不是文件: " + body.path);
				fs.unlinkSync(abs);
				return { ok: true, value: { deleted: toRelative(abs) } };
			}

			case "import": {
				// 导入一律落进「自定义音效库」，可带一层或多层子目录。
				const sub = safeSubDir(body.dir);
				const dirAbs = resolveInside(sub ? CUSTOM_LIB + "/" + sub : CUSTOM_LIB);
				fs.mkdirSync(dirAbs, { recursive: true });
				const bytes = Buffer.from(String(body.dataBase64 == null ? "" : body.dataBase64), "base64");
				if (!bytes.length) throw new Error("导入内容为空");
				if (bytes.length > MAX_BYTES) throw new Error("音效文件过大: " + bytes.length + " 字节");
				const target = uniqueTarget(path.join(dirAbs, safeFileName(body.name)));
				fs.writeFileSync(target, bytes);
				return { ok: true, value: { path: toRelative(target) } };
			}

			case "open": {
				const requested = body.path ? resolveInside(body.path) : LIB_ROOT;
				const target = fs.existsSync(requested) ? requested : LIB_ROOT;
				return { ok: true, value: { opened: openInFileManager(target) } };
			}

			case "status": {
				// 自报状态：库根目录、各库条目数、上次 apply 的注册结果。
				// 排查「库为空」时，这里能直接区分「宿主半段没重载」与「读错目录」。
				let recorded = null;
				try {
					recorded = JSON.parse(fs.readFileSync(path.join(LIB_ROOT, ".host-status.json"), "utf8"));
				} catch (err) {
					recorded = null;
				}
				const tree = readTree();
				const counts = {};
				for (const lib of tree.children) counts[lib.name] = countFiles(lib);
				return { ok: true, value: { libRoot: LIB_ROOT, counts, recorded, now: new Date().toISOString() } };
			}

			default:
				return {
					ok: false,
					error: { code: "soundPlayer/unknown-endpoint", message: "未知端点: " + endpoint, details: {} },
				};
		}
	} catch (err) {
		return {
			ok: false,
			error: {
				code: "soundPlayer/failed",
				message: err && err.message ? err.message : String(err),
				details: {},
			},
		};
	}
}

/** 浏览器端把 rpc.call(channel, endpoint) 拼成 HTTP 路径 POST，只有 /api 是挂载着的。 */
const RPC_CHANNEL = "/api";
/** 还没拿到 connection 服务时的重试节奏（服务可能稍后才注册）。 */
const RETRY_INTERVAL_MS = 500;
const MAX_ATTEMPTS = 60;

/** 描述一个服务实例暴露了什么，用于排查。 */
function describeService(service) {
	if (!service) return null;
	try {
		const own = Object.keys(service).slice(0, 24);
		const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(service) || {}).slice(0, 32);
		return { own, proto };
	} catch (err) {
		return { error: err && err.message ? err.message : String(err) };
	}
}

/** 所有端点（短名）；路径为 /api/soundPlayer/<name>。 */
const ENDPOINTS = ["tree", "read", "import", "delete", "open", "status"];

/**
 * 把一批端点包成一条连接的精确 Fetch 路由处理器。
 * 请求/响应与生成式 Remote 同形，因此客户端 connection.rpc.call 可直接用。
 * @param {string} name - 端点短名。
 * @returns {(request: Request) => Promise<Response>} Fetch 处理器。
 */
function makeRoute(name) {
	return async (request) => {
		const endpoint = ENDPOINT_PREFIX + name;
		if (request.method !== "POST") return new Response("not found", { status: 404 });
		const contentType = request.headers.get("content-type") || "";
		if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
			return new Response("content type must be application/json", { status: 415 });
		}
		let body = null;
		try {
			body = await request.json();
		} catch (err) {
			return new Response("body is not JSON", { status: 400 });
		}
		const rpcId = body && typeof body.rpcId === "string" ? body.rpcId : "";
		if (body && body.method !== undefined && body.method !== endpoint) {
			return Response.json({
				type: "server-response",
				rpcId,
				result: {
					ok: false,
					error: {
						code: "gateway/bad-request",
						message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
						details: { issues: [] },
					},
				},
			});
		}
		const result = await handle(name, body ? body.payload : undefined);
		return Response.json({ type: "server-response", rpcId, result });
	};
}

/**
 * 宿主端 apply。把音效库端点注册为 `/api/soundPlayer/<name>` 的精确 Fetch 路由。
 *
 * 只走精确路由，**绝不碰** `rpc.intercept("/api", …)`：那个槽位每通道只有一个，
 * 抢到就会顶掉网关自己的分发，让所有生成式 Remote（含桌面启动时的 welcome 读取）
 * 全部 404 —— 这正是之前那次「welcome: Web request failed」崩溃的形态，
 * 而精确路由是附加式、优先级更高、不影响任何其它端点。
 *
 * `inject` 声明了 connection；若服务尚未就绪就定时重试，并把每次尝试写进
 * sounds/.host-status.json（排查第一手证据）。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context。
 */
function apply(ctx) {
	const disposers = [];
	let attempts = 0;
	let timer = null;
	let finished = false;

	const status = {
		inject,
		libRoot: LIB_ROOT,
		libRootExists: fs.existsSync(LIB_ROOT),
		defaultLibExists: fs.existsSync(path.join(LIB_ROOT, DEFAULT_LIB)),
		hasConnection: false,
		hasFetchRegister: false,
		hasRpc: false,
		hasIntercept: false,
		registeredRoutes: [],
		attempts: 0,
		connectionShape: null,
		error: null,
		updatedAt: null,
	};

	const writeStatus = () => {
		status.attempts = attempts;
		status.updatedAt = new Date().toISOString();
		try {
			fs.mkdirSync(LIB_ROOT, { recursive: true });
			fs.writeFileSync(path.join(LIB_ROOT, ".host-status.json"), JSON.stringify(status, null, 2), "utf8");
		} catch (err) { /* 忽略 */ }
	};

	const resolveConnection = () => {
		let connection = null;
		try { connection = ctx && ctx.connection ? ctx.connection : null; } catch (err) { connection = null; }
		if (!connection && ctx && typeof ctx.get === "function") {
			try { connection = ctx.get("connection") || null; } catch (err) { connection = null; }
		}
		return connection;
	};

	const attempt = () => {
		if (finished) return;
		attempts += 1;
		const connection = resolveConnection();
		const fetchFace = connection && connection.fetch ? connection.fetch : null;
		status.hasConnection = !!connection;
		status.connectionShape = connection ? describeService(connection) : null;
		status.hasFetchRegister = !!(fetchFace && typeof fetchFace.register === "function");

		if (status.hasFetchRegister && !status.registeredRoutes.length) {
			for (const name of ENDPOINTS) {
				try {
					const disposer = fetchFace.register({
						path: "/api/" + ENDPOINT_PREFIX + name,
						methods: ["POST"],
						requestBody: "buffered",
						fetch: makeRoute(name),
					});
					disposers.push(disposer);
					status.registeredRoutes.push(name);
				} catch (err) {
					status.error = (status.error ? status.error + "; " : "") + name + ": " + (err && err.message ? err.message : String(err));
				}
			}
		}

		if (status.registeredRoutes.length) {
			finished = true;
			writeStatus();
			return;
		}
		writeStatus();
		if (attempts < MAX_ATTEMPTS) {
			timer = setTimeout(attempt, RETRY_INTERVAL_MS);
			if (timer && typeof timer.unref === "function") timer.unref();
		} else {
			console.warn("[dsh-sound-player] 音效库端点注册失败，状态见 sounds/.host-status.json", status);
		}
	};

	attempt();

	try {
		ctx.on("dispose", () => {
			finished = true;
			if (timer) clearTimeout(timer);
			for (const disposer of disposers) {
				try {
					const pending = disposer && disposer();
					if (pending && typeof pending.catch === "function") pending.catch(() => { /* 忽略 */ });
				} catch (err) { /* 忽略 */ }
			}
			disposers.length = 0;
		});
	} catch (err) { /* 忽略 */ }
}

export { apply, inject };
