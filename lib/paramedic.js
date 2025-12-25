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

const path = require('node:path');
const fs = require('node:fs');
const { setTimeout: timelimit } = require('node:timers/promises');

const Server = require('./LocalServer');
const { logger, utilities, spawnAsync } = require('./utils');
const Reporters = require('./Reporters');
const ParamedicKill = require('./ParamedicKill');
const ParamedicLogCollector = require('./ParamedicLogCollector');
const ParamediciOSPermissions = require('./ParamediciOSPermissions');
const ParamedicTargetChooser = require('./ParamedicTargetChooser');
const ParamedicAppUninstall = require('./ParamedicAppUninstall');
const ParamedicApp = require('./ParamedicApp');
const ParamedicConfig = require('./ParamedicConfig');

// Time to wait for initial device connection.
// If device has not connected within this interval the tests are stopped.
const INITIAL_CONNECTION_TIMEOUT = 540000; // 9mins

class ParamedicRunner {
    constructor () {
        /*
         * Get the config instance and extract needed configs for the ParamedicRunner.
         */
        this.config = ParamedicConfig.getInstance();
        this.runMainTests = !this.config.get(ParamedicConfig.Options.SKIP_MAIN_TESTS);
        this.platform = this.config.getPlatform();
        this.timeout = this.config.get(ParamedicConfig.Options.TIMEOUT);
        this.justBuild = this.config.get(ParamedicConfig.Options.JUST_BUILD);
        this.cleanUpAfterRun = this.config.get(ParamedicConfig.Options.CLEAN_UP_AFTER_RUN);
        this.outputDir = this.config.get(ParamedicConfig.Options.OUTPUT_DIR);
        this.cliCmd = this.config.get(ParamedicConfig.Options.CLI);
        this.cliCmdArgs = this.config.get(ParamedicConfig.Options.ARGS);
        this.target = this.config.get(ParamedicConfig.Options.TARGET);

        this.tempFolder = null;
        this.targetObj = undefined;
    }

    /**
     * The main runner that:
     * - Creates, sets up, & prepares the project.
     * - Runs the project
     * - Executes the tests
     *
     * On a successful case, the test results should be returned.
     *
     * An error can be thrown if there was any issues within the
     * process. Failures in the app uninstall process will not
     * error out.
     *
     * @returns {Promise}
     */
    async run () {
        this.checkConfig();

        const paramedicApp = new ParamedicApp(this.storedCWD, this);

        try {
            // Create a Cordova project
            this.tempFolder = await paramedicApp.createTempProject();

            // Prepare the project by installing plugins, platforms, seting up test startpage, & check platform requirements
            await paramedicApp.prepareProjectToRunTests();

            // Start server if the tests are to run
            if (this.runMainTests) {
                this.server = await Server.startServer();

                this.injectReporters();
                this.subcribeForEvents();

                const logUrl = this.server.getMedicAddress(this.platform);
                this.writeMedicJson(logUrl);

                logger.normal('[paramedic] Start building app and running tests at ' + (new Date()).toLocaleTimeString());
            }

            const results = await Promise.race([
                this.runLocalTests(),
                // If the tests fails to complete in the allowed timelimit, it will reject (default 60 minutes)
                timelimit(this.timeout)
                    .then(() => Promise.reject(
                        new Error(`[paramedic] Tests failed to complete in ${this.timeout} ms.`)
                    ))
            ]);

            logger.warn('---------------------------------------------------------');
            logger.warn('6. Collect data and clean up');
            logger.warn('---------------------------------------------------------');
            logger.normal('Completed tests at ' + (new Date()).toLocaleTimeString());

            // When --justbuild is not set, fetch logs from the device.
            if (!this.justBuild) {
            // collect logs and uninstall app
                await this.collectDeviceLogs();

                try {
                    await this.uninstallApp();
                } catch {
                    // do not fail if uninstall failed
                } finally {
                    this.killEmulatorProcess();
                }
            }

            return results;
        } catch (error) {
            logger.error(error);
            console.log(error.stack);
            throw error;
        } finally {
            this.cleanUpProject();
        }
    }

    checkConfig () {
        logger.warn('---------------------------------------------------------');
        logger.warn('0. Paramedic config');
        this.#loopConfigPrintout(this.config.toJSON());
        logger.warn('---------------------------------------------------------');
    }

    #loopConfigPrintout (config, isArray) {
        for (const [key, value] of Object.entries(config)) {
            if (Array.isArray(value)) {
                logger.warn(`   - ${key}:`);
                this.#loopConfigPrintout(value, true);
            } else if (typeof value === 'object') {
                this.#loopConfigPrintout(value, false);
            } else {
                if (isArray) {
                    logger.warn(`       - ${value}`);
                } else {
                    logger.warn(`   - ${key}: ${value}`);
                }
            }
        }
    }

    /**
     * Setup iOS related Permissions
     */
    async setPermissions () {
        const applicationsToGrantPermission = ['kTCCServiceAddressBook'];
        if (this.config.isIos()) {
            logger.info('[paramedic] Setting required permissions.');
            const tccDb = this.config.get(ParamedicConfig.Options.TCC_DB);
            if (tccDb) {
                const appName = utilities.PARAMEDIC_DEFAULT_APP_NAME;
                const paramediciOSPermissions = new ParamediciOSPermissions(appName, tccDb, this.targetObj);
                await paramediciOSPermissions.updatePermissions(applicationsToGrantPermission);
            }
        }
    }

    injectReporters () {
        const reporters = Reporters.getReporters(this.outputDir);

        [
            'jasmineStarted',
            'specStarted',
            'specDone',
            'suiteStarted',
            'suiteDone',
            'jasmineDone'
        ].forEach((route) => {
            reporters.forEach((reporter) => {
                if (reporter[route] instanceof Function) {
                    this.server.on(route, reporter[route].bind(reporter));
                }
            });
        });
    }

    subcribeForEvents () {
        this.server.on('deviceLog', (data) => {
            logger.verbose('device|console.' + data.type + ': ' + data.msg[0]);
        });

        this.server.on('deviceInfo', (data) => {
            logger.normal('[paramedic] Device info: ' + JSON.stringify(data));
        });
    }

    writeMedicJson (logUrl) {
        logger.normal('[paramedic] writing medic log url to project ' + logUrl);
        const medicFilePath = path.join(this.tempFolder.name, 'www', 'medic.json');
        const medicFileContent = JSON.stringify({ logurl: logUrl });
        fs.writeFileSync(medicFilePath, medicFileContent);
    }

    /**
     * Runs the local tests (Jasmine) and returns the results.
     * A reject maybe returned for example the tests do not complete in the timelimit.
     *
     * @returns {Promise}
     */
    async runLocalTests () {
        logger.warn('---------------------------------------------------------');
        logger.warn('4. Run (Jasmine) tests...');
        logger.warn('... locally');
        logger.warn('---------------------------------------------------------');

        // checking for Android platform here because in this case we still need to start an emulator
        // will check again a bit lower
        if (!this.runMainTests && this.config.isAndroid()) {
            logger.normal('Skipping main tests...');
            return utilities.TEST_PASSED;
        }

        logger.info('[paramedic] running tests locally');
        await this.setPermissions();

        const cmdArgs = await this.getRunLocalTestCommandArgs();

        if (this.justBuild) {
            await spawnAsync(
                this.cliCmd,
                cmdArgs,
                { cwd: this.tempFolder.name }
            );

            // Build only does not trigger tests. Pass will be returned.
            return utilities.TEST_PASSED;
        }

        // Main tests are being skipped. Pass will be returned.
        if (!this.runMainTests) {
            logger.normal('[paramedic] Skipping main tests...');
            return utilities.TEST_PASSED;
        }

        // Waiting for test results for run/emulate commands.
        if (!this.justBuild) {
            return await Promise.race([
                this.waitForTests(cmdArgs), // resolve on request
                timelimit(INITIAL_CONNECTION_TIMEOUT).then(() => {
                    if (!this.server.isDeviceConnected()) {
                        const ERR_MSG = `[paramedic] The device failed to connect to local server in ${INITIAL_CONNECTION_TIMEOUT / 1000} secs`;
                        return Promise.reject(new Error(ERR_MSG));
                    }
                })
            ]);
        }

        // Nothing happened so return pass.
        return utilities.TEST_PASSED;
    }

    async waitForTests (cmdArgs) {
        logger.info('[paramedic] Waiting for test results...');

        const testResults = new Promise((resolve, reject) => {
            this.server.on('jasmineDone', (data) => {
                logger.info('[paramedic] Tests has completed.');
                resolve(data.specResults.specFailed === 0);
            });
            this.server.on('disconnect', () => {
                reject(new Error('[paramedic] Device is disconnected before passing the tests'));
            });
        });

        // This spawns the Cordova run command. It will build, run, and trigger the automatic tests.
        await spawnAsync(
            this.cliCmd,
            cmdArgs,
            { cwd: this.tempFolder.name }
        );

        return testResults;
    }

    /**
     * Creates the run/build command.
     *
     * @returns {Array}
     */
    async getRunLocalTestCommandArgs () {
        const isBuild = this.justBuild;
        const args = [
            isBuild ? 'build' : 'run',
            this.platform,
            ...this.cliCmdArgs,
            ...utilities.PARAMEDIC_COMMON_ARGS
        ];

        if (this.config.isBrowser() || this.justBuild) {
            return args;
        }

        const targetChooser = new ParamedicTargetChooser(this.tempFolder.name);
        this.targetObj = await targetChooser.chooseTarget(this.target);

        // CB-11472 In case of iOS provide additional '--emulator' flag, otherwise
        // 'cordova run ios --target' would hang waiting for device with name
        // as specified in 'target' in case if any device is physically connected
        return [
            ...args,
            '--target',
            this.targetObj.target
        ].concat(this.config.isIos() ? ['--emulator'] : []);
    }

    /**
     * Removes the temporary project directory if flagged to cleanup after run.
     */
    cleanUpProject () {
        if (this.cleanUpAfterRun) {
            logger.info('[paramedic] Removing Temporary Project: ' + this.tempFolder.name);
            fs.rmSync(this.tempFolder.name, { force: true, recursive: true });
        }
    }

    killEmulatorProcess () {
        if (this.cleanUpAfterRun) {
            logger.info('[paramedic] Terminating Emulator Process');
            const paramedicKill = new ParamedicKill(this.platform);
            paramedicKill.kill();
        }
    }

    /**
     * Collects and stores logs when possible
     */
    async collectDeviceLogs () {
        logger.info('[paramedic] Collecting Device Logs');
        const outputDir = this.outputDir ? this.outputDir : this.tempFolder.name;
        const paramedicLogCollector = new ParamedicLogCollector(this.platform, this.tempFolder.name, outputDir, this.targetObj);
        await paramedicLogCollector.collectLogs();
    }

    uninstallApp () {
        logger.info('[paramedic] Uninstalling App');
        const paramedicAppUninstall = new ParamedicAppUninstall(this.tempFolder.name, this.platform);
        return paramedicAppUninstall.uninstallApp(this.targetObj, utilities.PARAMEDIC_DEFAULT_APP_NAME);
    }
}

let storedCWD = null;

exports.run = function () {
    storedCWD = storedCWD || process.cwd();

    const runner = new ParamedicRunner(null);
    runner.storedCWD = storedCWD;

    return runner.run();
};
