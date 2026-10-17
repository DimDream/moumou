# 部署指南（GitHub Pages）

本项目是纯静态单文件游戏（`index.html`，three.js 已内联），无需服务器、无需构建。

> 注：Gitee Pages 已于 2026 年停服，故改用 GitHub Pages。

## 首次部署

1. **推送代码**（已由 `push_github_ssh.py` 完成）：
   ```bash
   python push_github_ssh.py
   ```
   脚本会自动：测试 SSH 认证 -> git add/commit -> push 到
   `git@github.com:DimDream/moumou.git`

2. **开通 Pages**（网页操作，约 1 分钟）：
   打开 https://github.com/DimDream/moumou/settings/pages
   - Source 选 **Deploy from a branch**
   - Branch 选 **master**、目录 **/(root)**，点 **Save**
   - 等 1-2 分钟，访问 **https://dimdream.github.io/moumou/**

## 日常更新

修改游戏后（重新构建 `index.html`）：

```bash
python push_github_ssh.py
```

GitHub Pages **推送后自动部署**，约 1 分钟线上生效，无需手动操作。

## SSH 密钥说明

- 私钥：`G:/moumou_deploy/id_ed25519`（本机生成，请勿外传）
- 公钥：`G:/moumou_deploy/id_ed25519.pub`（已添加到 GitHub -> Settings -> SSH keys）
- 推送脚本通过 `GIT_SSH_COMMAND` 指定私钥路径，不依赖 `~/.ssh`

## 常见问题

- **推送时认证失败**：确认公钥已添加；重新运行脚本会显示待添加的公钥内容
- **Pages 页面 404**：确认部署目录是 `/(root)`，且 `index.html` 在仓库根目录
- **换了电脑**：把 `G:/moumou_deploy/id_ed25519` 私钥拷过去，或重新生成密钥对并更新 GitHub
