<!-- frontend/src/pages/Images.vue -->
<script setup>
import { ref, computed, onMounted } from "vue";
import { fetchImages } from "../api/image.js";

const list = ref([]);
onMounted(async () => { list.value = await fetchImages().catch(() => []); });

const grouped = computed(() => {
  const map = {};
  for (const im of list.value) {
    const cat = im.category || "通用";
    (map[cat] = map[cat] || []).push(im);
  }
  return map;
});

const PALETTE = ["var(--info)", "var(--accent)", "var(--ember)", "var(--ok)", "var(--info)"];
const catColor = (i) => PALETTE[i % PALETTE.length];
const cats = () => Object.keys(grouped.value);
</script>

<template>
  <div class="page">
    <header class="page-head rise">
      <div>
        <h1 class="head-title display">预置镜像</h1>
        <p class="head-sub muted">为 shell 节点提供的开箱即用运行环境，由平台统一维护。</p>
      </div>
      <span class="mono total">{{ list.length }} 个镜像</span>
    </header>

    <div v-if="cats().length === 0" class="card empty rise">
      <svg viewBox="0 0 24 24" width="42" height="42" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20.2 6.1l-8-3.6a2 2 0 0 0-1.6 0l-8 3.6A2 2 0 0 0 1.5 8v8a2 2 0 0 0 1.3 1.9l8 3.6a2 2 0 0 0 1.6 0l8-3.6a2 2 0 0 0 1.3-1.9V8a2 2 0 0 0-1.5-1.9zM2 8l10 4.5L22 8M12 12.5V21"/>
      </svg>
      <p class="dim">暂无可用镜像。</p>
    </div>

    <section v-for="(ims, cat) in grouped" :key="cat" class="cat rise" v-else>
      <div class="cat-label">
        <span class="cat-bar" :style="{ background: catColor(cats().indexOf(cat)) }"></span>
        <h2 class="cat-name display">{{ cat }}</h2>
        <span class="mono count">{{ ims.length }}</span>
      </div>
      <div class="img-grid stagger">
        <article
          v-for="im in ims"
          :key="im.id"
          class="img-card card"
          :style="{ '--c': catColor(cats().indexOf(cat)) }"
        >
          <span class="img-ico">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M20.2 6.1l-8-3.6a2 2 0 0 0-1.6 0l-8 3.6A2 2 0 0 0 1.5 8v8a2 2 0 0 0 1.3 1.9l8 3.6a2 2 0 0 0 1.6 0l8-3.6a2 2 0 0 0 1.3-1.9V8a2 2 0 0 0-1.5-1.9zM2 8l10 4.5L22 8M12 12.5V21"/>
            </svg>
          </span>
          <h3 class="img-name">{{ im.name }}</h3>
          <p class="img-image mono">{{ im.image }}</p>
        </article>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; gap: 26px; max-width: 1080px; }
.page-head { display: flex; align-items: flex-end; justify-content: space-between; padding-bottom: 2px; }
.head-title { margin: 0; font-size: 26px; font-weight: 700; }
.head-sub { margin: 6px 0 0; font-size: 13.5px; }
.total { font-size: 12px; color: var(--accent); background: var(--accent-soft); border-radius: 100px; padding: 5px 12px; }

.cat { display: flex; flex-direction: column; gap: 14px; }
.cat-label { display: flex; align-items: center; gap: 10px; }
.cat-bar { width: 3px; height: 16px; border-radius: 3px; }
.cat-name { margin: 0; font-size: 15px; font-weight: 700; letter-spacing: .03em; }
.count { font-size: 11px; color: var(--text-3); }
.img-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.img-card {
  padding: 20px; display: flex; flex-direction: column; align-items: flex-start;
  border-top: 3px solid transparent;
  transition: transform .2s var(--ease), border-color .2s var(--ease);
}
.img-card:hover { transform: translateY(-3px); border-top-color: var(--c); }
.img-ico {
  width: 44px; height: 44px; display: grid; place-items: center;
  color: var(--c);
  background: color-mix(in srgb, var(--c) 12%, transparent);
  border: 1px solid var(--line); border-radius: 12px;
  margin-bottom: 14px;
}
.img-name { margin: 0; font-family: var(--font-display); font-size: 14.5px; font-weight: 600; }
.img-image { margin: 5px 0 0; font-size: 12px; color: var(--text-2); word-break: break-all; line-height: 1.5; }
</style>