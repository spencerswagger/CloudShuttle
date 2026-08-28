// frontend/src/api/credential.js
import { client } from "./client.js";
export const fetchCredentials = () => client.get("/credentials");
export const createCredential = (d) => client.post("/credentials", d);
export const resolveMobiles = (credential, mobiles) => client.post("/dingtalk/resolve-mobile", { credential, mobiles });
export const listDepartments = (credential, deptId) => client.post("/dingtalk/departments", { credential, deptId });
export const listDepartmentUsers = (credential, deptId) => client.post("/dingtalk/department-users", { credential, deptId });