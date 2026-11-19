const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const publicDirectory = path.join(__dirname, "..", "public");

test("inline JavaScript in public pages parses successfully", () => {
  const pages = fs.readdirSync(publicDirectory).filter((file) => file.endsWith(".html"));

  for (const page of pages) {
    const html = fs.readFileSync(path.join(publicDirectory, page), "utf8");
    const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
    for (const [index, script] of [...scripts].entries()) {
      if (script[1].trim()) {
        assert.doesNotThrow(
          () => new vm.Script(script[1], { filename: `${page} inline script ${index + 1}` }),
        );
      }
    }
  }
});

test("authenticated dashboard and admin requests use bearer-token headers", () => {
  for (const page of ["dashboard.html", "admin.html"]) {
    const html = fs.readFileSync(path.join(publicDirectory, page), "utf8");
    const authorizationLines = html
      .split(/\r?\n/)
      .filter((line) => /Authorization/.test(line));
    assert.ok(authorizationLines.length > 0, `${page} should have authenticated requests`);

    for (const line of authorizationLines) {
      assert.match(
        line,
        /Authorization['"]?\s*:\s*`Bearer \$\{localStorage\.getItem\(["']token["']\)\}`/,
        `${page} has a malformed authorization header: ${line.trim()}`,
      );
    }
  }
});

test("home and registration pages expose separate faculty and outside flows", () => {
  const home = fs.readFileSync(path.join(publicDirectory, "index.html"), "utf8");
  const faculty = fs.readFileSync(path.join(publicDirectory, "register.html"), "utf8");
  const outside = fs.readFileSync(
    path.join(publicDirectory, "outside-register.html"),
    "utf8",
  );
  const registrationScript = fs.readFileSync(
    path.join(publicDirectory, "register.js"),
    "utf8",
  );

  assert.match(home, /href="register\.html"/);
  assert.match(home, /href="outside-register\.html"/);
  assert.match(home, /id="facultyPlansGrid"/);
  assert.match(home, /id="outsidePlansGrid"/);
  assert.match(faculty, /data-account-type="faculty"/);
  assert.match(faculty, /name="employee_id" required/);
  assert.match(outside, /data-account-type="outside"/);
  assert.doesNotMatch(outside, /name="employee_id"/);
  assert.match(registrationScript, /\/api\/register\/outside/);
});
