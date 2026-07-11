import assert from "node:assert/strict";
import test from "node:test";
import { isModuleNotFound } from "./util.ts";

test("isModuleNotFound recognizes Node's module-not-found spellings", () => {
  assert.equal(isModuleNotFound({ code: "ERR_MODULE_NOT_FOUND" }), true);
  assert.equal(isModuleNotFound({ code: "MODULE_NOT_FOUND" }), true);
  assert.equal(isModuleNotFound({ message: "Cannot find module 'x'" }), true);
  assert.equal(isModuleNotFound({ message: "Cannot find package 'x'" }), true);
  assert.equal(isModuleNotFound(new Error("boom")), false);
  assert.equal(isModuleNotFound({ code: "EACCES" }), false);
  assert.equal(isModuleNotFound(undefined), false);
});
