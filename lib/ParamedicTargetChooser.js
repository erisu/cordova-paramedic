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
const ParamedicKill = require('./ParamedicKill');
const { logger, utilities, exec } = require('./utils');

const ANDROID_RETRY_TIMES = 3;
const ANDROID_TIME_OUT = 300000; // 5 Minutes

class ParamedicTargetChooser {
    constructor (appPath, config) {
        this.appPath = appPath;
        this.platform = config.getPlatformId();
        this.cli = config.getCli();
    }

    chooseTarget (emulator, target) {
        let targetObj = '';

        switch (this.platform) {
        case utilities.ANDROID:
            targetObj = this.chooseTargetForAndroid(emulator, target);
            break;

        case utilities.IOS:
            targetObj = this.chooseTargetForIOS(emulator, target);
            break;

        case utilities.WINDOWS:
            targetObj = this.chooseTargetForWindows(emulator, target);
            break;
        }

        return targetObj;
    }

    chooseTargetForAndroid (emulator, target) {
        logger.info('[cordova-paramedic] Choosing Target for Android');

        if (target) {
            logger.info('[cordova-paramedic] Target defined as: ' + target);
            return { target };
        }

        return this.startAnAndroidEmulator(target).then(emulatorId => ({ target: emulatorId }));
    }

    startAnAndroidEmulator (target) {
        logger.info('[cordova-paramedic] Starting an Android emulator');

        const emuPath = path.join(this.appPath, 'platforms', 'android', 'cordova', 'lib', 'emulator');
        const emulator = require(emuPath);

        const tryStart = (numberTriesRemaining) => {
            return emulator.start(target, ANDROID_TIME_OUT).then((emulatorId) => {
                if (emulatorId) {
                    return emulatorId;
                } else if (numberTriesRemaining > 0) {
                    const paramedicKill = new ParamedicKill(utilities.ANDROID);
                    paramedicKill.kill();
                    return tryStart(numberTriesRemaining - 1);
                } else {
                    logger.error('[cordova-paramedic] Could not start an android emulator');
                    return null;
                }
            });
        };

        // Check if the emulator has already been started
        return emulator.list_started().then(
            (started) => (started && started.length > 0 ? started[0] : tryStart(ANDROID_RETRY_TIMES))
        );
    }

    chooseTargetForWindows (emulator, target) {
        logger.info('[cordova-paramedic] Choosing Target for Windows');
        const devicesResult = this.exec('run', ['add', '--list', '--emulator']);

        if (devicesResult.code > 0) {
            logger.error('Failed to get the list of devices for windows');
            return Promise.resolve({ target: undefined });
        }

        const lines = devicesResult.output.split(/\n/);
        if (lines.length <= 1) {
            logger.error('No devices/emulators available for windows');
            return Promise.resolve({ target: undefined });
        }

        let targets = lines.filter(line => /^\d+\.\s+/.test(line));

        if (target) {
            for (var t in targets) {
                if (targets.hasOwnProperty(t) && t.indexOf(target) >= 0) {
                    targets = [ t ];
                    break;
                }
            }
        }

        return Promise.resolve({ target: targets[0].split('. ')[0].trim() });
    }

    chooseTargetForIOS (emulator, target) {
        logger.info('cordova-paramedic: Choosing Target for iOS');

        const simulatorModelId = utilities.getSimulatorModelId(this.cli, target);
        const split = simulatorModelId.split(', ');
        const device = split[0].trim();
        const simId = utilities.getSimulatorId(simulatorModelId);

        return Promise.resolve({ target: device, simId: simId });
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

module.exports = ParamedicTargetChooser;
