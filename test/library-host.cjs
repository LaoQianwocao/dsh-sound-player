/* 宿主端音效库端点的无头测试。
 *
 * 用桩 ctx 捕获 `connection.fetch.register` 注册的精确 Fetch 路由，然后构造真实
 * Request 打进去，按生成式 Remote 的信封（server-response）取回结果 —— 与浏览器端
 * connection.rpc.call 的行为一致。
 *
 * 安全回归：桩里的 `connection.rpc.intercept/handle` 一旦被调用就抛错 ——
 * 那两个 API 属于「每通道单槽位」，插件用了会顶掉网关自己的 /api 分发
 * （表现为桌面端起不来、welcome 请求 404）。本插件必须只用精确路由。
 *
 * 用法: node test/library-host.cjs
 */
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "..");
const libRoot = path.join(root, "sounds");
const customDir = path.join(libRoot, "自定义音效库");

let failed = 0;
const results = [];
const ok = (m) => results.push("ok    " + m);
const fail = (m) => { failed += 1; results.push("FAIL  " + m); };

function find(nodes, name) {
	return (nodes || []).find((n) => n.name === name);
}
function countType(nodes, type) {
	return (nodes || []).filter((n) => n.type === type).length;
}

(async () => {
	const mod = await import(pathToFileURL(path.join(root, "lib", "index.js")).href);

	// —— 桩 ctx：捕获精确 Fetch 路由；碰 rpc.intercept/handle 就直接失败 ——
	const routes = new Map();
	let disposeCb = null;
	const ctx = {
		get: (key) => (key === "connection" ? {
			fetch: {
				register: (route) => {
					if (routes.has(route.path)) throw new Error("重复路由: " + route.path);
					routes.set(route.path, route);
					return async () => { routes.delete(route.path); };
				},
			},
			rpc: {
				intercept: () => { throw new Error("禁止使用 rpc.intercept：会顶掉网关的 /api 分发"); },
				handle: () => { throw new Error("禁止使用 rpc.handle：本插件不需要专用通道"); },
			},
		} : undefined),
		on: (ev, cb) => { if (ev === "dispose") disposeCb = cb; },
	};

	mod.apply(ctx);
	if (routes.size === 6) ok("注册了 6 条精确 Fetch 路由: " + [...routes.keys()].map((p) => p.replace("/api/soundPlayer/", "")).join(", "));
	else fail("路由数异常: " + routes.size + " -> " + [...routes.keys()].join(", "));
	if (Array.isArray(mod.inject) && mod.inject.includes("connection")) ok("inject 声明了 connection 依赖（避免早于服务就绪）");
	else fail("inject 应包含 connection，实际: " + JSON.stringify(mod.inject));
	if (typeof disposeCb === "function") ok("注册了 dispose 回调");
	else fail("未注册 dispose 回调");

	/** 直接打某条路由，返回 { status, result }（模拟 connection.rpc.call 的两端）。 */
	const rawCall = async (name, payload, options = {}) => {
		const endpoint = "soundPlayer/" + name;
		const route = routes.get("/api/" + endpoint);
		if (!route) return { status: 404, result: null, missing: true };
		const rpcId = "test-" + Math.random().toString(36).slice(2);
		const method = options.methodField || endpoint;
		const body = options.rawBody === undefined
			? JSON.stringify({ type: "client-request", rpcId, method, payload: payload === undefined ? {} : payload })
			: options.rawBody;
		const request = new Request("http://127.0.0.1/api/" + endpoint, {
			method: options.method || "POST",
			headers: { "content-type": options.contentType || "application/json" },
			// GET/HEAD 不能带 body（undici 会直接抛错）
			...((options.method || "POST") === "POST" ? { body } : {}),
		});
		const response = await route.fetch(request);
		if (!response.ok) return { status: response.status, result: null };
		const envelope = await response.json();
		if (envelope.rpcId !== rpcId) return { status: 200, result: null, rpcIdMismatch: true };
		return { status: 200, result: envelope.result };
	};
	/** 模拟浏览器端：非 2xx 抛 transport failure，与真实 rpc.call 一致。 */
	const handler = async (name, payload) => {
		const { status, result } = await rawCall(name, payload);
		if (status !== 200) throw new Error("transport failure for /api/soundPlayer/" + name + ": HTTP " + status);
		return result;
	};

	// —— tree ——
	const tree = await handler("tree", {});
	if (!tree.ok) { fail("tree 失败: " + JSON.stringify(tree.error)); report(); return; }
	const top = tree.value.children;
	const def = find(top, "默认音效库");
	const shen = find(top, "神人音效库");
	const cus = find(top, "自定义音效库");
	if (def && shen && cus) ok("目录树含三个库: " + top.map((d) => d.name).join(" / "));
	else fail("目录树缺少库: " + top.map((d) => d.name).join(" / "));

	const synth = def && find(def.children, "合成音效");
	const win = def && find(def.children, "Windows 系统提示音");
	if (synth && countType(synth.children, "synth") === 8) ok("默认音效库/合成音效 有 8 个合成项");
	else fail("合成音效项数异常: " + (synth ? countType(synth.children, "synth") : "无该目录"));
	if (win && countType(win.children, "audio") === 3) ok("默认音效库/Windows 系统提示音 有 3 个音频");
	else fail("Windows 提示音项数异常: " + (win ? countType(win.children, "audio") : "无该目录"));
	if (shen && Array.isArray(shen.children)) ok("神人音效库 条目数: " + shen.children.length);
	else fail("神人音效库 不可读");
	if (def && def.children.every((c) => c.type === "dir")) ok("合成音效被归到目录下（多级结构）");
	else fail("默认音效库 顶层应只有目录");

	// —— read：配方 JSON ——
	const recipePath = "默认音效库/合成音效/完成音（上扬）.json";
	const rec = await handler("read", { path: recipePath });
	if (rec.ok && rec.value.path === recipePath) {
		const parsed = JSON.parse(Buffer.from(rec.value.base64, "base64").toString("utf8"));
		if (Array.isArray(parsed.recipe) && parsed.recipe.length === 4 && parsed.recipe[0].f === 523.25) ok("read 合成配方 JSON 可解析（4 个音符，起始 523.25Hz）");
		else fail("配方内容异常: " + JSON.stringify(parsed).slice(0, 80));
	} else fail("read 配方失败: " + JSON.stringify(rec.error || rec.value));

	// —— read：真实 wav 字节 ——
	const wav = await handler("read", { path: "默认音效库/Windows 系统提示音/叮.wav" });
	if (wav.ok) {
		const bytes = Buffer.from(wav.value.base64, "base64");
		if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.length > 10000) ok("read wav 返回可解码字节（" + bytes.length + " 字节，RIFF）");
		else fail("wav 内容异常: " + bytes.length + " 字节 header=" + bytes.slice(0, 4).toString("ascii"));
	} else fail("read wav 失败: " + JSON.stringify(wav.error));

	// —— 越界防护 ——
	for (const bad of ["../../package.json", "..\\..\\client.js", "/etc/passwd"]) {
		const r = await handler("read", { path: bad });
		if (!r.ok && /超出音效库范围|ENOENT|不是文件/.test(r.error.message)) ok("越界路径被拒: " + bad);
		else fail("越界路径未被拒: " + bad + " -> " + JSON.stringify(r.value || r.error));
	}

	// —— import：落盘 + 重名去冲突 + 清理 ——
	const marker = "宿主测试音效";
	const payloadB64 = Buffer.from("RIFF0000WAVEfmt ").toString("base64");
	const imp1 = await handler("import", { name: marker + ".wav", dataBase64: payloadB64 });
	if (imp1.ok && imp1.value.path === "自定义音效库/" + marker + ".wav") ok("import 写入自定义音效库: " + imp1.value.path);
	else fail("import 失败: " + JSON.stringify(imp1.value || imp1.error));
	const imp2 = await handler("import", { name: marker + ".wav", dataBase64: payloadB64 });
	if (imp2.ok && imp2.value.path === "自定义音效库/" + marker + "-2.wav") ok("import 重名自动去冲突: " + imp2.value.path);
	else fail("import 重名处理异常: " + JSON.stringify(imp2.value || imp2.error));
	const imp3 = await handler("import", { name: "../../escape.wav", dataBase64: payloadB64 });
	if (imp3.ok && imp3.value.path.indexOf("自定义音效库/") === 0) ok("import 净化路径穿越的文件名: " + imp3.value.path);
	else fail("import 未净化文件名: " + JSON.stringify(imp3.value || imp3.error));

	const tree2 = await handler("tree", {});
	const cus2 = find(tree2.value.children, "自定义音效库");
	if (cus2 && countType(cus2.children, "audio") === 3) ok("导入后目录树实时反映新文件");
	else fail("导入后目录树未更新: " + (cus2 ? countType(cus2.children, "audio") : "无该库"));

	// —— delete：只允许删自定义库 ——
	const del1 = await handler("delete", { path: imp2.value.path });
	if (del1.ok) ok("delete 删掉自定义库文件: " + del1.value.deleted);
	else fail("delete 失败: " + JSON.stringify(del1.error));
	const del2 = await handler("delete", { path: "神人音效库/哈基米.mp3" });
	if (!del2.ok && /只能删除自定义音效库/.test(del2.error.message)) ok("delete 拒绝删除内置库文件");
	else fail("delete 未拒绝内置库: " + JSON.stringify(del2.value || del2.error));
	if (fs.existsSync(path.join(libRoot, "神人音效库", "哈基米.mp3"))) ok("内置库文件未被误删");
	else fail("内置库文件被删掉了");

	// 清理测试产物
	for (const f of ["宿主测试音效.wav", "宿主测试音效-2.wav", "escape.wav"]) {
		const p = path.join(customDir, f);
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}
	const statusFile = path.join(libRoot, ".host-status.json");
	const left = fs.existsSync(customDir) ? fs.readdirSync(customDir).filter((f) => !f.startsWith(".")) : [];
	if (left.length === 0) ok("测试产物已清理，自定义音效库为空");
	else fail("自定义音效库残留: " + left.join(", "));

	// —— status 端点：自报库位置与各库条目数（排查「库为空」用） ——
	const status = await handler("status", {});
	if (status.ok && status.value.libRoot && status.value.counts) {
		const counts = status.value.counts;
		if (counts["神人音效库"] === 34 && counts["默认音效库"] === 11) ok("status 回报库位置与条目数（默认 11 / 神人 34）");
		else fail("status counts = " + JSON.stringify(counts));
	} else fail("status 失败: " + JSON.stringify(status.error || status.value));
	if (fs.existsSync(statusFile)) {
		const recorded = JSON.parse(fs.readFileSync(statusFile, "utf8"));
		if (Array.isArray(recorded.registeredRoutes) && recorded.registeredRoutes.length === 6) ok("apply 写下 .host-status.json 并记录 6 条路由");
		else fail("状态文件未记录路由: " + JSON.stringify(recorded));
	} else fail("未写出 .host-status.json");

	// —— 协议细节 ——
	const notPost = await rawCall("tree", {}, { method: "GET" });
	if (notPost.status === 404) ok("非 POST 命中路由时返回 404");
	else fail("非 POST 返回 " + notPost.status);
	const badType = await rawCall("tree", {}, { contentType: "text/plain" });
	if (badType.status === 415) ok("内容类型不是 JSON 时返回 415");
	else fail("错误内容类型返回 " + badType.status);
	const badJson = await rawCall("tree", {}, { rawBody: "{not json" });
	if (badJson.status === 400) ok("请求体不是 JSON 时返回 400");
	else fail("坏 JSON 返回 " + badJson.status);
	const mismatch = await rawCall("tree", {}, { methodField: "soundPlayer/other" });
	if (mismatch.status === 200 && mismatch.result && !mismatch.result.ok && mismatch.result.error.code === "gateway/bad-request") ok("method 与端点名不符时返回结构化错误");
	else fail("method 不符未报错: " + JSON.stringify(mismatch));

	// —— 未注册路径不应被本插件接管 ——
	const nowhere = await rawCall("nope", {});
	if (nowhere.status === 404 && nowhere.missing) ok("未注册端点 404（路由只覆盖自己的 6 条路径）");
	else fail("未注册端点返回 " + JSON.stringify(nowhere));

	// —— dispose 释放路由 ——
	const before = routes.size;
	if (typeof disposeCb === "function") await disposeCb();
	if (routes.size === 0) ok("dispose 会释放全部 " + before + " 条路由");
	else fail("dispose 后仍有路由: " + [...routes.keys()].join(", "));

	// 最后清掉运行时状态文件：让「重启后是否出现」成为宿主加载新代码的判据。
	if (fs.existsSync(statusFile)) fs.unlinkSync(statusFile);

	report();
})();

function report() {
	console.log("=== lib/index.js (宿主端音效库端点) ===");
	for (const r of results) console.log("  " + r);
	console.log(failed === 0 ? "RESULT: all passed" : "RESULT: " + failed + " failed");
	process.exit(failed === 0 ? 0 : 1);
}
