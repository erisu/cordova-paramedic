#!/usr/bin/env node

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

const shelljs = require('shelljs');
const fs = require('fs');
const path = require('path');
const { logger, exec, utilities } = require('./utils');

class ParamedicLogCollector {
    constructor (platform, appPath, outputDir, targetObj) {
        this.platform = platform;
        this.appPath = appPath;
        this.outputDir = outputDir;
        this.targetObj = targetObj;
    }

    /**
     * Gathers and copies the known log files, for iOS, to the provided output directory.
     */
    logIOS () {
        const logFiles = [
            path.join(this.appPath, 'platforms', 'ios', 'cordova', 'console.log'),
            path.join(this.appPath, 'appium.log')
        ];
        this.copyLogsToOutput(logFiles);
    }

    logAndroid () {
        if (!this.targetObj) {
            logger.warn('[paramedic-logger] No target provided to get logs from.');
            return;
        }

        const logCommand = 'adb -s ' + this.targetObj.target + ' logcat -d -v time';
        const numDevices = utilities.countAndroidDevices();

        if (numDevices !== 1) {
            logger.error('[paramedic-logger] At least one emulator/device must be attached.');
            return;
        }

        this.generateLogs(logCommand);
    }

    /**
     * The copy logic that loops through a list of log paths and copies to the output
     * directory if they exist.
     *
     * The log files names will be renamed to: "{platform-name} + {original-file-name}"
     *
     * @param {Array} logs - List of known log file paths
     */
    copyLogsToOutput (logs = []) {
        for (const log of logs) {
            if (fs.existsSync(log)) {
                const currentLogFileDir = path.dirname(log);
                const fileName = path.basename(log);
                const outputFile = path.join(this.outputDir, `${this.platform}-${fileName}`);
                // To copy or rename the file?
                if (this.outputDir === currentLogFileDir) {
                    // As the output directory is the same, just rename the file to include the platform prefix.
                    fs.renameSync(log, outputFile);
                } else {
                    // Since the output directory is different, copy and format the file name.
                    fs.cpSync(log, outputFile, { force: true });
                }
            }
        }
    }

    generateLogs (logCommand) {
        logger.info('Running Command: ' + logCommand);

        const logFile = this.getLogFileName();
        const result = exec(logCommand);

        if (result.code > 0) {
            logger.error('Failed to run command: ' + logCommand);
            logger.error('Failure code: ' + result.code);
            return;
        }

        try {
            fs.writeFileSync(logFile, result.stdout);
            logger.info('Logfiles are written to: ' + logFile);
        } catch (ex) {
            logger.error('Cannot write the log results to the file. ' + ex);
        }
    }

    getLogFileName () {
        return path.join(this.outputDir, this.platform + '_logs.txt');
    }

    collectLogs () {
        shelljs.config.fatal = false;
        shelljs.config.silent = false;

        switch (this.platform) {
        case utilities.ANDROID:
            this.logAndroid();
            break;

        case utilities.IOS:
            this.logIOS();
            break;

        default:
            logger.info('Logging is unsupported for ' + this.platform + ', skipping...');
            break;
        }
    }
}

module.exports = ParamedicLogCollector;
