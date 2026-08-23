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
npm run build    # 产出 frontend/dist/（上传到 CDN 即可）
```

API 经由同域 `/api`、`/hook`、`/_/hook` 反代至控制面（见 [deploy/README.md](../deploy/README.md) 的 nginx/C相 反代规则）。

部署方式见 [deploy/README.md](../deploy/README.md)。