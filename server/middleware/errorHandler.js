"use strict";

const { HttpError, toErrorBody } = require("../utils/http");

/** 404 for unmatched routes. */
function notFoundHandler(req, res) {
  return res.status(404).json({
    ok: false,
    error: { code: "ROUTE_NOT_FOUND", message: `No route matches ${req.method} ${req.originalUrl}` },
  });
}

/** Final error handler — never leaks stack traces to the client. */
function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);

  const status = Number(error?.status) || 500;
  const body = toErrorBody(error instanceof HttpError ? error : error);

  if (status >= 500) console.error("[error]", req.method, req.originalUrl, error);
  else console.warn("[warn ]", req.method, req.originalUrl, body.error.message);

  return res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };