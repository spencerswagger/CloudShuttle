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
// 用表单输入的 AK/SK/Region 探测该地域的交换机与安全组（创建凭证时提供下拉候选，不落库）
export const probeEciNetworks = (d) => client.post("/eci/probe-networks", d, { silent: true, timeout: 8000 });