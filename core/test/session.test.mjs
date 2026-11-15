import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chromiumCookies,
  cookieDomainMatches,
  sameSiteName,
} from '../../host/session.mjs';

test('a cookie host matches the site and every name under it', () => {
  assert.equal(cookieDomainMatches('youtube.com', 'youtube.com'), true);
  assert.equal(cookieDomainMatches('.youtube.com', 'youtube.com'), true);
  assert.equal(cookieDomainMatches('www.youtube.com', 'youtube.com'), true);
  assert.equal(cookieDomainMatches('notyoutube.com', 'youtube.com'), false);
  assert.equal(cookieDomainMatches('youtube.com.evil.test', 'youtube.com'), false);
  assert.equal(cookieDomainMatches('', 'youtube.com'), false);
});

test('Firefox sameSite numbers read as the names Chrome wants', () => {
  assert.equal(sameSiteName(0), 'None');
  assert.equal(sameSiteName(1), 'Lax');
  assert.equal(sameSiteName(2), 'Strict');
  assert.equal(sameSiteName(undefined), 'Lax');
});

test('a copy keeps the site and drops every other site', () => {
  const rows = [
    { host: '.youtube.com', name: 'SID', value: 'one', path: '/', expiry: 1900000000, isSecure: 1, isHttpOnly: 1, sameSite: 0 },
    { host: '.google.com', name: 'SAPISID', value: 'two', path: '/', expiry: 1900000000, isSecure: 1, isHttpOnly: 1, sameSite: 0 },
    { host: 'example.test', name: 'keep', value: 'three', path: '/', expiry: 0, isSecure: 0, isHttpOnly: 0, sameSite: 1 },
  ];
  const cookies = chromiumCookies(rows, { domain: 'youtube.com' });
  assert.equal(cookies.length, 1);
  assert.equal(cookies[0].name, 'SID');
  assert.equal(cookies[0].domain, '.youtube.com');
  assert.equal(cookies[0].sameSite, 'None');
  assert.equal(cookies[0].secure, true);
  assert.equal(cookies[0].expires, 1900000000);
});

test('a session cookie reads as -1 and an insecure None reads as Lax', () => {
  const [cookie] = chromiumCookies(
    [{ host: 'example.test', name: 'a', value: 'b', path: '/', expiry: 0, isSecure: 0, isHttpOnly: 0, sameSite: 0 }],
    { domain: 'example.test' }
  );
  assert.equal(cookie.expires, -1);
  assert.equal(cookie.sameSite, 'Lax');
});

test('a record with no name is not copied', () => {
  assert.deepEqual(
    chromiumCookies([{ host: 'example.test', name: '', value: 'x' }], { domain: 'example.test' }),
    []
  );
});
