"use strict";

/** Error carrying an HTTP status so controllers can stay thin. */
class HttpError extends Error {
  constructor(status, message, code = "ERROR", details = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Wraps async express handlers so rejections reach the error middleware. */
function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

/** Normalizes any thrown value into a serializable error response body. */
function toErrorBody(error) {
  const status = Number(error?.status) || 500;
  return {
    ok: false,
    error: {
      code: error?.code || (status === 500 ? "INTERNAL_ERROR" : "REQUEST_FAILED"),
      message: error?.message || "Unexpected server error",
      ...(error?.details ? { details: error.details } : {}),
    },
  };
}

module.exports = { HttpError, asyncHandler, toErrorBody };