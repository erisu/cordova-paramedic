const { utilities, exec, logger } = require('./utils');

class CordovaCliExec {
    constructor (config) {
        this.config = config;
        this.cli = this.config.getCli();
    }

    run (cliArgs) {
        return this.exec('run', cliArgs);
    }

    pluginAdd (plugin, cliArgs) {
        return this.exec('plugin', ['add', plugin].concat(cliArgs));
    }

    pluginsVersion (cliArgs) {
        return this.exec('plugins', cliArgs);
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

module.export = CordovaCliExec;
