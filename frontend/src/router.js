// frontend/src/router.js
import { createRouter, createWebHistory } from "vue-router";
const routes = [
  { path: "/", redirect: "/pipelines" },

  // 流水线
  { path: "/pipelines", component: () => import("./pages/PipelineList.vue") },
  { path: "/pipelines/new", component: () => import("./pages/PipelineEdit.vue") },
  { path: "/pipelines/:id(\\d+)", component: () => import("./pages/PipelineEdit.vue") },

  // 凭证
  { path: "/credentials", component: () => import("./pages/CredentialList.vue") },
  { path: "/credentials/new", component: () => import("./pages/CredentialForm.vue") },
  { path: "/credentials/:id(\\d+)", component: () => import("./pages/CredentialForm.vue") },

  // 镜像
  { path: "/images", component: () => import("./pages/ImageList.vue") },
  { path: "/images/new", component: () => import("./pages/ImageForm.vue") },
  { path: "/images/:id(\\d+)", component: () => import("./pages/ImageForm.vue") },

  // 执行
  { path: "/executions", component: () => import("./pages/ExecutionList.vue") },
  { path: "/executions/:id(\\d+)", component: () => import("./pages/ExecutionDetail.vue") },
];
export const router = createRouter({ history: createWebHistory(), routes });