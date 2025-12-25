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

const tmp = require('tmp');

const PluginsManager = require('./PluginsManager');
const { logger, spawnAsync, utilities } = require('./utils');
const ParamedicConfig = require('./ParamedicConfig');

class ParamedicApp {
    constructor (storedCWD, runner) {
        /*
         * Get the config instance and extract needed configs for the ParamedicApp.
         */
        this.config = ParamedicConfig.getInstance();
        this.platform = this.config.getPlatform();
        this.platformToInstall = this.config.getPlatform(true);
        this.cliCmd = this.config.get(ParamedicConfig.Options.CLI);
        this.isAndroid = this.config.isAndroid();

        this.storedCWD = storedCWD;
        this.runner = runner;
        this.tempFolder = null;

        logger.info('---------------------------------------------------------');
        logger.info('1. Create Cordova app with configured platform and plugin(s).');
        logger.info('---------------------------------------------------------');
    }

    /**
     * Creates a Cordova project inside a newly created temporary directory.
     *
     * @returns {Promise<Object>} Object contains the directory path on the name property.
     */
    async createTempProject () {
        this.tempFolder = tmp.dirSync();
        tmp.setGracefulCleanup();
        logger.info('[paramedic] Creating temp project at ' + this.tempFolder.name);
        await spawnAsync(
            this.cliCmd,
            ['create', this.tempFolder.name, ...utilities.PARAMEDIC_COMMON_ARGS]
        );
        return this.tempFolder;
    }

    prepareProjectToRunTests () {
        return this.installPlatform()
            .then(() => this.installPlugins())
            .then(() => this.setUpStartPage())
            .then(() => this.checkPlatformRequirements())
            .then(() => this.checkDumpAndroidManifest())
            .then(() => this.checkDumpAndroidConfigXml());
    }

    /**
     * Installs testing related framework plugins and user defined plugin.
     *
     * (For All Platforms)
     *   - cordova-plugin-test-framework
     *   - paramedic-plugin
     * (For iOS Platform)
     *   - ios-geolocation-permissions-plugin (iOS)
     * (For CI)
     *   - ci-plugin
     * (User Defined Plugins)
     * (User Defined Plugin's Test)
     */
    async installPlugins () {
        const plugins = this.config.get(ParamedicConfig.Options.PLUGINS);
        const pluginsManager = new PluginsManager(this.tempFolder.name, this.storedCWD);
        logger.info(`[paramedic] Installing Plugins:\n\t - ${plugins.join('\n\t - ')}`);
        await pluginsManager.installPlugins(plugins);
    }

    /**
     * Edits the the testing application's content source to "cdvtests/index.html"
     */
    setUpStartPage () {
        logger.info('[paramedic] Setting the app start page to the test page');
        const filePath = path.join(this.tempFolder.name, 'config.xml');
        let config = fs.readFileSync(filePath, utilities.DEFAULT_ENCODING);
        config = config.replace('src="index.html"', 'src="cdvtests/index.html"');
        fs.writeFileSync(filePath, config, utilities.DEFAULT_ENCODING);
    }

    /**
     * Installs the Cordova platform for testing
     *
     * @returns {Promise<Object|Error>}
     */
    installPlatform () {
        logger.info(`[paramedic] Installing Platform: ${this.platformToInstall}`);
        return spawnAsync(
            this.cliCmd,
            ['platform', 'add', this.platformToInstall, ...utilities.PARAMEDIC_COMMON_ARGS],
            { cwd: this.tempFolder.name }
        );
    }

    /**
     * Gets the platform reqirements
     *
     * @returns {Promise<Object|Error>}
     */
    async checkPlatformRequirements () {
        const requirements = await spawnAsync(
            this.cliCmd,
            ['requirements', this.platform, ...utilities.PARAMEDIC_COMMON_ARGS],
            { cwd: this.tempFolder.name }
        );
        logger.normal(requirements.stdout);
    }

    /**
     * Fetches and dumps out the AndroidManifest.xml content.
     *
     * @return If not running for Android platform, return out.
     */
    checkDumpAndroidManifest () {
        if (!this.isAndroid) {
            return;
        }

        logger.normal('[paramedic] AndroidManifest.xml Dump');
        const androidManifest = path.join(this.tempFolder.name, 'platforms/android/app/src/main/AndroidManifest.xml');
        const xml = fs.readFileSync(androidManifest, utilities.DEFAULT_ENCODING);
        logger.normal(xml);
    }

    /**
     * Fetches and dumps out the Android's compiled config.xml content.
     *
     * @return If not running for Android platform, return out.
     */
    checkDumpAndroidConfigXml () {
        if (!this.isAndroid) {
            return;
        }

        logger.normal('[paramedic] config.xml Dump');
        const config = path.join(this.tempFolder.name, 'platforms/android/app/src/main/res/xml/config.xml');
        const xml = fs.readFileSync(config, utilities.DEFAULT_ENCODING);
        logger.normal(xml);
    }
}

module.exports = ParamedicApp;
