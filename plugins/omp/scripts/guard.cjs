#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_PERMISSION_MODES = new Set(['plan', 'default', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions']);
const TARGET_SUFFIXES = ['__omp_start', '__omp_followup'];

function deny(message) {
  process.stderr.write('OMP delegation blocked: ' + message + String.fromCharCode(10));
  process.exitCode = 2;
}

function isTargetTool(toolName) {
  return TARGET_SUFFIXES.some((suffix) => toolName.endsWith(suffix));
}

function absolutePath(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes(String.fromCharCode(0))) throw new Error(label + ' must be an absolute path');
  return value;
}

function real(value, label) {
  absolutePath(value, label);
  try { return fs.realpathSync.native(value); }
  catch (error) { throw new Error(label + ' cannot be resolved: ' + error.message); }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('error', (error) => deny('cannot read hook input: ' + error.message));
process.stdin.on('end', () => {
  let event;
  try { event = JSON.parse(input); }
  catch (error) { deny('hook input is not valid JSON'); return; }
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.tool_name !== 'string') {
    deny('hook input must contain a tool_name'); return;
  }
  if (!isTargetTool(event.tool_name)) return;
  try {
    if (typeof event.permission_mode !== 'string' || !ALLOWED_PERMISSION_MODES.has(event.permission_mode)) {
      throw new Error('permission_mode is missing or unknown');
    }
    if (event.permission_mode === 'plan') throw new Error('mutating delegation is unavailable in Plan mode');
    if (!event.tool_input || typeof event.tool_input !== 'object' || Array.isArray(event.tool_input)) throw new Error('tool_input is missing');
    const cwd = real(event.cwd, 'hook cwd');
    const workspace = real(event.tool_input.workspace, 'tool workspace');
    if (cwd !== workspace) throw new Error('hook cwd and tool workspace must resolve to the same directory');
  } catch (error) {
    deny(error instanceof Error ? error.message : String(error));
  }
});
