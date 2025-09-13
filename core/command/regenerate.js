const path = require('path');
const fs = require('../util/fs');
const logger = require('../util/logger')('regenerate');
const engineTools = require('../util/engineTools');
const cloneDeep = require('lodash/cloneDeep');

function ensureViewportLabel (configJSON) {
  if (Array.isArray(configJSON.viewports)) {
    configJSON.viewports.forEach(vp => {
      if (!vp.label) vp.label = vp.name;
    });
  }
}

function toAbsolute (projectPath, p) {
  return (path.isAbsolute(p)) ? p : path.join(projectPath, p);
}

async function buildCompareConfigFromConfig (config, target) {
  // Load user config (object-literal or file)
  const configJSON = (typeof config.args.config === 'object')
    ? cloneDeep(config.args.config)
    : Object.assign({}, require(config.backstopConfigFileName));

  ensureViewportLabel(configJSON);

  // Apply filter if provided
  if (config.args.filter) {
    const filters = String(config.args.filter).split(',');
    const scenarios = [];
    (configJSON.scenarios || []).forEach(scn => {
      if (filters.some(f => new RegExp(f).test(scn.label))) scenarios.push(scn);
    });
    configJSON.scenarios = scenarios;
  }

  // Prepare minimal engine config used by engineTools.generateTestPair()
  const engineConfig = {
    // required for engineTools
    paths: {
      bitmaps_test: config.bitmaps_test,
      bitmaps_reference: config.bitmaps_reference
    },
    fileNameTemplate: configJSON.fileNameTemplate,
    outputFormat: configJSON.outputFormat,
    id: config.id,
    backstopConfigFileName: config.backstopConfigFileName,
    defaultMisMatchThreshold: config.defaultMisMatchThreshold,
    defaultRequireSameDimensions: config.defaultRequireSameDimensions,
    // also expose scenario defaults for parity
    scenarioDefaults: configJSON.scenarioDefaults || {}
  };

  // Mirror runtime-calculated values used by engines
  const DEFAULT_FILENAME_TEMPLATE = '{configId}_{scenarioLabel}_{selectorIndex}_{selectorLabel}_{viewportIndex}_{viewportLabel}';
  engineConfig._bitmapsTestPath = engineConfig.paths.bitmaps_test || 'bitmaps_test';
  engineConfig._bitmapsReferencePath = engineConfig.paths.bitmaps_reference || 'bitmaps_reference';
  engineConfig._fileNameTemplate = engineConfig.fileNameTemplate || DEFAULT_FILENAME_TEMPLATE;
  engineConfig._outputFileFormatSuffix = '.' + ((engineConfig.outputFormat && engineConfig.outputFormat.match(/jpg|jpeg/)) || 'png');
  engineConfig._configId = engineConfig.id || engineTools.genHash(engineConfig.backstopConfigFileName);
  engineConfig.screenshotDateTime = target;

  const testPairs = [];

  const scenarios = (configJSON.scenarios || []).map(s => ({ ...engineConfig.scenarioDefaults, ...s }));
  scenarios.forEach((scenario, sIndex) => {
    scenario.sIndex = sIndex;
    const scenarioLabelSafe = engineTools.makeSafe(scenario.label);
    const variantOrScenarioLabelSafe = scenario._parent ? engineTools.makeSafe(scenario._parent.label) : scenarioLabelSafe;

    let desiredViewports = Array.isArray(scenario.viewports) && scenario.viewports.length
      ? scenario.viewports
      : (configJSON.viewports || []);
    // ensure viewport labels
    desiredViewports = desiredViewports.map((vp, i) => ({ ...vp, vIndex: typeof vp.vIndex === 'number' ? vp.vIndex : i, label: vp.label || vp.name || '' }));

    const selectors = Array.isArray(scenario.selectors) ? scenario.selectors : [];
    desiredViewports.forEach(viewport => {
      if (!selectors.length) {
        // If no selectors were provided, default to document to match typical capture default
        const testPair = engineTools.generateTestPair(engineConfig, scenario, viewport, variantOrScenarioLabelSafe, scenarioLabelSafe, 0, 'document');
        testPairs.push(testPair);
      } else {
        selectors.forEach((selector, selectorIndex) => {
          const testPair = engineTools.generateTestPair(engineConfig, scenario, viewport, variantOrScenarioLabelSafe, scenarioLabelSafe, selectorIndex, selector);
          testPairs.push(testPair);
        });
      }
    });
  });

  const compareConfigContent = { compareConfig: { testPairs } };
  await fs.writeFile(config.tempCompareConfigFileName, JSON.stringify(compareConfigContent, null, 2));
}

module.exports = {
  execute: function (config) {
    const { shouldRunDocker, runDocker } = require('../util/runDocker');
    const executeCommand = require('./index');

    const target = config.args.target || config.args.t;
    if (!target) {
      throw new Error('Missing required option --target. Provide a directory name under paths.bitmaps_test.');
    }

    const targetDir = path.join(config.bitmaps_test, target);
    return fs.pathExists(targetDir).then(async exists => {
      if (!exists) {
        throw new Error(`Target directory not found: ${targetDir}`);
      }

      // Set target on config for report paths
      config.screenshotDateTime = target;

      // Build compare config from config and target
      await buildCompareConfigFromConfig(config, target);

      if (shouldRunDocker(config)) {
        return runDocker(config, 'regenerate').finally(() => {
          if (config.openReport && config.report && config.report.indexOf('browser') > -1) {
            executeCommand('_openReport', config);
          }
        });
      } else {
        return executeCommand('_report', config);
      }
    });
  }
};
