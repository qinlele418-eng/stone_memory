const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(secure = true) {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/public/app.js'), 'utf8');
  const listeners = {}, messages = [];
  const button = {}, hint = {};
  const context = vm.createContext({
    window: { isSecureContext: secure, addEventListener: (name, fn) => { listeners[name] = fn; } },
    navigator: { userAgent: 'Chrome', platform: 'Linux', maxTouchPoints: 0 },
    document: { querySelector: selector => selector === '#install-stone-memory' ? button : hint },
    isPwaStandalone: () => false,
    showToast: message => messages.push(message),
  });
  vm.runInContext('let deferredPwaInstall = null;\n' + source.slice(source.indexOf('let pwaInstallPending'), source.indexOf('async function preparePwa')), context);
  return { context, listeners, messages, button, hint };
}

test('click prompts synchronously, blocks double clicks and keeps a dismissed event retryable', async () => {
  const { context, listeners, messages } = setup();
  let calls = 0, finish;
  const choice = new Promise(resolve => { finish = resolve; });
  listeners.beforeinstallprompt({ preventDefault() {}, prompt() { calls++; return Promise.resolve(); }, userChoice: choice });
  const pending = context.installStoneMemory();
  assert.equal(calls, 1);
  await context.installStoneMemory();
  assert.equal(calls, 1);
  finish({ outcome: 'dismissed' });
  await pending;
  await context.installStoneMemory();
  assert.equal(calls, 2);
  assert.match(messages.at(-1), /再次点击重试/);
});

test('HTTP addresses explain HTTPS requirement without invoking a prompt', async () => {
  const { context, listeners, messages } = setup(false);
  listeners.beforeinstallprompt({ preventDefault() {}, prompt() { assert.fail('must not prompt'); } });
  await context.installStoneMemory();
  assert.match(messages.at(-1), /HTTPS/);
});

test('prompt rejection is handled and a fresh browser event can be used', async () => {
  const { context, listeners, messages, button } = setup();
  listeners.beforeinstallprompt({ preventDefault() {}, prompt() { return Promise.reject(new Error('denied')); } });
  await context.installStoneMemory();
  assert.match(messages.at(-1), /未能打开/);
  let calls = 0;
  listeners.beforeinstallprompt({ preventDefault() {}, prompt() { calls++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  await context.installStoneMemory();
  assert.equal(calls, 1);
  listeners.appinstalled();
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, '已添加到桌面');
});
