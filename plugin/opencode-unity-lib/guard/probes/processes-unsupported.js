// Unity process probe for platforms without a process adapter in this version (spec sections 3 and
// 7.2). It cannot tell whether Unity is running or importing, so it answers with an error and the
// guard blocks (fail closed).

/**
 * @param {string} platform  `process.platform` value, for the error text.
 * @returns {import('../unity-processes.js').ProcessProbe}
 */
export function createUnsupportedProcessProbe(platform) {
  const error = `Unity process checks are not implemented on ${platform} in this version`;
  return {
    platform,
    detect: async () => ({ ok: false, error }),
    sample: async () => ({ ok: false, error }),
  };
}
