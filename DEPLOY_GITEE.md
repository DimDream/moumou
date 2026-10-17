# 部署到 Gitee Pages 操作指南

本项目是纯静态单文件游戏（`index.html`，three.js 已内联），无需服务器、无需构建，推送到 Gitee 仓库后开通 Pages 即可在线访问。

## 前置条件

1. 注册 Gitee 账号：https://gitee.com （需手机号实名认证，Pages 功能要求）
2. 本机已安装 Git（已验证 git 2.55.0 可用）

## 第一步：在 Gitee 创建仓库

1. 登录 Gitee，点右上角 **+** → **新建仓库**
2. 填写：
   - 仓库名称：`moumou`（**必须是公开仓库**，Gitee Pages 免费版不支持私有库）
   - 是否开源：**公开**
   - 其他保持默认（不要勾选“使用 Readme 文件初始化仓库”，避免和本地冲突）
3. 点 **创建**

## 第二步：推送代码到 Gitee

在本目录（`G:\moumou`）打开终端，执行（把 `你的用户名` 换成 Gitee 用户名）：

```bash
git remote add origin https://gitee.com/你的用户名/moumou.git
git push -u origin master
```

> 弹出登录框时输入 Gitee 账号密码（或访问令牌）。本地仓库已由助手初始化并完成首次提交，一般只需上面两行。

## 第三步：开通 Gitee Pages

1. 进入仓库页面 → 顶部 **服务** → **Gitee Pages**
2. 设置：
   - 部署分支：`master`
   - 部署目录：`/`（根目录，`index.html` 所在位置）
   - 强制更新 HTTPS：勾选（可选）
3. 点 **启动**，等待 1-2 分钟部署完成
4. 得到访问地址：**https://你的用户名.gitee.io/moumou/**

## 第四步：手机试玩

手机浏览器直接打开上面的地址即可。切关、重开均为无刷新切换，手机端可正常游玩。

## 日常更新

修改游戏后（重新构建 `index.html`）：

```bash
git add -A
git commit -m "更新游戏"
git push
```

**注意**：Gitee Pages 不会自动部署，每次推送后需回到 服务 → Gitee Pages 页面手动点一次 **更新**。

## 常见问题

- **Pages 选项是灰的 / 提示不支持**：仓库必须是公开的；账号需完成实名认证。
- **部署后 404**：确认部署目录选的是根目录 `/`，且 `index.html` 在仓库根目录下。
- **手机打开白屏**：Gitee Pages 偶尔缓存，等 1-2 分钟或强制刷新；确认部署的是最新一次提交。
- **想换仓库名**：仓库名即访问路径的一部分（`...gitee.io/仓库名/`），换名后在 Pages 设置里重新部署即可。
