/* =====================================================================
 * 哞哞庇护所 · 微信小游戏入口 (game.js)
 * 微信小游戏运行时加载顺序不可颠倒：
 *   1. adapter  先建立 wx → DOM/BOM 垫片、上屏 canvas、触摸分发
 *   2. three     UMD 在 CommonJS 下走 exports 分支，挂到 GameGlobal.THREE
 *   3. level     关卡数据写入 window.LEVEL_DATA
 *   4. core      游戏主体（自动 showMenu() + bootGame(0) 启动 rAF 主循环）
 *   5. 合成循环  在 core 之后注册，保证每帧「先 3D 渲染，再 2D 合成」
 * ===================================================================== */
var ADAPTER = require('./js/adapter.js');

var THREE = require('./js/libs/three.min.js');
GameGlobal.THREE = THREE;

require('./js/level_data.js');
require('./js/core.js');

ADAPTER.startCompositor();

/* 便于开发者工具控制台调试：可用 __mmBoot(11) 直接切到第 11 关（洞穴） */
