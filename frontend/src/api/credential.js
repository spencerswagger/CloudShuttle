// frontend/src/api/credential.js
import { client } from "./client.js";
export const fetchCredentials = () => client.get("/credentials");
export const createCredential = (d) => client.post("/credentials", d);
export const fetchDingtalkGroups = (credential) => client.post("/dingtalk/groups", { credential });