/* =====================================================================
 * 关卡数据（固定设置 / Level Data）
 * ---------------------------------------------------------------------
 * 每关都带一个固定随机种子 `seed`，保证同一关的：
 *   · 田野尺寸与边界（rw/rh/cell 决定开放地图大小）
 *   · 河流走向（rivers，自然水域，可走小桥过河）
 *   · 草料位置与数量
 *   · 庇护所（谷仓）位置（= 离入口最远的房间格）
 *   · 环境树 / 野花 / 草簇分布
 * 每次进入都完全一致 —— 不随机，便于测试复现与关卡微调。
 *
 * 字段说明：
 *   seed     固定随机种子（整数），改它即换一套固定布局
 *   name/desc 关卡名与简介
 *   star     难度星级（仅 UI）
 *   tornado  是否有龙卷风
 *   rain     是否下雨（第 5 关）
 *   snow     是否下雪（第 10 关，阴天）
 *   wind     是否大风（第 8/10 关，强风动画）
 *   terrain  地形类型：'mountain' = 山地（凹凸不平、石地、树+岩石、无河）
 *   rockCount 山地关岩石数量（越多越难）
 *   foodCount 需收集的草料数（默认 5）
 *   asset    开放田野配置（不再是迷宫）：
 *              rw,rh  房间行列数（仅用于网格坐标换算，网格 = (rw*2+1) x (rh*2+1)）
 *              cell   每格世界尺寸（同时决定地图大小）
 *              rivers 河流航点链（山地关为 null，无河）
 *   map      固定地图矩形 { w, d, cz }（第 1 关用；其余关按 asset 自动算尺寸）
 * ===================================================================== */
window.LEVEL_DATA = {
  1: {
    seed: 0x1A2B3C,
    name: '青草原野', desc: '收集草料回到庇护所，在开阔的草地上自由漫步',
    star: 1, tornado: false, rain: false, foodCount: 5, asset: null,
    map: { w: 150, d: 110, cz: 0 }
  },
  2: {
    seed: 0x2C3D4E,
    name: '小河绕行', desc: '一条小河横在田野上，沿河走或过小桥去对岸',
    star: 2, tornado: true, rain: false, foodCount: 5,
    asset: { rw: 5, rh: 3, cell: 12,
      rivers: [ { w: 1, pts: [[0, 2, 1], [6, 2, 1], [7, 3, 1], [10, 3, 2]] } ] }
  },
  3: {
    seed: 0x3E4F50,
    name: '水网田园', desc: '几道蜿蜒小河穿过田野，绕着水走、见桥就过',
    star: 2, tornado: true, rain: false, foodCount: 5,
    asset: { rw: 7, rh: 5, cell: 11,
      rivers: [
        { w: 1, pts: [[0, 2, 1], [8, 2, 1], [9, 3, 2], [12, 3, 2], [13, 4, 1], [14, 4, 1]] },
        { w: 2, pts: [[6, 0, 2], [6, 4, 1], [6, 10, 1]] }
      ] }
  },
  4: {
    seed: 0x4F5061,
    name: '河畔漫步', desc: '大片原野与河流，自由探索各处草料',
    star: 3, tornado: true, rain: false, foodCount: 5,
    asset: { rw: 9, rh: 9, cell: 11,
      rivers: [
        { w: 1, pts: [[0, 4, 1], [10, 4, 1], [11, 5, 2], [11, 12, 2], [12, 13, 1], [18, 13, 1]] },
        { w: 1, pts: [[8, 0, 1], [8, 8, 1], [8, 18, 2]] }
      ] }
  },
  5: {
    seed: 0x5A6B7C,
    name: '风雨原野', desc: '刮风下雨的开阔原野，坚持收集草料回庇护所',
    star: 3, tornado: true, rain: true, foodCount: 5,
    asset: { rw: 9, rh: 9, cell: 11,
      rivers: [
        { w: 1, pts: [[0, 4, 1], [10, 4, 1], [11, 5, 2], [11, 12, 2], [12, 13, 1], [18, 13, 1]] },
        { w: 1, pts: [[8, 0, 1], [8, 8, 1], [8, 18, 2]] }
      ] }
  },
  /* ===================== 第二大关：山地（6-10 关） =====================
   * 自由探索不变，过关机制不变；地形变为山地（凹凸不平）、障碍物为树木 + 岩石，
   * 没有河流，地面为石头，树木更少。第 10 关阴天下雪、有雪花与脚印、大风动画。 */
  /* ===================== 第三大关：洞穴（11-15 关） =====================
   * 主题切换为地下洞穴：阴暗环境 + 小牛自带提灯（暖色点光源），无龙卷风。
   * 11-14 关逐渐丰富的钟乳石（顶垂）、石柱（立柱）、石笋（地突）、平静水潭（倒影+走过波纹）；
   * 第 15 关为发光多彩水晶。所有洞穴关都有脆弱石板陷阱：走过会半陷入坑中，挣扎 2 秒才能出来，
   * 期间不能操作。字段说明：
   *   cave        是否为洞穴关卡（开启洞穴环境/无龙卷风）
   *   stalactites 钟乳石数量（自洞顶垂下，纯装饰）
   *   stalagmites 石笋数量（自地面突起，碰撞障碍）
   *   pillars     石柱数量（地面到洞顶的立柱，碰撞障碍）
   *   pools       水潭数量（圆形静水，倒影+波纹，碰撞障碍）
   *   crystals    水晶数量（仅第 15 关，发光多彩，碰撞障碍）
   *   traps       脆弱石板陷阱数量 */
  6: {
    seed: 0x6A1B2C,
    name: '碎石山坡', desc: '崎岖山地，绕开岩石与稀疏林木收集草料',
    star: 3, tornado: true, rain: false, terrain: 'mountain', rockCount: 22, foodCount: 5,
    asset: { rw: 7, rh: 5, cell: 11, rivers: null }
  },
  7: {
    seed: 0x7B2C3D,
    name: '林石峡谷', desc: '岩石与密林交错的山地，小心脚下',
    star: 4, tornado: true, rain: false, terrain: 'mountain', rockCount: 28, foodCount: 5,
    asset: { rw: 8, rh: 6, cell: 11, rivers: null }
  },
  8: {
    seed: 0x8C3D4E,
    name: '寒风高地', desc: '高处风大，踏着碎石坡收集草料',
    star: 4, tornado: true, rain: false, wind: true, terrain: 'mountain', rockCount: 30, foodCount: 5,
    asset: { rw: 9, rh: 7, cell: 11, rivers: null }
  },
  9: {
    seed: 0x9D4E5F,
    name: '迷雾石林', desc: '嶙峋怪石遍布，在山地中寻路前进',
    star: 5, tornado: true, rain: false, terrain: 'mountain', rockCount: 34, foodCount: 5,
    asset: { rw: 9, rh: 8, cell: 11, rivers: null }
  },
  10: {
    seed: 0xAE5F60,
    name: '雪原庇护', desc: '阴天下雪，跟着脚印与雪花回到庇护所',
    star: 5, tornado: false, rain: false, snow: true, wind: true, terrain: 'mountain', rockCount: 20, foodCount: 5,
    asset: { rw: 9, rh: 7, cell: 11, rivers: null }
  },

  11: {
    seed: 0xB1C2D3,
    name: '洞口初探', desc: '提灯照亮幽暗洞窟，绕过钟乳石与石笋，当心脚下的脆石板',
    star: 4, tornado: false, cave: true, foodCount: 5,
    asset: { rw: 7, rh: 5, cell: 11, rivers: null },
    stalactites: 14, stalagmites: 13, pillars: 4, pools: 2, crystals: 0, traps: 4
  },
  12: {
    seed: 0xC2D3E4,
    name: '石柱回廊', desc: '林立的石柱间穿行，静水潭映着提灯微光，踩碎石板会陷落',
    star: 4, tornado: false, cave: true, foodCount: 5,
    asset: { rw: 8, rh: 6, cell: 11, rivers: null },
    stalactites: 18, stalagmites: 16, pillars: 8, pools: 3, crystals: 0, traps: 5
  },
  13: {
    seed: 0xD3E4F5,
    name: '晶簇深窟', desc: '钟乳石与石笋密布，水潭静卧其间，小心每一步脆石板',
    star: 5, tornado: false, cave: true, foodCount: 5,
    asset: { rw: 9, rh: 7, cell: 11, rivers: null },
    stalactites: 22, stalagmites: 20, pillars: 12, pools: 3, crystals: 0, traps: 6
  },
  14: {
    seed: 0xE4F5A6,
    name: '幽渊石林', desc: '嶙峋石林与深潭交织的洞窟深处，石板陷阱无处不在',
    star: 5, tornado: false, cave: true, foodCount: 5,
    asset: { rw: 9, rh: 8, cell: 11, rivers: null },
    stalactites: 26, stalagmites: 24, pillars: 16, pools: 4, crystals: 0, traps: 7
  },
  15: {
    seed: 0xF5A607,
    name: '荧光水晶宫', desc: '发光的多彩水晶照亮洞窟，石笋水潭间藏着最后的脆石板',
    star: 5, tornado: false, cave: true, foodCount: 5,
    asset: { rw: 9, rh: 7, cell: 11, rivers: null },
    stalactites: 12, stalagmites: 12, pillars: 8, pools: 3, crystals: 16, traps: 8
  }
};
