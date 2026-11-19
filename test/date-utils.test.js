const test = require("node:test");
const assert = require("node:assert/strict");
const {
  accountTypeLabel,
  calculateAge,
  escapeCsvCell,
  isAddableMemberType,
  isEligibleForPlan,
  isPlanForAccount,
  participantTypeLabel,
} = require("../public/utils");

const today = new Date("2026-11-19T12:00:00Z");

test("calculates age based on whether the birthday has passed this year", () => {
  assert.equal(calculateAge("2000-11-19", today), 26);
  assert.equal(calculateAge("2000-11-20", today), 25);
});

test("calculates age correctly for leap-day birthdays", () => {
  assert.equal(calculateAge("2000-02-29", new Date("2025-02-28T12:00:00Z")), 24);
  assert.equal(calculateAge("2000-02-29", new Date("2025-03-01T12:00:00Z")), 25);
});

test("rejects malformed, impossible, and future dates of birth", () => {
  assert.equal(calculateAge("not-a-date", today), null);
  assert.equal(calculateAge("2001-02-29", today), null);
  assert.equal(calculateAge("2026-11-20", today), null);
});

test("applies plan age boundaries using the calculated age", () => {
  const plan = { age_min: 18, age_max: 25 };
  assert.equal(isEligibleForPlan("2000-11-20", plan, today), true);
  assert.equal(isEligibleForPlan("2000-11-19", plan, today), false);
  assert.equal(isEligibleForPlan("2020-01-01", plan, today), false);
});

test("rejects dates that exceed the supported 120-year age limit", () => {
  assert.equal(isEligibleForPlan("1900-01-01", { age_min: 0, age_max: null }, today), false);
});

test("labels employee, family, and guest participant types", () => {
  assert.equal(participantTypeLabel("employee"), "Employee");
  assert.equal(participantTypeLabel("outside"), "Outside member");
  assert.equal(participantTypeLabel("family"), "Family member");
  assert.equal(participantTypeLabel("guest"), "Guest");
});

test("labels faculty and outside member account types", () => {
  assert.equal(accountTypeLabel("faculty"), "Faculty");
  assert.equal(accountTypeLabel("outside"), "Outside member");
  assert.equal(accountTypeLabel("unexpected"), "Unknown");
});

test("keeps plan audiences restricted to their matching account type", () => {
  const outsidePlan = { audience: "outside" };
  assert.equal(isPlanForAccount(outsidePlan, "outside"), true);
  assert.equal(isPlanForAccount(outsidePlan, "faculty"), false);
  assert.equal(isPlanForAccount(null, "outside"), false);
});

test("only family and guest participants can be added from the dashboard", () => {
  assert.equal(isAddableMemberType("family"), true);
  assert.equal(isAddableMemberType("guest"), true);
  assert.equal(isAddableMemberType("employee"), false);
  assert.equal(isAddableMemberType("unknown"), false);
});

test("escapes CSV fields and prevents spreadsheet formula execution", () => {
  assert.equal(escapeCsvCell('Guest, "One"'), '"Guest, ""One"""');
  assert.equal(
    escapeCsvCell('=HYPERLINK("https://example.com")'),
    '"\'=HYPERLINK(""https://example.com"")"',
  );
  assert.equal(escapeCsvCell("\n=1+1"), '"\'\n=1+1"');
  assert.equal(escapeCsvCell(null), '""');
});
