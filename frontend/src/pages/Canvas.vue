<!-- frontend/src/pages/Canvas.vue -->
<script setup>
import { ref, onMounted } from "vue";
import { fetchPipelines, createPipeline, updatePipeline } from "../api/pipeline.js";
import { fetchImages } from "../api/image.js";
import { fetchCredentials } from "../api/credential.js";

const pipelines = ref([]);
const images = ref([]);
const creds = ref([]);
const current = ref({ name: "", spec_json: { nodes: [], edges: [] } });

const addNode = (type) => {
  const node = { id: `n${Date.now()}`, type, step: type,
    params: type === "shell" ? { image: images.value[0]?.image ?? "alpine", command: "", env: [] } : { approverUid: "" } };
  current.value.spec_json.nodes.push(node);
};
const save = async () => {
  current.value.id
    ? await updatePipeline(current.value.id, current.value)
    : Object.assign(current.value, await createPipeline(current.value));
};
</script>
<template>
  <div>
    <input v-model="current.name" placeholder="管道名" />
    <button @click="addNode('shell')">+Shell节点</button>
    <button @click="addNode('approval')">+审批节点</button>
    <button @click="save">保存</button>
    <select v-if="current.spec_json.nodes.length" @change="e=>current.id=+e.target.value">
      <option :value="''">新建</option>
      <option v-for="p in pipelines" :key="p.id" :value="p.id">{{ p.name }}</option>
    </select>
    <section v-for="(n, i) in current.spec_json.nodes" :key="n.id">
      <b>{{ n.id }}</b> <button @click="current.spec_json.nodes.splice(i,1)">删</button>
      <select v-if="n.type==='shell'" v-model="n.params.image">
        <option v-for="im in images" :key="im.image" :value="im.image">{{ im.name }}</option>
      </select>
      <textarea v-if="n.type==='shell'" v-model="n.params.command" placeholder="shell 命令" rows="3"></textarea>
      <input v-else v-model="n.params.approverUid" placeholder="审批人 openId" />
    </section>
  </div>
</template>