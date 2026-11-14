#!/usr/bin/env node
import { createApp } from './app.js';

const [command] = process.argv.slice(2);

if (command === 'synth') {
  createApp().synth();
} else {
  console.error('Usage: agentharness synth');
  process.exitCode = 1;
}
