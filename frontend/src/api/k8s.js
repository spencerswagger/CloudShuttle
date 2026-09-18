// frontend/src/api/k8s.js
import { client } from "./client.js";
// Shell 节点「命名空间」下拉：按 k8s 凭证名列出集群命名空间
export const fetchNamespaces = (credential) => client.post("/k8s/namespaces", { credential });