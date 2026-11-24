// Unit tests for the token-validation layer: extractBearer, the error-code
// mapping, and the 401/403 status split.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TokenError, extractBearer, mapJoseError } from "../lib/auth.js";

test("extractBearer accepts a well-formed Bearer header", () => {
  assert.equal(extractBearer("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearer("bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(extractBearer("  Bearer   tok  "), "tok");
});

test("extractBearer rejects anything that is not a Bearer token", () => {
  assert.equal(extractBearer(undefined), null);
  assert.equal(extractBearer(""), null);
  assert.equal(extractBearer("Basic dXNlcjpwd2Q="), null);
  assert.equal(extractBearer("Bearer"), null);
  assert.equal(extractBearer("Bearer  "), null);
  assert.equal(extractBearer("Bearer a b"), null);
});

test("TokenError status split: identity failures 401, wrong-scope-of-use 403", () => {
  for (const reason of ["missing", "malformed", "unsupported-alg", "unknown-key", "invalid", "expired", "foreign-issuer"]) {
    const err = new TokenError(reason, "x");
    assert.equal(err.status, 401, reason);
    assert.equal(err.errorCode, "invalid_token", reason);
  }
  for (const reason of ["wrong-audience", "insufficient-scope"]) {
    const err = new TokenError(reason, "x");
    assert.equal(err.status, 403, reason);
    assert.equal(err.errorCode, "insufficient_scope", reason);
  }
});

test("mapJoseError maps jose failure codes to verdicts", () => {
  assert.equal(mapJoseError({ code: "ERR_JWT_EXPIRED", message: "expired" }).reason, "expired");
  assert.equal(
    mapJoseError({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "iss", message: "iss" }).reason,
    "foreign-issuer",
  );
  assert.equal(
    mapJoseError({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "aud", message: "aud" }).reason,
    "wrong-audience",
  );
  assert.equal(
    mapJoseError({ code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED", message: "sig" }).reason,
    "invalid",
  );
  // Unknown failures fail closed as plain invalid — never as a pass.
  assert.equal(mapJoseError(new Error("weird")).reason, "invalid");
});
