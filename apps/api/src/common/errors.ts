export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg: string, details?: unknown) =>
  new ApiError(400, "BAD_REQUEST", msg, details);
export const unauthorized = (msg = "Unauthorized") =>
  new ApiError(401, "UNAUTHORIZED", msg);
export const forbidden = (msg = "Forbidden") => new ApiError(403, "FORBIDDEN", msg);
export const notFound = (msg = "Not found") => new ApiError(404, "NOT_FOUND", msg);
export const conflict = (msg: string) => new ApiError(409, "CONFLICT", msg);
export const tooManyRequests = (msg = "Too many requests") =>
  new ApiError(429, "TOO_MANY_REQUESTS", msg);
