import { test } from "node:test";
import assert from "node:assert/strict";
import { explain, HttpError } from "../src/errors.js";

test("failed requests are explained in words a visitor can act on", () => {
  assert.match(explain(new TypeError("Failed to fetch"), "load the launches"), /not answering, so this page could not load the launches/);
  assert.match(explain(new HttpError(503), "load the audit"), /restarting or overloaded.*\(error 503\)/);
  assert.match(explain(new HttpError(500), "load the audit"), /hit a problem.*nothing on the chain has changed/);
  assert.match(explain(new HttpError(404), "load the audit"), /reload it/);
  assert.match(explain(new HttpError(400, "this claim has expired; start again"), "claim"), /this claim has expired; start again/);
  assert.match(explain(Object.assign(new Error("x"), { name: "TimeoutError" }), "load"), /took too long/);
  assert.doesNotMatch(explain(new TypeError("Failed to fetch"), "x"), /Failed to fetch/);
});
