<!-- frontend/src/pages/Executions.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchExecutions, triggerExecution } from "../api/execution.js";
const list = ref([]);
onMounted(async () => { list.value = await fetchExecutions(); });
const trigger = (id) => triggerExecution(id).then(onMounted);
</script>
<template>
  <div>
    <h2>执行历史</h2>
    <ul><li v-for="e in list" :key="e.id">{{ e.id }} · {{ e.status }} <button @click="trigger(e.pipeline_id)">重跑</button></li></ul>
  </div>
</template>