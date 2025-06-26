import tsBaseConfig, { namingConventions } from '@map-colonies/eslint-config/ts-base';
import { config } from '@map-colonies/eslint-config/helpers';

const AllowedGithubLiterals = {
  selector: 'objectLiteralProperty',
  format: null,
  filter: {
    match: true,
    regex: '^(pull_request|issue_number|target_url)$',
  },
};

// Create a new array with the base rules and our custom rule
const namingConvention = [...namingConventions, AllowedGithubLiterals];

const customConfig = {
  rules: {
    '@typescript-eslint/naming-convention': namingConvention,
  },
  languageOptions: {
    parserOptions: {
      project: './tsconfig.json',
    },
  },
};

export default config(tsBaseConfig, { ignores: ['new-action-template', 'vitest.config.mts'] }, customConfig);
