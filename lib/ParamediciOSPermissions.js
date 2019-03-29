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

const path = require('path');
const fs = require('fs');
const shelljs = require('shelljs');
const { utilities, logger } = require('./utils');
const TCC_FOLDER_PERMISSION = '0755';

class ParamediciOSPermissions {
    constructor (appName, tccDb, targetObj) {
        this.appName = appName;
        this.tccDb = tccDb;
        this.targetObj = targetObj;
    }

    updatePermissions (serviceList) {
        const tccDir = path.join(utilities.getSimulatorsFolder(), this.targetObj.simId, 'data', 'Library', 'TCC');
        const tccDbFile = path.join(tccDir, 'TCC.db');

        logger.info(`Sim Id is: ${this.targetObj.simId}`);

        if (!utilities.doesFileExist(tccDbFile)) {
            // No TCC.db file exists by default. So, Copy the new TCC.db file
            if (!utilities.doesFileExist(tccDir)) fs.mkdirSync(tccDir, TCC_FOLDER_PERMISSION);
            logger.info(`Copying TCC Db file to ${tccDir}`);
            fs.copyFileSync(this.tccDb, tccDir);
        }

        for (var i = 0; i < serviceList.length; i++) {
            let command = utilities.getSqlite3InsertionCommand(tccDbFile, serviceList[i], this.appName);
            logger.info(`Running Command: ${command}`);

            // If the service has an entry already, the insert command will fail.
            // in this case we'll process with updating existing entry
            console.log(`$ ${command}`);
            const proc = shelljs.exec(command, { silent: true, async: false });

            if (proc.code) {
                logger.warn(`Failed to insert permissions for ${this.appName} into ${tccDbFile}. Will try to update existing permissions.`);

                // (service, client, client_type, allowed, prompt_count, csreq)
                command = `sqlite3 ${tccDbFile} "update access set client_type=0, allowed=1, prompt_count=1, csreq=NULL where service='${serviceList[i]}' and client='${this.appName}'"`;
                logger.info(`Running Command: ${command}`);

                const patchProc = shelljs.exec(command, { silent: true, async: false });
                if (patchProc.code) {
                    logger.warn(`Failed to update existing permissions for ${this.appName} into ${tccDbFile}. Continuing anyway.`);
                }
            }
        }
    }
}

module.exports = ParamediciOSPermissions;
