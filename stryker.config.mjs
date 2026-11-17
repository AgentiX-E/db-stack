/**
 * The mutation gate, invoked from the repository root, in a sandbox.
 *
 * ## Why this file is at the root and not in each package
 *
 * Stryker copies `process.cwd()` into its sandbox (`ProjectReader` crawls the
 * working directory; `TemporaryDirectory` resolves `tempDirName` against it).
 * The directory Stryker is invoked from is therefore the directory the tests run
 * in, and for this repository that directory has to be the root:
 *
 *   - `operations/tsconfig.json` extends `../tsconfig.base.json`, and Vite reads
 *     the nearest tsconfig for every file it transforms. A sandbox that is a
 *     copy of `operations/` has no parent, so the transform throws
 *     `TSConfckParseError: failed to resolve "extends"`;
 *   - every `vitest.setup.ts` imports `../scripts/test-tmpdir.mjs`, which is
 *     likewise outside a per-package sandbox.
 *
 * Both were worked around by running in place, which is not a sandbox at all:
 * four workers read the sources a fifth was rewriting, and a mutant could be
 * scored against the code it was supposed to replace. That is why iteration 35
 * had to verify fourteen "surviving" mutants by hand before it could believe the
 * number it published.
 *
 * A sandbox rooted at the repository contains both of the missing files, so the
 * workaround is gone: `scripts/mutation.mjs` refuses to run anywhere else, this
 * file refuses to run in place, and the gate now measures.
 *
 * ## Why there is no default target
 *
 * Three packages ship a gate and they have different thresholds. A default would
 * mean that forgetting the target runs *something* — and a gate that quietly
 * ran the wrong package would report a number for a package nobody was testing.
 */
import { configFor, TARGETS } from "./mutation/targets.mjs";

const IN_PLACE_FLAG = /^--inPlace(=|$)/;

if (process.argv.some((argument) => IN_PLACE_FLAG.test(argument))) {
  throw new Error(
    "Mutation testing runs in a sandbox, not in place: in-place mode lets a worker read a source " +
      "another worker is rewriting, so a mutant can be scored against the code it replaces. " +
      "Run `pnpm run test:mutation:<target>` from the repository root instead.",
  );
}

const target = process.env.MUTATION_TARGET;

if (!target) {
  throw new Error(
    `MUTATION_TARGET is not set. Known targets: ${Object.keys(TARGETS).join(", ")}. ` +
      "Run `pnpm run test:mutation:<target>` from the repository root; `scripts/mutation.mjs` " +
      "sets the variable and checks the working directory.",
  );
}

export default configFor(target);
