const JS_CODE_LITERAL_ESCAPES = {
  "<": "\\u003C",
  ">": "\\u003E",
  "/": "\\u002F",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

// JSON.stringify leaves `<`, `>`, `/`, and the line separators U+2028/U+2029
// intact. Those characters can break out of a script when the text is pasted
// into evaluated JavaScript, so escape them after stringify.
export function jsCodeLiteral(value) {
  return JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (character) => JS_CODE_LITERAL_ESCAPES[character]);
}
