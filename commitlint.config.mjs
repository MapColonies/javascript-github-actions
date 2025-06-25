import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Get allowed scopes from directories under the actions folder
 * @returns {string[]} Array of directory names
 */
const getAllowedScopes = () => {
  try {
    const scopes = readdirSync(join(process.cwd(), 'actions'), { withFileTypes: true })
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);
    return ['', ...scopes]; // Add empty string to allow no scope
  } catch {
    return [''];
  }
};

/**
 * @type {import('@commitlint/types').UserConfig}
 */
export default {
  extends: ['@map-colonies/commitlint-config'],
  rules: {
    'scope-enum': [2, 'always', getAllowedScopes()],
  },
};
