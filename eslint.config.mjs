import tsBaseConfig from '@map-colonies/eslint-config/ts-base';
import { config } from '@map-colonies/eslint-config/helpers';

export default config(tsBaseConfig, { ignores: ['new-action-template'] });
