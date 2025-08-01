#!/usr/bin/env node

// Generated by Copilot

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { createInterface } from 'node:readline';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import prettier from 'prettier';
import YAML from 'yaml';
import ora from 'ora';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants for paths and templates
const PROJECT_ROOT = join(__dirname, '..');
const TEMPLATE_FOLDER = join(PROJECT_ROOT, 'new-action-template');
const ACTIONS_FOLDER = join(PROJECT_ROOT, 'actions');
const RELEASE_CONFIG_PATH = join(PROJECT_ROOT, 'release-please-config.json');
const ROOT_README_PATH = join(PROJECT_ROOT, 'README.md');

// Constants for spinner timing to avoid magic numbers
const COPY_FILES_DELAY = 800;
const CREATE_README_DELAY = 600;
const UPDATE_CONFIG_DELAY = 600;
const UPDATE_ROOT_README_DELAY = 500;

/**
 * Safely reads a file, returning null if it doesn't exist
 * @param {string} filePath - Path to the file to read
 * @returns {Promise<string | null>} File content or null if not found
 */
const readFileOrNull = async (filePath) => {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    // File doesn't exist, return null
    return null;
  }
};

/**
 * Executes a step with a spinner and artificial delay
 * @param {string} message - Message to display on spinner
 * @param {Function} operation - Async operation to execute
 * @param {number} delay - Delay in milliseconds to make step feel substantial
 * @returns {Promise<any>} Result of the operation
 */
const executeWithSpinner = async (message, operation, delay) => {
  const spinner = ora(message).start();
  try {
    const result = await operation();
    await sleep(delay);
    spinner.succeed(message.replace('...', '').replace(/ing$/, 'ed'));
    return result;
  } catch (error) {
    spinner.fail('Operation failed');
    throw error;
  }
};

/**
 * Creates a readline interface for user input
 * @returns {readline.Interface} The readline interface
 */
const createReadlineInterface = () => {
  return createInterface({
    input: process.stdin,
    output: process.stdout,
  });
};

/**
 * Prompts the user for input
 * @param {readline.Interface} rl - The readline interface
 * @param {string} question - The question to ask
 * @returns {Promise<string>} The user's response
 */
const promptUser = (rl, question) => {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
};

/**
 * Validates the action name
 * @param {string} name - The action name to validate
 * @returns {boolean} Whether the name is valid
 */
const isValidActionName = (name) => {
  const nameRegex = /^[a-z][a-z0-9-]*[a-z0-9]$/;
  return nameRegex.test(name) && name.length >= 2;
};

/**
 * Copies files from template to new action directory
 * @param {string} templatePath - Path to template directory
 * @param {string} targetPath - Path to target directory
 * @param {string} actionName - Name of the action
 * @param {string} actionDescription - Description of the action
 */
const copyTemplateFiles = async (templatePath, targetPath, actionName, actionDescription) => {
  const files = await readdir(templatePath, { withFileTypes: true });

  await mkdir(targetPath, { recursive: true });

  for (const file of files) {
    const sourcePath = join(templatePath, file.name);

    // Handle file renaming for template files that should use action name
    let targetFileName = file.name;
    if (file.name.includes('new-action-template')) {
      targetFileName = file.name.replace(/new-action-template/g, actionName);
    }

    const targetFilePath = join(targetPath, targetFileName);

    if (file.isDirectory()) {
      await copyTemplateFiles(sourcePath, targetFilePath, actionName, actionDescription);
    } else {
      const content = await readFile(sourcePath, 'utf8');
      let processedContent;

      // Handle YAML files specially to preserve proper formatting
      if (file.name.endsWith('.yml') || file.name.endsWith('.yaml')) {
        const yamlDoc = YAML.parseDocument(content);

        // Update name and description in YAML structure
        if (yamlDoc.contents && typeof yamlDoc.contents === 'object') {
          if (yamlDoc.contents.items) {
            // Handle YAML document with items
            for (const item of yamlDoc.contents.items) {
              if (item.key && item.key.value === 'name' && item.value) {
                item.value.value = actionName;
              }
              if (item.key && item.key.value === 'description' && item.value) {
                item.value.value = actionDescription;
              }
            }
          }
        }

        processedContent = yamlDoc.toString();
      } else {
        // Handle non-YAML files with simple string replacement
        processedContent = content.replace(/{{ACTION_NAME}}/g, actionName).replace(/{{ACTION_DESCRIPTION}}/g, actionDescription);
      }

      await writeFile(targetFilePath, processedContent, 'utf8');
    }
  }
};

/**
 * Creates a README file for the new action
 * @param {string} actionPath - Path to the action directory
 * @param {string} actionName - Name of the action
 * @param {string} actionDescription - Description of the action
 */
const createActionReadme = async (actionPath, actionName, actionDescription) => {
  const readmeContent = `# ${actionName}

${actionDescription}

## Usage

\`\`\`yaml
uses: mapcolonies/javascript-github-actions/actions/${actionName}@v1
with:
  # Add your inputs here
\`\`\`

## Inputs

<!-- Add your action inputs here -->

## Outputs

<!-- Add your action outputs here -->

## Required Permissions
<!-- Add required permissions for the action here -->
\`\`\`
`;

  await writeFile(join(actionPath, 'README.md'), readmeContent, 'utf8');
};

/**
 * Formats a file using Prettier
 * @param {string} filePath - Path to the file to format
 */
const formatFileWithPrettier = async (filePath) => {
  try {
    const content = await readFile(filePath, 'utf8');
    const formatted = await prettier.format(content, {
      filepath: filePath,
      ...(await prettier.resolveConfig(filePath)),
    });
    await writeFile(filePath, formatted, 'utf8');
  } catch (error) {
    // If formatting fails, continue without formatting
    console.log(`⚠️  Could not format ${basename(filePath)}: ${error.message}`);
  }
};

/**
 * Updates the release-please config with the new action
 * @param {string} actionName - Name of the action
 */
const updateReleaseConfig = async (actionName) => {
  let config = {};

  try {
    const configContent = await readFile(RELEASE_CONFIG_PATH, 'utf8');
    const trimmedContent = configContent.trim();

    // Handle empty file or whitespace-only content
    if (trimmedContent) {
      config = JSON.parse(trimmedContent);
    }
  } catch (error) {
    // If file doesn't exist or has invalid JSON, start with empty config
    console.log('⚠️  Creating new release config file');
    config = {};
  }

  // Ensure packages object exists
  if (!config.packages) {
    config.packages = {};
  }

  // Add new action configuration
  config.packages[`actions/${actionName}`] = {
    'package-name': actionName,
    'release-type': 'simple',
    'extra-files': ['README.md'],
  };

  // Sort the package keys alphabetically
  const sortedPackages = Object.keys(config.packages)
    .sort()
    .reduce((acc, key) => {
      acc[key] = config.packages[key];
      return acc;
    }, {});

  config.packages = sortedPackages;

  await writeFile(RELEASE_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');

  // Format the config file with Prettier
  await formatFileWithPrettier(RELEASE_CONFIG_PATH);
};

/**
 * Cleans up partially created action in case of failure
 * @param {string} actionPath - Path to the action directory to clean up
 * @param {string} actionName - Name of the action for manifest cleanup
 * @param {string} originalConfig - Original config content to restore
 * @param {string} originalReadme - Original README content to restore
 */
const cleanupOnFailure = async (actionPath, actionName, originalConfig = null, originalReadme = null) => {
  console.log('🧹 Cleaning up after failure...');

  try {
    // Remove action directory if it exists
    if (existsSync(actionPath)) {
      await rm(actionPath, { recursive: true, force: true });
      console.log('✅ Removed action directory');
    }

    // Restore original config if we have it
    if (originalConfig !== null) {
      await writeFile(RELEASE_CONFIG_PATH, originalConfig, 'utf8');
      console.log('✅ Restored release config');
    }

    // Restore original README if we have it
    if (originalReadme !== null) {
      await writeFile(ROOT_README_PATH, originalReadme, 'utf8');
      console.log('✅ Restored root README');
    }
  } catch (cleanupError) {
    console.error('⚠️  Error during cleanup:', cleanupError.message);
  }
};

/**
 * Updates the root README with the new action
 * @param {string} actionName - Name of the action
 * @param {string} actionDescription - Description of the action
 */
const updateRootReadme = async (actionName, actionDescription) => {
  const readmeContent = await readFile(ROOT_README_PATH, 'utf8');

  // Find the actions section and add the new action
  const actionEntry = `- [${actionName}](./actions/${actionName}) - ${actionDescription}`;

  // Look for the Actions section header specifically
  const actionsSectionHeaderRegex = /^## Actions\s*$/m;
  const hasActionsSection = actionsSectionHeaderRegex.test(readmeContent);

  if (hasActionsSection) {
    // Find the line after "## Actions" and insert the new action there
    const actionsHeaderMatch = readmeContent.match(/(^## Actions\s*\n)/m);
    if (actionsHeaderMatch) {
      const headerWithNewline = actionsHeaderMatch[1];
      const headerIndex = readmeContent.indexOf(headerWithNewline);
      const afterHeader = headerIndex + headerWithNewline.length;

      // Check if there's already content after the header
      const afterHeaderContent = readmeContent.substring(afterHeader);
      const nextSectionMatch = afterHeaderContent.match(/^## /m);

      let insertPosition;
      let contentToInsert;

      if (nextSectionMatch) {
        // There's a next section, check if there are existing actions
        const contentBeforeNextSection = afterHeaderContent.substring(0, nextSectionMatch.index);
        const hasExistingActions = contentBeforeNextSection.trim().length > 0;

        if (hasExistingActions) {
          // Add after existing actions
          insertPosition = afterHeader + nextSectionMatch.index;
          contentToInsert = `${actionEntry}\n`;
        } else {
          // First action in empty section
          insertPosition = afterHeader;
          contentToInsert = `\n${actionEntry}\n`;
        }
      } else {
        // No next section, add at the end of file
        const hasExistingActions = afterHeaderContent.trim().length > 0;
        if (hasExistingActions) {
          // Add after existing actions
          insertPosition = readmeContent.length;
          contentToInsert = `\n${actionEntry}`;
        } else {
          // First action in empty section
          insertPosition = afterHeader;
          contentToInsert = `\n${actionEntry}`;
        }
      }

      const updatedContent = readmeContent.substring(0, insertPosition) + contentToInsert + readmeContent.substring(insertPosition);

      await writeFile(ROOT_README_PATH, updatedContent, 'utf8');
    }
  } else {
    // If no actions section exists, add one at the end
    const updatedContent = readmeContent.trim() + `\n\n## Actions\n\n${actionEntry}\n`;
    await writeFile(ROOT_README_PATH, updatedContent, 'utf8');
  }
};

/**
 * Main function to create a new action
 */
const createNewAction = async () => {
  const rl = createReadlineInterface();
  let originalConfig = null;
  let originalReadme = null;
  let actionPath = null;
  let activeSpinner = null;

  try {
    console.log('🚀 Creating a new GitHub Action\n');

    // Get action name
    let actionName;
    do {
      actionName = await promptUser(rl, 'Enter action name (lowercase, kebab-case): ');

      const isValidName = isValidActionName(actionName);
      if (!isValidName) {
        console.log('❌ Invalid action name. Use lowercase letters, numbers, and hyphens only. Must start with a letter.');
        continue;
      }

      // Check if action already exists
      actionPath = join(ACTIONS_FOLDER, actionName);
      if (existsSync(actionPath)) {
        console.log(`❌ Action "${actionName}" already exists. Please choose a different name.`);
        continue;
      }

      break;
    } while (true);

    // Get action description
    const actionDescription = await promptUser(rl, 'Enter action description: ');

    if (!actionDescription) {
      console.log('❌ Description is required');
      process.exit(1);
    }

    console.log(`\n📝 Creating action "${actionName}"...`);

    // Store original content for potential rollback
    originalConfig = await readFileOrNull(RELEASE_CONFIG_PATH);
    originalReadme = await readFileOrNull(ROOT_README_PATH);

    // Copy template files
    activeSpinner = ora('Copying template files...').start();
    await copyTemplateFiles(TEMPLATE_FOLDER, actionPath, actionName, actionDescription);
    await sleep(COPY_FILES_DELAY); // Make step feel more substantial
    activeSpinner.succeed('Template files copied');

    // Create README
    activeSpinner = ora('Creating README...').start();
    await createActionReadme(actionPath, actionName, actionDescription);
    await sleep(CREATE_README_DELAY);
    activeSpinner.succeed('README created');

    // Update release config
    activeSpinner = ora('Updating release config...').start();
    await updateReleaseConfig(actionName);
    await sleep(UPDATE_CONFIG_DELAY);
    activeSpinner.succeed('Release config updated');

    // Update root README
    activeSpinner = ora('Updating root README...').start();
    await updateRootReadme(actionName, actionDescription);
    await sleep(UPDATE_ROOT_README_DELAY);
    activeSpinner.succeed('Root README updated');

    // Clear active spinner reference after completion
    activeSpinner = null;

    console.log(`\n🎉 Action "${actionName}" created successfully!`);
    console.log(`📁 Location: ${actionPath}`);
    console.log(`\nNext steps:`);
    console.log(`1. Edit the action.yml file in ${actionPath}`);
    console.log(`2. Implement your action logic`);
    console.log(`3. Update the README with proper inputs/outputs documentation`);
  } catch (error) {
    // Stop any active spinner before showing error
    if (activeSpinner) {
      activeSpinner.fail('Operation failed');
      activeSpinner = null;
    }

    console.error('❌ Error creating action:', error.message);

    // Perform cleanup
    if (actionPath) {
      await cleanupOnFailure(actionPath, null, originalConfig, originalReadme);
    }

    process.exit(1);
  } finally {
    // Ensure spinner is stopped in all cases
    if (activeSpinner) {
      activeSpinner.stop();
    }
    rl.close();
  }
};

// Run the script
createNewAction();
