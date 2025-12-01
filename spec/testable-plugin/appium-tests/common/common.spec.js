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

'use strict';

const wdHelper = global.WD_HELPER;
const MINUTE = 60 * 1000;

describe('Testable Plugin UI Automation Tests', function () {
    let driver;
    let failedToStart = true;

    async function startDriver() {
        driver = await wdHelper.getDriver(PLATFORM, { switchToWebview: false });

        // Wait for the correct WebView
        await wdHelper.waitForCordovaWebview(driver);

        failedToStart = false;
        return driver;
    }

    function checkSession() {
        if (failedToStart) {
            throw new Error('Failed to start a session');
        }
    }

    afterAll(async () => {
        try {
            checkSession();
        } finally {
            if (driver) {
                await driver.deleteSession();
            }
        }
    }, MINUTE);

    it('should connect to an Appium endpoint properly', async function () {
        for (let i = 0; i < 3; i++) {
            try {
                await startDriver();
                break;
            } catch (err) {
                console.warn(`Attempt ${i + 1} failed:`, err.message);
            }
        }

        if (!driver) {
            throw new Error('Failed to start a driver after multiple retries');
        }

        // Test execution: simple async check
        const result = await driver.executeAsync((done) => done('success'));

        if (typeof result === 'string' && result.startsWith('ERROR:')) {
            throw new Error(result);
        }

        return result;
    }, 30 * MINUTE);
});
