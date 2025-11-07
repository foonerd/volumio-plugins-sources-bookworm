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
    
    // Add station management sections
    self.addStationManagementSections(uiconf);
    
    defer.resolve(uiconf);
  })
  .fail(function() {
    defer.reject(new Error());
  });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.addStationManagementSections = function(uiconf) {
  var self = this;
  
  // Get current page numbers from config
  var fmPage = self.config.get('fm_management_page', 1);
  var dabPage = self.config.get('dab_management_page', 1);
  var stationsPerPage = 10;
  
  // Add FM Station Management section with collapsible + pagination
  if (self.stationsDb.fm && self.stationsDb.fm.length > 0) {
    var fmStations = self.stationsDb.fm.filter(function(s) { return !s.deleted; });
    var totalFmPages = Math.ceil(fmStations.length / stationsPerPage);
    
    // Ensure page is within bounds
    if (fmPage < 1) fmPage = 1;
    if (fmPage > totalFmPages) fmPage = totalFmPages;
    
    var startIdx = (fmPage - 1) * stationsPerPage;
    var endIdx = Math.min(startIdx + stationsPerPage, fmStations.length);
    var pageStations = fmStations.slice(startIdx, endIdx);
    
    // Build data array with field IDs for CURRENT PAGE + enable toggle
    var fmDataArray = ['fm_stations_enable'];
    for (var i = startIdx; i < endIdx; i++) {
      fmDataArray.push('fm_station_' + i + '_customname');
      fmDataArray.push('fm_station_' + i + '_favorite');
      fmDataArray.push('fm_station_' + i + '_hidden');
    }
    
    var fmSection = {
      id: 'fm_stations_section',
      element: 'section',
      label: 'Customize FM Stations',
      icon: 'fa-signal',
      onSave: { 
        type: 'controller', 
        endpoint: 'music_service/rtlsdr_radio', 
        method: 'saveStationSettings' 
      },
      saveButton: {
        label: 'Apply Changes',
        data: fmDataArray
      },
      content: [
        {
          id: 'fm_stations_enable',
          element: 'switch',
          label: 'Enable FM Station Customization',
          value: self.config.get('fm_management_enabled', false),
          doc: 'Show FM station management options below'
        }
      ]
    };
    
    // Page navigation info
    fmSection.content.push({
      id: 'fm_page_info',
      element: 'info',
      label: 'FM Stations',
      description: 'Page ' + fmPage + ' of ' + totalFmPages + ' - Showing stations ' + (startIdx + 1) + '-' + endIdx + ' of ' + fmStations.length + ' total',
      visibleIf: {
        field: 'fm_stations_enable',
        value: true
      }
    });
    
    // Page navigation buttons
    if (totalFmPages > 1) {
      // Previous button
      if (fmPage > 1) {
        fmSection.content.push({
          id: 'fm_prev_page',
          element: 'button',
          label: 'Previous Page',
          onClick: {
            type: 'emit',
            message: 'callMethod',
            data: {
              endpoint: 'music_service/rtlsdr_radio',
              method: 'changeFmPage',
              data: { page: fmPage - 1 }
            }
          },
          visibleIf: {
            field: 'fm_stations_enable',
            value: true
          }
        });
      }
      
      // Next button
      if (fmPage < totalFmPages) {
        fmSection.content.push({
          id: 'fm_next_page',
          element: 'button',
          label: 'Next Page',
          onClick: {
            type: 'emit',
            message: 'callMethod',
            data: {
              endpoint: 'music_service/rtlsdr_radio',
              method: 'changeFmPage',
              data: { page: fmPage + 1 }
            }
          },
          visibleIf: {
            field: 'fm_stations_enable',
            value: true
          }
        });
      }
      
      fmSection.content.push({
        id: 'fm_nav_separator',
        element: 'hr',
        visibleIf: {
          field: 'fm_stations_enable',
          value: true
        }
      });
    }
    
    // Add stations for current page
    pageStations.forEach(function(station, index) {
      var displayName = station.customName || station.name;
      var globalIndex = startIdx + index;
      
      fmSection.content.push({
        id: 'fm_station_' + globalIndex + '_header',
        element: 'section',
        label: displayName + ' (' + station.frequency + ' MHz)',
        description: 'Signal: ' + station.signal_strength + ' dBm',
        visibleIf: {
          field: 'fm_stations_enable',
          value: true
        }
      });
      
      fmSection.content.push({
        id: 'fm_station_' + globalIndex + '_customname',
        type: 'text',
        element: 'input',
        label: 'Custom Name',
        value: station.customName || '',
        placeholder: 'Leave empty for default',
        doc: 'Set a custom name for this station',
        visibleIf: {
          field: 'fm_stations_enable',
          value: true
        }
      });
      
      fmSection.content.push({
        id: 'fm_station_' + globalIndex + '_favorite',
        type: 'boolean',
        element: 'switch',
        label: 'Favorite',
        value: station.favorite || false,
        doc: 'Mark as favorite for quick access',
        visibleIf: {
          field: 'fm_stations_enable',
          value: true
        }
      });
      
      fmSection.content.push({
        id: 'fm_station_' + globalIndex + '_hidden',
        type: 'boolean',
        element: 'switch',
        label: 'Hidden',
        value: station.hidden || false,
        doc: 'Hide from station lists',
        visibleIf: {
          field: 'fm_stations_enable',
          value: true
        }
      });
      
      fmSection.content.push({
        id: 'fm_station_' + globalIndex + '_delete',
        element: 'button',
        label: 'Delete Station',
        onClick: {
          type: 'emit',
          message: 'callMethod',
          data: {
            endpoint: 'music_service/rtlsdr_radio',
            method: 'deleteStation',
            data: { uri: 'rtlsdr://fm/' + station.frequency }
          }
        },
        visibleIf: {
          field: 'fm_stations_enable',
          value: true
        }
      });
      
      if (index < pageStations.length - 1) {
        fmSection.content.push({
          id: 'fm_station_' + globalIndex + '_separator',
          element: 'hr',
          visibleIf: {
            field: 'fm_stations_enable',
            value: true
          }
        });
      }
    });
    
    uiconf.sections.push(fmSection);
  }
  
  
  // Add DAB Station Management section with collapsible + pagination
  if (self.stationsDb.dab && self.stationsDb.dab.length > 0) {
    var dabStations = self.stationsDb.dab.filter(function(s) { return !s.deleted; });
    var totalDabPages = Math.ceil(dabStations.length / stationsPerPage);
    
    // Ensure page is within bounds
    if (dabPage < 1) dabPage = 1;
    if (dabPage > totalDabPages) dabPage = totalDabPages;
    
    var startIdx = (dabPage - 1) * stationsPerPage;
    var endIdx = Math.min(startIdx + stationsPerPage, dabStations.length);
    var pageStations = dabStations.slice(startIdx, endIdx);
    
    // Build data array with field IDs for CURRENT PAGE + enable toggle
    var dabDataArray = ['dab_stations_enable'];
    for (var i = startIdx; i < endIdx; i++) {
      dabDataArray.push('dab_station_' + i + '_customname');
      dabDataArray.push('dab_station_' + i + '_favorite');
      dabDataArray.push('dab_station_' + i + '_hidden');
    }
    
    var dabSection = {
      id: 'dab_stations_section',
      element: 'section',
      label: 'Customize DAB Stations',
      icon: 'fa-rss',
      onSave: { 
        type: 'controller', 
        endpoint: 'music_service/rtlsdr_radio', 
        method: 'saveStationSettings' 
      },
      saveButton: {
        label: 'Apply Changes',
        data: dabDataArray
      },
      content: [
        {
          id: 'dab_stations_enable',
          element: 'switch',
          label: 'Enable DAB Station Customization',
          value: self.config.get('dab_management_enabled', false),
          doc: 'Show DAB station management options below'
        }
      ]
    };
    
    // Page navigation info
    dabSection.content.push({
      id: 'dab_page_info',
      element: 'info',
      label: 'DAB Stations',
      description: 'Page ' + dabPage + ' of ' + totalDabPages + ' - Showing services ' + (startIdx + 1) + '-' + endIdx + ' of ' + dabStations.length + ' total',
      visibleIf: {
        field: 'dab_stations_enable',
        value: true
      }
    });
    
    // Page navigation buttons
    if (totalDabPages > 1) {
      // Previous button
      if (dabPage > 1) {
        dabSection.content.push({
          id: 'dab_prev_page',
          element: 'button',
          label: 'Previous Page',
          onClick: {
            type: 'emit',
            message: 'callMethod',
            data: {
              endpoint: 'music_service/rtlsdr_radio',
              method: 'changeDabPage',
              data: { page: dabPage - 1 }
            }
          },
          visibleIf: {
            field: 'dab_stations_enable',
            value: true
          }
        });
      }
      
      // Next button
      if (dabPage < totalDabPages) {
        dabSection.content.push({
          id: 'dab_next_page',
          element: 'button',
          label: 'Next Page',
          onClick: {
            type: 'emit',
            message: 'callMethod',
            data: {
              endpoint: 'music_service/rtlsdr_radio',
              method: 'changeDabPage',
              data: { page: dabPage + 1 }
            }
          },
          visibleIf: {
            field: 'dab_stations_enable',
            value: true
          }
        });
      }
      
      dabSection.content.push({
        id: 'dab_nav_separator',
        element: 'hr',
        visibleIf: {
          field: 'dab_stations_enable',
          value: true
        }
      });
    }
    
    // Add stations for current page
    pageStations.forEach(function(station, index) {
      var displayName = station.customName || station.name;
      var globalIndex = startIdx + index;
      
      dabSection.content.push({
        id: 'dab_station_' + globalIndex + '_header',
        element: 'section',
        label: displayName,
        description: station.ensemble + ' - Channel ' + station.channel + ' (' + station.bitrate + ' kbps)',
        visibleIf: {
          field: 'dab_stations_enable',
          value: true
        }
      });
      
      dabSection.content.push({
        id: 'dab_station_' + globalIndex + '_customname',
        type: 'text',
        element: 'input',
        label: 'Custom Name',
        value: station.customName || '',
        placeholder: 'Leave empty for default',
        doc: 'Set a custom name for this service',
        visibleIf: {
          field: 'dab_stations_enable',
          value: true
        }
      });
      
      dabSection.content.push({
        id: 'dab_station_' + globalIndex + '_favorite',
        type: 'boolean',
        element: 'switch',
        label: 'Favorite',
        value: station.favorite || false,
        doc: 'Mark as favorite for quick access',
        visibleIf: {
          field: 'dab_stations_enable',
          value: true
        }
      });
      
      dabSection.content.push({
        id: 'dab_station_' + globalIndex + '_hidden',
        type: 'boolean',
        element: 'switch',
        label: 'Hidden',
        value: station.hidden || false,
        doc: 'Hide from station lists',
        visibleIf: {
          field: 'dab_stations_enable',
          value: true
        }
      });
      
      dabSection.content.push({
        id: 'dab_station_' + globalIndex + '_delete',
        element: 'button',
        label: 'Delete Service',
        onClick: {
          type: 'emit',
          message: 'callMethod',
          data: {
            endpoint: 'music_service/rtlsdr_radio',
            method: 'deleteStation',
            data: { uri: 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName) }
          }
        },
        visibleIf: {
          field: 'dab_stations_enable',
          value: true
        }
      });
      
      if (index < pageStations.length - 1) {
        dabSection.content.push({
          id: 'dab_station_' + globalIndex + '_separator',
          element: 'hr',
          visibleIf: {
            field: 'dab_stations_enable',
            value: true
          }
        });
      }
    });
    
    uiconf.sections.push(dabSection);
  }
  // Add Deleted Stations section (unchanged)
  var deletedFm = self.stationsDb.fm ? self.stationsDb.fm.filter(function(s) { return s.deleted; }) : [];
  var deletedDab = self.stationsDb.dab ? self.stationsDb.dab.filter(function(s) { return s.deleted; }) : [];
  
  if (deletedFm.length > 0 || deletedDab.length > 0) {
    var deletedSection = {
      id: 'deleted_stations',
      element: 'section',
      label: 'Deleted Stations (' + (deletedFm.length + deletedDab.length) + ')',
      icon: 'fa-trash',
      content: []
    };
    
    deletedSection.content.push({
      id: 'purge_all_deleted',
      element: 'button',
      label: 'Purge All Deleted Stations (Permanent)',
      onClick: {
        type: 'emit',
        message: 'callMethod',
        data: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'purgeDeletedStations',
          data: {}
        }
      },
      description: 'Permanently remove all deleted stations from database'
    });
    
    deletedSection.content.push({
      id: 'deleted_separator',
      element: 'hr'
    });
    
    deletedFm.forEach(function(station, index) {
      var displayName = station.customName || station.name;
      var status = station.availableAgain ? ' (Available again in scan)' : '';
      
      deletedSection.content.push({
        id: 'deleted_fm_' + index,
        element: 'section',
        label: 'FM: ' + displayName + status,
        description: station.frequency + ' MHz'
      });
      
      deletedSection.content.push({
        id: 'deleted_fm_' + index + '_restore',
        element: 'button',
        label: 'Restore Station',
        onClick: {
          type: 'emit',
          message: 'callMethod',
          data: {
            endpoint: 'music_service/rtlsdr_radio',
            method: 'restoreStation',
            data: { uri: 'rtlsdr://fm/' + station.frequency }
          }
        }
      });
      
      deletedSection.content.push({
        id: 'deleted_fm_' + index + '_purge',
        element: 'button',
        label: 'Purge (Permanent)',
        onClick: {
          type: 'emit',
          message: 'callMethod',
          data: {
            endpoint: 'music_service/rtlsdr_radio',
            method: 'purgeStation',
            data: { uri: 'rtlsdr://fm/' + station.frequency }
          }
        }
      });
    });
    
    deletedDab.forEach(function(station, index) {
      var displayName = station.customName || station.name;
      var status = station.availableAgain ? ' (Available again in scan)' : '';
      
      deletedSection.content.push({
        id: 'deleted_dab_' + index,
        element: 'section',
        label: 'DAB: ' + displayName + status,
        description: station.ensemble + ' - Channel ' + station.channel
      });
      
      deletedSection.content.push({
        id: 'deleted_dab_' + index + '_restore',
        element: 'button',
        label: 'Restore Service',
        onClick: {
          type: 'emit',
          message: 'callMethod',
          data: {
            endpoint: 'music_service/rtlsdr_radio',
            method: 'restoreStation',
            data: { uri: 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName) }
          }
        }
      });
      
      deletedSection.content.push({
        id: 'deleted_dab_' + index + '_purge',
        element: 'button',
        label: 'Purge (Permanent)',
        onClick: {
          type: 'emit',
          message: 'callMethod',
          data: {
            endpoint: 'music_service/rtlsdr_radio',
            method: 'purgeStation',
            data: { uri: 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName) }
          }
        }
      });
    });
    
    uiconf.sections.push(deletedSection);
  }
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

ControllerRtlsdrRadio.prototype.saveStationSettings = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  try {
    var updated = 0;
    
    // Save enable toggles
    if (data.fm_stations_enable !== undefined) {
      self.config.set('fm_management_enabled', data.fm_stations_enable);
    }
    if (data.dab_stations_enable !== undefined) {
      self.config.set('dab_management_enabled', data.dab_stations_enable);
    }
    
    // Process ALL FM stations
    if (self.stationsDb.fm) {
      var fmStations = self.stationsDb.fm.filter(function(s) { return !s.deleted; });
      
      for (var i = 0; i < fmStations.length; i++) {
        var station = fmStations[i];
        var prefix = 'fm_station_' + i + '_';
        var customName = data[prefix + 'customname'];
        var favorite = data[prefix + 'favorite'];
        var hidden = data[prefix + 'hidden'];
        
        var changed = false;
        
        // Update custom name
        if (customName !== undefined) {
          var newName = customName.trim() === '' ? null : customName.trim();
          if (station.customName !== newName) {
            station.customName = newName;
            changed = true;
          }
        }
        
        // Update favorite
        if (favorite !== undefined && station.favorite !== favorite) {
          station.favorite = favorite;
          changed = true;
        }
        
        // Update hidden
        if (hidden !== undefined && station.hidden !== hidden) {
          station.hidden = hidden;
          changed = true;
        }
        
        if (changed) {
          updated++;
        }
      }
    }
    
    // Process ALL DAB stations (use actual indices from data keys)
    if (self.stationsDb.dab) {
      var dabStations = self.stationsDb.dab.filter(function(s) { return !s.deleted; });
      
      // Use actual array index to match UI field IDs
      for (var i = 0; i < dabStations.length; i++) {
        var station = dabStations[i];
        var prefix = 'dab_station_' + i + '_';
        var customName = data[prefix + 'customname'];
        var favorite = data[prefix + 'favorite'];
        var hidden = data[prefix + 'hidden'];
        
        var changed = false;
        
        // Update custom name
        if (customName !== undefined) {
          var newName = customName.trim() === '' ? null : customName.trim();
          if (station.customName !== newName) {
            station.customName = newName;
            changed = true;
          }
        }
        
        // Update favorite
        if (favorite !== undefined && station.favorite !== favorite) {
          station.favorite = favorite;
          changed = true;
        }
        
        // Update hidden
        if (hidden !== undefined && station.hidden !== hidden) {
          station.hidden = hidden;
          changed = true;
        }
        
        if (changed) {
          updated++;
        }
      }
    }
    
    // Save database
    self.saveStations();
    
    self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 
      'Updated ' + updated + ' station(s)');
    
    defer.resolve();
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to save station settings: ' + e);
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to save settings');
    defer.reject(e);
  }
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.changeFmPage = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var newPage = data.page || 1;
  self.config.set('fm_management_page', newPage);
  
  // Auto-enable toggle when user navigates (they clearly want to see stations!)
  self.config.set('fm_management_enabled', true);
  
  self.commandRouter.pushToastMessage('info', 'FM/DAB Radio', 
    'Showing FM stations page ' + newPage);
  
  // Reload settings page to show new page
  self.commandRouter.reloadUi();
  
  defer.resolve();
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.changeDabPage = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var newPage = data.page || 1;
  self.config.set('dab_management_page', newPage);
  
  // Auto-enable toggle when user navigates (they clearly want to see stations!)
  self.config.set('dab_management_enabled', true);
  
  self.commandRouter.pushToastMessage('info', 'FM/DAB Radio', 
    'Showing DAB stations page ' + newPage);
  
  // Reload settings page to show new page
  self.commandRouter.reloadUi();
  
  defer.resolve();
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
  
  // Handle rescan triggers (legacy compatibility)
  if (curUri === 'rtlsdr://rescan') {
    self.scanFm()
      .then(function() {
        return self.handleBrowseUri('rtlsdr');
      })
      .then(function(response) {
        defer.resolve(response);
      })
      .fail(function(e) {
        if (!self.intentionalStop) {
          self.logger.error('[RTL-SDR Radio] Rescan failed: ' + e);
          defer.reject(e);
        } else {
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
  
  if (curUri === 'rtlsdr://rescan-dab') {
    self.scanDab()
      .then(function() {
        return self.handleBrowseUri('rtlsdr');
      })
      .then(function(response) {
        defer.resolve(response);
      })
      .fail(function(e) {
        if (!self.intentionalStop) {
          self.logger.error('[RTL-SDR Radio] DAB rescan failed: ' + e);
          defer.reject(e);
        } else {
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
  
  // Route to appropriate view
  if (curUri === 'rtlsdr' || curUri === 'rtlsdr://') {
    defer.resolve(self.showMainOrganizedView());
  } else if (curUri === 'rtlsdr://favorites') {
    defer.resolve(self.showFavoritesView());
  } else if (curUri === 'rtlsdr://recent') {
    defer.resolve(self.showRecentView());
  } else if (curUri === 'rtlsdr://fm') {
    defer.resolve(self.showFmView());
  } else if (curUri === 'rtlsdr://dab') {
    defer.resolve(self.showDabByEnsembleView());
  } else if (curUri.indexOf('rtlsdr://dab/ensemble/') === 0) {
    var ensembleName = decodeURIComponent(curUri.replace('rtlsdr://dab/ensemble/', ''));
    defer.resolve(self.showDabEnsembleStations(ensembleName));
  } else if (curUri === 'rtlsdr://dab?view=flat') {
    defer.resolve(self.showDabFlatView());
  } else if (curUri === 'rtlsdr://deleted') {
    defer.resolve(self.showDeletedView());
  } else if (curUri === 'rtlsdr://deleted/fm') {
    defer.resolve(self.showDeletedFmView());
  } else if (curUri === 'rtlsdr://deleted/dab') {
    defer.resolve(self.showDeletedDabView());
  } else if (curUri === 'rtlsdr://hidden') {
    defer.resolve(self.showHiddenView());
  } else if (curUri === 'rtlsdr://manage/fm') {
    defer.resolve(self.showFmManagement());
  } else if (curUri === 'rtlsdr://manage/dab') {
    defer.resolve(self.showDabManagement());
  } else if (curUri.indexOf('rtlsdr://manage-station/') === 0) {
    // Extract URI from manage-station URL
    var stationUri = decodeURIComponent(curUri.replace('rtlsdr://manage-station/', ''));
    self.showStationManagementModal(stationUri);
    // Return previous browse view
    defer.resolve(self.showMainOrganizedView());
  } else {
    // Unknown URI
    self.logger.warn('[RTL-SDR Radio] Unknown URI: ' + curUri);
    defer.resolve(self.showMainOrganizedView());
  }
  
  return defer.promise;
};

// ========== HIERARCHICAL BROWSE VIEW FUNCTIONS ==========

ControllerRtlsdrRadio.prototype.showMainOrganizedView = function() {
  var self = this;
  
  var favorites = self.getFavoriteStations();
  var recent = self.getRecentStations();
  
  // Count visible stations
  var fmCount = 0;
  var dabCount = 0;
  var deletedCount = 0;
  var hiddenCount = 0;
  
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (station.deleted) {
        deletedCount++;
      } else if (station.hidden) {
        hiddenCount++;
      } else {
        fmCount++;
      }
    });
  }
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (station.deleted) {
        deletedCount++;
      } else if (station.hidden) {
        hiddenCount++;
      } else {
        dabCount++;
      }
    });
  }
  
  var lists = [];
  
  // Quick Access section
  var quickAccessItems = [];
  
  if (favorites.length > 0) {
    quickAccessItems.push({
      service: 'rtlsdr_radio',
      type: 'folder',
      title: 'Favorites',
      artist: favorites.length + ' station' + (favorites.length !== 1 ? 's' : ''),
      album: '',
      icon: 'fa fa-star',
      uri: 'rtlsdr://favorites'
    });
  }
  
  if (recent.length > 0) {
    quickAccessItems.push({
      service: 'rtlsdr_radio',
      type: 'folder',
      title: 'Recently Played',
      artist: recent.length + ' station' + (recent.length !== 1 ? 's' : ''),
      album: '',
      icon: 'fa fa-history',
      uri: 'rtlsdr://recent'
    });
  }
  
  if (quickAccessItems.length > 0) {
    lists.push({
      title: 'Quick Access',
      icon: 'fa fa-bolt',
      availableListViews: ['list', 'grid'],
      items: quickAccessItems
    });
  }
  
  // Radio Sources section
  var radioSourcesItems = [];
  
  radioSourcesItems.push({
    service: 'rtlsdr_radio',
    type: 'folder',
    title: 'FM Radio',
    artist: fmCount + ' station' + (fmCount !== 1 ? 's' : ''),
    album: '',
    icon: 'fa fa-signal',
    uri: 'rtlsdr://fm'
  });
  
  radioSourcesItems.push({
    service: 'rtlsdr_radio',
    type: 'folder',
    title: 'DAB Radio',
    artist: dabCount + ' service' + (dabCount !== 1 ? 's' : ''),
    album: '',
    icon: 'fa fa-rss',
    uri: 'rtlsdr://dab'
  });
  
  lists.push({
    title: 'Radio Sources',
    icon: 'fa fa-radio',
    availableListViews: ['list'],
    items: radioSourcesItems
  });
  
  // Management section
  if (deletedCount > 0 || hiddenCount > 0) {
    var managementItems = [];
    
    if (deletedCount > 0) {
      managementItems.push({
        service: 'rtlsdr_radio',
        type: 'folder',
        title: 'Deleted Stations',
        artist: deletedCount + ' station' + (deletedCount !== 1 ? 's' : ''),
        album: '',
        icon: 'fa fa-trash',
        uri: 'rtlsdr://deleted'
      });
    }
    
    if (hiddenCount > 0) {
      managementItems.push({
        service: 'rtlsdr_radio',
        type: 'folder',
        title: 'Hidden Stations',
        artist: hiddenCount + ' station' + (hiddenCount !== 1 ? 's' : ''),
        album: '',
        icon: 'fa fa-eye-slash',
        uri: 'rtlsdr://hidden'
      });
    }
    
    lists.push({
      title: 'Management',
      icon: 'fa fa-cog',
      availableListViews: ['list'],
      items: managementItems
    });
  }
  
  return {
    navigation: {
      lists: lists
    }
  };
};

// ========== CONTEXT MENU HELPER ==========

ControllerRtlsdrRadio.prototype.getStationContextMenu = function(uri, stationType, isDeleted, isHidden) {
  var self = this;
  var menu = [];
  
  if (isDeleted) {
    // Deleted stations: Restore or Purge
    menu.push({
      name: 'Restore Station',
      method: 'callMethod',
      data: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'restoreStation',
        data: { uri: uri }
      }
    });
    menu.push({
      name: 'Purge Station Permanently',
      method: 'callMethod',
      data: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'purgeStation',
        data: { uri: uri }
      }
    });
  } else {
    // Regular stations: Full management menu
    menu.push({
      name: 'Toggle Favorite',
      method: 'callMethod',
      data: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'toggleFavorite',
        data: { uri: uri }
      }
    });
    menu.push({
      name: 'Rename Station',
      method: 'callMethod',
      data: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'showRenameModal',
        data: { uri: uri }
      }
    });
    
    if (isHidden) {
      menu.push({
        name: 'Unhide Station',
        method: 'callMethod',
        data: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'unhideStation',
          data: { uri: uri }
        }
      });
    } else {
      menu.push({
        name: 'Hide Station',
        method: 'callMethod',
        data: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'hideStation',
          data: { uri: uri }
        }
      });
    }
    
    menu.push({
      name: 'Delete Station',
      method: 'callMethod',
      data: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'deleteStation',
        data: { uri: uri }
      }
    });
  }
  
  return menu;
};

ControllerRtlsdrRadio.prototype.showFavoritesView = function() {
  var self = this;
  
  var favorites = self.getFavoriteStations();
  var items = [];
  
  favorites.forEach(function(fav) {
    if (fav.type === 'fm') {
      var uri = 'rtlsdr://fm/' + fav.station.frequency;
      items.push({
        service: 'rtlsdr_radio',
        type: 'song',
        title: fav.station.customName || fav.station.name,
        artist: fav.station.frequency + ' MHz',
        album: 'Favorites',
        albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
        icon: 'fa fa-star',
        uri: uri,
        menu: self.getStationContextMenu(uri, 'fm', false, fav.station.hidden || false)
      });
    } else if (fav.type === 'dab') {
      var uri = 'rtlsdr://dab/' + fav.station.channel + '/' + encodeURIComponent(fav.station.exactName);
      items.push({
        service: 'rtlsdr_radio',
        type: 'webradio',
        title: fav.station.customName || fav.station.name,
        artist: fav.station.ensemble,
        album: 'Favorites',
        albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
        icon: 'fa fa-star',
        uri: uri,
        menu: self.getStationContextMenu(uri, 'dab', false, fav.station.hidden || false)
      });
    }
  });
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No favorites yet',
      artist: 'Add stations to favorites from FM or DAB lists',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://' },
      lists: [{
        title: 'Favorites (' + favorites.length + ' stations)',
        icon: 'fa fa-star',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showRecentView = function() {
  var self = this;
  
  var recent = self.getRecentStations();
  var items = [];
  
  recent.forEach(function(rec) {
    if (rec.type === 'fm') {
      var uri = 'rtlsdr://fm/' + rec.station.frequency;
      items.push({
        service: 'rtlsdr_radio',
        type: 'song',
        title: rec.station.customName || rec.station.name,
        artist: rec.station.frequency + ' MHz',
        album: 'Recently Played',
        albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
        uri: uri,
        menu: self.getStationContextMenu(uri, 'fm', false, rec.station.hidden || false)
      });
    } else if (rec.type === 'dab') {
      var uri = 'rtlsdr://dab/' + rec.station.channel + '/' + encodeURIComponent(rec.station.exactName);
      items.push({
        service: 'rtlsdr_radio',
        type: 'webradio',
        title: rec.station.customName || rec.station.name,
        artist: rec.station.ensemble,
        album: 'Recently Played',
        albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
        uri: uri,
        menu: self.getStationContextMenu(uri, 'dab', false, rec.station.hidden || false)
      });
    }
  });
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No recently played stations',
      artist: 'Play some stations to see them here',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://' },
      lists: [{
        title: 'Recently Played',
        icon: 'fa fa-history',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showFmView = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (!station.deleted) {
        var uri = 'rtlsdr://fm/' + station.frequency;
        items.push({
          service: 'rtlsdr_radio',
          type: 'song',
          title: station.customName || station.name,
          artist: station.frequency + ' MHz',
          album: 'FM Radio',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
          icon: station.favorite ? 'fa fa-star' : (station.hidden ? 'fa fa-eye-slash' : ''),
          uri: uri,
          menu: self.getStationContextMenu(uri, 'fm', false, station.hidden || false)
        });
      }
    });
  }
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No FM stations found',
      artist: 'Click Rescan to search for stations',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  // Add management button
  items.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Manage FM Stations',
    artist: 'Hide, rename, or delete stations',
    album: '',
    icon: 'fa fa-cog',
    uri: 'rtlsdr://manage/fm'
  });
  
  // Add rescan button
  items.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Rescan FM Stations',
    artist: 'Scan for FM stations (takes ~10 seconds)',
    album: '',
    icon: 'fa fa-refresh',
    uri: 'rtlsdr://rescan'
  });
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://' },
      lists: [{
        title: 'FM Radio (' + (items.length - 1) + ' stations)',
        icon: 'fa fa-signal',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDabByEnsembleView = function() {
  var self = this;
  
  var ensembles = self.getStationsByEnsemble();
  var items = [];
  
  // Create folder for each ensemble
  ensembles.forEach(function(ensemble) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'folder',
      title: ensemble.name,
      artist: ensemble.stations.length + ' service' + (ensemble.stations.length !== 1 ? 's' : '') + 
              ' on Ch ' + ensemble.channel,
      album: 'DAB Ensembles',
      icon: 'fa fa-list',
      uri: 'rtlsdr://dab/ensemble/' + encodeURIComponent(ensemble.name)
    });
  });
  
  if (items.length > 0) {
    // Add flat view option
    items.push({
      service: 'rtlsdr_radio',
      type: 'folder',
      title: 'All DAB Stations (Flat List)',
      artist: self.stationsDb.dab.filter(function(s) { return !s.deleted && !s.hidden; }).length + ' services',
      album: '',
      icon: 'fa fa-th-list',
      uri: 'rtlsdr://dab?view=flat'
    });
  } else {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No DAB stations found',
      artist: 'Click Rescan to search for stations',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  // Add management button
  items.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Manage DAB Stations',
    artist: 'Hide, rename, or delete services',
    album: '',
    icon: 'fa fa-cog',
    uri: 'rtlsdr://manage/dab'
  });
  
  // Add rescan button
  items.push({
    service: 'rtlsdr_radio',
      type: 'streaming-category',
    title: 'Rescan DAB Stations',
    artist: 'Scan for DAB stations (takes 30-60 seconds)',
    album: '',
    icon: 'fa fa-refresh',
    uri: 'rtlsdr://rescan-dab'
  });
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://' },
      lists: [{
        title: 'DAB Radio',
        icon: 'fa fa-rss',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDabEnsembleStations = function(ensembleName) {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (!station.deleted && station.ensemble === ensembleName) {
        var uri = 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName);
        items.push({
          service: 'rtlsdr_radio',
          type: 'webradio',
          title: station.customName || station.name,
          artist: station.ensemble,
          album: 'Channel ' + station.channel,
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
          icon: station.favorite ? 'fa fa-star' : (station.hidden ? 'fa fa-eye-slash' : ''),
          uri: uri,
          menu: self.getStationContextMenu(uri, 'dab', false, station.hidden || false)
        });
      }
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://dab' },
      lists: [{
        title: ensembleName + ' (' + items.length + ' services)',
        icon: 'fa fa-list',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDabFlatView = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (!station.deleted) {
        var uri = 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName);
        items.push({
          service: 'rtlsdr_radio',
          type: 'webradio',
          title: station.customName || station.name,
          artist: station.ensemble,
          album: 'Channel ' + station.channel,
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
          icon: station.favorite ? 'fa fa-star' : (station.hidden ? 'fa fa-eye-slash' : ''),
          uri: uri,
          menu: self.getStationContextMenu(uri, 'dab', false, station.hidden || false)
        });
      }
    });
  }
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No DAB stations found',
      artist: 'Click Rescan to search for stations',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  // Add management button
  items.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Manage DAB Stations',
    artist: 'Hide, rename, or delete services',
    album: '',
    icon: 'fa fa-cog',
    uri: 'rtlsdr://manage/dab'
  });
  
  // Add rescan button
  items.push({
    service: 'rtlsdr_radio',
    type: 'streaming-category',
    title: 'Rescan DAB Stations',
    artist: 'Scan for DAB stations (takes 30-60 seconds)',
    album: '',
    icon: 'fa fa-refresh',
    uri: 'rtlsdr://rescan-dab'
  });
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://dab' },
      lists: [{
        title: 'All DAB Stations',
        icon: 'fa fa-th-list',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDeletedView = function() {
  var self = this;
  
  var fmDeleted = 0;
  var dabDeleted = 0;
  
  if (self.stationsDb.fm) {
    fmDeleted = self.stationsDb.fm.filter(function(s) { return s.deleted; }).length;
  }
  
  if (self.stationsDb.dab) {
    dabDeleted = self.stationsDb.dab.filter(function(s) { return s.deleted; }).length;
  }
  
  var items = [];
  
  if (fmDeleted > 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'folder',
      title: 'FM Deleted',
      artist: fmDeleted + ' station' + (fmDeleted !== 1 ? 's' : ''),
      album: '',
      icon: 'fa fa-signal',
      uri: 'rtlsdr://deleted/fm'
    });
  }
  
  if (dabDeleted > 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'folder',
      title: 'DAB Deleted',
      artist: dabDeleted + ' service' + (dabDeleted !== 1 ? 's' : ''),
      album: '',
      icon: 'fa fa-rss',
      uri: 'rtlsdr://deleted/dab'
    });
  }
  
  if (items.length > 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'Purge All Deleted (Permanent)',
      artist: 'Remove all deleted stations from database',
      album: '',
      icon: 'fa fa-trash-o',
      uri: 'rtlsdr://purge-all-deleted'
    });
  } else {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No deleted stations',
      artist: '',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://' },
      lists: [{
        title: 'Deleted Stations (' + (fmDeleted + dabDeleted) + ' total)',
        icon: 'fa fa-trash',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDeletedFmView = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (station.deleted) {
        var artist = 'Deleted';
        if (station.availableAgain) {
          artist = 'Deleted - Available again in scan';
        }
        
        var uri = 'rtlsdr://fm/' + station.frequency;
        items.push({
          service: 'rtlsdr_radio',
          type: 'song',
          title: station.customName || station.name,
          artist: artist,
          album: 'FM Deleted',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
          icon: 'fa fa-undo',
          uri: uri,
          menu: self.getStationContextMenu(uri, 'fm', true, false)
        });
      }
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://deleted' },
      lists: [{
        title: 'FM Deleted Stations (' + items.length + ')',
        icon: 'fa fa-signal',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDeletedDabView = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (station.deleted) {
        var artist = 'Deleted';
        if (station.availableAgain) {
          artist = 'Deleted - Available again in scan';
        }
        
        var uri = 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName);
        items.push({
          service: 'rtlsdr_radio',
          type: 'webradio',
          title: station.customName || station.name,
          artist: artist,
          album: 'DAB Deleted',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
          icon: 'fa fa-undo',
          uri: uri,
          menu: self.getStationContextMenu(uri, 'dab', true, false)
        });
      }
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://deleted' },
      lists: [{
        title: 'DAB Deleted Stations (' + items.length + ')',
        icon: 'fa fa-rss',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showHiddenView = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (station.hidden && !station.deleted) {
        var uri = 'rtlsdr://fm/' + station.frequency;
        items.push({
          service: 'rtlsdr_radio',
          type: 'song',
          title: station.customName || station.name,
          artist: station.frequency + ' MHz',
          album: 'FM Hidden',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
          icon: 'fa fa-eye-slash',
          uri: uri,
          menu: self.getStationContextMenu(uri, 'fm', false, true)
        });
      }
    });
  }
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (station.hidden && !station.deleted) {
        var uri = 'rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName);
        items.push({
          service: 'rtlsdr_radio',
          type: 'webradio',
          title: station.customName || station.name,
          artist: station.ensemble,
          album: 'DAB Hidden',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
          icon: 'fa fa-eye-slash',
          uri: uri,
          menu: self.getStationContextMenu(uri, 'dab', false, true)
        });
      }
    });
  }
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No hidden stations',
      artist: '',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://' },
      lists: [{
        title: 'Hidden Stations (' + items.length + ')',
        icon: 'fa fa-eye-slash',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
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
  
  // Check if station is deleted
  var station = self.stationsDb.fm ? self.stationsDb.fm.find(function(s) {
    return s.frequency === frequency;
  }) : null;
  
  if (station && station.deleted) {
    self.logger.error('[RTL-SDR Radio] Cannot play deleted station: ' + frequency);
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 
      'Cannot play deleted station. Restore it first from Settings.');
    defer.reject(new Error('Station is deleted'));
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
  
  // Update play statistics
  var uri = 'rtlsdr://fm/' + freq;
  var stationInfo = self.getStationByUri(uri);
  if (stationInfo) {
    stationInfo.station.playCount = (stationInfo.station.playCount || 0) + 1;
    stationInfo.station.lastPlayed = new Date().toISOString();
    self.saveStations();
  }
  
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
      var data = fs.readJsonSync(stationsFile);
      var version = self.getDatabaseVersion(data);
      
      self.logger.info('[RTL-SDR Radio] Database version: ' + version);
      
      if (version < 2) {
        // Migration needed from v1 to v2
        self.logger.info('[RTL-SDR Radio] Migrating database from v' + version + ' to v2');
        self.stationsDb = self.migrateDatabase(data);
        
        if (self.stationsDb) {
          // Save migrated database
          self.saveStations();
          self.commandRouter.pushToastMessage('info', 'FM/DAB Radio', 
            'Database upgraded to v2 (backup saved)');
        } else {
          // Migration failed, create new
          self.logger.error('[RTL-SDR Radio] Migration failed, creating new database');
          self.stationsDb = self.createEmptyDatabaseV2();
        }
      } else if (version === 2) {
        // Validate v2 database
        var validation = self.validateDatabaseV2(data);
        if (validation.valid) {
          self.stationsDb = data;
          self.logger.info('[RTL-SDR Radio] Loaded v2 database successfully');
        } else {
          self.logger.error('[RTL-SDR Radio] Database validation failed: ' + 
            validation.errors.join(', '));
          // Try to load backup or create new
          var backupFile = stationsFile + '.backup';
          if (fs.existsSync(backupFile)) {
            self.logger.info('[RTL-SDR Radio] Loading from backup');
            self.stationsDb = fs.readJsonSync(backupFile);
          } else {
            self.logger.info('[RTL-SDR Radio] Creating new database');
            self.stationsDb = self.createEmptyDatabaseV2();
          }
        }
      } else {
        // Unsupported version
        self.logger.error('[RTL-SDR Radio] Unsupported database version: ' + version);
        self.stationsDb = self.createEmptyDatabaseV2();
      }
    } else {
      // No database file, create new v2
      self.logger.info('[RTL-SDR Radio] No stations database found, creating v2');
      self.stationsDb = self.createEmptyDatabaseV2();
    }
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Error loading stations: ' + e);
    self.stationsDb = self.createEmptyDatabaseV2();
  }
  
  return libQ.resolve();
};

ControllerRtlsdrRadio.prototype.saveStations = function() {
  var self = this;
  var stationsFile = '/data/plugins/music_service/rtlsdr_radio/stations.json';
  
  try {
    // Validate before saving
    if (self.stationsDb.version === 2) {
      var validation = self.validateDatabaseV2(self.stationsDb);
      if (!validation.valid) {
        self.logger.error('[RTL-SDR Radio] Cannot save invalid database: ' + 
          validation.errors.join(', '));
        return;
      }
    }
    
    fs.writeJsonSync(stationsFile, self.stationsDb);
    self.logger.info('[RTL-SDR Radio] Saved stations database');
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to save stations: ' + e);
  }
};

// ========== DATABASE V2 FUNCTIONS ==========

ControllerRtlsdrRadio.prototype.getDatabaseVersion = function(db) {
  var self = this;
  
  if (!db || typeof db !== 'object') {
    return 1;
  }
  
  // Check for version field
  if (db.version && typeof db.version === 'number') {
    return db.version;
  }
  
  // Check for v2 structure (groups and settings objects)
  if (db.groups && db.settings) {
    return 2;
  }
  
  // Default to v1
  return 1;
};

ControllerRtlsdrRadio.prototype.createEmptyDatabaseV2 = function() {
  var self = this;
  
  return {
    version: 2,
    fm: [],
    dab: [],
    groups: self.createBuiltinGroups(),
    settings: self.createDefaultSettings()
  };
};

ControllerRtlsdrRadio.prototype.createBuiltinGroups = function() {
  var self = this;
  
  return {
    favorites: {
      id: 'favorites',
      name: 'Favorites',
      icon: 'fa fa-star',
      order: 0,
      builtin: true,
      type: 'both',
      description: 'Your favorite stations'
    },
    recent: {
      id: 'recent',
      name: 'Recently Played',
      icon: 'fa fa-history',
      order: 1,
      builtin: true,
      type: 'both',
      description: 'Last 10 played stations'
    },
    all_fm: {
      id: 'all_fm',
      name: 'All FM Stations',
      icon: 'fa fa-signal',
      order: 100,
      builtin: true,
      type: 'fm',
      description: 'All scanned FM stations'
    },
    all_dab: {
      id: 'all_dab',
      name: 'All DAB Stations',
      icon: 'fa fa-rss',
      order: 101,
      builtin: true,
      type: 'dab',
      description: 'All scanned DAB stations'
    }
  };
};

ControllerRtlsdrRadio.prototype.createDefaultSettings = function() {
  var self = this;
  
  return {
    showHidden: false,
    defaultView: 'grouped',
    sortStations: 'frequency',
    recentlyPlayedCount: 10,
    autoHideWeakSignals: false,
    signalThreshold: -40
  };
};

ControllerRtlsdrRadio.prototype.transformStationToV2 = function(station, type) {
  var self = this;
  var now = new Date().toISOString();
  
  // Base v2 fields
  var v2Station = {
    customName: null,
    hidden: false,
    favorite: false,
    groups: [],
    notes: '',
    playCount: 0,
    lastPlayed: null,
    dateAdded: station.last_seen || now,
    userCreated: false,
    deleted: false,
    availableAgain: false
  };
  
  // Merge with existing station data
  for (var key in station) {
    if (station.hasOwnProperty(key)) {
      v2Station[key] = station[key];
    }
  }
  
  return v2Station;
};

ControllerRtlsdrRadio.prototype.backupDatabase = function(suffix) {
  var self = this;
  var stationsFile = '/data/plugins/music_service/rtlsdr_radio/stations.json';
  
  try {
    if (!fs.existsSync(stationsFile)) {
      return null;
    }
    
    var timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    var backupFile = stationsFile + '.' + suffix + '.' + timestamp + '.backup';
    
    fs.copySync(stationsFile, backupFile);
    self.logger.info('[RTL-SDR Radio] Created backup: ' + backupFile);
    
    return backupFile;
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to create backup: ' + e);
    return null;
  }
};

ControllerRtlsdrRadio.prototype.migrateDatabase = function(oldDb) {
  var self = this;
  
  self.logger.info('[RTL-SDR Radio] Starting database migration to v2');
  
  try {
    // Create backup before migration
    var backupFile = self.backupDatabase('v1');
    if (backupFile) {
      self.logger.info('[RTL-SDR Radio] Backup created: ' + backupFile);
    }
    
    // Create new v2 structure
    var newDb = self.createEmptyDatabaseV2();
    
    // Migrate FM stations
    if (oldDb.fm && Array.isArray(oldDb.fm)) {
      newDb.fm = oldDb.fm.map(function(station) {
        return self.transformStationToV2(station, 'fm');
      });
      self.logger.info('[RTL-SDR Radio] Migrated ' + newDb.fm.length + ' FM stations');
    }
    
    // Migrate DAB stations
    if (oldDb.dab && Array.isArray(oldDb.dab)) {
      newDb.dab = oldDb.dab.map(function(station) {
        return self.transformStationToV2(station, 'dab');
      });
      self.logger.info('[RTL-SDR Radio] Migrated ' + newDb.dab.length + ' DAB stations');
    }
    
    // Validate migrated database
    var validation = self.validateDatabaseV2(newDb);
    if (!validation.valid) {
      self.logger.error('[RTL-SDR Radio] Migration produced invalid database: ' + 
        validation.errors.join(', '));
      return null;
    }
    
    self.logger.info('[RTL-SDR Radio] Migration completed successfully');
    return newDb;
    
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Migration failed: ' + e);
    return null;
  }
};

ControllerRtlsdrRadio.prototype.validateDatabaseV2 = function(db) {
  var self = this;
  var errors = [];
  
  // Check version
  if (!db.version || db.version !== 2) {
    errors.push('Missing or invalid version field');
  }
  
  // Check fm array
  if (!db.fm || !Array.isArray(db.fm)) {
    errors.push('Missing or invalid fm array');
  }
  
  // Check dab array
  if (!db.dab || !Array.isArray(db.dab)) {
    errors.push('Missing or invalid dab array');
  }
  
  // Check groups object
  if (!db.groups || typeof db.groups !== 'object') {
    errors.push('Missing or invalid groups object');
  } else {
    // Check for required builtin groups
    var requiredGroups = ['favorites', 'recent', 'all_fm', 'all_dab'];
    requiredGroups.forEach(function(groupId) {
      if (!db.groups[groupId]) {
        errors.push('Missing builtin group: ' + groupId);
      }
    });
  }
  
  // Check settings object
  if (!db.settings || typeof db.settings !== 'object') {
    errors.push('Missing or invalid settings object');
  }
  
  // Validate FM stations have required fields
  if (db.fm && Array.isArray(db.fm)) {
    db.fm.forEach(function(station, index) {
      if (!station.frequency) {
        errors.push('FM station ' + index + ' missing frequency');
      }
      if (typeof station.hidden !== 'boolean') {
        errors.push('FM station ' + index + ' missing hidden flag');
      }
      if (typeof station.favorite !== 'boolean') {
        errors.push('FM station ' + index + ' missing favorite flag');
      }
    });
  }
  
  // Validate DAB stations have required fields
  if (db.dab && Array.isArray(db.dab)) {
    db.dab.forEach(function(station, index) {
      if (!station.channel) {
        errors.push('DAB station ' + index + ' missing channel');
      }
      if (!station.serviceId) {
        errors.push('DAB station ' + index + ' missing serviceId');
      }
      if (typeof station.hidden !== 'boolean') {
        errors.push('DAB station ' + index + ' missing hidden flag');
      }
      if (typeof station.favorite !== 'boolean') {
        errors.push('DAB station ' + index + ' missing favorite flag');
      }
    });
  }
  
  return {
    valid: errors.length === 0,
    errors: errors
  };
};

ControllerRtlsdrRadio.prototype.getStationByUri = function(uri) {
  var self = this;
  
  if (!uri || typeof uri !== 'string') {
    return null;
  }
  
  // Parse FM URI: rtlsdr://fm/95.0
  if (uri.indexOf('rtlsdr://fm/') === 0) {
    var frequency = uri.replace('rtlsdr://fm/', '');
    
    for (var i = 0; i < self.stationsDb.fm.length; i++) {
      if (self.stationsDb.fm[i].frequency === frequency) {
        return {
          type: 'fm',
          station: self.stationsDb.fm[i],
          index: i
        };
      }
    }
  }
  
  // Parse DAB URI: rtlsdr://dab/<channel>/<serviceName>
  if (uri.indexOf('rtlsdr://dab/') === 0) {
    var dabParts = uri.replace('rtlsdr://dab/', '').split('/');
    if (dabParts.length >= 2) {
      var channel = dabParts[0];
      var serviceName = decodeURIComponent(dabParts[1]);
      
      for (var i = 0; i < self.stationsDb.dab.length; i++) {
        var station = self.stationsDb.dab[i];
        if (station.channel === channel && station.exactName === serviceName) {
          return {
            type: 'dab',
            station: station,
            index: i
          };
        }
      }
    }
  }
  
  return null;
};

ControllerRtlsdrRadio.prototype.updateStation = function(uri, updates) {
  var self = this;
  var defer = libQ.defer();
  
  try {
    var stationInfo = self.getStationByUri(uri);
    
    if (!stationInfo) {
      self.logger.error('[RTL-SDR Radio] Station not found: ' + uri);
      defer.reject(new Error('Station not found'));
      return defer.promise;
    }
    
    // Apply updates
    for (var key in updates) {
      if (updates.hasOwnProperty(key)) {
        stationInfo.station[key] = updates[key];
      }
    }
    
    // Save database
    self.saveStations();
    
    defer.resolve();
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to update station: ' + e);
    defer.reject(e);
  }
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.getFavoriteStations = function() {
  var self = this;
  var favorites = [];
  
  // Get FM favorites
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (station.favorite && !station.deleted && !station.hidden) {
        favorites.push({
          type: 'fm',
          station: station
        });
      }
    });
  }
  
  // Get DAB favorites
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (station.favorite && !station.deleted && !station.hidden) {
        favorites.push({
          type: 'dab',
          station: station
        });
      }
    });
  }
  
  return favorites;
};

ControllerRtlsdrRadio.prototype.getRecentStations = function(count) {
  var self = this;
  var recent = [];
  count = count || self.stationsDb.settings.recentlyPlayedCount || 10;
  
  // Combine FM and DAB stations
  var allStations = [];
  
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (!station.deleted && !station.hidden && station.lastPlayed) {
        allStations.push({
          type: 'fm',
          station: station,
          lastPlayed: new Date(station.lastPlayed).getTime()
        });
      }
    });
  }
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (!station.deleted && !station.hidden && station.lastPlayed) {
        allStations.push({
          type: 'dab',
          station: station,
          lastPlayed: new Date(station.lastPlayed).getTime()
        });
      }
    });
  }
  
  // Sort by lastPlayed descending
  allStations.sort(function(a, b) {
    return b.lastPlayed - a.lastPlayed;
  });
  
  // Return top N
  return allStations.slice(0, count);
};

ControllerRtlsdrRadio.prototype.getStationsByEnsemble = function() {
  var self = this;
  var ensembles = {};
  
  // Group DAB stations by ensemble
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (station.deleted || station.hidden) {
        return;
      }
      
      var ensembleName = station.ensemble;
      if (!ensembles[ensembleName]) {
        ensembles[ensembleName] = {
          name: ensembleName,
          channel: station.channel,
          stations: []
        };
      }
      ensembles[ensembleName].stations.push(station);
    });
  }
  
  // Convert to sorted array
  var ensembleArray = Object.keys(ensembles).map(function(key) {
    return ensembles[key];
  }).sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
  
  return ensembleArray;
};

ControllerRtlsdrRadio.prototype.toggleFavorite = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  
  self.logger.info('[RTL-SDR Radio] Toggle favorite: ' + uri);
  
  var stationInfo = self.getStationByUri(uri);
  
  if (!stationInfo) {
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Station not found');
    defer.reject(new Error('Station not found'));
    return defer.promise;
  }
  
  // Toggle favorite flag
  var newValue = !stationInfo.station.favorite;
  stationInfo.station.favorite = newValue;
  
  // Save database
  self.saveStations();
  
  var stationName = stationInfo.station.customName || stationInfo.station.name;
  var message = newValue ? 'Added to favorites' : 'Removed from favorites';
  
  self.commandRouter.pushToastMessage('success', stationName, message);
  
  defer.resolve();
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.renameStation = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  var customName = data.customName || null;
  
  self.logger.info('[RTL-SDR Radio] Rename station: ' + uri + ' to ' + customName);
  
  self.updateStation(uri, { customName: customName })
    .then(function() {
      self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 'Station renamed');
      defer.resolve();
    })
    .fail(function(e) {
      self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to rename station');
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.hideStation = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  
  self.logger.info('[RTL-SDR Radio] Toggle hide station: ' + uri);
  
  var stationInfo = self.getStationByUri(uri);
  
  if (!stationInfo) {
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Station not found');
    defer.reject(new Error('Station not found'));
    return defer.promise;
  }
  
  // Toggle hidden flag
  var newValue = !stationInfo.station.hidden;
  stationInfo.station.hidden = newValue;
  
  // Save database
  self.saveStations();
  
  var message = newValue ? 'Station hidden' : 'Station unhidden';
  self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', message);
  
  defer.resolve();
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.unhideStation = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  
  self.logger.info('[RTL-SDR Radio] Unhide station: ' + uri);
  
  self.updateStation(uri, { hidden: false })
    .then(function() {
      self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 'Station unhidden');
      defer.resolve();
    })
    .fail(function(e) {
      self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to unhide station');
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.showRenameModal = function(data) {
  var self = this;
  
  var uri = data.uri;
  var stationInfo = self.getStationByUri(uri);
  
  if (!stationInfo) {
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Station not found');
    return;
  }
  
  var currentName = stationInfo.station.customName || stationInfo.station.name;
  
  var modalData = {
    title: 'Rename Station',
    message: 'Current name: ' + currentName,
    size: 'md',
    buttons: [
      {
        name: 'Cancel',
        class: 'btn btn-warning',
        emit: 'closeModals',
        payload: ''
      },
      {
        name: 'Clear Name',
        class: 'btn btn-default',
        emit: 'callMethod',
        payload: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'renameStation',
          data: {
            uri: uri,
            customName: ''
          }
        }
      },
      {
        name: 'Save',
        class: 'btn btn-info',
        emit: 'callMethod',
        payload: {
          endpoint: 'music_service/rtlsdr_radio',
          method: 'processRename',
          data: {
            uri: uri
          }
        }
      }
    ],
    inputs: [
      {
        id: 'new_name',
        type: 'text',
        placeholder: 'Enter new station name',
        value: stationInfo.station.customName || ''
      }
    ]
  };
  
  self.commandRouter.broadcastMessage('openModal', modalData);
};

ControllerRtlsdrRadio.prototype.processRename = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  var newName = data.new_name || '';
  
  self.logger.info('[RTL-SDR Radio] Process rename: ' + uri + ' to ' + newName);
  
  self.updateStation(uri, { customName: newName.trim() === '' ? null : newName.trim() })
    .then(function() {
      var message = newName.trim() === '' ? 'Station name cleared' : 'Station renamed';
      self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', message);
      defer.resolve();
    })
    .fail(function(e) {
      self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to rename station');
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.deleteStation = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  
  self.logger.info('[RTL-SDR Radio] Delete station: ' + uri);
  
  self.updateStation(uri, { deleted: true, availableAgain: false })
    .then(function() {
      self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 'Station deleted');
      defer.resolve();
    })
    .fail(function(e) {
      self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to delete station');
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.restoreStation = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  
  self.logger.info('[RTL-SDR Radio] Restore station: ' + uri);
  
  self.updateStation(uri, { deleted: false, availableAgain: false })
    .then(function() {
      self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 'Station restored');
      defer.resolve();
    })
    .fail(function(e) {
      self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to restore station');
      defer.reject(e);
    });
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.purgeStation = function(data) {
  var self = this;
  var defer = libQ.defer();
  
  var uri = data.uri;
  
  self.logger.info('[RTL-SDR Radio] Purge station: ' + uri);
  
  try {
    var stationInfo = self.getStationByUri(uri);
    
    if (!stationInfo) {
      self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Station not found');
      defer.reject(new Error('Station not found'));
      return defer.promise;
    }
    
    // Remove from array
    if (stationInfo.type === 'fm') {
      self.stationsDb.fm.splice(stationInfo.index, 1);
    } else if (stationInfo.type === 'dab') {
      self.stationsDb.dab.splice(stationInfo.index, 1);
    }
    
    // Save database
    self.saveStations();
    
    self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 'Station permanently removed');
    defer.resolve();
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to purge station: ' + e);
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to purge station');
    defer.reject(e);
  }
  
  return defer.promise;
};

ControllerRtlsdrRadio.prototype.purgeDeletedStations = function() {
  var self = this;
  var defer = libQ.defer();
  
  self.logger.info('[RTL-SDR Radio] Purge all deleted stations');
  
  try {
    var count = 0;
    
    // Filter out deleted FM stations
    if (self.stationsDb.fm) {
      var originalLength = self.stationsDb.fm.length;
      self.stationsDb.fm = self.stationsDb.fm.filter(function(station) {
        return !station.deleted;
      });
      count += originalLength - self.stationsDb.fm.length;
    }
    
    // Filter out deleted DAB stations
    if (self.stationsDb.dab) {
      var originalLength = self.stationsDb.dab.length;
      self.stationsDb.dab = self.stationsDb.dab.filter(function(station) {
        return !station.deleted;
      });
      count += originalLength - self.stationsDb.dab.length;
    }
    
    // Save database
    self.saveStations();
    
    self.commandRouter.pushToastMessage('success', 'FM/DAB Radio', 
      'Purged ' + count + ' deleted stations');
    defer.resolve();
  } catch (e) {
    self.logger.error('[RTL-SDR Radio] Failed to purge deleted stations: ' + e);
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Failed to purge deleted stations');
    defer.reject(e);
  }
  
  return defer.promise;
};

// ========== RESCAN MERGE LOGIC - Phase 5.5 ==========

ControllerRtlsdrRadio.prototype.mergeFmScanResults = function(newStations) {
  var self = this;
  
  self.logger.info('[RTL-SDR Radio] Merging FM scan results with existing database');
  
  var mergedStations = [];
  var existingMap = {};
  var reappearedCount = 0;
  
  // Create map of existing stations by frequency
  if (self.stationsDb.fm && self.stationsDb.fm.length > 0) {
    self.stationsDb.fm.forEach(function(station) {
      existingMap[station.frequency] = station;
    });
  }
  
  // Process each scanned station
  newStations.forEach(function(newStation) {
    var frequency = newStation.frequency;
    var existingStation = existingMap[frequency];
    
    if (existingStation) {
      // Station exists - merge data
      var mergedStation = self.mergeStationData(existingStation, newStation, 'fm');
      
      // Check if deleted station reappeared
      if (existingStation.deleted && !existingStation.availableAgain) {
        mergedStation.availableAgain = true;
        reappearedCount++;
        self.logger.info('[RTL-SDR Radio] Deleted FM station reappeared: ' + frequency + ' MHz');
      }
      
      mergedStations.push(mergedStation);
      
      // Mark as processed
      delete existingMap[frequency];
    } else {
      // New station - add with default v2 fields
      var newStationV2 = self.transformStationToV2(newStation, 'fm');
      mergedStations.push(newStationV2);
      self.logger.info('[RTL-SDR Radio] New FM station discovered: ' + frequency + ' MHz');
    }
  });
  
  // Add remaining existing stations that weren't in scan
  // (Keep user-deleted stations, manual entries, etc.)
  for (var frequency in existingMap) {
    if (existingMap.hasOwnProperty(frequency)) {
      mergedStations.push(existingMap[frequency]);
      self.logger.info('[RTL-SDR Radio] Keeping existing FM station not in scan: ' + frequency + ' MHz');
    }
  }
  
  // Sort by frequency
  mergedStations.sort(function(a, b) {
    return parseFloat(a.frequency) - parseFloat(b.frequency);
  });
  
  self.logger.info('[RTL-SDR Radio] FM merge complete: ' + newStations.length + ' scanned, ' + 
                  mergedStations.length + ' total, ' + reappearedCount + ' reappeared');
  
  if (reappearedCount > 0) {
    self.commandRouter.pushToastMessage('info', 'FM Radio', 
      reappearedCount + ' deleted station(s) available again');
  }
  
  return mergedStations;
};

ControllerRtlsdrRadio.prototype.mergeDabScanResults = function(newStations) {
  var self = this;
  
  self.logger.info('[RTL-SDR Radio] Merging DAB scan results with existing database');
  
  var mergedStations = [];
  var existingMap = {};
  var reappearedCount = 0;
  
  // Create map of existing stations by channel + serviceId
  if (self.stationsDb.dab && self.stationsDb.dab.length > 0) {
    self.stationsDb.dab.forEach(function(station) {
      var key = station.channel + '|' + station.serviceId;
      existingMap[key] = station;
    });
  }
  
  // Process each scanned station
  newStations.forEach(function(newStation) {
    var key = newStation.channel + '|' + newStation.serviceId;
    var existingStation = existingMap[key];
    
    if (existingStation) {
      // Station exists - merge data
      var mergedStation = self.mergeStationData(existingStation, newStation, 'dab');
      
      // Check if deleted station reappeared
      if (existingStation.deleted && !existingStation.availableAgain) {
        mergedStation.availableAgain = true;
        reappearedCount++;
        self.logger.info('[RTL-SDR Radio] Deleted DAB station reappeared: ' + 
                        newStation.name + ' on ' + newStation.channel);
      }
      
      mergedStations.push(mergedStation);
      
      // Mark as processed
      delete existingMap[key];
    } else {
      // New station - add with default v2 fields
      var newStationV2 = self.transformStationToV2(newStation, 'dab');
      mergedStations.push(newStationV2);
      self.logger.info('[RTL-SDR Radio] New DAB station discovered: ' + 
                      newStation.name + ' on ' + newStation.channel);
    }
  });
  
  // Add remaining existing stations that weren't in scan
  // (Keep user-deleted stations, manual entries, etc.)
  for (var key in existingMap) {
    if (existingMap.hasOwnProperty(key)) {
      var station = existingMap[key];
      mergedStations.push(station);
      self.logger.info('[RTL-SDR Radio] Keeping existing DAB station not in scan: ' + 
                      station.name + ' on ' + station.channel);
    }
  }
  
  // Sort alphabetically by name
  mergedStations.sort(function(a, b) {
    return a.name.localeCompare(b.name);
  });
  
  self.logger.info('[RTL-SDR Radio] DAB merge complete: ' + newStations.length + ' scanned, ' + 
                  mergedStations.length + ' total, ' + reappearedCount + ' reappeared');
  
  if (reappearedCount > 0) {
    self.commandRouter.pushToastMessage('info', 'DAB Radio', 
      reappearedCount + ' deleted service(s) available again');
  }
  
  return mergedStations;
};

ControllerRtlsdrRadio.prototype.mergeStationData = function(existingStation, newStation, type) {
  var self = this;
  
  // Start with existing station (preserves all user data)
  var merged = {};
  for (var key in existingStation) {
    if (existingStation.hasOwnProperty(key)) {
      merged[key] = existingStation[key];
    }
  }
  
  // Update scan-related fields from new station
  if (type === 'fm') {
    // FM: Update name, signal_strength, last_seen
    merged.name = newStation.name;
    merged.signal_strength = newStation.signal_strength;
    merged.last_seen = newStation.last_seen;
    merged.frequency = newStation.frequency; // Ensure frequency stays correct
  } else if (type === 'dab') {
    // DAB: Update name, exactName, ensemble, bitrate, audioType, last_seen
    merged.name = newStation.name;
    merged.exactName = newStation.exactName;
    merged.ensemble = newStation.ensemble;
    merged.channel = newStation.channel;
    merged.serviceId = newStation.serviceId;
    merged.ensembleId = newStation.ensembleId;
    merged.bitrate = newStation.bitrate;
    merged.audioType = newStation.audioType;
    merged.last_seen = newStation.last_seen;
  }
  
  // User fields are preserved from existingStation:
  // - customName
  // - favorite
  // - hidden
  // - deleted
  // - groups
  // - notes
  // - playCount
  // - lastPlayed
  // - dateAdded
  // - userCreated
  // - availableAgain
  
  return merged;
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
            
            // Merge with existing database (preserves user data)
            self.stationsDb.fm = self.mergeFmScanResults(stations);
            self.saveStations();
            
            var totalStations = self.stationsDb.fm.length;
            self.commandRouter.pushToastMessage('success', self.getI18nString('FM_RADIO'), 
              'Scan complete: ' + stations.length + ' found, ' + totalStations + ' total');
            
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
            
            // Merge with existing database (preserves user data)
            self.stationsDb.dab = self.mergeDabScanResults(stations);
            self.saveStations();
            
            var totalStations = self.stationsDb.dab.length;
            self.commandRouter.pushToastMessage('success', self.getI18nString('DAB_RADIO'), 
              'Scan complete: ' + stations.length + ' found, ' + totalStations + ' total');
            
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
  
  // Check if station is deleted
  var station = self.stationsDb.dab ? self.stationsDb.dab.find(function(s) {
    return s.channel === channel && s.exactName === serviceName;
  }) : null;
  
  if (station && station.deleted) {
    self.logger.error('[RTL-SDR Radio] Cannot play deleted station: ' + serviceName);
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 
      'Cannot play deleted station. Restore it first from Settings.');
    defer.reject(new Error('Station is deleted'));
    return defer.promise;
  }
  
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
  
  // Update play statistics
  var uri = 'rtlsdr://dab/' + channel + '/' + encodeURIComponent(serviceName);
  var stationInfo = self.getStationByUri(uri);
  if (stationInfo) {
    stationInfo.station.playCount = (stationInfo.station.playCount || 0) + 1;
    stationInfo.station.lastPlayed = new Date().toISOString();
    self.saveStations();
  }
  
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

// ===== STATION MANAGEMENT BROWSE VIEWS =====

ControllerRtlsdrRadio.prototype.showFmManagement = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.fm) {
    self.stationsDb.fm.forEach(function(station) {
      if (!station.deleted) {
        var uri = 'rtlsdr://manage-station/' + encodeURIComponent('rtlsdr://fm/' + station.frequency);
        var statusText = [];
        if (station.favorite) statusText.push('Favorite');
        if (station.hidden) statusText.push('Hidden');
        
        items.push({
          service: 'rtlsdr_radio',
          type: 'streaming-category',
          title: station.customName || station.name,
          artist: station.frequency + ' MHz' + (statusText.length > 0 ? ' - ' + statusText.join(', ') : ''),
          album: 'Click to manage this station',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/fm.svg',
          icon: station.favorite ? 'fa fa-star' : (station.hidden ? 'fa fa-eye-slash' : 'fa fa-cog'),
          uri: uri
        });
      }
    });
  }
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No FM stations found',
      artist: 'Run a scan first',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://fm' },
      lists: [{
        title: 'Manage FM Stations (' + items.length + ' total)',
        icon: 'fa fa-cog',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showDabManagement = function() {
  var self = this;
  
  var items = [];
  
  if (self.stationsDb.dab) {
    self.stationsDb.dab.forEach(function(station) {
      if (!station.deleted) {
        var uri = 'rtlsdr://manage-station/' + encodeURIComponent('rtlsdr://dab/' + station.channel + '/' + encodeURIComponent(station.exactName));
        var statusText = [];
        if (station.favorite) statusText.push('Favorite');
        if (station.hidden) statusText.push('Hidden');
        
        items.push({
          service: 'rtlsdr_radio',
          type: 'streaming-category',
          title: station.customName || station.name,
          artist: station.ensemble + ' - ' + station.channel + (statusText.length > 0 ? ' - ' + statusText.join(', ') : ''),
          album: 'Click to manage this service',
          albumart: '/albumart?sourceicon=music_service/rtlsdr_radio/assets/dab.svg',
          icon: station.favorite ? 'fa fa-star' : (station.hidden ? 'fa fa-eye-slash' : 'fa fa-cog'),
          uri: uri
        });
      }
    });
  }
  
  if (items.length === 0) {
    items.push({
      service: 'rtlsdr_radio',
      type: 'streaming-category',
      title: 'No DAB stations found',
      artist: 'Run a scan first',
      album: '',
      icon: 'fa fa-info-circle',
      uri: ''
    });
  }
  
  return {
    navigation: {
      prev: { uri: 'rtlsdr://dab' },
      lists: [{
        title: 'Manage DAB Stations (' + items.length + ' total)',
        icon: 'fa fa-cog',
        availableListViews: ['list'],
        items: items
      }]
    }
  };
};

ControllerRtlsdrRadio.prototype.showStationManagementModal = function(stationUri) {
  var self = this;
  
  var stationInfo = self.getStationByUri(stationUri);
  
  if (!stationInfo) {
    self.commandRouter.pushToastMessage('error', 'FM/DAB Radio', 'Station not found');
    return;
  }
  
  var station = stationInfo.station;
  var stationType = stationInfo.type;
  var displayName = station.customName || station.name;
  var statusText = [];
  if (station.favorite) statusText.push('Favorite');
  if (station.hidden) statusText.push('Hidden');
  
  var buttons = [
    {
      name: 'Close',
      class: 'btn btn-default',
      emit: 'closeModals',
      payload: ''
    },
    {
      name: station.favorite ? 'Remove Favorite' : 'Mark Favorite',
      class: station.favorite ? 'btn btn-warning' : 'btn btn-info',
      emit: 'callMethod',
      payload: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'toggleFavorite',
        data: { uri: stationUri }
      }
    },
    {
      name: station.hidden ? 'Unhide' : 'Hide',
      class: station.hidden ? 'btn btn-success' : 'btn btn-warning',
      emit: 'callMethod',
      payload: {
        endpoint: 'music_service/rtlsdr_radio',
        method: station.hidden ? 'unhideStation' : 'hideStation',
        data: { uri: stationUri }
      }
    },
    {
      name: 'Save Name',
      class: 'btn btn-info',
      emit: 'callMethod',
      payload: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'processRename',
        data: { uri: stationUri }
      }
    },
    {
      name: 'Clear Name',
      class: 'btn btn-default',
      emit: 'callMethod',
      payload: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'renameStation',
        data: {
          uri: stationUri,
          customName: ''
        }
      }
    },
    {
      name: 'Delete',
      class: 'btn btn-danger',
      emit: 'callMethod',
      payload: {
        endpoint: 'music_service/rtlsdr_radio',
        method: 'deleteStation',
        data: { uri: stationUri }
      }
    }
  ];
  
  var modalData = {
    title: 'Manage Station',
    message: displayName + (statusText.length > 0 ? '\nStatus: ' + statusText.join(', ') : ''),
    size: 'md',
    buttons: buttons,
    inputs: [
      {
        id: 'new_name',
        type: 'text',
        placeholder: 'Enter custom name (or leave empty)',
        value: station.customName || ''
      }
    ]
  };
  
  self.commandRouter.broadcastMessage('openModal', modalData);
};
