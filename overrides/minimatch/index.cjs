"use strict";

// CJS entry: ESLint loads minimatch with require(), and the v3 callers need a function export.
/* eslint-disable @typescript-eslint/no-require-imports */
const real = require("minimatch-11");

function minimatch(path, pattern, options) {
  return real.minimatch(path, pattern, options);
}

Object.assign(minimatch, real, {
  minimatch: real.minimatch,
  Minimatch: real.Minimatch,
});

module.exports = minimatch;
