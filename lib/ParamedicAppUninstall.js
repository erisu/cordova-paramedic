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
const { utilities, logger, exec } = require('./utils');

class ParamedicAppUninstall {
    constructor (appPath, platform) {
        this.appPath = appPath;
        this.platform = platform;
    }

    uninstallApp (targetObj, app) {
        if (!targetObj || !targetObj.target) { return Promise.resolve(); }

        if (this.platform === utilities.ANDROID) return this.uninstallAppAndroid(targetObj, app);
        if (this.platform === utilities.IOS) return this.uninstallAppIOS(targetObj, app);
        if (this.platform === utilities.WINDOWS) return this.uninstallAppWindows(targetObj, app);

        return Promise.resolve();
    }

    uninstallAppAndroid (targetObj, app) {
        const uninstallCommand = `adb -s ${targetObj.target} uninstall ${app}`;
        return this.executeUninstallCommand(uninstallCommand);
    }

    uninstallAppWindows (targetObj, app) {
        const platformPath = path.join(this.appPath, 'platforms', 'windows');
        const packageJSPath = path.join(platformPath, 'cordova', 'lib', 'package.js');
        const programFilesPath = process.env['ProgramFiles(x86)'] || process.env.ProgramFiles;
        const appDeployPath = path.join(programFilesPath, 'Microsoft SDKs', 'Windows Phone', 'v8.1', 'Tools', 'AppDeploy', 'AppDeployCmd.exe');

        if (fs.existsSync(packageJSPath)) {
            const packageJS = require(packageJSPath);
            const appId = packageJS.getAppId(platformPath);
            const uninstallCommand = `"${appDeployPath}" /uninstall ${appId} /targetdevice:${targetObj.target}`;

            return this.executeUninstallCommand(uninstallCommand);
        }

        return Promise.resolve();
    }

    uninstallAppIOS (targetObj, app) {
        const uninstallCommand = `xcrun simctl uninstall ${targetObj.simId} uninstall ${app}`;
        return this.executeUninstallCommand(uninstallCommand);
    }

    executeUninstallCommand (uninstallCommand) {
        return new Promise((resolve, reject) => {
            logger.info(`cordova-paramedic: Running command: ${uninstallCommand}`);
            exec(uninstallCommand, code => {
                if (code === 0) resolve();

                const error = `Failed to uninstall the app with the error code: ${code}`;
                logger.error(error);
                reject(new Error(error));
            });
        }).fail(() => {
            logger.warn('cordova-paramedic: App uninstall timed out!');
        });
    }
}

module.exports = ParamedicAppUninstall;
