import { describe, expect, it } from 'vitest';
import { countEmails, detectSensitive, hasCard, hasSecret, luhnValid } from '../src/detect/sensitive-paste.ts';

describe('sensitive paste detection', () => {
  it.each([
    'key = AKIAIOSFODNN7EXAMPLE',
    'token ghp_' + 'a'.repeat(36),
    'gho_' + 'B1'.repeat(18),
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'SLACK=xoxb-1234567890-abcdefghij',
    'AIzaSyA-1234567890abcdefghijklmnopqrstu',
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz012345',
    'sk-ant-api03-abcdefghijklmnopqrstuvwxyz',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIE...',
    '-----BEGIN OPENSSH PRIVATE KEY-----',
    '-----BEGIN PRIVATE KEY-----',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ])('secret: %s', (s) => {
    expect(hasSecret(s)).toBe(true);
    expect(detectSensitive(s)).toBe('secret');
  });

  it.each([
    'Ask the model about AKIA and AWS keys in general',
    'my sk-short key',
    'skeleton-key-for-the-lock-is-here',
    '-----BEGIN PUBLIC KEY-----',
    'eyJ alone is not a token',
    'ghp_tooshort',
  ])('no secret: %s', (s) => expect(hasSecret(s)).toBe(false));

  it('card: Luhn-valid 13-19 digits, plain or grouped', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(hasCard('card 4111 1111 1111 1111 exp 12/29')).toBe(true);
    expect(hasCard('5500-0000-0000-0004')).toBe(true);
    expect(hasCard('378282246310005')).toBe(true); // Amex, 15 digits
    expect(detectSensitive('pay with 4111111111111111')).toBe('card');
  });

  it('no card: Luhn-invalid, too short or long, repeated digits, dates and phone numbers', () => {
    expect(hasCard('4111 1111 1111 1112')).toBe(false);
    expect(hasCard('order 123456789012')).toBe(false); // 12 digits
    expect(hasCard('41111111111111111111')).toBe(false); // 20 digits
    expect(hasCard('0000 0000 0000 0000')).toBe(false);
    expect(hasCard('Call +1 415 555 0100 on 2026-10-23')).toBe(false);
  });

  it('emails: 5 or more distinct addresses', () => {
    const five = 'a@x.com, b@x.com; c@y.org\nd@z.io e@acme.co.uk';
    expect(countEmails(five)).toBe(5);
    expect(detectSensitive(five)).toBe('emails');
    expect(detectSensitive('a@x.com A@X.COM a@x.com b@x.com c@x.com d@x.com')).toBe(null); // 4 distinct
    expect(detectSensitive('write to me at alice@example.com or bob@example.com')).toBe(null);
  });

  it('large: more than 2000 characters', () => {
    expect(detectSensitive('word '.repeat(401))).toBe('large');
    expect(detectSensitive('x'.repeat(2000))).toBe(null);
  });

  it('priority: secret > card > emails > large', () => {
    const emails = 'a@x.com b@x.com c@x.com d@x.com e@x.com';
    expect(detectSensitive(`${emails} 4111111111111111 AKIAIOSFODNN7EXAMPLE ${'z'.repeat(3000)}`)).toBe('secret');
    expect(detectSensitive(`${emails} 4111111111111111 ${'z '.repeat(1500)}`)).toBe('card');
    expect(detectSensitive(`${emails} ${'z '.repeat(1500)}`)).toBe('emails');
  });

  it('normal text and empty input are not flagged', () => {
    expect(detectSensitive('Summarise this paragraph about quarterly planning for the team.')).toBe(null);
    expect(detectSensitive('')).toBe(null);
    expect(detectSensitive(null)).toBe(null);
  });
});
