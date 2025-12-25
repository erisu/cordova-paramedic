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

const utils = require('node:util');

const paramedic = require('./lib/paramedic');
const ParamedicConfig = require('./lib/ParamedicConfig');

const options = ParamedicConfig.getParseArgOpts();
const { values: argv } = utils.parseArgs({ options });

if (argv.version) {
    console.log(require('./package.json').version);
    process.exit(0);
}

if (argv.help) {
    console.log(ParamedicConfig.getUsage());
    process.exit(0);
}

/*
 * Create the config instance and extract needed configs for the main runner.
 */
const config = new ParamedicConfig(argv);
const platform = config.getPlatform();
const plugins = config.get(ParamedicConfig.Options.PLUGINS);

if ((!platform || !plugins)) {
    console.log(ParamedicConfig.getUsage(true));
    process.exit(1);
}

paramedic.run()
    .then((isTestPassed) => {
        const exitCode = isTestPassed ? 0 : 1;
        console.log('Finished with exit code ' + exitCode);
        process.exit(exitCode);
    })
    .catch((error) => {
        console.error(error && error.stack ? error.stack : error);
        process.exit(1);
    });
