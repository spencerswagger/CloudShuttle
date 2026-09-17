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
// 用草稿 secret 测试连接连通性（数据库 / k8s 集群 / 私服 / 仓库 / 对象存储；不落库）
export const testDbConnection = (d) => client.post("/credentials/test", d, { silent: true, timeout: 8000 });
// 网页生成 SSH 密钥对（私钥回填表单、公钥供复制配置授权，如 GitHub Deploy keys）
export const genSshKeypair = () => client.post("/credentials/ssh-keygen", {}, { silent: true, timeout: 8000 });