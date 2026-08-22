// dsh-sound-player 宿主端（node half）。
// 浏览器端通过 exports["./client"] 与 package.json 的 dsh.client 声明发布。
// 宿主端目前只做挂载占位：音效播放全部在浏览器端完成（存储 / 触发 / UI）。
// 后续如需「宿主插件也能触发音效」，可在此提供一个 host 服务，
// 通过 api-remotes 广播给所有浏览器端。
const inject = [];

/**
 * 宿主端 apply。留空占位，保证 loader 能正常挂载本行。
 * @param {import('@deepseek-ai/cordis').Context} ctx - host context。
 */
function apply(ctx) {
  // no-op host half — 客户端功能见 ./client.js
}

export { apply, inject };
