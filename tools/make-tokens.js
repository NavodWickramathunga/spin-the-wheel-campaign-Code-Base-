// Makes the signed customer tokens (CleverTap profile property stw_token) for a list of identities.
//   $env:STW_TOKEN_SECRET="<same value as the Firebase secret>"; node tools/make-tokens.js identities.csv tokens.csv
// Input: a CSV/text file whose first column is the CleverTap Identity (mobile number); a header row is skipped.
// Output: "Identity,stw_token" CSV, ready for a CleverTap profile upload.
// Optional: $env:TOKEN_CAMPAIGN (default "stw") - must match the function's TOKEN_CAMPAIGN.
//
// Dialog's backend can make the same token itself:
//   token = base64url( HMAC-SHA256( key = STW_TOKEN_SECRET, message = TOKEN_CAMPAIGN + ":" + identity ) )
// where identity has spaces and dashes removed (no "=" padding in base64url).
const fs = require('fs');
const crypto = require('crypto');

const [input, output] = process.argv.slice(2);
const secret = process.env.STW_TOKEN_SECRET, campaign = process.env.TOKEN_CAMPAIGN || 'stw';
if (!input || !output || !secret) {
  console.error('Usage: set STW_TOKEN_SECRET, then: node tools/make-tokens.js <identities.csv> <tokens.csv>');
  process.exit(1);
}
const IDENTITY_RE = /^[\w+.@]{3,64}$/; // same rule as the server
const rows = ['Identity,stw_token'];
let skipped = 0;
for (const line of fs.readFileSync(input, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
  const identity = line.split(',')[0].replace(/"/g, '').replace(/[\s-]/g, '');
  if (!identity) continue;
  if (!IDENTITY_RE.test(identity) || /^identity$/i.test(identity)) { skipped++; continue; }
  const token = crypto.createHmac('sha256', secret).update(`${campaign}:${identity}`).digest('base64url');
  rows.push(`${identity},${token}`);
}
fs.writeFileSync(output, rows.join('\r\n') + '\r\n');
console.log(`Wrote ${rows.length - 1} tokens to ${output}` + (skipped ? ` (skipped ${skipped} lines that are not identities)` : ''));
