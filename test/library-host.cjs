/* 宿主端音效库端点的无头测试。
 *
 * 用桩 ctx 捕获 `connection.rpc.intercept` 注册的 handler，然后直接调用它，
 * 断言目录树 / 读取 / 导入 / 路径越界防护。不会真的打开资源管理器。
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

	// —— 桩 ctx：捕获 intercept 注册的 handler ——
	let handler = null;
	const disposers = [];
	const ctx = {
		get: (key) => (key === "connection" ? {
			rpc: {
				intercept: (channel, matches, h) => {
					if (channel !== "/api") throw new Error("channel 应为 /api");
					if (!matches("soundPlayer/tree")) throw new Error("matches 应接受 soundPlayer/tree");
					if (matches("session/list")) throw new Error("matches 不应接受其它端点");
					handler = h;
					return async () => { disposers.push("rpc"); };
				},
			},
		} : undefined),
		on: (ev, cb) => { if (ev === "dispose") disposers.push(cb); },
	};

	mod.apply(ctx);
	if (typeof handler === "function") ok("注册了 /api 上的 soundPlayer/* handler");
	else { fail("未注册 handler"); report(); return; }
	if (Array.isArray(mod.inject) && mod.inject.length === 0) ok("宿主端不硬依赖任何服务（缺少 connection 时静默降级）");
	else fail("inject 应为空数组，实际: " + JSON.stringify(mod.inject));

	// —— tree ——
	const tree = await handler("soundPlayer/tree", {});
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
	const rec = await handler("soundPlayer/read", { path: recipePath });
	if (rec.ok && rec.value.path === recipePath) {
		const parsed = JSON.parse(Buffer.from(rec.value.base64, "base64").toString("utf8"));
		if (Array.isArray(parsed.recipe) && parsed.recipe.length === 4 && parsed.recipe[0].f === 523.25) ok("read 合成配方 JSON 可解析（4 个音符，起始 523.25Hz）");
		else fail("配方内容异常: " + JSON.stringify(parsed).slice(0, 80));
	} else fail("read 配方失败: " + JSON.stringify(rec.error || rec.value));

	// —— read：真实 wav 字节 ——
	const wav = await handler("soundPlayer/read", { path: "默认音效库/Windows 系统提示音/叮.wav" });
	if (wav.ok) {
		const bytes = Buffer.from(wav.value.base64, "base64");
		if (bytes.slice(0, 4).toString("ascii") === "RIFF" && bytes.length > 10000) ok("read wav 返回可解码字节（" + bytes.length + " 字节，RIFF）");
		else fail("wav 内容异常: " + bytes.length + " 字节 header=" + bytes.slice(0, 4).toString("ascii"));
	} else fail("read wav 失败: " + JSON.stringify(wav.error));

	// —— 越界防护 ——
	for (const bad of ["../../package.json", "..\\..\\client.js", "/etc/passwd"]) {
		const r = await handler("soundPlayer/read", { path: bad });
		if (!r.ok && /超出音效库范围|ENOENT|不是文件/.test(r.error.message)) ok("越界路径被拒: " + bad);
		else fail("越界路径未被拒: " + bad + " -> " + JSON.stringify(r.value || r.error));
	}

	// —— import：落盘 + 重名去冲突 + 清理 ——
	const marker = "宿主测试音效";
	const payloadB64 = Buffer.from("RIFF0000WAVEfmt ").toString("base64");
	const imp1 = await handler("soundPlayer/import", { name: marker + ".wav", dataBase64: payloadB64 });
	if (imp1.ok && imp1.value.path === "自定义音效库/" + marker + ".wav") ok("import 写入自定义音效库: " + imp1.value.path);
	else fail("import 失败: " + JSON.stringify(imp1.value || imp1.error));
	const imp2 = await handler("soundPlayer/import", { name: marker + ".wav", dataBase64: payloadB64 });
	if (imp2.ok && imp2.value.path === "自定义音效库/" + marker + "-2.wav") ok("import 重名自动去冲突: " + imp2.value.path);
	else fail("import 重名处理异常: " + JSON.stringify(imp2.value || imp2.error));
	const imp3 = await handler("soundPlayer/import", { name: "../../escape.wav", dataBase64: payloadB64 });
	if (imp3.ok && imp3.value.path.indexOf("自定义音效库/") === 0) ok("import 净化路径穿越的文件名: " + imp3.value.path);
	else fail("import 未净化文件名: " + JSON.stringify(imp3.value || imp3.error));

	const tree2 = await handler("soundPlayer/tree", {});
	const cus2 = find(tree2.value.children, "自定义音效库");
	if (cus2 && countType(cus2.children, "audio") === 3) ok("导入后目录树实时反映新文件");
	else fail("导入后目录树未更新: " + (cus2 ? countType(cus2.children, "audio") : "无该库"));

	// —— delete：只允许删自定义库 ——
	const del1 = await handler("soundPlayer/delete", { path: imp2.value.path });
	if (del1.ok) ok("delete 删掉自定义库文件: " + del1.value.deleted);
	else fail("delete 失败: " + JSON.stringify(del1.error));
	const del2 = await handler("soundPlayer/delete", { path: "神人音效库/哈基米.mp3" });
	if (!del2.ok && /只能删除自定义音效库/.test(del2.error.message)) ok("delete 拒绝删除内置库文件");
	else fail("delete 未拒绝内置库: " + JSON.stringify(del2.value || del2.error));
	if (fs.existsSync(path.join(libRoot, "神人音效库", "哈基米.mp3"))) ok("内置库文件未被误删");
	else fail("内置库文件被删掉了");

	// 清理测试产物
	for (const f of ["宿主测试音效.wav", "宿主测试音效-2.wav", "escape.wav"]) {
		const p = path.join(customDir, f);
		if (fs.existsSync(p)) fs.unlinkSync(p);
	}
	const left = fs.existsSync(customDir) ? fs.readdirSync(customDir).filter((f) => !f.startsWith(".")) : [];
	if (left.length === 0) ok("测试产物已清理，自定义音效库为空");
	else fail("自定义音效库残留: " + left.join(", "));

	// —— 未知端点 ——
	const unknown = await handler("soundPlayer/nope", {});
	if (!unknown.ok && unknown.error.code === "soundPlayer/unknown-endpoint") ok("未知端点返回结构化错误");
	else fail("未知端点处理异常");

	// —— dispose 时释放端点 ——
	const before = disposers.length;
	for (const d of disposers.slice()) { try { await d(); } catch (e) { /* 忽略 */ } }
	if (disposers.length >= before && disposers.includes("rpc")) ok("dispose 会释放 RPC 端点注册");
	else fail("dispose 未释放端点");

	report();
})();

function report() {
	console.log("=== lib/index.js (宿主端音效库端点) ===");
	for (const r of results) console.log("  " + r);
	console.log(failed === 0 ? "RESULT: all passed" : "RESULT: " + failed + " failed");
	process.exit(failed === 0 ? 0 : 1);
}
