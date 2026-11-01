// SPDX-License-Identifier: AGPL-3.0-or-later

// Self-test helper: scan one log file against an allowlist file. Exit 1 when a non-allowlisted error is found.
//   logscan-check.mjs LOGFILE ALLOWFILE
import fs from 'node:fs';
import {loadAllowlist, scanLines} from './logscan.mjs';

const [logFile, allowFile] = process.argv.slice(2);
const hits = scanLines(fs.readFileSync(logFile, 'utf8').split('\n'), loadAllowlist(allowFile));
for (const hit of hits) console.log(hit);
process.exit(hits.length === 0 ? 0 : 1);
