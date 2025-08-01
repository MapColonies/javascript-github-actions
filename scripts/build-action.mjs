#!/usr/bin/env node

// Generated by Copilot

import { readdir, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { build } from 'esbuild';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants for paths
const PROJECT_ROOT = join(__dirname, '..');
const ACTIONS_FOLDER = join(PROJECT_ROOT, 'actions');

// Build configuration constants
const BUILD_CONFIG = {
  bundle: true,
  platform: 'node',
  treeShaking: true,
  target: 'node20',
};

/**
 * Checks if a directory contains a valid action (has index.ts)
 * @param {string} actionPath - Path to the action directory
 * @returns {Promise<boolean>} Whether the directory contains a valid action
 */
const isValidAction = async (actionPath) => {
  try {
    const indexPath = join(actionPath, 'index.ts');
    return existsSync(indexPath);
  } catch {
    return false;
  }
};

/**
 * Discovers all available actions in the actions folder
 * @returns {Promise<string[]>} Array of action names
 */
const discoverActions = async () => {
  try {
    const entries = await readdir(ACTIONS_FOLDER, { withFileTypes: true });
    const actions = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const actionPath = join(ACTIONS_FOLDER, entry.name);
      const hasValidAction = await isValidAction(actionPath);

      if (hasValidAction) {
        actions.push(entry.name);
      }
    }

    return actions.sort();
  } catch (error) {
    throw new Error(`Failed to discover actions: ${error.message}`);
  }
};

/**
 * Builds a single action using esbuild
 * @param {string} actionName - Name of the action to build
 * @returns {Promise<void>}
 */
const buildAction = async (actionName) => {
  const actionPath = join(ACTIONS_FOLDER, actionName);
  const entryPoint = join(actionPath, 'index.ts');
  const distDir = join(actionPath, 'dist');
  const outfile = join(distDir, 'index.js');

  // Validate that the action exists and has an index.ts file
  const hasValidAction = await isValidAction(actionPath);
  if (!hasValidAction) {
    throw new Error(`Action "${actionName}" not found or missing index.ts file`);
  }

  // Ensure dist directory exists
  try {
    await mkdir(distDir, { recursive: true });
  } catch (error) {
    throw new Error(`Failed to create dist directory for ${actionName}: ${error.message}`);
  }

  // Build the action using esbuild
  try {
    await build({
      ...BUILD_CONFIG,
      entryPoints: [entryPoint],
      outfile,
    });
  } catch (error) {
    throw new Error(`Failed to build action "${actionName}": ${error.message}`);
  }
};

/**
 * Builds multiple actions with progress indication
 * @param {string[]} actionNames - Array of action names to build
 * @returns {Promise<{successful: string[], failed: Array<{name: string, error: string}>}>}
 */
const buildMultipleActions = async (actionNames) => {
  const results = {
    successful: [],
    failed: [],
  };

  for (const actionName of actionNames) {
    const spinner = ora(`Building ${actionName}...`).start();

    try {
      await buildAction(actionName);
      results.successful.push(actionName);
      spinner.succeed(`Built ${actionName}`);
    } catch (error) {
      results.failed.push({
        name: actionName,
        error: error.message,
      });
      spinner.fail(`Failed to build ${actionName}`);
    }
  }

  return results;
};

/**
 * Displays usage information
 */
const showUsage = () => {
  console.log(`
🔧 GitHub Actions Builder

Usage:
  npm run build-action                    # Build all actions
  npm run build-action <action-name>      # Build specific action
  npm run build-action action1 action2    # Build multiple specific actions

Examples:
  npm run build-action
  npm run build-action jira-pull-request-integration
  npm run build-action action1 action2 action3

Options:
  --help, -h    Show this help message
`);
};

/**
 * Main function to handle CLI arguments and orchestrate the build process
 */
const main = async () => {
  const args = process.argv.slice(2);

  // Handle help flag
  const shouldShowHelp = args.includes('--help') || args.includes('-h');
  if (shouldShowHelp) {
    showUsage();
    return;
  }

  try {
    let actionsToBuild = [];

    if (args.length === 0) {
      // No arguments provided - build all actions
      console.log('🔍 Discovering all actions...');
      actionsToBuild = await discoverActions();

      if (actionsToBuild.length === 0) {
        console.log('⚠️  No actions found to build');
        return;
      }

      console.log(`📦 Found ${actionsToBuild.length} action(s): ${actionsToBuild.join(', ')}`);
    } else {
      // Specific actions provided
      actionsToBuild = args;
      console.log(`📦 Building ${actionsToBuild.length} action(s): ${actionsToBuild.join(', ')}`);
    }

    // Build the actions
    const results = await buildMultipleActions(actionsToBuild);

    // Display results summary
    console.log('\n📊 Build Summary:');

    if (results.successful.length > 0) {
      console.log(`✅ Successfully built ${results.successful.length} action(s):`);
      for (const actionName of results.successful) {
        console.log(`   • ${actionName}`);
      }
    }

    if (results.failed.length > 0) {
      console.log(`❌ Failed to build ${results.failed.length} action(s):`);
      for (const failure of results.failed) {
        console.log(`   • ${failure.name}: ${failure.error}`);
      }

      // Exit with error code if any builds failed
      process.exit(1);
    }

    const totalActions = results.successful.length + results.failed.length;
    console.log(`\n🎉 Build process completed for ${totalActions} action(s)`);
  } catch (error) {
    console.error('❌ Build process failed:', error.message);
    process.exit(1);
  }
};

// Run the script
main();
