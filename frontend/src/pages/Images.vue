<!-- frontend/src/pages/Images.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchImages } from "../api/image.js";
const list = ref([]);
onMounted(async () => { list.value = await fetchImages(); });
</script>
<template>
  <div><h2>预置镜像</h2><pre>{{ list }}</pre></div>
</template>