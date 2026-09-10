// 全局接口在途请求计数器：由 axios 拦截器统一驱动，
// pending>0 时 App 顶部显示进度条，保证所有 API 调用都有 loading 反馈。
import { ref } from "vue";

export const pending = ref(0);
export const isBusy = () => pending.value > 0;