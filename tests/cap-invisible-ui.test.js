const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(ROOT, "static/js/cap-invisible.js"), "utf8");

function fakeForm() {
  const attributes = { "data-cap-endpoint": "https://cap.example/site/" };
  const field = { name: "cap-token", value: "" };
  const button = { disabled: false };
  const error = { textContent: "", hidden: true };
  let listener = null;
  let submits = 0;

  return {
    field,
    button,
    error,
    get submits() { return submits; },
    submitHandler: (...args) => listener(...args),
    getAttribute: (name) => attributes[name] || null,
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (type, handler) => { listener = handler; },
    querySelector: (selector) => {
      if (selector === 'input[name="cap-token"]') return field;
      if (selector === 'button[type="submit"], input[type="submit"]') return button;
      if (selector === ".checkout-error, .form-error, .cap-error") return error;
      return null;
    },
    requestSubmit: () => { submits += 1; }
  };
}

function run(form, Cap) {
  const context = {
    window: { Cap },
    document: { querySelectorAll: () => [form] }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

test("invisible Cap writes the token before the form submits", async () => {
  const form = fakeForm();
  const context = run(form, function() {
    this.solve = async () => ({ token: "cap-invisible-token" });
  });
  let prevented = false;
  let stopped = false;

  form.submitHandler({
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; }
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(form.field.value, "cap-invisible-token");
  assert.equal(form.button.disabled, false);
  assert.equal(form.submits, 1);

  prevented = false;
  stopped = false;
  form.submitHandler({
    preventDefault: () => { prevented = true; },
    stopImmediatePropagation: () => { stopped = true; }
  });

  assert.equal(prevented, false);
  assert.equal(stopped, false);
  assert.equal(typeof context.window.capInvisible.solve, "function");
});

test("invisible Cap keeps the form unsent when solving fails", async () => {
  const form = fakeForm();
  run(form, function() {
    this.solve = async () => { throw new Error("instr_blocked"); };
  });

  form.submitHandler({
    preventDefault() {},
    stopImmediatePropagation() {}
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(form.field.value, "");
  assert.equal(form.submits, 0);
  assert.equal(form.button.disabled, false);
  assert.equal(form.error.hidden, false);
  assert.match(form.error.textContent, /Verification failed/);
});
