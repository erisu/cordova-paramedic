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

const { spawn } = require('node:child_process');

module.exports = {
    exec: require('./execWrapper').exec,
    logger: require('cordova-common').CordovaLogger.get(),
    execPromise: require('./execWrapper').execPromise,
    utilities: require('./utilities')
};

/**
 * Runs a command asynchronously using spawn and returns a Promise.
 *
 * @param {string} cmd - The command to execute
 * @param {Array} args - Array of string arguments for the command
 * @param {SpawnOptionsWithoutStdio} option - Options for spawn (default: { stdio: 'inherit' })
 * @returns {Promise<void>} Resolves when the command exits with code 0, rejects otherwise.
 */
module.exports.spawnAsync = function (cmd, args = [], options = {}) {
    const defaultOptions = { stdio: 'pipe' };
    const opts = { ...defaultOptions, ...options };

    console.log(`[paramedic]: Running command: "${ cmd } ${ args.join(' ') }"`);

    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, opts);
        let stdout = '';
        let stderr = '';

        if (!opts.stdio !== 'inherit') {
            child.stdout.on('data', chunk => { stdout += chunk.toString(); });
            child.stderr.on('data', chunk => { stderr += chunk.toString(); });
        }

        child.on('error', reject);
        child.on('close', code => {
            if (code === 0) {
                resolve({ stdout, stderr, code });
            } else {
                reject(new Error(`${cmd} exited with code ${code}\n${stderr}`));
            }
        });
    });
};