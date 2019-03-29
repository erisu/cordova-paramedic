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

const path = require('path');
const fs = require('fs');
const { logger, exec, utilities } = require('./utils');
const { PluginInfoProvider } = require('cordova-common');
const Server = require('./LocalServer');

class PluginsManager {
    constructor (appRoot, storedCWD, config) {
        this.appRoot = appRoot;
        this.storedCWD = storedCWD;
        this.config = config;
    }

    installPlugins (plugins) {
        plugins.forEach((plugin) => { this.installSinglePlugin(plugin); });
    }

    installTestsForExistingPlugins () {
        const installedPlugins = new PluginInfoProvider().getAllWithinSearchPath(path.join(this.appRoot, 'plugins'));

        installedPlugins.forEach((plugin) => {
            // there is test plugin available
            if (fs.existsSync(path.join(plugin.dir, 'tests', 'plugin.xml'))) {
                let cliArgs = [];

                // special handling for cordova-plugin-file-transfer
                if (plugin.id.indexOf('cordova-plugin-file-transfer') >= 0) {
                    if (this.config.getFileTransferServer()) {
                        // user specified a file transfer server address, so using it
                        cliArgs.push(`--variable FILETRANSFER_SERVER_ADDRESS=${this.config.getFileTransferServer()}`);
                    } else {
                        // no server address specified, starting a local server
                        const server = new Server(0, this.config.getExternalServerUrl());
                        const fileServerUrl = server.getConnectionAddress(this.config.getPlatformId()) + ':5000';
                        cliArgs.push(`--variable FILETRANSFER_SERVER_ADDRESS=${fileServerUrl}`);
                    }
                }
                this.installSinglePlugin(path.join(plugin.dir, 'tests'), cliArgs);
            }
        });

        // this will list installed plugins and their versions
        this.showPluginsVersions();
    }

    installSinglePlugin (plugin, cliArgs) {
        const pluginPath = path.resolve(this.storedCWD, plugin);

        try {
            // Check if the plugin path exists
            if (!fs.existsSync(pluginPath)) throw `Failed to locate plugin: ${plugin}`;

            const addResult = this.exec('plugin', ['add', plugin].concat(cliArgs));

            // Bubble up error when plugin install fails
            if (addResult.code !== 0) throw `Failed to install plugin: ${plugin}`;
        } catch (error) {
            logger.error(error);
            throw new Error(error);
        }
    }

    showPluginsVersions () {
        this.exec('plugins');
    }

    exec (command, cliArgs) {
        // Append paramedic specific CLI arguments.
        cliArgs.push(utilities.PARAMEDIC_COMMON_CLI_ARGS);

        // Create command string
        const cmd = [this.config.getCli(), command].concat(cliArgs, [utilities.PARAMEDIC_COMMON_CLI_ARGS]);

        // Execute and return results.
        logger.normal(`[cordova-paramedic] executing cordova command "${cmd}"`);
        return exec(cmd.join(' '));
    }
}

module.exports = PluginsManager;
