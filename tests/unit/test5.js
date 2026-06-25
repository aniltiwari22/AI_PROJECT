// Ashu Codex AI - Unit Test Framework
const assert = require('assert');
const { validatePayload } = require('../../backend/src/middleware/middleware1');

describe('Ashu Codex AI Core Unit Suite', () => {
  it('should successfully pass parsing validation with structural fields', () => {
    const req = { method: 'POST', body: { prompt: 'Analyze repository context' } };
    const res = {};
    let calledNext = false;
    const next = () => { calledNext = true; };

    validatePayload(req, res, next);
    assert.strictEqual(calledNext, true);
  });

  it('should explicitly fail or intercept when structural fields are empty', () => {
    const req = { method: 'POST', body: {} };
    let statusSet = null;
    let jsonSent = null;
    const res = {
      status(code) { statusSet = code; return this; },
      json(data) { jsonSent = data; }
    };
    const next = () => {};

    validatePayload(req, res, next);
    assert.strictEqual(statusSet, 400);
    assert.ok(jsonSent.error);
  });
});