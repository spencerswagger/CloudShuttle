// frontend/src/api/pipeline.js
import { client } from "./client.js";
export const fetchPipelines = () => client.get("/pipelines");
export const getPipeline = (id) => client.get(`/pipelines/${id}`, { silent: true });
export const createPipeline = (d) => client.post("/pipelines", d);
export const updatePipeline = (id, d) => client.put(`/pipelines/${id}`, d);
export const deletePipeline = (id) => client.delete(`/pipelines/${id}`);
export const runPipeline = (id) => client.post(`/pipelines/${id}/run`);