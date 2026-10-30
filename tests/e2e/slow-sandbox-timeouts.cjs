"use strict";

const http = require("node:http");

const sandboxDeadlineMs = 600_000;
const originalSetTimeout = global.setTimeout;
global.setTimeout = (handler, delay, ...args) =>
  originalSetTimeout(
    handler,
    delay === 20_000 || delay === 145_000 ? sandboxDeadlineMs : delay,
    ...args,
  );

const originalResponseTimeout = http.ServerResponse.prototype.setTimeout;
http.ServerResponse.prototype.setTimeout = function setSandboxResponseTimeout(
  delay,
  callback,
) {
  return originalResponseTimeout.call(
    this,
    delay === 150_000 ? sandboxDeadlineMs + 5_000 : delay,
    callback,
  );
};
