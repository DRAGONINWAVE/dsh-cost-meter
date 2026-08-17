/**
 * @dsh-external/dsh-cost-meter — host half.
 *
 * This is a client-only plugin: the browser half renders the cost line in the
 * conversation composer dock. The host half only exists so the loader can
 * activate this entry and serve its `/client` bundle to the Web shell.
 */
export const name = "@dsh-external/dsh-cost-meter";

export const inject = [];

export function apply(_ctx) {
  // Nothing to do on the host. See lib/client.js for the browser half.
}
