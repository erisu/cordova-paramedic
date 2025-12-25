/**
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

const fs = require('node:fs');
const path = require('node:path');

const { logger, utilities } = require('./utils');

class ParamedicConfigOption {
    constructor (
        key,
        type = 'boolean',
        description = '',
        defaultValue = undefined,
        required = false
    ) {
        this.internal = false;
        this.key = key;
        this.type = type;
        this.description = description;
        this.defaultValue = defaultValue;
        this.required = required;
    }

    toJSON () {
        return {
            type: this.type,
            required: this.required,
            description: this.description,
            defaultValue: this.defaultValue
        };
    }
}

class ParamedicConfigInternalOption extends ParamedicConfigOption {
    constructor (...args) {
        super(...args);
        this.internal = true;
    }

    toJSON () {
        return {
            type: this.type,
            required: this.required,
            description: this.description,
            defaultValue: this.defaultValue
        };
    }
}

class ParamedicConfig {
    static #DEFAULT_TIMEOUT = 60 * 60 * 1000; // 60 Minutes in Milliseconds
    static #DEFAULT_CLI = 'cordova'; // Global Cordova CLI

    /**
     * Place where verbose flag is stored for early use. This will exist the config object is set.
     *
     * @var {Boolean} verbose
     */
    #verbose = false;

    static Options = Object.freeze({
        PLATFORM: new ParamedicConfigOption(
            Symbol('platform'),
            'string',
            'Platform of which the plugin is tested on. (E.g. android, ios)',
            undefined,
            true
        ),
        PLUGIN: new ParamedicConfigOption(
            Symbol('plugin'),
            'string',
            'Plugin directory that will be tested',
            undefined,
            true
        ),
        ARGS: new ParamedicConfigOption(
            Symbol('args'),
            'string',
            'Parameter to provide additional "cordova <build|run>" command line argument.',
            [],
            false
        ),
        CI: new ParamedicConfigOption(
            Symbol('ci'),
            'boolean',
            'Flag to skip tests that require user interaction.',
            false,
            false
        ),
        CLEAN_UP_AFTER_RUN: new ParamedicConfigOption(
            Symbol('cleanUpAfterRun'),
            'boolean',
            'Removes temporary directories after the run completes.',
            true,
            false
        ),
        CLI: new ParamedicConfigOption(
            Symbol('cli'),
            'string',
            'Path to the Cordova CLI to use.',
            ParamedicConfig.#DEFAULT_CLI,
            false
        ),
        CONFIG: new ParamedicConfigOption(
            Symbol('config'),
            'string',
            'Path paramedic run config file.',
            undefined,
            false
        ),
        JUST_BUILD: new ParamedicConfigOption(
            Symbol('justBuild'),
            'boolean',
            'Flag to only build and not run tests.',
            false,
            false
        ),
        OUTPUT_DIR: new ParamedicConfigOption(
            Symbol('outputDir'),
            'string',
            'Directory path where logs will be saved, if available.',
            undefined,
            false
        ),
        SKIP_MAIN_TESTS: new ParamedicConfigOption(
            Symbol('skipMainTests'),
            'boolean',
            'Flag to not run the main tests (cordova-test-framework).',
            false,
            false
        ),
        TARGET: new ParamedicConfigOption(
            Symbol('target'),
            'string',
            'Target which the application will be deployed and run on.',
            undefined,
            false
        ),
        TCC_DB: new ParamedicConfigOption(
            Symbol('tccDb'),
            'string',
            '(iOS Only) Path to the TCC database file that will be updated/copied.',
            undefined,
            false
        ),
        TIMEOUT: new ParamedicConfigOption(
            Symbol('timeout'),
            'string',
            'Timeout limit',
            ParamedicConfig.#DEFAULT_TIMEOUT,
            false
        ),
        VERBOSE: new ParamedicConfigOption(
            Symbol('verbose'),
            'boolean',
            'Flag to enable verbose logging',
            false,
            true
        ),
        VERSION: new ParamedicConfigOption(
            Symbol('version'),
            'boolean',
            'Display Paramedic Version',
            undefined,
            null
        ),
        HELP: new ParamedicConfigOption(
            Symbol('help'),
            'boolean',
            'Display Paramedic Usage',
            undefined,
            null
        ),

        // Internals
        PLUGINS: new ParamedicConfigInternalOption(
            Symbol('plugins'),
            'array',
            'A compiled list of all plugins to be installed',
            []
        )
    });

    // Stores the config data
    #config = {};

    // Stores an isntance of the config class object
    static #instance;

    constructor (cliArgs) {
        if (ParamedicConfig.#instance) {
            throw new Error('[paramedic] The config object was already initalized. Use getInstance() instead.');
        }

        // Set what comes from CLI.
        this.#verbose = cliArgs.verbose;

        // Build up the defaults. They are extracted from the ParamedicConfigOption.
        const defaults = Object.entries(ParamedicConfig.getParseArgOpts())
            .reduce((obj, [k, d]) => {
                obj[k] = d.defaultValue;
                return obj;
            }, {});

        const configFromFile = this.#getConfigFromFile(cliArgs?.config ?? false);

        this.#config = {
            ...defaults,
            // Take config from file first
            ...configFromFile,
            // Override them with CLI args if present.
            ...cliArgs
        };

        // Set the final verbose setting.
        this.#verbose = cliArgs.verbose;

        this.#formatPlugins();
        this.#setupCLI();

        ParamedicConfig.#instance = this;
    }

    get (opt) {
        if (!(opt instanceof ParamedicConfigOption)) {
            throw new Error('[paramedic] Invlaid option provided to ParamedicConfig.get()');
        }
        return this.#config?.[opt.key.description] ?? null;
    }

    getPlatform (forInstall = false) {
        const value = this.get(ParamedicConfig.Options.PLATFORM);
        return forInstall ? value : (value.split('@')?.[0] ?? '').toLowerCase();
    }

    isAndroid () {
        return this.getPlatform() === utilities.ANDROID;
    }

    isBrowser () {
        return this.getPlatform() === utilities.BROWSER;
    }

    isIos () {
        return this.getPlatform() === utilities.IOS;
    }

    /**
     * Returns instance of ParamedicConfig if created
     * @throws {Error} When instance is not initialized
     * @returns {ParamedicConfig}
     */
    static getInstance () {
        if (!ParamedicConfig.#instance) {
            throw new Error('[paramedic] ParamedicConfig has not been initialized.');
        }

        return ParamedicConfig.#instance;
    }

    static getParseArgOpts () {
        const resp = {};
        for (const knownOpts of Object.values(ParamedicConfig.Options)) {
            if (!knownOpts.internal) {
                resp[knownOpts.key.description] = knownOpts.toJSON();
            }
        }
        return resp;
    }

    static getUsage (hasError = false) {
        return [
            // Display error line if there was an error
            ...(hasError ? ['Error: Missing Arguments\n'] : []),
            // Show example command
            'Example Command:\n',
            '    cordova-paramedic --platform PLATFORM --plugin PATH [--justbuild --timeout MSECS --version ...]\n',
            // Compile and list out all valid command arguments
            'Command Arguments:\n',
            ...Object.entries(ParamedicConfig.getParseArgOpts())
                .map(([opt, details]) => {
                    const requiredText = details.required === null
                        ? ''
                        : `(Required: ${details.required})`;

                    return `    --${opt}: ${requiredText}\n      ${details.description}`;
                }),
            ''
        ].join('\n');
    }

    #getConfigFromFile (configPath) {
        // No config path provided.
        if (!configPath) {
            return {};
        }

        // Path was absolute but did not exist, return out. No need to try and find.
        if (this.#verbose) {
            logger.info(`[paramedic] Attempting to locate config file at: ${configPath}`);
        }
        if (path.isAbsolute(configPath) && !fs.existsSync(configPath)) {
            return {};
        }

        // For non-absolute paths, will build out a searchpath
        const searchPath = [path.resolve(configPath)];

        // Try with the following path to match older behavior.
        searchPath.push(path.resolve('conf', configPath));

        if (!configPath.endsWith('.config.json')) {
            searchPath.push(path.resolve(`${configPath}.config.json`));
            searchPath.push(path.join(__dirname, '..', '..', 'conf', `${configPath}.config.json`));
        }

        for (const configFile of searchPath) {
            try {
                if (this.#verbose) {
                    logger.info(`[paramedic] Attempting to locate config file at: ${configFile}`);
                }
                if (fs.existsSync(configFile)) {
                    return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
                }
            } catch {}
        }

        logger.warn('[paramedic] Failed to locate or parse config file. Attempting to run with defaults...');
        return {};
    }

    /**
     * During the construction of the instance, we will format the plugins config
     * option into an array plugins that needs to be installed for either build
     * and run action.
     *
     * The plugins will contain:
     * 1. cordova-plugin-test-framework (need for the actual test)
     * 2. paramedic-plugin (which has specific paramedic app configurations)
     * 3. ios-geolocation-permissions-plugin (If the platform is iOS)
     * 4. ci-plugin (When CI is Enabled)
     * 5. The user's provided plugin E.g. (cordova-plugin-camera)
     * 6. The user's provided plugin test E.g. (cordova-plugin-camera/tests/)
     */
    #formatPlugins () {
        const userRequestedPluginPath = path.resolve(this.#config.plugin);
        const userRequestedPlugin = [userRequestedPluginPath];
        // This is following Cordova's requirement. Any other directory is not valid.
        const userRequestedPluginTestPath = path.resolve(userRequestedPluginPath, 'tests');
        if (fs.existsSync(path.join(userRequestedPluginTestPath, 'plugin.xml'))) {
            userRequestedPlugin.push(userRequestedPluginTestPath);
        }

        this.#config.plugins = [
            'github:apache/cordova-plugin-test-framework',
            path.join(__dirname, '..', 'paramedic-plugin'),

            // iOS Plugins
            ...(
                this.isIos()
                    ? [path.join(__dirname, '..', 'ios-geolocation-permissions-plugin')]
                    : []
            ),

            // CI Plugins
            ...(
                this.#config.ci
                    ? [path.join(__dirname, '..', 'ci-plugin')]
                    : []
            ),

            // User requested plugin for testing
            ...userRequestedPlugin
        ];
    }

    #setupCLI () {
        if (!['cordova', 'phonegap'].includes(this.#config.cli)) {
            if (!path.isAbsolute(this.#config.cli)) {
                const cliAbsolutePath = path.resolve(this.#config.cli);

                if (fs.existsSync(cliAbsolutePath)) {
                    this.#config.cli = cliAbsolutePath;
                } else {
                    this.#config.cli = ParamedicConfig.#DEFAULT_CLI;
                }
            }
        }
    }

    toJSON () {
        // Remove the undefined configs
        return Object.fromEntries(
            Object.entries(this.#config).filter(([key, value]) =>
                // Arrays that has data
                (Array.isArray(value) && value.length > 0) ||
                // Not arrays and not undefined
                (!Array.isArray(value) && value !== undefined)
            )
        );
    }
}

module.exports = ParamedicConfig;
