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

/* global window */

'use strict';

const { remote } = require('webdriverio');
const { utilities } = require('../../utils');

// Appium Server Settings
const APPIUM_SERVER_HOST = 'localhost';
const APPIUM_SERVER_PORT = 4723;
// Timeouts
const IMPLICIT_WAIT_TIMEOUT = 10000;
const ASYNC_SCRIPT_TIMEOUT = 60000;
// Context keys
const CONTEXT_NATIVE_APP = 'NATIVE_APP';

/**
  * Gets the WebDriver session.
  *
  * @param {String} platform - The target platform
  * @returns
  */
async function getDriver (platform = '') {
    platform = platform.toLowerCase().trim();

    // Only Android & iOS is supported. Anything else will be rejected.
    if (![utilities.ANDROID, utilities.IOS].includes(platform)) {
        throw new Error(`Unknown platform: ${platform}`);
    }

    /**
     * List of capabilities that the Appium session will have.
     * Appium capabilities are prefixed with `appium:`.
     */
    const capabilities = {
        'appium:app': global.PACKAGE_PATH,
        'appium:autoAcceptAlerts': true,
        // Platform Name
        platformName: platform === utilities.ANDROID
            ? utilities.APPIUM_CAPABILITIES_PLATFORM_NAME_ANDROID
            : utilities.APPIUM_CAPABILITIES_PLATFORM_NAME_IOS,
        // Driver Name
        'appium:automationName': platform === utilities.ANDROID
            ? utilities.APPIUM_DRIVER_ANDROID
            : utilities.APPIUM_DRIVER_IOS
    };

    /*
     * Appending capabilities that was configured by AppiumRunner and stored on global.
     */
    if (global.DEVICE_NAME) {
        capabilities['appium:deviceName'] = global.DEVICE_NAME;
    }
    if (global.PLATFORM_VERSION) {
        capabilities['appium:platformVersion'] = global.PLATFORM_VERSION;
    }
    if (global.UDID) {
        capabilities['appium:udid'] = global.UDID;
    }
    // iOS Only: Sets a launch timeout, in ms, for the WebDriverAgent to be pingable.
    if (platform === utilities.IOS) {
        capabilities['appium:wdaLaunchTimeout'] = 150000;
    }

    const driver = await remote({
        hostname: APPIUM_SERVER_HOST,
        port: APPIUM_SERVER_PORT,
        path: '/wd/hub',
        logLevel: global.VERBOSE ? 'info' : 'warn',
        capabilities
    });

    // Setup the timeouts
    await driver.setTimeout({
        implicit: IMPLICIT_WAIT_TIMEOUT,
        script: ASYNC_SCRIPT_TIMEOUT
    });

    return driver;
}

/**
 * Dismiss system alerts to prevent blocking.
 *
 * @param {Object} driver - Browser object with sessionId.
 * @param {String} platform
 */
async function bustAlert (driver, platform = '') {
    platform = platform.toLowerCase();

    let currentContext = CONTEXT_NATIVE_APP;
    try {
        currentContext = await driver.getContext();
    } catch (err) {
        if (global.VERBOSE) {
            console.warn('[WebDriver Helper] bustAlert: failed to get current context:', err.message);
        }
    }

    if (currentContext !== CONTEXT_NATIVE_APP) {
        try {
            await driver.switchContext(CONTEXT_NATIVE_APP);
        } catch (err) {
            if (global.VERBOSE) {
                console.warn('[WebDriver Helper] bustAlert: failed to switch to NATIVE_APP:', err.message);
            }
        }
    }

    try {
        switch (platform) {
        case utilities.IOS: {
            await driver.acceptAlert();
            break;
        }
        case utilities.ANDROID: {
            const el = await driver.$('//android.widget.Button[translate(@text,"alow","ALOW")="ALLOW"]');
            if (await el.isDisplayed()) {
                await el.click();
            }
            break;
        }
        default: {
            throw new Error('Unsupported platform: ' + platform);
        }
        }
    } catch (err) {
        if (global.VERBOSE) {
            console.warn('[WebDriver Helper] bustAlert: unexpected error handling alert:', err.message);
        }
    }

    if (currentContext && currentContext !== CONTEXT_NATIVE_APP) {
        try {
            await driver.switchContext(currentContext);
        } catch (err) {
            if (global.VERBOSE) {
                console.warn('[WebDriver Helper] bustAlert: failed to restore previous context:', err.message);
            }
        }
    }
}

/**
 * Looking for Cordova's WebView with retry limit.
 *
 * @param {Object} driver - Browser object with sessionId.
 * @param {Number} retries - Number of retry attempts.
 * @returns Context
 */
async function waitForCordovaWebview (driver, retries = 40) {
    for (let i = 0; i < retries; i++) {
        const contexts = await driver.getContexts();

        for (const ctx of contexts) {
            if (ctx === CONTEXT_NATIVE_APP) {
                continue;
            }

            try {
                await driver.switchContext(ctx);
                const hasCordova = await driver.execute(() => !!window.cordova);
                if (hasCordova) {
                    console.log('[WebDriver Helper] waitForCordovaWebview: Cordova WebView was found:', ctx);
                    return ctx;
                }
            } catch (err) {
                if (global.VERBOSE) {
                    console.warn('[WebDriver Helper] waitForCordovaWebview: failed to find Cordova WebView\'s context with error: ', err.message);
                }
            }
        }

        await driver.pause(500);
    }

    throw new Error('Cordova WebView never appeared.');
}

module.exports = {
    getDriver,
    bustAlert,
    waitForCordovaWebview
};
