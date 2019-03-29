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

const cp = require('child_process');
const { logger, utilities, exec, execPromise } = require('./utils');
const shell = require('shelljs');
const Server = require('./LocalServer');
const path = require('path');
const fs = require('fs');
const Reporters = require('./Reporters');
const ParamedicKill = require('./ParamedicKill');
const AppiumRunner = require('./appium/AppiumRunner');
const ParamedicLogCollector = require('./ParamedicLogCollector');
const ParamediciOSPermissions = require('./ParamediciOSPermissions');
const ParamedicTargetChooser = require('./ParamedicTargetChooser');
const ParamedicAppUninstall = require('./ParamedicAppUninstall');
const ParamedicApp = require('./ParamedicApp');
const ParamedicSauceLabs = require('./ParamedicSauceLabs');

// this will add custom promise chain methods to the driver prototype
require('./appium/helpers/wdHelper');

// Time to wait for initial device connection.
// If device has not connected within this interval the tests are stopped.
const INITIAL_CONNECTION_TIMEOUT = 540000; // 9mins

// Stores the current working directory. Set by the `exports.run` method call
let storedCWD;

class ParamedicRunner {
    constructor (config, _callback) {
        this.tempFolder = null;
        this.targetObj = undefined;
        this.paramedicSauceLabs = null;

        this.config = config;
        this.platformId = this.config.getPlatformId();
        this.isPlatformAndroid = this.platformId === utilities.ANDROID;
        this.isPlatformBrowser = this.platformId === utilities.BROWSER;
        this.isPlatformIOS = this.platformId === utilities.IOS;

        exec.setVerboseLevel(config.isVerbose());
    }

    run () {
        this.checkConfig();

        return Promise.resolve()
            .then(() => {
                // create project and prepare (install plugins, setup test startpage, install platform, check platform requirements)
                const paramedicApp = new ParamedicApp(this.config, this.storedCWD, this);
                this.tempFolder = paramedicApp.createTempProject();
                shell.pushd(this.tempFolder.name);
                return paramedicApp.prepareProjectToRunTests();
            })
            .then(() => {
                if (this.config.runMainTests()) {
                // start server
                    const noListener = this.isPlatformBrowser && this.config.shouldUseSauce();
                    return Server.startServer(this.config.getPorts(), this.config.getExternalServerUrl(), this.config.getUseTunnel(), noListener);
                }
            })
            .then((server) => {
                if (this.config.runMainTests()) {
                    // configure server usage
                    this.server = server;
                    this.injectReporters();
                    this.subcribeForEvents();

                    const logUrl = this.server.getConnectionUrl(this.platformId);
                    this.writeMedicJson(logUrl);

                    logger.normal('Start running tests at ' + (new Date()).toLocaleTimeString());
                }

                // run tests
                return this.runTests();
            })
            .timeout(this.config.getTimeout(), 'Timed out after waiting for ' + this.config.getTimeout() + ' ms.')
            .catch((error) => {
                logger.error(error);
                console.log(error.stack);
                throw new Error(error);
            })
            .then((result) => {
                logger.normal('Completed tests at ' + (new Date()).toLocaleTimeString());
                // if we do --justbuild  or run on sauce,
                // we should NOT do actions below
                if (this.config.getAction() !== 'build' && !this.config.shouldUseSauce()) {
                // collect logs and uninstall app
                    this.collectDeviceLogs();
                    return this.uninstallApp()
                        .then(
                            () => {
                                this.killEmulatorProcess();
                            },
                            () => {
                                this.killEmulatorProcess();
                            }
                        );
                }
                return this.paramedicSauceLabs.displaySauceDetails(this.sauceBuildName);
            })
            .then(() => {
                this.cleanUpProject();
            });
    }

    checkConfig () {
        if (this.config.shouldUseSauce()) {
            this.paramedicSauceLabs = new ParamedicSauceLabs(this.config, this);
            this.paramedicSauceLabs.checkSauceRequirements();
        }

        if (!this.config.runMainTests() && !this.config.runAppiumTests()) {
            throw new Error('No tests to run: both --skipAppiumTests and --skipMainTests are used');
        }

        if (this.config.getCli() !== 'cordova' && this.config.getCli() !== 'phonegap') {
            if (!path.isAbsolute(this.config.getCli())) {
                const cliAbsolutePath = path.resolve(this.config.getCli());
                this.config.setCli(cliAbsolutePath);
            }
        }

        logger.info('cordova-paramedic: Will use the following cli: ' + this.config.getCli());
    }

    setPermissions () {
        let applicationsToGrantPermission = ['kTCCServiceAddressBook'];

        if (this.isPlatformIOS) {
            logger.info('cordova-paramedic: Setting required permissions.');

            const tccDb = this.config.getTccDb();
            if (tccDb) {
                const paramediciOSPermissions = new ParamediciOSPermissions(utilities.PARAMEDIC_DEFAULT_APP_NAME, tccDb, this.targetObj);
                paramediciOSPermissions.updatePermissions(applicationsToGrantPermission);
            }
        }
    }

    injectReporters () {
        [
            'jasmineStarted',
            'specStarted',
            'specDone',
            'suiteStarted',
            'suiteDone',
            'jasmineDone'
        ].forEach((route) => {
            Reporters.getReporters(this.config.getOutputDir()).forEach((reporter) => {
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
            logger.normal('cordova-paramedic: Device info: ' + JSON.stringify(data));
        });
    }

    writeMedicJson (logUrl) {
        logger.normal('cordova-paramedic: writing medic log url to project ' + logUrl);

        fs.writeFileSync(path.join('www', 'medic.json'), JSON.stringify({ logurl: logUrl }));
    }

    maybeRunFileTransferServer () {
        return Promise.resolve().then(() => {
            const plugins = this.config.getPlugins();

            for (let i = 0; i < plugins.length; i++) {
                if (plugins[i].indexOf('cordova-plugin-file-transfer') >= 0 && !this.config.getFileTransferServer() && !this.config.isCI()) {
                    return this.server.startFileTransferServer(this.tempFolder.name);
                }
            }
        });
    }

    runLocalTests () {
        let runProcess = null;

        // checking for Android platform here because in this case we still need to start an emulator
        // will check again a bit lower
        if (!this.config.runMainTests() && !this.isPlatformAndroid) {
            logger.normal('Skipping main tests...');
            return Promise.resolve(utilities.TEST_PASSED);
        }

        logger.info('cordova-paramedic: running tests locally');

        return Promise.resolve()
            .then(this.maybeRunFileTransferServer)
            .then(this.getCommandForStartingTests)
            .then((command) => {
                this.setPermissions();
                logger.normal('cordova-paramedic: running command ' + command);

                if (!this.isPlatformBrowser) return execPromise(command);

                console.log('$ ' + command);
                runProcess = cp.exec(command, () => {
                // a precaution not to try to kill some other process
                    runProcess = null;
                });
            })
            .then(() => {
            // skipping here and not at the beginning because we need to
            // start up the Android emulator for Appium tests to run on
                if (!this.config.runMainTests()) {
                    logger.normal('Skipping main tests...');
                    return utilities.TEST_PASSED;
                }

                // skip tests if it was just build
                if (this.shouldWaitForTestResult()) {
                    return new Promise((resolve, reject) => {
                        // reject if timed out
                        this.waitForConnection().catch(reject);
                        // resolve if got results
                        this.waitForTests().then(resolve);
                    });
                }

                return utilities.TEST_PASSED; // if we're not waiting for a test result, just report tests as passed
            })
            .then((result) => {
                if (runProcess) {
                    return new Promise((resolve, reject) => {
                        utilities.killProcess(runProcess.pid, () => resolve(result));
                    });
                }

                return result;
            });
    }

    runAppiumTests (useSauce) {
        logger.normal('Start running Appium tests...');

        if (this.config.getAction() === 'build') {
            logger.normal('Skipping Appium tests: action = build ...');
            return Promise.resolve(utilities.TEST_PASSED);
        }

        if (!this.config.runAppiumTests()) {
            logger.normal('Skipping Appium tests: not configured to run ...');
            return Promise.resolve(utilities.TEST_PASSED);
        }

        if (!this.isPlatformAndroid && !this.isPlatformIOS) {
            logger.warn('Unsupported platform for Appium test run: ' + this.platformId);
            // just skip Appium tests
            return Promise.resolve(utilities.TEST_PASSED);
        }

        if (!useSauce && (!this.targetObj || !this.targetObj.target)) {
            throw new Error('Cannot determine local device name for Appium');
        }

        logger.normal('Running Appium tests ' + (useSauce ? 'on Sauce Labs' : 'locally'));

        let options = {
            platform: this.platformId,
            appPath: this.tempFolder.name,
            pluginRepos: this.config.getPlugins().map((plugin) => path.join(this.tempFolder.name, 'plugins', path.basename(plugin))),
            appiumDeviceName: this.targetObj && this.targetObj.target,
            appiumPlatformVersion: null,
            screenshotPath: path.join(process.cwd(), 'appium_screenshots'),
            output: this.config.getOutputDir(),
            verbose: this.config.isVerbose(),
            sauce: useSauce,
            cli: this.config.getCli()
        };

        if (useSauce) {
            options.sauceAppPath = 'sauce-storage:' + this.paramedicSauceLabs.getAppName();
            options.sauceUser = this.config.getSauceUser();
            options.sauceKey = this.config.getSauceKey();
            options.sauceCaps = this.paramedicSauceLabs.getSauceCaps();
            options.sauceCaps.name += '_Appium';
        }

        const appiumRunner = new AppiumRunner(options);
        if (appiumRunner.options.testPaths && appiumRunner.options.testPaths.length === 0) {
            logger.warn(`Couldn't find Appium tests, skipping...`);
            return Promise.resolve(utilities.TEST_PASSED);
        }

        return Promise.resolve()
            .then(() => {
                return appiumRunner.prepareApp();
            })
            .then(() => {
                if (useSauce) {
                    return this.paramedicSauceLabs.packageApp()
                        .then(this.paramedicSauceLabs.uploadApp);
                }
            })
            .then(() => {
                return appiumRunner.runTests(useSauce);
            });
    }

    runTests () {
        let isTestPassed = false;
        // Sauce Labs
        if (this.config.shouldUseSauce()) {
            return this.paramedicSauceLabs.runSauceTests()
                .then((result) => {
                    isTestPassed = result;
                    return this.runAppiumTests(true);
                })
                .then((isAppiumTestPassed) => isTestPassed === utilities.TEST_PASSED && isAppiumTestPassed === utilities.TEST_PASSED);
        // Not Sauce Labs
        } else {
            return this.runLocalTests()
                .then((result) => {
                    isTestPassed = result;
                })
                .then(this.runAppiumTests.bind(this))
                .then((isAppiumTestPassed) => isTestPassed === utilities.TEST_PASSED && isAppiumTestPassed === utilities.TEST_PASSED);
        }
    }

    waitForTests () {
        logger.info('cordova-paramedic: waiting for test results');
        return new Promise((resolve, reject) => {

            // time out if connection takes too long
            setTimeout(() => {
                if (!this.server.isDeviceConnected()) {
                    reject(new Error('waitForTests: Seems like device not connected to local server in ' + INITIAL_CONNECTION_TIMEOUT / 1000 + ' secs'));
                }
            }, INITIAL_CONNECTION_TIMEOUT);

            this.server.on('jasmineDone', (data) => {
                logger.info('cordova-paramedic: tests have been completed');

                const isTestPassed = (data.specResults.specFailed === 0);
                resolve(isTestPassed);
            });

            this.server.on('disconnect', () => {
                reject(new Error('device is disconnected before passing the tests'));
            });
        });
    }

    getCommandForStartingTests () {
        let cmd = this.config.getCli() + ' ' + this.config.getAction() + ' ' + this.platformId + utilities.PARAMEDIC_COMMON_CLI_ARGS;

        function addConfigArgs (cmd) {
            if (this.config.getArgs()) {
                cmd += ' ' + this.config.getArgs();
            }

            return cmd;
        }

        if (this.isPlatformBrowser) return addConfigArgs(cmd);

        const paramedicTargetChooser = new ParamedicTargetChooser(this.tempFolder.name, this.config);

        // The app is to be run as a store app or just build. So no need to choose a target.
        if (this.config.getAction() === 'build' || (this.platformId === utilities.WINDOWS && this.config.getArgs().indexOf('appx=8.1-phone') < 0)) {
            return Promise.resolve(addConfigArgs(cmd));
        }

        // For now we always trying to run test app on emulator
        return Promise.resolve()
            .then(() => {
                const configTarget = this.config.getTarget();
                return paramedicTargetChooser.chooseTarget(/* useEmulator= */true, /* preferredTarget= */configTarget);
            })
            .then((targetObj) => {
                this.targetObj = targetObj;
                cmd += ' --target ' + this.targetObj.target;

                // CB-11472 In case of iOS provide additional '--emulator' flag, otherwise
                // 'cordova run ios --target' would hang waiting for device with name
                // as specified in 'target' in case if any device is physically connected
                if (this.isPlatformIOS) {
                    cmd += ' --emulator';
                }

                return addConfigArgs(cmd);
            });
    }

    shouldWaitForTestResult () {
        const action = this.config.getAction();
        return (action.indexOf('run') === 0) || (action.indexOf('emulate') === 0);
    }

    waitForConnection () {
        return new Promise((resolve, reject) => {
            setTimeout(() => {
                if (!this.server.isDeviceConnected()) {
                    reject(new Error('waitForConnection: Seems like device not connected to local server in ' + INITIAL_CONNECTION_TIMEOUT / 1000 + ' secs'));
                } else {
                    resolve();
                }
            }, INITIAL_CONNECTION_TIMEOUT);
        });
    }

    cleanUpProject () {
        this.server && this.server.cleanUp();
        if (this.config.shouldCleanUpAfterRun()) {
            logger.info('cordova-paramedic: Deleting the application: ' + this.tempFolder.name);
            shell.popd();
            shell.rm('-rf', this.tempFolder.name);
        }
    }

    killEmulatorProcess () {
        if (this.config.shouldCleanUpAfterRun()) {
            logger.info('cordova-paramedic: Killing the emulator process.');
            const paramedicKill = new ParamedicKill(this.platformId);
            paramedicKill.kill();
        }
    }

    collectDeviceLogs () {
        logger.info('Collecting logs for the devices.');
        const outputDir = this.config.getOutputDir() ? this.config.getOutputDir() : this.tempFolder.name;
        const logMins = this.config.getLogMins() ? this.config.getLogMins() : utilities.DEFAULT_LOG_TIME;
        const paramedicLogCollector = new ParamedicLogCollector(this.platformId, this.tempFolder.name, outputDir, this.targetObj);
        paramedicLogCollector.collectLogs(logMins);
    }

    uninstallApp () {
        logger.info('Uninstalling the app.');
        const paramedicAppUninstall = new ParamedicAppUninstall(this.tempFolder.name, this.platformId);
        return paramedicAppUninstall.uninstallApp(this.targetObj, utilities.PARAMEDIC_DEFAULT_APP_NAME);
    }
}

exports.run = function (paramedicConfig) {
    storedCWD = storedCWD || process.cwd();

    const runner = new ParamedicRunner(paramedicConfig, null);
    runner.storedCWD = storedCWD;
    return runner.run();
};
