// SPDX-License-Identifier: AGPL-3.0-or-later

// Self-test helper: judge log files the way scenario 99 does. Exit 1 when the verdict is a failure.
//   logscan-check.mjs LOGFILE ALLOWFILE                    strict: any error-looking line fails
//   logscan-check.mjs LOGFILE ALLOWFILE --later LOGFILE2   two-look: LOGFILE is the full log, LOGFILE2 is what was
//                                                          logged after a pause; only a fatal line, errors that keep
//                                                          arriving, or one repeating error fail
import fs from 'node:fs';
import {classifyLines, decideScan, loadAllowlist, scanLines} from './logscan.mjs';

const args = process.argv.slice(2);
const laterIndex = args.indexOf('--later');
const [logFile, allowFile] = args;
const allow = loadAllowlist(allowFile);
const lines = fs.readFileSync(logFile, 'utf8').split('\n');

if (laterIndex === -1) {
	const hits = scanLines(lines, allow);
	for (const hit of hits) console.log(hit);
	process.exit(hits.length === 0 ? 0 : 1);
}

const later = classifyLines(fs.readFileSync(args[laterIndex + 1], 'utf8').split('\n'), allow);
const verdict = decideScan(classifyLines(lines, allow), later);
console.log(`${verdict.ok ? 'OK' : 'FAIL'}: ${verdict.reason}`);
process.exit(verdict.ok ? 0 : 1);
