// 部署时修改：把 apiBase 指到控制面后端。
// 默认同源 /api 适用「docker-compose / 本机 nginx 反代」；
// 云端 CDN 无反向代理，必须改为控制面的完整地址，如：
//   window.CloudShuttleConfig = { apiBase: "https://control.example.com/api" };
window.CloudShuttleConfig = { apiBase: "/api" };