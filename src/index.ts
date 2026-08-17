/**
 * @dsh-external/dsh-cost-meter — host half (TypeScript source).
 *
 * Client-only plugin: the browser half renders the cost line. The host half
 * only exists so the loader can activate this entry and serve `/client`.
 * `lib/index.js` is committed prebuilt; regenerate it from this file with the
 * DSH source checkout's tsc (see scripts/build.sh).
 */
export const name = '@dsh-external/dsh-cost-meter'

export const inject: string[] = []

export function apply(_ctx: unknown): void {
  // Nothing to do on the host. See src/client/index.ts for the browser half.
}
