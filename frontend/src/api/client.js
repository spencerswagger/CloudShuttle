// frontend/src/api/client.js
import axios from "axios";
export const client = axios.create({ baseURL: "/api" });
client.interceptors.response.use((r) => r.data, (e) => Promise.reject(e.response?.data ?? e));