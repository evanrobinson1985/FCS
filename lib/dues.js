// Membership dues: pure date/status logic, shared by server.js and the tests.
//
// Rules (agreed with the site owner):
// - Dues are yearly. A payment makes membership good for one year.
// - Paying early (before the current membership expires) adds the year
//   onto the current expiry date, so nobody loses the time they had left.
//   Paying after it has expired starts the new year on the day paid.
// - Admins and webmasters are exempt: no dues tracked, shown or emailed.
// - An account with no recorded payment is "none" (not recorded) - never
//   treated as overdue, never emailed, never blocked.
//
// All dates are calendar dates ("YYYY-MM-DD") in Florida's (Eastern) time,
// so "today" matches what the members see on their calendars.

const TIME_ZONE = "America/New_York";
const EXEMPT_ROLES = ["admin", "webmaster"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function todayISO(now = new Date()) {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function isValidDate(iso) {
  if (typeof iso !== "string" || !ISO_DATE.test(iso)) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Same day next year; 29 February becomes 28 February.
function addOneYear(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const day = m === 2 && d === 29 ? 28 : d;
  return `${y + 1}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Whole days from date a to date b (positive when b is later)
function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
}

// Works out the expiry date from the full payment history, in date order,
// so deleting a mistaken payment recalculates everything correctly.
function computeExpiry(payments) {
  const list = (payments || [])
    .filter((p) => p && isValidDate(p.paidOn))
    .map((p, i) => ({ p, i }))
    .sort((a, b) => (a.p.paidOn === b.p.paidOn ? a.i - b.i : a.p.paidOn < b.p.paidOn ? -1 : 1));
  let expires = null;
  for (const { p } of list) {
    const base = expires && expires > p.paidOn ? expires : p.paidOn;
    expires = addOneYear(base);
  }
  return expires;
}

function isExempt(user) {
  return !!user && EXEMPT_ROLES.includes(user.role);
}

// { state, expires, daysLeft }
//   state: "exempt" | "none" | "paid" | "due-soon" | "expired"
//   daysLeft: days until it expires (0 or less once expired)
function duesStatus(user, { reminderDays = 30, today = todayISO() } = {}) {
  if (isExempt(user)) return { state: "exempt", expires: null, daysLeft: null };
  const expires = computeExpiry(user && user.duesPayments);
  if (!expires) return { state: "none", expires: null, daysLeft: null };
  const daysLeft = daysBetween(today, expires);
  if (daysLeft <= 0) return { state: "expired", expires, daysLeft };
  if (daysLeft <= reminderDays) return { state: "due-soon", expires, daysLeft };
  return { state: "paid", expires, daysLeft };
}

// Should this account get the automatic "expires in N days" reminder now?
// Once per membership year: the reminder is keyed to the expiry date it
// was sent for, so a renewal (new expiry date) re-arms it.
function needsReminder(user, { reminderDays = 30, today = todayISO() } = {}) {
  if (!user || user.status !== "active" || !user.email || isExempt(user)) return false;
  const s = duesStatus(user, { reminderDays, today });
  if (s.state !== "due-soon") return false;
  return user.duesReminderSentFor !== s.expires;
}

// A PayPal link for paying dues, with the amount filled in and the member's
// username in the payment description so the payment can be matched.
function paypalDuesLink(amount, username, business = "Floridacavesurvey@gmail.com") {
  const params = new URLSearchParams({
    business,
    amount: Number(amount).toFixed(2),
    currency_code: "USD",
    item_name: `Florida Cave Survey membership dues - ${username}`,
  });
  return `https://www.paypal.com/donate/?${params.toString()}`;
}

function formatDate(iso) {
  if (!isValidDate(iso)) return iso || "";
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
}

function reminderEmail(user, status, amount, siteUrl) {
  const name = user.fullName || user.username;
  return {
    subject: `Florida Cave Survey - Your membership expires ${formatDate(status.expires)}`,
    text:
      `Hi ${name},\n\n` +
      `Your Florida Cave Survey membership expires on ${formatDate(status.expires)} ` +
      `(in ${status.daysLeft} day${status.daysLeft === 1 ? "" : "s"}).\n\n` +
      `Yearly dues are $${Number(amount).toFixed(2)}. You can pay with PayPal here:\n` +
      `${paypalDuesLink(amount, user.username)}\n\n` +
      "Paying before it expires adds a full year on top of the time you have left.\n\n" +
      `You can check your membership any time after logging in at ${siteUrl}/portal\n\n` +
      "Thank you for supporting the Florida Cave Survey!",
  };
}

function overdueEmail(user, status, amount, siteUrl) {
  const name = user.fullName || user.username;
  return {
    subject: "Florida Cave Survey - Your membership dues are due",
    text:
      `Hi ${name},\n\n` +
      `Your Florida Cave Survey membership expired on ${formatDate(status.expires)}. ` +
      "Please pay your yearly dues to regain access to the site.\n\n" +
      `Yearly dues are $${Number(amount).toFixed(2)}. You can pay with PayPal here:\n` +
      `${paypalDuesLink(amount, user.username)}\n\n` +
      "If you've already paid, thank you - just reply to this email and a webmaster will update your account.\n\n" +
      `${siteUrl}/portal`,
  };
}

module.exports = {
  TIME_ZONE,
  todayISO,
  isValidDate,
  addOneYear,
  daysBetween,
  computeExpiry,
  isExempt,
  duesStatus,
  needsReminder,
  paypalDuesLink,
  formatDate,
  reminderEmail,
  overdueEmail,
};
