import { describeAgentDocsPerCheck } from 'afdocs/helpers';
import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';

// Load base config from file
const configFile = readFileSync('./agent-docs.config.yml', 'utf-8');
const baseConfig = parseYaml(configFile);

// Override URL from environment variable if present
const config = {
  ...baseConfig,
  url: process.env.DEPLOY_URL || baseConfig.url,
};

describeAgentDocsPerCheck(config);
