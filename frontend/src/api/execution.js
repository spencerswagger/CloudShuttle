// frontend/src/api/execution.js
import { client } from "./client.js";
export const fetchExecutions = () => client.get("/executions");
export const triggerExecution = (pipelineId) => client.post("/executions", { pipelineId });