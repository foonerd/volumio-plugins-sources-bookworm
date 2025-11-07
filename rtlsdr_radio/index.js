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
  self.scanProcess = null;
  self.currentStation = null;
  self.stationsDb = { fm: [], dab: [] };
  
  // Device state management
  self.deviceState = 'idle'; // idle, scanning_fm, scanning_dab, playing_fm, playing_dab
  self.operationQueue = []; // Queue of pending operations
  self.QUEUE_TIMEOUT = 60000; // 60 seconds
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
  
  // Load i18n strings
  self.loadI18nStrings()
    .then(function() {
      return self.loadAlsaLoopback();
    })
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
  
  self.logger.info('[RTL-SDR Radio] Stopping plugin - killing all RTL-SDR processes');
  
  // Set intentional stop flag
  self.intentionalStop = true;
  
  // Kill all RTL-SDR processes synchronously
  try {
    var execSync = require('child_process').execSync;
    
    // Kill all processes (playback and scan)
    execSync('sudo pkill -9 -f "rtl_fm"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "rtl_power"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "dab-rtlsdr-3"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "dab-scanner-3"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "aplay -D volumio"', { timeout: 2000 });
    
    self.logger.info('[RTL-SDR Radio] All RTL-SDR processes killed');
  } catch (e) {
    // pkill returns error if no processes found - this is OK
    self.logger.info('[RTL-SDR Radio] Process cleanup complete (some processes may not have been running)');
  }
  
  // Clear state
  self.decoderProcess = null;
  self.scanProcess = null;
  self.deviceState = 'idle';
  
  // Remove browse source
  self.commandRouter.volumioRemoveToBrowseSources('FM/DAB Radio');
  
  self.logger.info('[RTL-SDR Radio] Plugin stopped');
  defer.resolve();
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.onUnload = function() {
  var self = this;
  
  self.logger.info('[RTL-SDR Radio] Unloading plugin - final cleanup');
  
  // Use same cleanup as onStop
  try {
    var execSync = require('child_process').execSync;
    execSync('sudo pkill -9 -f "rtl_fm"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "rtl_power"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "dab-rtlsdr-3"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "dab-scanner-3"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "aplay -D volumio"', { timeout: 2000 });
  } catch (e) {
    // Ignore errors - processes may already be gone
  }
  
  self.logger.info('[RTL-SDR Radio] Plugin unloaded');
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.onVolumioStop = function() {
  var self = this;
  
  self.logger.info('[RTL-SDR Radio] Volumio stopping - killing all RTL-SDR processes');
  
  // Set intentional stop flag
  self.intentionalStop = true;
  
  // Use synchronous kill with SIGKILL for guaranteed termination
  try {
    var execSync = require('child_process').execSync;
    execSync('sudo pkill -9 -f "rtl_fm"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "rtl_power"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "dab-rtlsdr-3"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "dab-scanner-3"', { timeout: 2000 });
    execSync('sudo pkill -9 -f "aplay -D volumio"', { timeout: 2000 });
    self.logger.info('[RTL-SDR Radio] All processes terminated');
  } catch (e) {
    // Ignore errors
  }
  
  // Clear state
  self.decoderProcess = null;
  self.scanProcess = null;
  self.deviceState = 'idle';
  
  self.logger.info('[RTL-SDR Radio] Ready for Volumio restart');
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.loadI18nStrings = function() {
  var self = this;
  var defer = libQ.defer();
  
  var lang_code = self.commandRouter.sharedVars.get('language_code') || 'en';
  
  self.commandRouter.i18nJson(
    __dirname + '/i18n/strings_' + lang_code + '.json',
    __dirname + '/i18n/strings_en.json',
    __dirname + '/i18n/strings_en.json'
  )
  .then(function(i18nStrings) {
    self.i18nStrings = i18nStrings;
    self.logger.info('[RTL-SDR Radio] Loaded i18n strings for language: ' + lang_code);
    defer.resolve();
  })
  .fail(function(e) {
    self.logger.error('[RTL-SDR Radio] Failed to load i18n strings: ' + e);
    // Fallback to empty object
    self.i18nStrings = {};
    defer.resolve(); // Don't fail plugin startup due to missing translations
  });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.getI18nString = function(key) {
  var self = this;
  
  if (self.i18nStrings && self.i18nStrings[key]) {
    return self.i18nStrings[key];
  }
  
  // Fallback to key if translation not found
  self.logger.warn('[RTL-SDR Radio] Missing translation for key: ' + key);
  return key;
};

ControllerRtlsdrRadio.prototype.getI18nStringFormatted = function(key, ...args) {
  var self = this;
  var str = self.getI18nString(key);
  
  // Replace {0}, {1}, etc. with provided arguments
  for (var i = 0; i < args.length; i++) {
    str = str.replace('{' + i + '}', args[i]);
  }
  
  return str;
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
    
    // Populate scan sensitivity dropdown (content[4])
    var scanSensitivity = self.config.get('scan_sensitivity', 8);
    radioSettings.content[4].value = {
      value: scanSensitivity,
      label: self.getSensitivityLabel(scanSensitivity)
    };
    
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

ControllerRtlsdrRadio.prototype.getSensitivityLabel = function(value) {
  var labels = {
    15: 'Conservative (+15 dB) - Very strong signals only',
    10: 'Moderate (+10 dB) - Strong signals',
    8: 'Balanced (+8 dB) - Good signals (recommended)',
    5: 'Sensitive (+5 dB) - All reasonable signals',
    3: 'Very Sensitive (+3 dB) - Weaker signals, may include noise'
  };
  return labels[value] || labels[8];
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
    albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/radio.svg'
  };
  
  self.commandRouter.volumioAddToBrowseSources(data);
};

// ========== DEVICE STATE MANAGEMENT ==========

ControllerRtlsdrRadio.prototype.checkDeviceAvailable = function(requestedOperation, operationData) {
  var self = this;
  
  if (self.deviceState === 'idle') {
    return libQ.resolve(true);
  }
  
  // Device is busy - show modal and handle user choice
  var defer = libQ.defer();
  
  var stateKeys = {
    'scanning_fm': 'DEVICE_STATE_SCANNING_FM',
    'scanning_dab': 'DEVICE_STATE_SCANNING_DAB',
    'playing_fm': 'DEVICE_STATE_PLAYING_FM',
    'playing_dab': 'DEVICE_STATE_PLAYING_DAB'
  };
  
  var currentActivity = self.getI18nString(stateKeys[self.deviceState] || 'DEVICE_STATE_SCANNING_FM');
  
  self.logger.info('[RTL-SDR Radio] Device conflict: currently ' + currentActivity + ', requested: ' + requestedOperation);
  
  // Store the pending operation internally (cannot pass defer through modal)
  if (!self.pendingOperations) {
    self.pendingOperations = {};
  }
  
  self.pendingOperations[requestedOperation] = {
    type: requestedOperation,
    data: operationData,
    timestamp: Date.now(),
    defer: defer
  };
  
  // Show modal to user (pass only operation type, not defer object)
  self.showDeviceConflictModal(currentActivity, requestedOperation);
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.showDeviceConflictModal = function(currentActivity, requestedOperation) {
  var self = this;
  
  // Get translated operation name
  var operationKeys = {
    'scan_fm': 'OPERATION_SCAN_FM',
    'scan_dab': 'OPERATION_SCAN_DAB',
    'play_fm': 'OPERATION_PLAY_FM',
    'play_dab': 'OPERATION_PLAY_DAB'
  };
  
  var requestedName = self.getI18nString(operationKeys[requestedOperation] || 'OPERATION_SCAN_FM');
  
  // Capitalize first letter for button
  var capitalizedOperation = requestedName.charAt(0).toUpperCase() + requestedName.slice(1);
  
  var modalData = {
    title: self.getI18nString('DEVICE_BUSY_TITLE'),
    message: self.getI18nStringFormatted('DEVICE_BUSY_MESSAGE', currentActivity),
    size: 'md',
    buttons: [
      {
        name: self.getI18nStringFormatted('MODAL_BTN_CANCEL_AND', capitalizedOperation),
        class: 'btn btn-warning',
        emit: 'callMethod',
        payload: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'handleDeviceConflict',
          data: {
            action: 'cancel',
            operationType: requestedOperation
          }
        }
      },
      {
        name: self.getI18nString('MODAL_BTN_QUEUE'),
        class: 'btn btn-info',
        emit: 'callMethod',
        payload: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'handleDeviceConflict',
          data: {
            action: 'queue',
            operationType: requestedOperation
          }
        }
      },
      {
        name: self.getI18nString('MODAL_BTN_CANCEL_REQUEST'),
        class: 'btn btn-default',
        emit: 'callMethod',
        payload: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'handleDeviceConflict',
          data: {
            action: 'reject',
            operationType: requestedOperation
          }
        }
      }
    ]
  };
  
  self.commandRouter.broadcastMessage('openModal', modalData);
};

ControllerRtlsdrRadio.prototype.handleDeviceConflict = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var action = data.action;
  var operationType = data.operationType;
  
  // Look up the pending operation
  var operation = self.pendingOperations[operationType];
  
  if (!operation) {
    self.logger.error('[RTL-SDR Radio] No pending operation found for type: ' + operationType);
    defer.reject(new Error('No pending operation found'));
    return defer.promise;
  }
  
  self.logger.info('[RTL-SDR Radio] Device conflict resolution: ' + action + ' for ' + operationType);
  
  if (action === 'cancel') {
    // User explicitly chose to cancel - clear queue to prevent old operations from executing
    self.operationQueue = [];
    self.logger.info('[RTL-SDR Radio] Queue cleared due to explicit cancel');
    
    // Inform user that we're stopping the current operation
    self.commandRouter.pushToastMessage(
      'info',
      self.getI18nString('PLUGIN_NAME'),
      self.getI18nString('TOAST_STOPPING_OPERATION')
    );
    
    // Cancel current operation and proceed with new one
    self.stopCurrentOperation()
      .then(function() {
        // Wait for processes to fully terminate and release USB device
        // Processes need time for graceful shutdown (rtl_power finishes scan pass)
        // stopDecoder has 500ms timeout, add extra margin for graceful shutdown
        self.logger.info('[RTL-SDR Radio] Waiting for device cleanup...');
        setTimeout(function() {
          // Resolve the pending operation's defer to proceed
          operation.defer.resolve(true);
          // Remove from pending operations
          delete self.pendingOperations[operationType];
          defer.resolve();
        }, 1200);
      })
      .fail(function(e) {
        operation.defer.reject(e);
        delete self.pendingOperations[operationType];
        defer.reject(e);
      });
  } else if (action === 'queue') {
    // Add to queue
    self.operationQueue.push(operation);
    // Remove from pending operations (now in queue)
    delete self.pendingOperations[operationType];
    self.logger.info('[RTL-SDR Radio] Operation queued: ' + operation.type);
    
    self.commandRouter.pushToastMessage(
      'info',
      self.getI18nString('TOAST_OPERATION_QUEUED'),
      self.getI18nString('TOAST_OPERATION_QUEUED_MSG')
    );
    defer.resolve();
  } else {
    // Reject request
    operation.defer.reject(new Error('User cancelled operation'));
    delete self.pendingOperations[operationType];
    defer.resolve();
  }
  
  // Close modal
  self.commandRouter.broadcastMessage('closeAllModals', '');
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.stopCurrentOperation = function() {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Stopping current operation: ' + self.deviceState);
  
  if (self.deviceState.startsWith('playing_')) {
    // Stop playback
    self.stop()
      .then(function() {
        self.setDeviceState('idle');
        defer.resolve();
      })
      .fail(function(e) {
        defer.reject(e);
      });
  } else if (self.deviceState.startsWith('scanning_')) {
    // Kill scan process
    self.stopDecoder();
    self.setDeviceState('idle');
    defer.resolve();
  } else {
    // Already idle
    defer.resolve();
  }
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.setDeviceState = function(newState) {
  var self = this;
  
  var oldState = self.deviceState;
  self.deviceState = newState;
  
  self.logger.info('[RTL-SDR Radio] Device state: ' + oldState + ' -> ' + newState);
  
  // If device became idle, process queue
  if (newState === 'idle' && self.operationQueue.length > 0) {
    self.processOperationQueue();
  }
};

ControllerRtlsdrRadio.prototype.processOperationQueue = function() {
  var self = this;
  
  if (self.operationQueue.length === 0) {
    return;
  }
  
  // Remove expired operations
  var now = Date.now();
  self.operationQueue = self.operationQueue.filter(function(op) {
    var isExpired = (now - op.timestamp) > self.QUEUE_TIMEOUT;
    if (isExpired) {
      self.logger.info('[RTL-SDR Radio] Operation expired: ' + op.type);
      op.defer.reject(new Error('Operation timed out in queue'));
    }
    return !isExpired;
  });
  
  if (self.operationQueue.length === 0) {
    return;
  }
  
  // Process first operation (FIFO)
  var nextOp = self.operationQueue.shift();
  
  self.logger.info('[RTL-SDR Radio] Processing queued operation: ' + nextOp.type);
  
  self.commandRouter.pushToastMessage(
    'info',
    self.getI18nString('TOAST_STARTING_QUEUED'),
    self.getI18nString('TOAST_DEVICE_AVAILABLE')
  );
  
  // Resolve the defer to allow operation to proceed
  nextOp.defer.resolve(true);
};

ControllerRtlsdrRadio.prototype.handleBrowseUri = function(curUri) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Browse URI: ' + curUri);
  
  // Handle rescan trigger
  if (curUri === 'rtlsdr://rescan') {
    self.scanFm()
      .then(function() {
        // Return to main browse view after scan
        return self.handleBrowseUri('rtlsdr');
      })
      .then(function(response) {
        defer.resolve(response);
      })
      .fail(function(e) {
        // Only log and reject if stop was not intentional
        if (!self.intentionalStop) {
          self.logger.error('[RTL-SDR Radio] Rescan failed: ' + e);
          defer.reject(e);
        } else {
          // Canceled intentionally, return current browse state
          self.handleBrowseUri('rtlsdr')
            .then(function(response) {
              defer.resolve(response);
            })
            .fail(function(err) {
              defer.reject(err);
            });
        }
      });
    return defer.promise;
  }
  
  // Handle DAB rescan trigger
  if (curUri === 'rtlsdr://rescan-dab') {
    self.scanDab()
      .then(function() {
        // Return to main browse view after scan
        return self.handleBrowseUri('rtlsdr');
      })
      .then(function(response) {
        defer.resolve(response);
      })
      .fail(function(e) {
        // Only log and reject if stop was not intentional
        if (!self.intentionalStop) {
          self.logger.error('[RTL-SDR Radio] DAB rescan failed: ' + e);
          defer.reject(e);
        } else {
          // Canceled intentionally, return current browse state
          self.handleBrowseUri('rtlsdr')
            .then(function(response) {
              defer.resolve(response);
            })
            .fail(function(err) {
              defer.reject(err);
            });
        }
      });
    return defer.promise;
  }
  
  // Build FM station list
  var fmItems = [];
  if (self.stationsDb.fm && self.stationsDb.fm.length > 0) {
    fmItems = self.stationsDb.fm.map(function(station) {
      return {
        service: 'rtlsdr_radio',
        type: 'song',
        title: station.name,
        artist: station.frequency + ' MHz',
        album: 'FM Radio',
        albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
        uri: 'rtlsdr://fm/' + station.frequency
      };
    });
  } else {
    // No stations - show scan prompt
    fmItems.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No stations found',
      artist: 'Click Rescan to search for FM stations',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  // Add rescan option at the end
  fmItems.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Rescan Stations',
    artist: 'Scan for FM stations (takes ~10 seconds)',
    album: '',
    icon: 'fa fa-refresh',
    uri: 'rtlsdr://rescan'
  });
  
  // Build DAB station list
  var dabItems = [];
  
  if (self.stationsDb.dab && self.stationsDb.dab.length > 0) {
    // Add DAB stations
    self.stationsDb.dab.forEach(function(station) {
      dabItems.push({
        service: 'rtlsdr_radio',
        type: 'webradio',
        title: station.name,                           // Display name (trimmed)
        artist: station.ensemble,
        album: 'Channel ' + station.channel,
        albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
        icon: 'fa fa-broadcast-tower',
        uri: 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName)  // Use exactName with spaces
      });
    });
  } else {
    // No stations - show scan prompt
    dabItems.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No DAB stations found',
      artist: 'Click Rescan to search for DAB stations',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  // Add rescan option at the end
  dabItems.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Rescan DAB Stations',
    artist: 'Scan for DAB stations (takes ~30-60 seconds)',
    album: '',
    icon: 'fa fa-refresh',
    uri: 'rtlsdr://rescan-dab'
  });
  
  var response = {
    navigation: {
      lists: [
        {
          title: 'FM Radio (' + (self.stationsDb.fm ? self.stationsDb.fm.length : 0) + ' stations)',
          icon: 'fa fa-signal',
          availableListViews: ['list'],
          items: fmItems
        },
        {
          title: 'DAB Radio (' + (self.stationsDb.dab ? self.stationsDb.dab.length : 0) + ' services)',
          icon: 'fa fa-broadcast-tower',
          availableListViews: ['list'],
          items: dabItems
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
    // DAB playback - parse URI: rtlsdr://dab/<channel>/<serviceName>
    var dabParts = track.uri.replace('rtlsdr://dab/', '').split('/');
    if (dabParts.length < 2) {
      self.logger.error('[RTL-SDR Radio] Invalid DAB URI: ' + track.uri);
      defer.reject(new Error('Invalid DAB URI'));
      return defer.promise;
    }
    
    var channel = dabParts[0];
    var serviceName = decodeURIComponent(dabParts[1]);
    
    self.playDabStation(channel, serviceName, track.title || serviceName)
      .then(function() {
        defer.resolve();
      })
      .fail(function(e) {
        self.logger.error('[RTL-SDR Radio] DAB playback failed: ' + e);
        self.commandRouter.pushToastMessage('error', 'DAB Radio', 'Failed to play station: ' + e);
        defer.reject(e);
      });
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
  
  // Check device availability
  self.checkDeviceAvailable('play_fm', { frequency: freq, stationName: stationName })
    .then(function() {
      // Device is available, proceed with playback
      self.setDeviceState('playing_fm');
      
      // If decoder is still running, wait for cleanup to complete
      if (self.decoderProcess !== null) {
        self.logger.info('[RTL-SDR Radio] Waiting for previous station cleanup...');
        setTimeout(function() {
          self.startFmPlayback(freq, stationName, defer);
        }, 600); // Wait slightly longer than stopDecoder timeout (500ms)
      } else {
        self.startFmPlayback(freq, stationName, defer);
      }
    })
    .fail(function(e) {
      self.logger.info('[RTL-SDR Radio] FM playback cancelled or rejected: ' + e);
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.startFmPlayback = function(freq, stationName, defer) {
  var self = this;
  
  // Get gain from config
  var gain = self.config.get('fm_gain', 50);
  
  // Build rtl_fm command piped to aplay
  // rtl_fm: -f frequency, -M wfm (wideband FM), -s 180k sample rate, -r 48k resample, -g gain
  // aplay: -D volumio (Volumio's modular ALSA device), -f S16_LE (format), -r 48000 (rate), -c 1 (mono)
  var command = 'rtl_fm -f ' + freq + 'M -M wfm -s 180k -r 48k -g ' + gain + 
                ' | aplay -D volumio -f S16_LE -r 48000 -c 1';
  
  self.logger.info('[RTL-SDR Radio] Command: ' + command);
  
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
    uri: 'rtlsdr://fm/' + freq,
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
    albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
    uri: 'rtlsdr://fm/' + freq,
    trackType: 'fm',
    samplerate: '48 KHz',
    bitdepth: '16 bit',
    channels: 1,
    duration: 0,
    seek: 0
  };
  
  // Clear state to force state machine recognition of change
  // This mimics the stop() function behavior to ensure UI update
  self.commandRouter.stateMachine.setVolatile({
    service: 'rtlsdr_radio',
    status: 'stop',
    title: '',
    artist: '',
    album: '',
    uri: ''
  });
  
  self.commandRouter.servicePushState(state, 'rtlsdr_radio');
  
  // Force state machine update to trigger UI refresh
  // This ensures "Received an update from plugin" event fires
  setTimeout(function() {
    self.commandRouter.stateMachine.pushState(state);
  }, 500);
  
  defer.resolve();
};

ControllerRtlsdrRadio.prototype.stop = function() {
  var self = this;
  self.stopDecoder();
  
  // Reset device state to idle
  self.setDeviceState('idle');
  
  // Get current state and just change status to pause
  // Keep all track info for resume
  var currentState = self.commandRouter.stateMachine.getState();
  currentState.status = 'pause';
  self.commandRouter.servicePushState(currentState, 'rtlsdr_radio');
  self.commandRouter.stateMachine.setConsumeUpdateService('');
  // Push stopped state to UI
  self.commandRouter.stateMachine.setVolatile({
    service: 'rtlsdr_radio',
    status: 'pause',
    title: '',
    artist: '',
    album: '',
    uri: ''
  });
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
  
  self.logger.info('[RTL-SDR Radio] Stopping all processes');
  self.intentionalStop = true;
  
  try {
    // Kill FM playback processes
    exec('sudo pkill -f "rtl_fm -f"');
    exec('sudo pkill -f "aplay -D volumio"');
    
    // Kill DAB playback processes
    exec('sudo pkill -f "dab-rtlsdr-3"');
    
    // Kill FM scan processes
    exec('sudo pkill -f "rtl_power"');
    
    // Kill DAB scan processes
    exec('sudo pkill -f "dab-scanner-3"');
    
    // Kill stored process reference if exists
    if (self.decoderProcess !== null) {
      self.decoderProcess.kill('SIGTERM');
    }
    
    // Kill scan process reference if exists
    if (self.scanProcess !== null) {
      self.scanProcess.kill('SIGTERM');
    }
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Error stopping processes: ' + e);
  }
  
  // Wait for processes to fully terminate
  setTimeout(function() {
    self.decoderProcess = null;
    self.scanProcess = null;
    // DON'T clear currentStation - needed for resume
  }, 500);
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
  if (data.scan_sensitivity !== undefined) {
    // Dropdown sends {value: X, label: "..."} object, extract value
    var sensitivityValue = data.scan_sensitivity.value || data.scan_sensitivity;
    var sensitivity = parseInt(sensitivityValue);
    if (!isNaN(sensitivity)) {
      self.config.set('scan_sensitivity', sensitivity);
      self.logger.info('[RTL-SDR Radio] Scan sensitivity set to +' + sensitivity + ' dB');
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

// FM SCANNING METHODS - Phase 3 Implementation
// ============================================

ControllerRtlsdrRadio.prototype.scanFm = function() {
  var self = this;
  var defer = libQ.defer();
  
  // Check device availability
  self.checkDeviceAvailable('scan_fm', {})
    .then(function() {
      // Device is available, proceed with scan
      self.setDeviceState('scanning_fm');
      
      self.logger.info('[RTL-SDR Radio] Starting FM scan...');
      self.commandRouter.pushToastMessage('info', self.getI18nString('FM_RADIO'), self.getI18nString('TOAST_FM_SCANNING'));
      
      // Generate unique temp file name
      var scanFile = '/tmp/fm_scan_' + Date.now() + '.csv';
      
      // rtl_power command:
      // -f 88M:108M:125k = Scan 88-108 MHz in 125kHz steps (160 bins)
      // -i 10 = Integrate for 10 seconds
      // -1 = Single-shot mode (exit after one scan)
      var command = 'rtl_power -f 88M:108M:125k -i 10 -1 ' + scanFile;
      
      self.logger.info('[RTL-SDR Radio] Scan command: ' + command);
      
      self.scanProcess = exec(command, { timeout: 30000 }, function(error, stdout, stderr) {
        if (error) {
          // Only log and show error if stop was not intentional
          if (!self.intentionalStop) {
            self.logger.error('[RTL-SDR Radio] Scan failed: ' + error);
            self.commandRouter.pushToastMessage('error', self.getI18nString('FM_RADIO'), 
              self.getI18nStringFormatted('TOAST_SCAN_FAILED', error.message));
          }
          self.setDeviceState('idle');
          self.scanProcess = null;
          defer.reject(error);
          return;
        }
        
        self.logger.info('[RTL-SDR Radio] Scan complete, parsing results...');
        
        // Parse scan results
        self.parseScanResults(scanFile)
          .then(function(stations) {
            self.logger.info('[RTL-SDR Radio] Found ' + stations.length + ' FM stations');
            
            // Save to database
            self.stationsDb.fm = stations;
            self.saveStations();
            
            self.commandRouter.pushToastMessage('success', self.getI18nString('FM_RADIO'), 
              self.getI18nStringFormatted('TOAST_FM_SCAN_COMPLETE', stations.length));
            
            self.setDeviceState('idle');
            self.scanProcess = null;
            defer.resolve(stations);
          })
          .fail(function(e) {
            self.logger.error('[RTL-SDR Radio] Failed to parse scan results: ' + e);
            self.commandRouter.pushToastMessage('error', self.getI18nString('FM_RADIO'), 
              self.getI18nString('TOAST_PARSE_FAILED'));
            self.setDeviceState('idle');
            self.scanProcess = null;
            defer.reject(e);
          });
      });
    })
    .fail(function(e) {
      self.logger.info('[RTL-SDR Radio] FM scan cancelled or rejected: ' + e);
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.parseScanResults = function(scanFile) {
  var self = this;
  var defer = libQ.defer();
  
  fs.readFile(scanFile, 'utf8', function(err, data) {
    if (err) {
      self.logger.error('[RTL-SDR Radio] Failed to read scan file: ' + err);
      defer.reject(err);
      return;
    }
    
    try {
      var lines = data.trim().split('\n');
      if (lines.length === 0) {
        self.logger.error('[RTL-SDR Radio] Empty scan file');
        defer.reject(new Error('Empty scan file'));
        return;
      }
      
      self.logger.info('[RTL-SDR Radio] Processing ' + lines.length + ' frequency hops');
      
      // Build frequency map by combining all hops
      var freqMap = {}; // frequency -> power
      
      // Process each line (frequency hop)
      for (var lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        var line = lines[lineIdx];
        var values = line.split(',').map(function(v) { return v.trim(); });
        
        // CSV format: date, time, Hz_low, Hz_high, Hz_step, samples, dBm_values...
        if (values.length < 7) {
          continue; // Skip invalid lines
        }
        
        var startFreq = parseFloat(values[2]) / 1000000; // Hz to MHz
        var step = parseFloat(values[4]) / 1000000;
        
        // Extract power values (skip first 6 metadata fields)
        var powerValues = values.slice(6);
        
        // Map each bin to its frequency
        for (var i = 0; i < powerValues.length; i++) {
          var power = parseFloat(powerValues[i]);
          
          // Skip NaN values
          if (isNaN(power)) {
            continue;
          }
          
          var freq = startFreq + (i * step);
          var freqKey = freq.toFixed(6); // Use high precision key
          
          // Store power value for this frequency
          freqMap[freqKey] = power;
        }
      }
      
      // Convert frequency map to sorted array
      var freqArray = [];
      for (var freqKey in freqMap) {
        freqArray.push({
          freq: parseFloat(freqKey),
          power: freqMap[freqKey]
        });
      }
      
      // Sort by frequency
      freqArray.sort(function(a, b) {
        return a.freq - b.freq;
      });
      
      if (freqArray.length === 0) {
        self.logger.error('[RTL-SDR Radio] No valid power values found');
        defer.reject(new Error('No valid data'));
        return;
      }
      
      self.logger.info('[RTL-SDR Radio] Combined spectrum: ' + freqArray.length + ' valid bins');
      
      // Calculate average power for threshold (skip NaN already filtered)
      var sum = 0;
      for (var i = 0; i < freqArray.length; i++) {
        sum += freqArray[i].power;
      }
      var avgPower = sum / freqArray.length;
      
      // Get threshold from config (default: +8 dB for balanced detection)
      var thresholdOffset = self.config.get('scan_sensitivity', 8);
      var threshold = avgPower + thresholdOffset;
      
      self.logger.info('[RTL-SDR Radio] Average power: ' + avgPower.toFixed(1) + 
                      ' dBm, threshold: ' + threshold.toFixed(1) + ' dBm (+' + thresholdOffset + ' dB)');
      
      // Find peaks (local maxima above threshold)
      var stations = [];
      for (var i = 1; i < freqArray.length - 1; i++) {
        var current = freqArray[i];
        var prev = freqArray[i - 1];
        var next = freqArray[i + 1];
        
        // Check if this is a peak above threshold
        if (current.power > threshold && 
            current.power > prev.power && 
            current.power > next.power) {
          
          // Round to nearest 0.1 MHz for display
          var freqRounded = Math.round(current.freq * 10) / 10;
          
          stations.push({
            frequency: freqRounded.toFixed(1),
            name: 'FM ' + freqRounded.toFixed(1),
            signal_strength: current.power.toFixed(1),
            last_seen: new Date().toISOString()
          });
          
          self.logger.info('[RTL-SDR Radio] Found station: ' + freqRounded.toFixed(1) + 
                          ' MHz (' + current.power.toFixed(1) + ' dBm)');
        }
      }
      
      // Sort stations by frequency
      stations.sort(function(a, b) {
        return parseFloat(a.frequency) - parseFloat(b.frequency);
      });
      
      // Cleanup temp file
      fs.unlink(scanFile, function() {});
      
      defer.resolve(stations);
      
    } catch (e) {
      self.logger.error('[RTL-SDR Radio] Error parsing scan data: ' + e);
      defer.reject(e);
    }
  });
  
  return defer.promise;
};

// ============================================
// DAB Radio Functions
// ============================================

ControllerRtlsdrRadio.prototype.scanDab = function() {
  var self = this;
  var defer = libQ.defer();
  
  // Check device availability
  self.checkDeviceAvailable('scan_dab', {})
    .then(function() {
      // Device is available, proceed with scan
      self.setDeviceState('scanning_dab');
      
      self.logger.info('[RTL-SDR Radio] Starting DAB scan...');
      self.commandRouter.pushToastMessage('info', self.getI18nString('DAB_RADIO'), self.getI18nString('TOAST_DAB_SCANNING'));
      
      // Generate unique temp file name
      var scanFile = '/tmp/dab_scan_' + Date.now() + '.json';
      
      // Get DAB gain from config
      var dabGain = self.config.get('dab_gain', 80);
      
      // dab-scanner-3 command:
      // -B BAND_III = Scan Band III (European DAB standard, 174-240 MHz)
      // -G <gain> = Tuner gain (0-49.6, higher = more sensitive)
      // -j = JSON output format
      var command = 'dab-scanner-3 -B BAND_III -G ' + dabGain + ' -j > ' + scanFile;
      
      self.logger.info('[RTL-SDR Radio] DAB scan command: ' + command);
      
      self.scanProcess = exec(command, { timeout: 120000 }, function(error, stdout, stderr) {
        if (error) {
          // Only log and show error if stop was not intentional
          if (!self.intentionalStop) {
            self.logger.error('[RTL-SDR Radio] DAB scan failed: ' + error);
            self.commandRouter.pushToastMessage('error', self.getI18nString('DAB_RADIO'), 
              self.getI18nStringFormatted('TOAST_SCAN_FAILED', error.message));
          }
          self.setDeviceState('idle');
          self.scanProcess = null;
          defer.reject(error);
          return;
        }
        
        self.logger.info('[RTL-SDR Radio] DAB scan complete, parsing results...');
        
        // Parse scan results
        self.parseDabScanResults(scanFile)
          .then(function(stations) {
            self.logger.info('[RTL-SDR Radio] Found ' + stations.length + ' DAB services');
            
            // Save to database
            self.stationsDb.dab = stations;
            self.saveStations();
            
            self.commandRouter.pushToastMessage('success', self.getI18nString('DAB_RADIO'), 
              self.getI18nStringFormatted('TOAST_DAB_SCAN_COMPLETE', stations.length));
            
            self.setDeviceState('idle');
            self.scanProcess = null;
            defer.resolve(stations);
          })
          .fail(function(e) {
            self.logger.error('[RTL-SDR Radio] Failed to parse DAB scan results: ' + e);
            self.commandRouter.pushToastMessage('error', self.getI18nString('DAB_RADIO'), 
              self.getI18nString('TOAST_PARSE_FAILED'));
            self.setDeviceState('idle');
            self.scanProcess = null;
            defer.reject(e);
          });
      });
    })
    .fail(function(e) {
      self.logger.info('[RTL-SDR Radio] DAB scan cancelled or rejected: ' + e);
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.parseDabScanResults = function(scanFile) {
  var self = this;
  var defer = libQ.defer();
  
  fs.readFile(scanFile, 'utf8', function(err, data) {
    if (err) {
      self.logger.error('[RTL-SDR Radio] Failed to read DAB scan file: ' + err);
      defer.reject(err);
      return;
    }
    
    try {
      // dab-scanner-3 outputs debug text before JSON
      // Extract only the JSON portion (starts with '{')
      var jsonStart = data.indexOf('{');
      if (jsonStart === -1) {
        self.logger.error('[RTL-SDR Radio] No JSON found in scan output');
        defer.reject(new Error('No JSON in scan output'));
        return;
      }
      
      var jsonData = data.substring(jsonStart);
      self.logger.info('[RTL-SDR Radio] Extracted JSON from position ' + jsonStart);
      
      // Parse JSON output from dab-scanner-3
      var scanData = JSON.parse(jsonData);
      
      // Scanner returns ensembles as object with ensemble IDs as keys
      var ensembleIds = Object.keys(scanData);
      
      if (ensembleIds.length === 0) {
        self.logger.info('[RTL-SDR Radio] No DAB ensembles found');
        defer.resolve([]);
        return;
      }
      
      self.logger.info('[RTL-SDR Radio] Found ' + ensembleIds.length + ' DAB ensembles');
      
      // Flatten ensemble/service structure into service list
      var services = [];
      
      ensembleIds.forEach(function(ensembleId) {
        var ensemble = scanData[ensembleId];
        
        if (!ensemble.services) {
          return;
        }
        
        // Services are also an object with service IDs as keys
        var serviceIds = Object.keys(ensemble.services);
        
        serviceIds.forEach(function(serviceId) {
          var service = ensemble.services[serviceId];
          
          // Only include services with audio field (exclude data services)
          if (!service.audio) {
            return;
          }
          
          // Store both trimmed name for display and exact name for playback
          var trimmedName = service.name.trim();
          var exactName = service.name;  // Preserve trailing spaces
          
          services.push({
            name: trimmedName,              // For display in UI
            exactName: exactName,            // For playback command (with spaces)
            ensemble: ensemble.name.trim(),
            channel: ensemble.channel,
            serviceId: serviceId,
            ensembleId: ensembleId,
            bitrate: service.bitRate,
            audioType: service.audio,
            last_seen: new Date().toISOString()
          });
          
          self.logger.info('[RTL-SDR Radio] Found DAB service: ' + trimmedName + 
                          ' (' + service.bitRate + 'kbps ' + service.audio + ') on ' + 
                          ensemble.name.trim() + ' (Ch ' + ensemble.channel + ')');
        });
      });
      
      // Sort services alphabetically by name
      services.sort(function(a, b) {
        return a.name.localeCompare(b.name);
      });
      
      // Cleanup temp file
      fs.unlink(scanFile, function() {});
      
      defer.resolve(services);
      
    } catch (e) {
      self.logger.error('[RTL-SDR Radio] Error parsing DAB scan data: ' + e);
      defer.reject(e);
    }
  });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.playDabStation = function(channel, serviceName, stationTitle) {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Playing DAB station: ' + serviceName + ' on channel ' + channel);
  
  // Check device availability
  self.checkDeviceAvailable('play_dab', { channel: channel, serviceName: serviceName, stationTitle: stationTitle })
    .then(function() {
      // Device is available, proceed with playback
      self.setDeviceState('playing_dab');
      
      // If decoder is still running, wait for cleanup to complete
      if (self.decoderProcess !== null) {
        self.logger.info('[RTL-SDR Radio] Waiting for previous station cleanup...');
        setTimeout(function() {
          self.startDabPlayback(channel, serviceName, stationTitle, defer);
        }, 600); // Wait slightly longer than stopDecoder timeout (500ms)
      } else {
        self.startDabPlayback(channel, serviceName, stationTitle, defer);
      }
    })
    .fail(function(e) {
      self.logger.info('[RTL-SDR Radio] DAB playback cancelled or rejected: ' + e);
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.startDabPlayback = function(channel, serviceName, stationTitle, defer) {
  var self = this;
  
  // Get DAB gain from config
  var dabGain = self.config.get('dab_gain', 80);
  
  // Build dab-rtlsdr-3 command piped to aplay
  // -C <channel> = DAB channel (e.g., 12B)
  // -P "<service>" = Service name (must match exactly with spaces)
  // -G <gain> = Tuner gain
  // -D 30 = Detection timeout (30 seconds to find ensemble)
  // 2>/dev/null = Discard debug output to stderr
  // Pipe PCM audio to aplay with Volumio device
  var command = 'dab-rtlsdr-3 -C ' + channel + 
                ' -P "' + serviceName.replace(/"/g, '\\"') + '"' +
                ' -G ' + dabGain + 
                ' -D 30' +
                ' 2>/dev/null | aplay -D volumio -f S16_LE -r 48000 -c 2';
  
  self.logger.info('[RTL-SDR Radio] DAB command: ' + command);
  
  // Clear intentional stop flag when starting new playback
  
  // Start decoder process
  self.decoderProcess = exec(command, function(error, stdout, stderr) {
    if (error) {
      // Only log error if it wasn't an intentional stop
      if (!self.intentionalStop) {
        self.logger.error('[RTL-SDR Radio] DAB decoder error: ' + error);
      }
      self.decoderProcess = null;
    }
  });
  
  // Store current station for resume
  self.currentStation = {
    uri: 'rtlsdr://dab/' + channel + '/' + encodeURIComponent(serviceName),
    name: stationTitle,
    service: 'rtlsdr_radio'
  };
  
  // Update Volumio state machine
  self.commandRouter.stateMachine.setConsumeUpdateService('rtlsdr_radio');
  
  var state = {
    status: 'play',
    service: 'rtlsdr_radio',
    title: stationTitle,
    artist: 'DAB Radio',
    album: 'Channel ' + channel,
    albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
    uri: 'rtlsdr://dab/' + channel + '/' + encodeURIComponent(serviceName),
    trackType: 'DAB',
    samplerate: '48 kHz',
    bitdepth: '16 bit',
    channels: 2,
    duration: 0,
    seek: 0
  };
  
  // Clear state to force state machine recognition of change
  // This mimics the stop() function behavior to ensure UI update
  self.commandRouter.stateMachine.setVolatile({
    service: 'rtlsdr_radio',
    status: 'stop',
    title: '',
    artist: '',
    album: '',
    uri: ''
  });
  
  self.commandRouter.servicePushState(state, 'rtlsdr_radio');
  
  // Force state machine update to trigger UI refresh
  // This ensures "Received an update from plugin" event fires
  setTimeout(function() {
    self.commandRouter.stateMachine.pushState(state);
  }, 500);
  
  defer.resolve();
};
