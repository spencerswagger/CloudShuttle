// frontend/src/api/credential.js
import { client } from "./client.js";
export const fetchCredentials = () => client.get("/credentials");
export const getCredential = (id) => client.get(`/credentials/${id}`, { silent: true });
export const createCredential = (d) => client.post("/credentials", d);
export const updateCredential = (id, d) => client.put(`/credentials/${id}`, d);
export const deleteCredential = (id) => client.delete(`/credentials/${id}`);
export const resolveMobiles = (credential, mobiles) => client.post("/dingtalk/resolve-mobile", { credential, mobiles });
export const listDepartments = (credential, deptId) => client.post("/dingtalk/departments", { credential, deptId });
export const listDepartmentUsers = (credential, deptId) => client.post("/dingtalk/department-users", { credential, deptId });
// 用 ECI 凭证探测阿里云可购规格（AK 在服务端解密使用）
export const fetchEciSpecs = (credential) => client.get(`/eci/specs/${encodeURIComponent(credential)}`, { silent: true });