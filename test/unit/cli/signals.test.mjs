import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { describe, it } from 'node:test';
import { createInterruptController, getInterruptSignals, killProcessTree } from '../../../src/cli/signals.js';

function createHarness(options = {}) {
  const exits = /** @type {number[]} */ ([]);
  const messages = /** @type {string[]} */ ([]);
  const controller = createInterruptController({
    platform: 'win32',
    exit: (code) => exits.push(code),
    stderr: { write: (text) => messages.push(text) },
    killTree: () => true,
    ...options,
  });
  return { controller, exits, messages };
}

describe('interrupt controller', () => {
  it('runs cleanups newest first, prints their notes, aborts and exits 130', () => {
    const { controller, exits, messages } = createHarness();
    const order = /** @type {string[]} */ ([]);
    controller.addCleanup(() => {
      order.push('lock');
      return 'released the GPU lock';
    });
    controller.addCleanup(() => {
      order.push('staging');
      return 'rolled back the staged install';
    });
    controller.addCleanup(() => {
      order.push('silent');
    });
    controller.handleSignal('SIGINT');
    assert.deepEqual(order, ['silent', 'staging', 'lock']);
    assert.deepEqual(exits, [130]);
    assert.equal(controller.signal.aborted, true);
    assert.equal(messages.join(''), 'opencode-unity: interrupted by SIGINT; rolled back the staged install; released the GPU lock\n');
  });

  it('removes cleanups that are no longer needed and runs each only once', () => {
    const { controller } = createHarness();
    let calls = 0;
    const remove = controller.addCleanup(() => {
      calls += 1;
    });
    controller.addCleanup(() => 'kept');
    remove();
    assert.deepEqual(controller.runCleanups(), ['kept']);
    assert.deepEqual(controller.runCleanups(), []);
    assert.equal(calls, 0);
  });

  it('keeps going when a cleanup throws', () => {
    const { controller } = createHarness();
    controller.addCleanup(() => 'first');
    controller.addCleanup(() => {
      throw new Error('disk busy');
    });
    assert.deepEqual(controller.runCleanups(), ['cleanup failed: disk busy', 'first']);
  });

  it('ignores Ctrl+C and Ctrl+Break while suspended, but not SIGTERM', () => {
    const { controller, exits } = createHarness();
    const resume = controller.suspendInterrupts();
    controller.handleSignal('SIGINT');
    controller.handleSignal('SIGBREAK');
    assert.deepEqual(exits, []);
    assert.equal(controller.signal.aborted, false);
    resume();
    resume();
    controller.handleSignal('SIGINT');
    assert.deepEqual(exits, [130]);

    const second = createHarness();
    second.controller.suspendInterrupts();
    second.controller.handleSignal('SIGTERM');
    assert.deepEqual(second.exits, [130]);
  });

  it('calls onInterrupt with the signal name before exiting', () => {
    const calls = /** @type {unknown[]} */ ([]);
    const { controller, exits } = createHarness({
      onInterrupt: (/** @type {string} */ name, /** @type {string[]} */ notes) => calls.push([name, notes, exits.length]),
    });
    controller.addCleanup(() => 'note');
    controller.handleSignal('SIGHUP');
    assert.deepEqual(calls, [['SIGHUP', ['note'], 0]]);
  });

  it('kills a tracked child tree on interrupt and forgets it after exit', () => {
    const killed = /** @type {number[]} */ ([]);
    const { controller } = createHarness({ killTree: (/** @type {number} */ pid) => killed.push(pid) > 0 });
    const running = Object.assign(new EventEmitter(), { pid: 101, exitCode: null, signalCode: null });
    const finished = Object.assign(new EventEmitter(), { pid: 102, exitCode: null, signalCode: null });
    controller.trackChild(/** @type {any} */ (running));
    controller.trackChild(/** @type {any} */ (finished));
    finished.exitCode = 0;
    finished.emit('exit', 0, null);
    assert.deepEqual(controller.runCleanups(), ['stopped process 101']);
    assert.deepEqual(killed, [101]);
  });

  it('installs and removes process listeners for the platform signals', () => {
    const target = new EventEmitter();
    const { controller, exits } = createHarness();
    const uninstall = controller.install(/** @type {any} */ (target));
    assert.deepEqual(getInterruptSignals('win32').map((name) => target.listenerCount(name)), [1, 1, 1, 1]);
    target.emit('SIGBREAK');
    assert.deepEqual(exits, [130]);
    uninstall();
    assert.deepEqual(getInterruptSignals('win32').map((name) => target.listenerCount(name)), [0, 0, 0, 0]);
    assert.deepEqual(getInterruptSignals('linux'), ['SIGINT', 'SIGTERM', 'SIGHUP']);
  });
});

describe('killProcessTree', () => {
  it('uses taskkill /T /F on Windows', () => {
    const calls = /** @type {unknown[]} */ ([]);
    const runSync = /** @type {any} */ ((/** @type {string} */ file, /** @type {string[]} */ args) => {
      calls.push([file, args]);
      return { status: 0 };
    });
    assert.equal(killProcessTree(4242, { platform: 'win32', runSync }), true);
    assert.deepEqual(calls, [['taskkill', ['/PID', '4242', '/T', '/F']]]);
  });

  it('stops a real child process', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    await once(child, 'spawn');
    assert.equal(killProcessTree(/** @type {number} */ (child.pid)), true);
    await once(child, 'exit');
    assert.ok(child.exitCode !== 0 || child.signalCode !== null);
  });
});
