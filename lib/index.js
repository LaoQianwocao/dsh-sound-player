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
// 客户端经 RPC 读取目录树、取音频字节、写入导入、打开库位置。宿主端同时注册两条路：
//   1. `ctx.connection.rpc.handle("soundPlayer", …)` —— 插件自己的专用通道，endpoint 不带前缀
//   2. `ctx.connection.rpc.intercept("/api", ep => ep.startsWith("soundPlayer/"), …)`
//      —— 拦截共享通道，endpoint 形如 `soundPlayer/tree`
// 客户端先试专用通道，失败退回共享通道（见 client.js 的 RPC_ROUTES）。两条都走
// 与生成式 Remote 同一条已认证链路，因此不必自己处理浏览器鉴权，也不改任何官方文件。
//
// 端点（短名；共享通道需加 `soundPlayer/` 前缀）：
//   tree   { }                        -> 目录树
//   read   { path }                   -> { path, base64 }
//   import { name, dataBase64, dir? } -> { path }
//   delete { path }                   -> { deleted }（仅自定义音效库）
//   open   { path? }                  -> { opened }
//   status { }                        -> { libRoot, counts, recorded }
//
// 音频字节以 base64 放在返回值里：客户端一元 RPC 的结果类型只声明了
// { ok, value }，没有暴露 attachments，所以不依赖附件通道。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const inject = [];

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

/**
 * 宿主端 apply。把音效库端点注册到 RPC 通道。
 *
 * 同时用两种方式注册，客户端按顺序尝试，任一可用即可：
 *   1. `rpc.handle("soundPlayer", …)` —— 插件自己的专用通道（首选）
 *   2. `rpc.intercept("/api", ep => ep.startsWith("soundPlayer/"), …)` —— 拦截共享通道
 * 并把注册结果写进 sounds/.host-status.json，便于排查「库为空」这类问题：
 * 宿主半段改动必须重启桌面端才会生效，该文件能直接说明它加载的是不是新代码。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context。
 */
function apply(ctx) {
	let connection = null;
	try {
		connection = ctx && typeof ctx.get === "function" ? ctx.get("connection") : null;
	} catch (err) {
		connection = null;
	}
	const rpc = connection && connection.rpc ? connection.rpc : null;
	const status = {
		appliedAt: new Date().toISOString(),
		libRoot: LIB_ROOT,
		libRootExists: fs.existsSync(LIB_ROOT),
		defaultLibExists: fs.existsSync(path.join(LIB_ROOT, DEFAULT_LIB)),
		hasRpc: !!rpc,
		hasHandle: !!(rpc && typeof rpc.handle === "function"),
		hasIntercept: !!(rpc && typeof rpc.intercept === "function"),
		registeredHandle: false,
		registeredIntercept: false,
		error: null,
	};
	let disposeHandle = null;
	let disposeIntercept = null;
	try {
		if (rpc && typeof rpc.handle === "function") {
			// 专用通道：endpoint 就是 "tree" / "read" / …（不带前缀）。
			disposeHandle = rpc.handle("soundPlayer", (endpoint, payload) => handle(endpoint, payload));
			status.registeredHandle = true;
		}
	} catch (err) {
		status.error = "handle: " + (err && err.message ? err.message : String(err));
	}
	try {
		if (rpc && typeof rpc.intercept === "function") {
			// 共享通道：endpoint 形如 "soundPlayer/tree"，剥掉前缀复用同一个 handler。
			disposeIntercept = rpc.intercept(
				"/api",
				(endpoint) => typeof endpoint === "string" && endpoint.startsWith(ENDPOINT_PREFIX),
				(endpoint, payload) => handle(String(endpoint).slice(ENDPOINT_PREFIX.length), payload)
			);
			status.registeredIntercept = true;
		}
	} catch (err) {
		status.error = (status.error ? status.error + "; " : "") + "intercept: " + (err && err.message ? err.message : String(err));
	}
	// 写一份状态到库里（点「打开音效库」也能看到），排查时直接读文件。
	try {
		fs.mkdirSync(LIB_ROOT, { recursive: true });
		fs.writeFileSync(path.join(LIB_ROOT, ".host-status.json"), JSON.stringify(status, null, 2), "utf8");
	} catch (err) { /* 忽略 */ }
	if (!status.registeredHandle && !status.registeredIntercept) {
		console.warn("[dsh-sound-player] 音效库端点两种注册方式都失败：", status);
		return;
	}
	try {
		ctx.on("dispose", () => {
			for (const disposer of [disposeHandle, disposeIntercept]) {
				try {
					const pending = disposer && disposer();
					if (pending && typeof pending.catch === "function") pending.catch(() => { /* 忽略 */ });
				} catch (err) { /* 忽略 */ }
			}
		});
	} catch (err) { /* 忽略 */ }
}

export { apply, inject };
