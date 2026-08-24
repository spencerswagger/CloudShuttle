# frontend · 管理端

Vue 3 + Vite 构建的管理界面，静态产物部署到 **OSS/CDN**（0 成本空闲）。

## 页面

- **画布（Canvas）**：可视化拼接 DAG 流水线，配置 `shell` 与 `approval` 节点；
- **凭证（Credentials）**：管理 git / docker registry / 对象存储 / 钉钉机器人等 SM4 加密凭证；
- **镜像（Images）**：管理 runner 预置镜像（增删、上传 ACR）；
- **执行（Executions）**：查看执行历史、节点状态与日志。

```
frontend/src/
  pages/      # Canvas / Credentials / Images / Executions
  api/        # client + pipeline / credential / image / execution
  router.js   # 页面路由
  App.vue     # 入口布局
```

## 本地开发

```bash
npm install
npm run dev      # 开发服务器
npm run build    # 产出 frontend/dist/
```

## 自行打包（发布产物）

GitHub Release 上的 `cloudshuttle-web-<tag>.zip`（CDN 用）即由下面方式产出，可直接下载，无需自己打包。

```bash
npm run build                      # 产物 frontend/dist/
cd dist && zip -r ../cloudshuttle-web-<tag>.zip .
# 把 zip 内容上传到 OSS 静态桶并接 CDN 即可（见 deploy/README.md 方式 B.4）
```

API 地址统一在前端 `dist/cloudshuttle-config.js` 的 `apiBase` 配置（默认同源 `/api`，构建时由 `public/` 原样带出，可部署时改）：

- **docker-compose / 本机**：nginx 反代 `/api`、`/hook`、`/_/hook`，保持默认即可；
- **云端 CDN**（无反代）：把 `apiBase` 改成控制面完整地址，如 `window.CloudShuttleConfig = { apiBase: "https://control.example.com/api" }`（见 [deploy/README.md](../deploy/README.md) 方式 B.4）。

部署方式见 [deploy/README.md](../deploy/README.md)。