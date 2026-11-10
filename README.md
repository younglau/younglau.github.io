# 少年很多年

GitHub Actions 将专用 Notion 文章库里的已发布文章加入首页和归档。同一次构建生成的静态文件分别部署到 GitHub Pages（`younglau.me`）和 Vercel（`www.younglau.com`）。新文章的路径是 `/posts/<slug>/`，原有文章路径继续有效。

## 一次性配置

1. 在 Notion 的 [集成管理](https://www.notion.so/profile/integrations) 创建一个仅有 **Read content** 权限的内部集成。在「少年很多年 · 博客文章」右上角的「连接」菜单添加这个集成。只授权这张文章库。文章库可以保持私有。
2. 确认 Vercel 项目管理 `www.younglau.com`，记录项目 ID 和所属账户或团队 ID。为部署使用该账户或团队下的 Vercel Token。
3. 在仓库的 [Actions Secrets](https://github.com/younglau/younglau.github.io/settings/secrets/actions) 保存 `NOTION_TOKEN` 和 `VERCEL_TOKEN`。在 [Actions Variables](https://github.com/younglau/younglau.github.io/settings/variables/actions) 填写 `NOTION_DATA_SOURCE_ID`（专用文章库的数据源 ID）、`VERCEL_ORG_ID` 和 `VERCEL_PROJECT_ID`。
4. 在仓库的 [Pages 设置](https://github.com/younglau/younglau.github.io/settings/pages) 把 **Build and deployment → Source** 选为 **GitHub Actions**，保留现有域名。在 Actions Variables 中设置 `NOTION_PUBLISH_ENABLED` 为 `true`，然后在 [Actions](https://github.com/younglau/younglau.github.io/actions) 手动运行 **Publish blog from Notion**，选 `master`。
5. 确认两端首次部署成功后，将 Vercel 原生 Git 集成对生产分支的自动部署关闭，例如通过 `vercel.json` 的 `git.deploymentEnabled` 按分支配置。此后 GitHub Actions 是两端生产部署的入口，避免 Vercel 的原生 Git 构建用仓库里的旧页面覆盖 Notion 文章。用一篇可公开的测试文验证发布、改稿和撤稿。

定时任务每 15 分钟检查，内容变化时部署。两端都成功后才记录本次内容，单端失败时下一轮会重试。GitHub Actions 调度繁忙时可能延迟。公开仓库连续 60 天无活动时，GitHub 可能停用定时任务，可在 Actions 页重新启用。

## 写文章

| 属性 | 类型 | 用法 |
| --- | --- | --- |
| Title | Title | 文章标题 |
| Status | Select | 默认留空或选 `Draft`，确认要公开时选 `Published` |
| Slug | Text | 唯一的固定网址名，例如 `first-post`。只用小写英文字母、数字和短横线 |
| Date | Date | 发布日期 |
| Summary | Text | 可选的首页摘要 |

正文写在记录对应的 Notion 页面里。可以使用常见 Markdown 排版、代码块和图片。同步块、子页面和部分嵌入会使构建停止，请改用普通文本、图片或外部链接。正文和媒体一旦发布就可以被访客访问。把文章切回 `Draft` 后，下一次成功部署会移除站内页面和链接，已经被其他人保存的副本仍可能存在。编辑 `Published` 文章也会在下一次成功同步后上线。

## 本地预览现有站点

用 Node.js 24 运行 `npm ci --ignore-scripts` 和 `npm run build`，然后运行 `python3 -m http.server --directory _site`。不设 Notion 环境变量时只构建仓库现有页面。
