<template>
  <div class="shell">
    <div class="grid-bg"></div>

    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2 L19 8 L19 16 L12 22 L5 16 L5 8 Z" />
            <path d="M12 2 L12 22 M5 8 L19 16 M19 8 L5 16" />
          </svg>
        </div>
        <div class="brand-text">
          <span class="display brand-name">CloudShuttle</span>
          <span class="brand-sub">SERVERLESS OPS CONSOLE</span>
        </div>
      </div>

      <nav class="nav">
        <RouterLink
          v-for="item in nav"
          :key="item.to"
          :to="item.to"
          class="nav-item"
          :style="{ '--i': item.idx }"
        >
          <svg class="nav-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
            <path :d="item.iconA" />
            <path :d="item.iconB" v-if="item.iconB" />
          </svg>
          <span class="nav-label">{{ item.label }}</span>
        </RouterLink>
      </nav>

      <div class="sidebar-foot">
        <span class="live-dot"></span>
        <span class="dim mono-tag">Control Plane</span>
      </div>
    </aside>

    <main class="main">
      <RouterView />
    </main>
  </div>
</template>

<script setup>
const nav = [
  { to: "/", label: "管道画布", iconA: "M3 6h11M14 6a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM3 12h11M14 12a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0zM3 18h11M14 18a2.5 2.5 0 1 0 5 0 2.5 2.5 0 0 0-5 0z" },
  { to: "/credentials", label: "凭证", iconA: "M12 3a5 5 0 0 1 5 5 3 3 0 0 1 3 3v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-3a3 3 0 0 1 2-2.8", iconB: "M8.5 11.5V9a3.5 3.5 0 0 1 7 0" },
  { to: "/images", label: "镜像", iconA: "M20.2 6.1l-8-3.6a2 2 0 0 0-1.6 0l-8 3.6A2 2 0 0 0 1.5 8v8a2 2 0 0 0 1.3 1.9l8 3.6a2 2 0 0 0 1.6 0l8-3.6a2 2 0 0 0 1.3-1.9V8a2 2 0 0 0-1.5-1.9zM2 8l10 4.5L22 8M12 12.5V21" },
  { to: "/executions", label: "执行", iconA: "M21 7a4 4 0 0 1-6.6 3L9 15a4 4 0 1 1-2-2l5.4-5A4 4 0 1 1 21 7z" },
];
</script>

<style scoped>
.shell { display: flex; height: 100%; position: relative; z-index: 1; }

/* ---- 侧边栏 ---- */
.sidebar {
  width: 232px;
  flex: 0 0 232px;
  display: flex;
  flex-direction: column;
  padding: 22px 16px 18px;
  background: linear-gradient(180deg, rgba(14, 20, 33, 0.92), rgba(11, 14, 21, 0.96));
  border-right: 1px solid var(--line);
  backdrop-filter: blur(8px);
}
.brand { display: flex; align-items: center; gap: 12px; padding: 2px 8px 22px; }
.brand-mark {
  width: 38px; height: 38px; flex: 0 0 38px;
  display: grid; place-items: center;
  color: var(--accent);
  background: var(--accent-soft);
  border: 1px solid var(--line-strong);
  border-radius: 11px;
  box-shadow: 0 0 0 4px rgba(84, 208, 198, 0.06);
}
.brand-name { font-size: 17px; font-weight: 700; letter-spacing: 0.01em; color: var(--text-1); }
.brand-sub {
  display: block;
  font-family: var(--font-mono);
  font-size: 8.5px; letter-spacing: 0.16em;
  color: var(--text-3); margin-top: 2px;
}

.nav { display: flex; flex-direction: column; gap: 4px; flex: 1; }
.nav-item {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 12px;
  border-radius: 10px;
  color: var(--text-2);
  text-decoration: none;
  font-family: var(--font-display);
  font-size: 13.5px; font-weight: 500;
  letter-spacing: 0.02em;
  border: 1px solid transparent;
  transition: all 0.16s var(--ease);
}
.nav-item:hover { color: var(--text-1); background: var(--bg-2); }
.nav-item.router-link-active {
  color: var(--text-1);
  background: linear-gradient(180deg, var(--bg-3), var(--bg-2));
  border-color: var(--line-strong);
  box-shadow: inset 3px 0 0 var(--accent);
}
.nav-ico { color: currentColor; flex: 0 0 auto; }
.sidebar-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: 12px; padding: 12px 8px 0;
  border-top: 1px solid var(--line);
}
.live-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--ok);
  box-shadow: 0 0 0 3px var(--ok-soft);
  animation: pulseDot 1.8s ease-in-out infinite;
}

/* ---- 内容区 ---- */
.main {
  flex: 1;
  min-width: 0;
  overflow: auto;
  height: 100%;
  padding: 28px 34px 48px;
}
</style>