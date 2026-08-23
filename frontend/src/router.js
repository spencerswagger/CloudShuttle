// frontend/src/router.js
import { createRouter, createWebHistory } from "vue-router";
const routes = [
  { path: "/", component: () => import("./pages/Canvas.vue") },
  { path: "/credentials", component: () => import("./pages/Credentials.vue") },
  { path: "/images", component: () => import("./pages/Images.vue") },
  { path: "/executions", component: () => import("./pages/Executions.vue") },
];
export const router = createRouter({ history: createWebHistory(), routes });