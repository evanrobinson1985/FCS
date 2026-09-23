// Experimental, part of the Passenger-bypass workaround (see
// start-background.js): writes an .htaccess into httpdocs/ that proxies
// every request to the manually-started background server instead of
// relying on Passenger to spawn/route to the app. Only makes sense while
// start-background.js's process is actually running - if that process
// ever dies, this ProxyPass has nothing to reach and the whole site goes
// down (worse than the current Passenger failure, which at least still
// serves static files via Apache directly). Treat this as a stopgap, not
// a permanent fix.
//
// Run via: npm run setup-proxy
// Undo with: npm run remove-proxy
const path = require("path");
const fs = require("fs");

const HTACCESS_PATH = path.join(__dirname, "..", "httpdocs", ".htaccess");
const PORT = process.env.PORT || 3000;

const CONTENT = `# Written by scripts/write-htaccess.js - see that file for context.
# Proxies everything to the app running on 127.0.0.1:${PORT} instead of
# going through Phusion Passenger, which currently can't spawn this app.
ProxyPreserveHost On
RequestHeader set X-Forwarded-Proto "https"

ProxyPass / http://127.0.0.1:${PORT}/
ProxyPassReverse / http://127.0.0.1:${PORT}/
`;

fs.writeFileSync(HTACCESS_PATH, CONTENT);
console.log(`Wrote ${HTACCESS_PATH}:`);
console.log(CONTENT);
console.log(`If Apache doesn't allow ProxyPass in .htaccess for this vhost, requests will likely start`);
console.log(`returning a 500 with "Invalid command 'ProxyPass'" in the Apache error log - check that if`);
console.log(`the site doesn't come up after this.`);
