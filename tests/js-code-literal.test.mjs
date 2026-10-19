import assert from "node:assert/strict";
import test from "node:test";
import { jsCodeLiteral } from "../scripts/lib/js-code-literal.mjs";

test("jsCodeLiteral keeps certification strings identical to JSON.stringify", () => {
  for (const value of ["PREPARE", "TRACK", "Snake", "Salary cap", "Marquez Valdes-Scantling"]) {
    assert.equal(jsCodeLiteral(value), JSON.stringify(value));
  }
});

test("jsCodeLiteral escapes script breakout characters without changing the value", () => {
  const value = "</script>\u2028/\u2029";
  const literal = jsCodeLiteral(value);
  assert.equal(literal.includes("<"), false);
  assert.equal(literal.includes(">"), false);
  assert.equal(literal.includes("/"), false);
  assert.equal(literal.includes("\u2028"), false);
  assert.equal(literal.includes("\u2029"), false);
  assert.equal(JSON.parse(literal), value);
});
