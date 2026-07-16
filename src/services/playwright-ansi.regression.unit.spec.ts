import { describe, expect, test } from 'bun:test';

import { extractStderrSummary } from './playwright.service.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// Regression for the S6324 fix: the old hand-rolled ANSI regex missed OSC
// (terminal title) sequences, leaving "]0;..." garbage in error messages
// stored on execution rows. node:util's stripVTControlCharacters covers
// the full CSI/OSC/SGR range. The OSC case below FAILS on the old regex.
describe('extractStderrSummary ANSI stripping', () => {
  test('strips OSC terminal-title sequences the old regex missed', () => {
    const stderr = `${ESC}]0;npm run test${BEL}Error: boom`;
    expect(extractStderrSummary(stderr)).toBe('Error: boom');
  });

  test('still strips SGR colour codes', () => {
    expect(extractStderrSummary(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain');
  });

  test('still strips CSI erase-line sequences', () => {
    expect(extractStderrSummary(`${ESC}[2Kline one\n${ESC}[1Aline two`)).toBe('line one\nline two');
  });
});
