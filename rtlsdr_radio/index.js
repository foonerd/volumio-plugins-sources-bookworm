'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var config = new (require('v-conf'))();
var exec = require('child_process').exec;
var execSync = require('child_process').execSync;

module.exports = ControllerRtlsdrRadio;

function ControllerRtlsdrRadio(context) {
  var self = this;
  
  self.context = context;
  self.commandRouter = self.context.coreCommand;
  self.logger = self.context.logger;
  self.configManager = self.context.configManager;
  
  self.decoderProcess = null;
  self.currentStation = null;
  self.stationsDb = { fm: [], dab: [] };
}

ControllerRtlsdrRadio.prototype.onVolumioStart = function() {
  var self = this;
  var configFile = self.commandRouter.pluginManager.getConfigurationFile(
    self.context, 'config.json'
  );
  self.config = new (require('v-conf'))();
  self.config.loadFile(configFile);
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.onStart = function() {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Starting plugin');
  
  self.loadAlsaLoopback()
    .then(function() {
      return self.loadStations();
    })
    .then(function() {
      self.addToBrowseSources();
      self.logger.info('[RTL-SDR Radio] Plugin started successfully');
      defer.resolve();
    })
    .fail(function(e) {
      self.logger.error('[RTL-SDR Radio] Startup failed: ' + e);
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.onStop = function() {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Stopping plugin');
  
  self.stopDecoder();
  self.commandRouter.volumioRemoveToBrowseSources('FM/DAB Radio');
  
  defer.resolve();
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.getConfigurationFiles = function() {
  return ['config.json'];
};

ControllerRtlsdrRadio.prototype.getUIConfig = function() {
  var self = this;
  var defer = libQ.defer();
  var lang_code = self.commandRouter.sharedVars.get('language_code');
  
  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/UIConfig.json'
  )
  .then(function(uiconf) {
    // Populate radio settings with current config values
    var radioSettings = uiconf.sections[0];
    radioSettings.content[0].value = self.config.get('fm_enabled', true);
    radioSettings.content[1].value = self.config.get('dab_enabled', true);
    radioSettings.content[2].value = self.config.get('fm_gain', 50);
    radioSettings.content[3].value = self.config.get('dab_gain', 80);
    
    // Add current values to save button data
    radioSettings.saveButton.data = [
      'fm_enabled',
      'dab_enabled',
      'fm_gain',
      'dab_gain'
    ];
    
    // Populate manual playback with saved frequency
    var manualPlayback = uiconf.sections[1];
    manualPlayback.content[0].value = self.config.get('manual_fm_frequency', '98.8');
    
    defer.resolve(uiconf);
  })
  .fail(function() {
    defer.reject(new Error());
  });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.loadAlsaLoopback = function() {
  var self = this;
  var defer = libQ.defer();
  
  try {
    var lsmod = execSync('lsmod | grep snd_aloop', { encoding: 'utf8' });
    if (lsmod.length > 0) {
      self.logger.info('[RTL-SDR Radio] snd-aloop already loaded');
      defer.resolve();
      return defer.promise;
    }
  } catch (e) {
    // Module not loaded
  }
  
  try {
    execSync('sudo modprobe snd-aloop', { encoding: 'utf8' });
    self.logger.info('[RTL-SDR Radio] Loaded snd-aloop module');
    defer.resolve();
  } catch (err) {
    self.logger.error('[RTL-SDR Radio] Failed to load snd-aloop: ' + err);
    defer.reject(err);
  }
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.addToBrowseSources = function() {
  var self = this;
  
  var data = {
    name: 'FM/DAB Radio',
    uri: 'rtlsdr',
    plugin_type: 'music_service',
    plugin_name: 'rtlsdr_radio',
    albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/icon.png'
  };
  
  self.commandRouter.volumioAddToBrowseSources(data);
};

ControllerRtlsdrRadio.prototype.handleBrowseUri = function(curUri) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Browse URI: ' + curUri);
  
  var response = {
    navigation: {
      lists: [
        {
          title: 'FM Radio',
          icon: 'fa fa-signal',
          availableListViews: ['list'],
          items: []
        },
        {
          title: 'DAB Radio',
          icon: 'fa fa-broadcast-tower',
          availableListViews: ['list'],
          items: []
        }
      ]
    }
  };
  
  defer.resolve(response);
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.clearAddPlayTrack = function(track) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Play track: ' + JSON.stringify(track));
  
  self.stopDecoder();
  
  // Parse URI to determine type (FM or DAB)
  if (track.uri && track.uri.indexOf('rtlsdr://fm/') === 0) {
    // FM playback
    var frequency = track.uri.replace('rtlsdr://fm/', '');
    self.playFmStation(frequency, track.name || 'FM ' + frequency)
      .then(function() {
        defer.resolve();
      })
      .fail(function(e) {
        self.logger.error('[RTL-SDR Radio] FM playback failed: ' + e);
        self.commandRouter.pushToastMessage('error', 'FM Radio', 'Failed to play station: ' + e);
        defer.reject(e);
      });
  } else if (track.uri && track.uri.indexOf('rtlsdr://dab/') === 0) {
    // DAB playback (not implemented yet)
    self.logger.info('[RTL-SDR Radio] DAB playback not yet implemented');
    self.commandRouter.pushToastMessage('info', 'FM/DAB Radio', 'DAB playback coming soon');
    defer.reject(new Error('DAB not implemented'));
  } else {
    self.logger.error('[RTL-SDR Radio] Invalid URI: ' + track.uri);
    defer.reject(new Error('Invalid URI'));
  }
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.playFmStation = function(frequency, stationName) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Playing FM station: ' + frequency + ' MHz');
  
  // Validate frequency (FM band: 88-108 MHz)
  var freq = parseFloat(frequency);
  if (isNaN(freq) || freq < 88 || freq > 108) {
    self.logger.error('[RTL-SDR Radio] Invalid FM frequency: ' + frequency);
    defer.reject(new Error('Invalid frequency'));
    return defer.promise;
  }
  
  // Get gain from config
  var gain = self.config.get('fm_gain', 50);
  
  // Build rtl_fm command piped to aplay
  // rtl_fm: -f frequency, -M wfm (wideband FM), -s 180k sample rate, -r 48k resample, -g gain
  // aplay: -D volumio (Volumio's modular ALSA device), -f S16_LE (format), -r 48000 (rate), -c 1 (mono)
  var command = 'rtl_fm -f ' + freq + 'M -M wfm -s 180k -r 48k -g ' + gain + 
                ' | aplay -D volumio -f S16_LE -r 48000 -c 1';
  
  self.logger.info('[RTL-SDR Radio] Command: ' + command);
  
  // Clear intentional stop flag when starting new playback
  self.intentionalStop = false;
  
  // Start decoder process
  self.decoderProcess = exec(command, function(error, stdout, stderr) {
    if (error) {
      // Only log error if it wasn't an intentional stop
      if (!self.intentionalStop) {
        self.logger.error('[RTL-SDR Radio] Decoder error: ' + error);
      }
      self.decoderProcess = null;
    }
  });
  
  // Store current station for resume
  self.currentStation = {
    uri: 'rtlsdr://fm/' + frequency,
    name: stationName,
    service: 'rtlsdr_radio'
  };
  
  // Update Volumio state machine
  self.commandRouter.stateMachine.setConsumeUpdateService('rtlsdr_radio');
  
  var state = {
    status: 'play',
    service: 'rtlsdr_radio',
    title: stationName,
    artist: 'FM ' + freq + ' MHz',
    album: 'FM Radio',
    uri: 'rtlsdr://fm/' + frequency,
    trackType: 'fm',
    samplerate: '48 KHz',
    bitdepth: '16 bit',
    channels: 1,
    duration: 0,
    seek: 0,
    volatile: false
  };
  
  self.commandRouter.servicePushState(state, 'rtlsdr_radio');
  
  defer.resolve();
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.stop = function() {
  var self = this;
  
  self.stopDecoder();
  
  // Get current state and just change status to pause
  // Keep all track info for resume
  var currentState = self.commandRouter.stateMachine.getState();
  currentState.status = 'pause';
  
  self.commandRouter.servicePushState(currentState, 'rtlsdr_radio');
  self.commandRouter.stateMachine.setConsumeUpdateService('');
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.pause = function() {
  var self = this;
  return self.stop();
};

ControllerRtlsdrRadio.prototype.resume = function() {
  var self = this;
  
  if (self.currentStation) {
    return self.clearAddPlayTrack(self.currentStation);
  }
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.stopDecoder = function() {
  var self = this;
  
  if (self.decoderProcess !== null) {
    self.logger.info('[RTL-SDR Radio] Stopping decoder process');
    self.intentionalStop = true;
    
    try {
      exec('sudo pkill -f "rtl_fm -f"');
      exec('sudo pkill -f "aplay -D volumio"');
      self.decoderProcess.kill('SIGTERM');
    } catch (e) {
      self.logger.error('[RTL-SDR Radio] Error stopping decoder: ' + e);
    }
    
    // Wait for processes to fully terminate
    setTimeout(function() {
      self.decoderProcess = null;
      // DON'T clear currentStation - needed for resume
    }, 500);
  }
};

ControllerRtlsdrRadio.prototype.saveManualFrequency = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var frequency = data.manual_fm_frequency;
  
  self.logger.info('[RTL-SDR Radio] Save and play manual FM: ' + frequency);
  
  // Validate frequency
  var freq = parseFloat(frequency);
  if (isNaN(freq) || freq < 88 || freq > 108) {
    self.commandRouter.pushToastMessage('error', 'FM Radio', 'Invalid frequency. Enter 88.0 - 108.0 MHz');
    defer.reject(new Error('Invalid frequency'));
    return defer.promise;
  }
  
  // Save to config for next time
  self.config.set('manual_fm_frequency', freq.toString());
  
  // Create track object
  var track = {
    uri: 'rtlsdr://fm/' + freq,
    name: 'FM ' + freq,
    service: 'rtlsdr_radio'
  };
  
  // Play the station
  self.clearAddPlayTrack(track)
    .then(function() {
      self.commandRouter.pushToastMessage('success', 'FM Radio', 'Playing FM ' + freq + ' MHz');
      defer.resolve();
    })
    .fail(function(e) {
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.saveConfig = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Saving configuration');
  
  // Save configuration values
  if (data.fm_enabled !== undefined) {
    self.config.set('fm_enabled', data.fm_enabled);
  }
  if (data.dab_enabled !== undefined) {
    self.config.set('dab_enabled', data.dab_enabled);
  }
  if (data.fm_gain !== undefined) {
    var fmGain = parseInt(data.fm_gain);
    if (!isNaN(fmGain) && fmGain >= 0 && fmGain <= 100) {
      self.config.set('fm_gain', fmGain);
    }
  }
  if (data.dab_gain !== undefined) {
    var dabGain = parseInt(data.dab_gain);
    if (!isNaN(dabGain) && dabGain >= 0 && dabGain <= 100) {
      self.config.set('dab_gain', dabGain);
    }
  }
  
  self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 'Configuration saved');
  defer.resolve();
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.loadStations = function() {
  var self = this;
  var stationsFile = '/data/plugins/music_service/rtlsdr_radio/stations.json';
  
  try {
    if (fs.existsSync(stationsFile)) {
      self.stationsDb = fs.readJsonSync(stationsFile);
      self.logger.info('[RTL-SDR Radio] Loaded stations database');
    } else {
      self.stationsDb = { fm: [], dab: [] };
      self.logger.info('[RTL-SDR Radio] No stations database found');
    }
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Error loading stations: ' + e);
    self.stationsDb = { fm: [], dab: [] };
  }
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.saveStations = function() {
  var self = this;
  var stationsFile = '/data/plugins/music_service/rtlsdr_radio/stations.json';
  
  try {
    fs.writeJsonSync(stationsFile, self.stationsDb);
    self.logger.info('[RTL-SDR Radio] Saved stations database');
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to save stations: ' + e);
  }
};
