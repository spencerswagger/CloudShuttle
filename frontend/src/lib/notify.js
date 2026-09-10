// frontend/src/lib/notify.js —— 全局轻提示（错误 toast，含可复制 requestId）
import { reactive } from "vue";

export const toasts = reactive([]);
let seq = 0;

export function notify({ type = "error", message = "操作失败，请稍后再试", requestId = "" } = {}) {
  const id = ++seq;
  toasts.push({ id, type, message, requestId });
  window.setTimeout(() => {
    const i = toasts.findIndex((t) => t.id === id);
    if (i >= 0) toasts.splice(i, 1);
  }, 7000);
}