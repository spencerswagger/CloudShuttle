<!-- 通用二次确认对话框：危险操作（删除）统一复用 -->
<template>
  <Teleport to="body">
    <Transition name="cd">
      <div v-if="open" class="cd-mask" @click.self="cancel">
        <div class="cd-panel" role="alertdialog" aria-modal="true">
          <div class="cd-head">
            <span class="cd-title display">{{ title }}</span>
            <button type="button" class="cd-x" aria-label="关闭" @click="cancel">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button>
          </div>
          <div class="cd-body">
            <svg class="cd-ico" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>
            </svg>
            <p class="cd-msg">{{ message }}</p>
            <p v-if="detail" class="cd-detail">{{ detail }}</p>
          </div>
          <div class="cd-foot">
            <button type="button" class="btn" :disabled="loading" @click="cancel">取消</button>
            <button type="button" class="btn btn-danger-solid" :disabled="loading" @click="confirm">
              <span v-if="loading" class="spin-ring"></span>
              {{ loading ? loadingText : confirmText }}
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: "确认操作" },
  message: { type: String, default: "" },
  detail: { type: String, default: "" },
  confirmText: { type: String, default: "确认删除" },
  loading: { type: Boolean, default: false },
  loadingText: { type: String, default: "删除中…" },
});
const emit = defineEmits(["confirm", "close", "update:open"]);
const cancel = () => {
  emit("close");
  emit("update:open", false);
};
const confirm = () => emit("confirm");
</script>

<style scoped>
.cd-mask {
  position: fixed; inset: 0; z-index: 120;
  background: rgba(4, 7, 13, 0.62);
  backdrop-filter: blur(3px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.cd-panel {
  width: 420px; max-width: 92vw;
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  border: 1px solid var(--line-strong);
  border-radius: 14px;
  box-shadow: 0 26px 70px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.cd-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 15px 18px; border-bottom: 1px solid var(--line);
}
.cd-title { font-size: 15px; font-weight: 700; letter-spacing: 0.02em; }
.cd-x {
  width: 28px; height: 28px; display: grid; place-items: center;
  color: var(--text-2); background: transparent; border: 1px solid transparent;
  border-radius: 8px; cursor: pointer; transition: all 0.15s var(--ease);
}
.cd-x:hover { color: var(--text-1); background: var(--bg-2); border-color: var(--line); }
.cd-body {
  display: flex; flex-direction: column; align-items: center; text-align: center;
  gap: 8px; padding: 24px 22px 6px;
}
.cd-ico { color: var(--err); margin-bottom: 4px; }
.cd-msg { margin: 0; font-size: 13.5px; line-height: 1.6; color: var(--text-1); word-break: break-word; }
.cd-detail { margin: 0; font-size: 12px; line-height: 1.6; color: var(--text-3); word-break: break-word; }
.cd-foot {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 16px 18px; border-top: 1px solid var(--line); margin-top: 14px;
}
.spin-ring {
  width: 13px; height: 13px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff;
  animation: cdSpin 0.7s linear infinite;
}
@keyframes cdSpin { to { transform: rotate(360deg); } }
.cd-enter-active, .cd-leave-active { transition: all 0.2s var(--ease); }
.cd-enter-from, .cd-leave-to { opacity: 0; transform: scale(0.96); }
</style>