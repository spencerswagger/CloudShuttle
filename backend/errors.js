// backend/errors.js —— 统一 HTTP 错误契约
// 响应给用户的 message 必须人类可读、不泄露技术细节；技术细节放 detail，仅写入日志。
export class HttpError extends Error {
  constructor(status = 500, code = "INTERNAL_ERROR", message = "服务暂时不可用，请稍后再试", detail) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}