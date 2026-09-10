// frontend/src/api/execution.js
import { client } from "./client.js";
export const fetchExecutions = () => client.get("/executions");
export const getExecution = (id) => client.get(`/executions/${id}`);
export const triggerExecution = (pipelineId) => client.post("/executions", { pipelineId });
export const cancelExecution = (id) => client.post(`/executions/${id}/cancel`);
export const rerunExecution = (id) => client.post(`/executions/${id}/rerun`);