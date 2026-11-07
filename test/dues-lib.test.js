// Unit tests for the membership dues rules in lib/dues.js
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const dues = require("../lib/dues");

const pay = (paidOn) => ({ paidOn, amount: 15 });
const member = (payments, extra = {}) => ({ role: "member", status: "active", email: "m@example.com", username: "m", duesPayments: payments, ...extra });

describe("dues rules", () => {
  test("a payment is good for one year from the day paid", () => {
    assert.equal(dues.computeExpiry([pay("2026-11-02")]), "2027-11-02");
  });

  test("29 February rolls to 28 February", () => {
    assert.equal(dues.addOneYear("2028-02-29"), "2029-02-28");
  });

  test("paying early adds the year onto the current expiry date", () => {
    assert.equal(dues.computeExpiry([pay("2026-01-10"), pay("2026-12-01")]), "2028-01-10");
  });

  test("paying after it expired starts a fresh year on the day paid", () => {
    assert.equal(dues.computeExpiry([pay("2024-01-10"), pay("2026-03-05")]), "2027-03-05");
  });

  test("payment order in the list doesn't matter", () => {
    assert.equal(dues.computeExpiry([pay("2026-12-01"), pay("2026-01-10")]), "2028-01-10");
  });

  test("statuses: paid, due soon, expired, not recorded, exempt", () => {
    const opts = (today) => ({ reminderDays: 30, today });
    const m = member([pay("2026-01-01")]); // expires 2027-01-01
    assert.equal(dues.duesStatus(m, opts("2026-06-01")).state, "paid");
    const soon = dues.duesStatus(m, opts("2026-12-02"));
    assert.equal(soon.state, "due-soon");
    assert.equal(soon.daysLeft, 30);
    assert.equal(dues.duesStatus(m, opts("2027-01-01")).state, "expired");
    assert.equal(dues.duesStatus(member([]), opts("2026-06-01")).state, "none");
    assert.equal(dues.duesStatus({ role: "admin" }, opts("2026-06-01")).state, "exempt");
    assert.equal(dues.duesStatus({ role: "webmaster", duesPayments: [pay("2020-01-01")] }, opts("2026-06-01")).state, "exempt");
  });

  test("the reminder goes out once per membership year, and only when due soon", () => {
    const m = member([pay("2026-01-01")]);
    const opts = { reminderDays: 30, today: "2026-12-10" };
    assert.equal(dues.needsReminder(m, opts), true);
    m.duesReminderSentFor = "2027-01-01";
    assert.equal(dues.needsReminder(m, opts), false);
    // Renewing re-arms it for the next year
    m.duesPayments.push(pay("2026-12-15"));
    assert.equal(dues.needsReminder(m, { reminderDays: 30, today: "2027-12-10" }), true);
    // Never for: not yet due, expired, no record, inactive, exempt, no email
    assert.equal(dues.needsReminder(member([pay("2026-01-01")]), { reminderDays: 30, today: "2026-06-01" }), false);
    assert.equal(dues.needsReminder(member([pay("2025-01-01")]), { reminderDays: 30, today: "2026-06-01" }), false);
    assert.equal(dues.needsReminder(member([]), opts), false);
    assert.equal(dues.needsReminder(member([pay("2026-01-01")], { status: "pending" }), opts), false);
    assert.equal(dues.needsReminder(member([pay("2026-01-01")], { role: "admin" }), opts), false);
    assert.equal(dues.needsReminder(member([pay("2026-01-01")], { email: "" }), opts), false);
  });

  test("the PayPal link has the amount and the member's username", () => {
    const url = new URL(dues.paypalDuesLink(15, "caver1"));
    assert.equal(url.hostname, "www.paypal.com");
    assert.equal(url.searchParams.get("amount"), "15.00");
    assert.equal(url.searchParams.get("business"), "Floridacavesurvey@gmail.com");
    assert.match(url.searchParams.get("item_name"), /caver1/);
  });

  test("rejects impossible dates", () => {
    assert.equal(dues.isValidDate("2026-02-30"), false);
    assert.equal(dues.isValidDate("2026-13-01"), false);
    assert.equal(dues.isValidDate("Nov 2"), false);
    assert.equal(dues.isValidDate("2026-11-02"), true);
  });
});
