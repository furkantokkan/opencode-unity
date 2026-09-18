// node:assert's throws() does not hand the error back, and most of our expected failures are CliError
// values whose exitCode, code and hint a test wants to read.

/**
 * Runs `action` and returns the error it threw.
 * @param {() => unknown} action
 * @returns {any}  The thrown value; typed loosely so a test can read CliError fields directly.
 * @throws {Error} When the call did not throw.
 */
export function catchError(action) {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

/**
 * The same, for a call that rejects.
 * @param {() => unknown} action
 * @returns {Promise<any>}  The rejection value; typed loosely for the same reason.
 * @throws {Error} When the call did not reject.
 */
export async function catchAsync(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}
