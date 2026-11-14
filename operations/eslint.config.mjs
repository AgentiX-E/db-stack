// @ts-check
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../eslint.shared.mjs';

export default createConfig({ tsconfigRootDir: dirname(fileURLToPath(import.meta.url)) });
