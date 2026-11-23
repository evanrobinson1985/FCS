// Recognises common web attacks in a request: injection attempts in the
// address, query or JSON body, known attack tools by their User-Agent, and
// probes for files that attackers look for on every website.
//
// Pure functions only (no I/O), so they're easy to test; server.js decides
// what to record, who to tell, and whether to restrict an account.
//
// The patterns aim at things ordinary use of this site never sends. Cave
// notes and narratives are free text, so plain words ("select", "union",
// "sleep") never match on their own - only the shapes attacks use.

const CATEGORY_LABELS = {
  sqli: "Database (SQL) injection",
  xss: "Script injection (XSS)",
  traversal: "Path traversal / file access",
  command: "Command injection",
  template: "Template / Log4Shell injection",
  nosql: "Object or NoSQL injection",
  tool: "Attack tool",
  probe: "Probing for files attackers look for",
  forged: "Forged or tampered login token",
  bruteforce: "Password guessing",
};

const SEVERITY = {
  sqli: "high", xss: "high", traversal: "high", command: "high", template: "high", nosql: "high",
  forged: "high", tool: "medium", bruteforce: "medium", probe: "low",
};

const RULES = [
  ["sqli", /\bunion\b[\s\S]{0,40}?\bselect\b/i],
  ["sqli", /['"`]\s*\)?\s*(or|and)\s+['"`]?\w+['"`]?\s*(=|like)\s*['"`]?\w+/i],
  ["sqli", /;\s*(drop|delete\s+from|insert\s+into|update\s+\w+\s+set|truncate|alter\s+table|exec)\b/i],
  ["sqli", /\b(sleep|benchmark|pg_sleep)\s*\(\s*\d+\s*[,)]|\bwaitfor\s+delay\b|\binformation_schema\b|\bxp_cmdshell\b|\bload_file\s*\(/i],
  ["xss", /<\s*\/?\s*(script|iframe|object|embed|applet|base|meta)\b/i],
  // (bounded: an open "[^>]*" re-scans to the end of the text from every "<",
  // so text full of "<" took seconds - a way to freeze the server)
  ["xss", /<[^>]{0,300}\bon(error|load|mouseover|mouseenter|focus|blur|click|animationstart|toggle|pointerover)\s*=/i],
  ["xss", /\bjavascript\s*:|\bvbscript\s*:|\bdata\s*:\s*text\/html|document\.cookie|\balert\s*\(\s*(1|document|origin)/i],
  ["traversal", /(\.\.[\/\\]){1,}|%2e%2e(%2f|%5c|\/|\\)|%252e%252e|\.\.%2f|\.\.%5c/i],
  ["traversal", /\/etc\/(passwd|shadow|hosts)\b|\bc:\\windows\\|\bboot\.ini\b|\bproc\/self\/environ\b|\bfile:\/\//i],
  // A shell command after a separator, in the shape attacks use: a path,
  // a flag or a URL after it, or a bare information command
  ["command", /[;&|`]\s*(cat|ls|wget|curl|nc|ncat|bash|sh|python\d?|perl|powershell|rm|chmod)\s+(\/|-\w|https?:|~)/i],
  ["command", /[;&|`]\s*(id|whoami|uname|ifconfig|pwd)\s*([;&|`#]|$)|\|\s*(bash|sh)\b/i],
  ["command", /\$\(\s*(cat|id|whoami|uname|wget|curl|nc|bash|sh)\b/i],
  ["template", /\$\{\s*jndi\s*:|\{\{\s*\d+\s*\*\s*\d+\s*\}\}|\$\{\s*\d+\s*\*\s*\d+\s*\}|<%=?\s*[\w.]+|#\{\s*\d+\s*\*\s*\d+\s*\}/i],
  ["nosql", /__proto__|\bconstructor\s*\.\s*prototype\b|\bconstructor\s*\[\s*['"]prototype/i],
];

const NOSQL_KEYS = /^(\$where|\$ne|\$gt|\$gte|\$lt|\$lte|\$regex|\$in|\$nin|\$or|\$and|\$expr|__proto__|constructor|prototype)$/;

const ATTACK_TOOLS =
  /\b(sqlmap|nikto|nmap|masscan|zgrab|acunetix|nessus|openvas|wpscan|dirbuster|gobuster|ffuf|feroxbuster|nuclei|wfuzz|hydra|burpcollaborator|commix|xsstrike|jaeles|arachni|w3af|whatweb|netsparker|qualys)\b/i;

// Files and addresses this site doesn't have, that bots and attackers
// request on every website hoping to find secrets or admin panels
const PROBE_PATHS =
  /(^|\/)(\.env|\.git|\.svn|\.hg|\.aws|\.ssh|\.htaccess|\.htpasswd|\.ds_store|\.vscode|\.idea|wp-admin|wp-login|wp-content|wp-includes|xmlrpc|phpmyadmin|pma|myadmin|adminer|cgi-bin|server-status|actuator|boaform|hnap1|vendor\/phpunit|telescope|solr|jenkins|manager\/html|console|owa|autodiscover|config\.json|config\.yml|docker-compose|web\.config|backup\.(sql|zip|tar)|dump\.sql|database\.sql|id_rsa)(\/|$|\.|\?)/i;
const PROBE_EXTENSIONS = /\.(php\d?|phtml|asp|aspx|jsp|jspx|cgi|pl|cfm|env|bak|old|sql|swp)$/i;

// Never scanned (and never logged): what people type as passwords is theirs
const SKIP_KEYS = /^(password|newPassword|currentPassword|confirmPassword|passphrase|token|twoFactorToken|code)$/i;

function snippet(text, index, length) {
  const start = Math.max(0, index - 20);
  return String(text).slice(start, Math.min(String(text).length, index + length + 40)).replace(/\s+/g, " ").slice(0, 160);
}

// Every rule that matches this text: [{ category, sample }]
function detectInText(text) {
  if (typeof text !== "string" || text.length < 3) return [];
  const value = text.length > 20000 ? text.slice(0, 20000) : text;
  const found = [];
  const seen = new Set();
  for (const [category, rule] of RULES) {
    if (seen.has(category)) continue;
    const m = rule.exec(value);
    if (m) {
      seen.add(category);
      found.push({ category, sample: snippet(value, m.index, m[0].length) });
    }
  }
  return found;
}

function safeDecode(s) {
  let out = String(s || "");
  for (let i = 0; i < 2; i++) {
    try {
      const d = decodeURIComponent(out.replace(/\+/g, " "));
      if (d === out) break;
      out = d;
    } catch {
      break;
    }
  }
  return out;
}

// Walks a parsed JSON body (bounded), checking every string value and key
// At most this much text is examined per request body, however it's split up,
// so a huge or many-fielded body can't tie the server up checking it
const BODY_SCAN_CHARS = 100000;

function scanBody(body) {
  const found = [];
  let budget = 400;
  let chars = BODY_SCAN_CHARS;
  const walk = (value, key, depth) => {
    if (budget-- <= 0 || depth > 6) return;
    if (key && SKIP_KEYS.test(key)) return;
    if (typeof value === "string") {
      if (chars <= 0) return;
      const text = value.length > chars ? value.slice(0, chars) : value;
      chars -= text.length;
      detectInText(text).forEach((f) => found.push({ ...f, field: key || "" }));
    } else if (Array.isArray(value)) {
      value.slice(0, 200).forEach((v) => walk(v, key, depth + 1));
    } else if (value && typeof value === "object") {
      for (const k of Object.keys(value).slice(0, 200)) {
        if (NOSQL_KEYS.test(k)) found.push({ category: "nosql", sample: `key "${k}"`, field: key || "" });
        walk(value[k], k, depth + 1);
      }
    }
  };
  walk(body, "", 0);
  return found;
}

// The address a request asked for, with any login token taken out so it
// never ends up in a log
function cleanUrl(originalUrl) {
  return String(originalUrl || "").replace(/([?&])(token|resetToken|verifyEmail)=[^&#]*/gi, "$1$2=[removed]").slice(0, 300);
}

// Findings for the parts of a request available before its body is read
function scanRequestLine({ originalUrl, path, userAgent }) {
  const found = [];
  const url = cleanUrl(originalUrl);
  const decoded = safeDecode(url);
  const seen = new Set();
  for (const f of [...detectInText(decoded), ...detectInText(url)]) {
    if (!seen.has(f.category)) { seen.add(f.category); found.push({ ...f, field: "address" }); }
  }
  const p = safeDecode(path || "");
  if (PROBE_PATHS.test(p) || PROBE_EXTENSIONS.test(p)) found.push({ category: "probe", sample: p.slice(0, 160), field: "address" });
  if (userAgent && ATTACK_TOOLS.test(userAgent)) {
    found.push({ category: "tool", sample: String(userAgent).slice(0, 160), field: "User-Agent" });
  }
  return found;
}

const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
function worstSeverity(categories) {
  return categories.reduce((worst, c) => (SEVERITY_RANK[SEVERITY[c]] > SEVERITY_RANK[worst] ? SEVERITY[c] : worst), "low");
}

module.exports = {
  CATEGORY_LABELS,
  SEVERITY,
  detectInText,
  scanBody,
  scanRequestLine,
  cleanUrl,
  worstSeverity,
};
