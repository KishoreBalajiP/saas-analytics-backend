#!/usr/bin/env node

/**
 * Explicit operator command for the first platform administrator.
 *
 * Examples:
 *   npm run bootstrap:admin -- --email operator@example.com
 *   npm run bootstrap:admin -- --email operator@example.com --generate-password
 *
 * This command connects only when explicitly executed. It never runs during
 * normal server startup and never accepts credentials through an HTTP route.
 */

import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { connectDatabase, disconnectDatabase } from '../../src/config/database.js';
import adminBootstrapService from '../../src/services/adminBootstrap.service.js';

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`Unexpected argument: ${value}`);
    const [key, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) args[key] = inline;
    else if (key === 'generate-password') args[key] = true;
    else args[key] = argv[++index];
  }
  return args;
}

function readSecret(prompt) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('Interactive password entry requires a TTY; use --generate-password instead');
  }
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk) => {
      const key = chunk.toString('utf8');
      if (key === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        reject(new Error('Password entry cancelled'));
      } else if (key === '\r' || key === '\n') {
        process.stdout.write('\n');
        process.stdin.setRawMode(false);
        process.stdin.pause();
        resolve(value);
      } else if (key === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += key;
      }
    };
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

const args = parseArgs(process.argv.slice(2));
if (!args.email) throw new Error('--email is required');
if (args['admin-type'] && !['super', 'platform', 'support'].includes(args['admin-type'])) {
  throw new Error('--admin-type must be super, platform, or support');
}

let password;
let generated = false;
if (args['generate-password']) {
  password = randomBytes(24).toString('base64url');
  generated = true;
} else {
  password = await readSecret('Initial password (input hidden): ');
  const confirmation = await readSecret('Confirm password (input hidden): ');
  if (password !== confirmation) throw new Error('Passwords do not match');
}

if (!(await connectDatabase())) throw new Error('Unable to connect to the configured database');
try {
  const result = await adminBootstrapService.bootstrapAdmin({
    email: args.email,
    password,
    adminType: args['admin-type'] ?? 'super',
    name: args.name ?? '',
  });
  if (result.created) {
    console.log(`Created ${result.admin.adminType} administrator for ${result.admin.email}.`);
    if (generated) console.log(`Initial password (show once, then rotate): ${password}`);
    console.log('Sign in through /admin/login and enroll MFA immediately.');
  } else {
    console.log(`Administrator ${result.admin.email} already exists; no changes were made.`);
  }
} finally {
  await disconnectDatabase();
}
