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
const { exec, spawn } = require('node:child_process');

const wd = require('webdriverio');
const expectTelnet = require('expect-telnet');
const Jasmine = require('jasmine');
const unorm = require('unorm');
const portChecker = require('tcp-port-used');
const wdHelper = require('./helpers/wdHelper');
const screenshotHelper = require('./helpers/screenshotHelper');
const appPatcher = require('./helpers/appPatcher.js');
const { ParamedicReporter, getReporters } = require('../Reporters');
const { logger, spawnAsync, utilities } = require('../utils');

const SMALL_BUFFER_SIZE = 1024 * 1024;
const ROOT_DIR = path.join(__dirname, '..', '..');
const APPIUM_BIN = path.join(ROOT_DIR, 'node_modules', '.bin', 'appium');
const APPIUM_HOME = path.join(ROOT_DIR, '.appium');

/**
 * Sets the Appium home directory to isolate between system & cordova-paramedic's Appium
 */
process.env.APPIUM_HOME = APPIUM_HOME;

/**
 * Extracted Appium Configurations by Platform Name.
 */
const AppiumPlatformConfigs = {
    android: {
        driver: utilities.APPIUM_DRIVER_ANDROID.toLowerCase(),
        serverArgs: ['--allow-insecure', 'chromedriver_autodownload'],
        preferences: {
            loadUrlTimeoutValue: 60000
        }
    },
    ios: {
        driver: utilities.APPIUM_DRIVER_IOS.toLowerCase(),
        serverArgs: [],
        preferences: {
            CameraUsesGeolocation: 'true'
        }
    }
};

class AppiumRunner {
    /**
     * @param {Object} options
     * @throws {Error} When platform is not Android or iOS
     */
    constructor (options) {
        // Make sure AppiumRunner is locked down to Android & iOS only.
        if (![utilities.ANDROID, utilities.IOS].includes(options.platform)) {
            throw new Error('An instance of AppiumRunner can not be created for the platform: ' + options.platform);
        }
        this.#prepareOptions(options);

        /**
         * Storage contain for the Appium process
         */
        this.proc = {
            abortController: null,
            isAlive: false
        };

        this.createScreenshotDir();
        this.#findTests();
        this.setGlobals();
    }

    /**
     * Creates a directory where screenshots are stored.
     */
    createScreenshotDir () {
        utilities.mkdirSync(this.options.screenshotPath);
    }

    /**
     * Formats options that were passed in the initialization of AppiumRunner's instance.
     */
    #prepareOptions (options) {
        this.options = options;
        if (!Object.prototype.hasOwnProperty.call(this.options, 'device')) {
            this.options.device = false;
        }
        if (this.options.platform === utilities.IOS && this.options.appiumDeviceName) {
            this.options.appiumDeviceName = this.options.appiumDeviceName.replace(/-/g, ' ');
        }
    }

    /**
     * Setup and executes Appium tests with Jasmine.
     *
     * @returns {Promise}
     */
    #startTests () {
        return new Promise((resolve, reject) => {
            const jasmine = new Jasmine();
            const exitGracefully = (e) => {
                if (this.exiting) {
                    return;
                }
                if (e) {
                    logger.normal('paramedic-appium: ' + e);
                }
                logger.normal('paramedic-appium: Uncaught exception! Killing Appium server and exiting in 2 seconds...');
                this.exiting = true;
                reject(e.stack);
            };

            process.on('uncaughtException', (err) => {
                exitGracefully(err);
            });

            logger.normal('paramedic-appium: Running tests from:');
            this.options.testPaths.forEach((testPath) => {
                logger.normal('paramedic-appium: ' + testPath);
            });

            jasmine.loadConfig({
                spec_dir: '',
                spec_files: this.options.testPaths
            });

            // don't use default reporter, it exits the process before
            // we would get the chance to kill appium server
            // jasmine.configureDefaultReporter({ showColors: false });
            const outputDir = this.options.output || process.cwd();
            const reporters = getReporters(outputDir);
            const paramedicReporter = new ParamedicReporter((passed) => {
                resolve(passed);
            });

            reporters.forEach((reporter) => {
                jasmine.addReporter(reporter);
            });
            jasmine.addReporter(paramedicReporter);

            try {
                // Launch the tests!
                jasmine.execute();
            } catch (e) {
                exitGracefully(e);
            }
        });
    }

    /**
     * Starts the Appium Server
     *
     * @returns {Promise}
     */
    #startAppiumServer () {
        const loggingArgs = this.options.logFile
            ? ['--log', this.options.logFile]
            : [];

        // Appium Arguments
        const args = [
            ...loggingArgs,
            // Base Path
            '--base-path',
            '/wd/hub',
            // Platform Server Args
            ...(AppiumPlatformConfigs[this.options.platform].serverArgs ?? [])
        ];

        logger.normal('[Paramedic AppiumRunner]: Running: appium ' + args.join(' '));

        return new Promise((resolve, reject) => {
            this.proc.abortController = new AbortController();
            this.proc.isAlive = true;

            const child = spawnAppiumSync(
                args,
                {
                    stdio: ['ignore', 'pipe', 'pipe'],
                    signal: this.proc.abortController.signal
                }
            );

            function removeListener () {
                child.removeListener('error', onError);
                child.removeListener('exit', onExit);
            }

            child.stdout.on('data', data => {
                const msg = data.toString();
                process.stdout.write(msg);

                if (msg.includes('Appium REST http interface listener started')) {
                    // Listeners can be removed to prevent fufilling the promise multiple times.
                    removeListener();
                    resolve();
                }
            });

            child.stderr.on('data', data => {
                process.stderr.write(data.toString());
            });

            function onError (err) {
                // Listeners can be removed to prevent fufilling the promise multiple times.
                removeListener();
                reject(err);
            }

            function onExit (code, signal) {
                // Listeners can be removed to prevent fufilling the promise multiple times.
                removeListener();
                if (code === 0) {
                    resolve();
                } else if (code) {
                    reject(new Error(`Appium exited with code ${code}`));
                } else {
                    reject(new Error(`Appium terminated with signal ${signal}`));
                }
            }

            child.on('error', onError);
            child.on('exit', onExit);
            child.on('close', () => {
                this.proc.isAlive = false;
                this.proc.abortController = null;
            });
        });
    }

    /**
     * Stops the Appium Server if the isAlive flag and abortController is set and valid.
     */
    #stopAppiumServer () {
        if (this.proc.isAlive && this.proc.abortController) {
            this.proc.abortController.abort();
        }
    }

    /**
     * Finds and stores a list of appium tests to run.
     */
    #findTests () {
        if (!this.options.pluginRepos) {
            this.options.pluginRepos = getPluginDirs(this.options.appPath);
        }

        // looking for the tests
        this.options.testPaths = [];
        const searchPaths = [];
        this.options.pluginRepos.forEach((pluginRepo) => {
            searchPaths.push(path.join(pluginRepo, 'appium-tests', this.options.platform));
            searchPaths.push(path.join(pluginRepo, 'appium-tests', 'common'));
        });
        searchPaths.forEach((searchPath) => {
            logger.normal('paramedic-appium: Looking for tests in: ' + searchPath);
            if (fs.existsSync(searchPath)) {
                logger.normal('paramedic-appium: Found tests in: ' + searchPath);
                if (path.isAbsolute(searchPath)) {
                    searchPath = path.relative(process.cwd(), searchPath);
                }
                this.options.testPaths.push(path.join(searchPath, '*.spec.js'));
            }
        });
    }

    /**
     * Sets up global variables that are exposed to the Appium tests.
     */
    setGlobals () {
        global.WD = wd;
        global.WD_HELPER = wdHelper;
        global.SCREENSHOT_HELPER = screenshotHelper;
        global.ET = expectTelnet;
        global.DEVICE = this.options.device;
        global.DEVICE_NAME = this.options.appiumDeviceName;
        global.PLATFORM = this.options.platform;
        global.PLATFORM_VERSION = this.options.appiumPlatformVersion;
        global.SCREENSHOT_PATH = this.options.screenshotPath;
        global.UNORM = unorm;
        global.UDID = this.options.udid;
        global.VERBOSE = this.options.verbose;
    }

    /**
     * 1. Updates the Cordova app's config.xml
     * 2. Installs cordova-save-image-gallery so that images could be taken and stored in the image gallery.
     * 3. Builds the Cordova app.
     *
     * @returns {Promise}
     */
    prepareApp () {
        return new Promise((resolve, reject) => {
            const fullAppPath = getFullAppPath(this.options.appPath);
            const deviceString = this.options.device ? '--device' : '';
            const buildCommand = [
                this.options.cli,
                'build',
                this.options.platform,
                deviceString,
                ...utilities.PARAMEDIC_COMMON_ARGS,
                '--target',
                `"${this.options.appiumDeviceName}"`
            ].join(' ');

            // remove medic.json and (re)build
            fs.rmSync(path.join(fullAppPath, 'www', 'medic.json'), { force: true });

            fs.stat(fullAppPath, async (error, stats) => {
                // check if the app exists
                if (error || !stats.isDirectory()) {
                    reject(new Error('The app directory doesn\'t exist: ' + fullAppPath));
                }

                // set properties/CSP rules
                const platformPreferences = AppiumPlatformConfigs[this.options.platform].preferences;
                for (const [key, value] of Object.entries(platformPreferences)) {
                    appPatcher.setPreference(fullAppPath, key, value);
                }

                appPatcher.addCspSource(fullAppPath, 'connect-src', 'http://*');
                appPatcher.permitAccess(fullAppPath, '*');
                // add cordova-save-image-gallery plugin from npm to enable
                // Appium tests for camera plugin to save test image to the gallery
                await spawnAsync(
                    this.options.cli,
                    ['plugin', 'add', 'cordova-save-image-gallery'],
                    { cwd: fullAppPath }
                );

                // rebuild the app
                logger.normal('paramedic-appium: Building the app...');
                console.log('$ ' + buildCommand);

                exec(buildCommand, { cwd: fullAppPath, maxBuffer: SMALL_BUFFER_SIZE }, (error, stdout, stderr) => {
                    if (error || stdout.indexOf('BUILD FAILED') >= 0 || stderr.indexOf('BUILD FAILED') >= 0) {
                        reject(new Error('Couldn\'t build the app: ' + error));
                    } else {
                        global.PACKAGE_PATH = getPackagePath(this.options);
                        resolve();
                    }
                });
            });
        });
    }

    /**
     * 1. Checks is the Appium server port is free
     * 2. Install Appium drivers if the port is not in use.
     * 3. Starts the Appium server
     * 4. Starts running though the Appium tests.
     * 5. Stops the Appium Server
     * 6. Sends the test results up.
     *
     * @returns {String}
     */
    async runTests () {
        const isPortInUse = await portChecker.check(4723);

        if (!isPortInUse) {
            await installAppiumDrivers(this.options.platform);
            await this.#startAppiumServer();
        } else {
            logger.info('paramedic-appium: Appium port is taken, looks like it is already running. Jumping straight to running tests.');
        }

        const testResults = await this.#startTests();
        this.#stopAppiumServer();
        return testResults;
    }
}

function getFullAppPath (appPath) {
    return !path.isAbsolute(appPath)
        ? path.join(ROOT_DIR, appPath)
        : appPath;
}

function getPackagePath (options) {
    const fullAppPath = getFullAppPath(options.appPath);

    switch (options.platform) {
    case utilities.ANDROID: {
        let packagePath = null;
        const maybePackagePaths = [
            path.join(fullAppPath, 'platforms', 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'),
            path.join(fullAppPath, 'platforms', 'android', 'app', 'build', 'outputs', 'apk', 'android-debug.apk'),
            path.join(fullAppPath, 'platforms', 'android', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
        ];

        maybePackagePaths.forEach((p) => {
            if (fs.existsSync(p)) {
                packagePath = p;
            }
        });

        if (packagePath != null) {
            return packagePath;
        }
        throw new Error('Could not find apk');
    }

    case utilities.IOS: {
        const searchDir = options.device
            ? path.join(fullAppPath, 'platforms', 'ios', 'build', 'Debug-iphoneos')
            : path.join(fullAppPath, 'platforms', 'ios', 'build', 'Debug-iphonesimulator');

        const mask = options.device ? '.ipa$' : '.app$';
        const files = fs.readdirSync(searchDir)
            .filter(file => file.match(new RegExp(mask)));

        logger.normal(`paramedic-appium: Looking for the app package in "${searchDir}" with the filter of "${mask}"`);

        if (files && files.length > 0) {
            logger.normal('paramedic-appium: Found the app package: ' + files[0]);
            return path.resolve(searchDir, files[0]);
        }

        throw new Error('Could not find the app package');
    }
    }
}

async function spawnAppiumAsync (args, options) {
    const defaultSpawnOptions = { stdio: 'pipe' };
    console.log('[Paramedic - AppiumRunner] Running: appium ' + args.join(' '));
    return await spawnAsync(
        'node',
        [APPIUM_BIN, ...args],
        { ...defaultSpawnOptions, ...options }
    );
}

function spawnAppiumSync (args, options) {
    const defaultSpawnOptions = { stdio: 'pipe' };
    console.log('[Paramedic - AppiumRunner] Running: appium ' + args.join(' '));
    return spawn(
        'node',
        [APPIUM_BIN, ...args],
        { ...defaultSpawnOptions, ...options }
    );
}

/**
 * Returns a list of installed plugins, excluding cordova-save-image-gallery and ios-geolocation-permissions-plugin.
 *
 * @param {String} appPath
 * @returns {Array}
 */
function getPluginDirs (appPath) {
    return fs.readdirSync(
        path.join(appPath, 'plugins'),
        { withFileTypes: true }
    )
        .filter(dirent => dirent.isDirectory())
        .map(dirent => dirent.name)
        .filter(dir => ![
            'cordova-save-image-gallery',
            'ios-geolocation-permissions-plugin'
        ].includes(dir));
}

/**
 * Installs Appium driver by driver name.
 *
 * @param {String} driverName Appium driver to install
 */
async function installAppiumDriver (driverName) {
    try {
        console.log(`Installing Appium driver: ${driverName}...`);
        await spawnAppiumAsync(['driver', 'install', driverName]);
        console.log(`Driver ${driverName} installed successfully.`);
    } catch (err) {
        // Driver allready installed?
    }
}

/**
 * Gets and returns a list of installed Appium drivers.
 *
 * @returns {Array}
 */
async function getInstalledAppiumDrivers () {
    const driverListRaw = await spawnAppiumAsync(
        ['driver', 'list'],
        { encoding: 'utf8' }
    );
    return Object.keys(JSON.parse(driverListRaw.stdout || '{}'));
}

/**
 * Installs Appium Drivers for the targeted platform.
 */
async function installAppiumDrivers (platform) {
    const driverList = await getInstalledAppiumDrivers();
    const driverToInstall = AppiumPlatformConfigs[platform].driver;
    if (driverToInstall && !driverList.includes(driverToInstall)) {
        await installAppiumDriver(driverToInstall);
    }
}

module.exports = AppiumRunner;
