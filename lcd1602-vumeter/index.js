'use strict';

const libQ = require('kew');
const exec = require('child_process').exec;
const execFile = require('child_process').execFile;
const path = require('path');

module.exports = ControllerLcdVuMeter;

function ControllerLcdVuMeter(context) {
  const self = this;

  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;

  self.configFile = self.commandRouter.pluginManager.getConfigurationFile(
    self.context.pluginType,
    self.context.pluginName
  );

  self.config = self.configManager.loadConfig(self.configFile);

  return self;
}

ControllerLcdVuMeter.prototype.onStart = function () {
  const self = this;
  const defer = libQ.defer();

  const scriptPath = path.join(__dirname, 'lcd', 'display.py');

  self.logger.info('Starting LCD VU Meter Python process...');

  self.pythonProcess = execFile(
    'python3',
    [scriptPath],
    { env: process.env },
    (error, stdout, stderr) => {
      if (error) {
        self.logger.error('LCD VU Meter process error: ' + error.message);
        return;
      }
      if (stderr) self.logger.warn('LCD VU Meter stderr: ' + stderr);
    }
  );

  self.logger.info('LCD VU Meter started.');
  defer.resolve();
  return defer.promise;
};

ControllerLcdVuMeter.prototype.onStop = function () {
  const self = this;
  const defer = libQ.defer();

  if (self.pythonProcess) {
    self.pythonProcess.kill();
    self.logger.info('LCD VU Meter process killed.');
  }

  defer.resolve();
  return defer.promise;
};

ControllerLcdVuMeter.prototype.onInstall = function () {
  return libQ.resolve();
};

ControllerLcdVuMeter.prototype.onUninstall = function () {
  return libQ.resolve();
};

ControllerLcdVuMeter.prototype.getUIConfig = function () {
  const self = this;
  const defer = libQ.defer();

  const lang_code = self.commandRouter.sharedVars.get('language_code');

  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  ).then((uiconf) => {
    defer.resolve(uiconf);
  }).fail(() => {
    defer.reject(new Error());
  });

  return defer.promise;
};

ControllerLcdVuMeter.prototype.setUIConfig = function (data) {
  const self = this;
  return libQ.resolve();
};

ControllerLcdVuMeter.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

ControllerLcdVuMeter.prototype.saveConfig = function (data) {
  const self = this;
  return libQ.resolve();
};
