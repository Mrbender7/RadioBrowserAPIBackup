import fetch from 'node-fetch';
import fs from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

const config = JSON.parse(fs.readFileSync(path.join(rootDir, 'config.json'), 'utf8'));
const isDryRun = process.argv.includes('--dry-run');

function log(message, level = 'INFO') {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message}`;
  console.log(logMessage);

  const logDir = path.join(rootDir, config.backup.logsDirectory);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const logFile = path.join(logDir, 'backup.log');
  fs.appendFileSync(logFile, logMessage + '\n');
}

function logError(message, error) {
  const timestamp = new Date().toISOString();
  const errorMessage = `[${timestamp}] [ERROR] ${message}\n${error.stack || error}\n`;
  console.error(errorMessage);

  const logDir = path.join(rootDir, config.backup.logsDirectory);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const errorFile = path.join(logDir, 'errors.log');
  fs.appendFileSync(errorFile, errorMessage + '\n');
}

async function fetchWithRetry(url, retries = config.api.retries) {
  for (let i = 0; i < retries; i++) {
    try {
      log(`Attempting to fetch from ${url} (attempt ${i + 1}/${retries})`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), config.api.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'RadioSphere-Backup/1.0'
        }
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      log(`Successfully fetched ${data.length} stations from ${url}`);
      return data;

    } catch (error) {
      logError(`Fetch attempt ${i + 1} failed for ${url}`, error);

      if (i < retries - 1) {
        const delay = config.api.retryDelay * Math.pow(2, i);
        log(`Waiting ${delay}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
}

async function downloadStations() {
  log('Starting station download process');

  for (const endpoint of config.api.endpoints) {
    try {
      const stations = await fetchWithRetry(endpoint);

      if (!Array.isArray(stations)) {
        throw new Error('Response is not an array');
      }

      if (stations.length < config.filtering.minStationsThreshold) {
        throw new Error(`Insufficient stations: ${stations.length} < ${config.filtering.minStationsThreshold}`);
      }

      log(`Download successful: ${stations.length} stations retrieved`);
      return stations;

    } catch (error) {
      logError(`Failed to download from ${endpoint}`, error);
    }
  }

  throw new Error('All API endpoints failed');
}

function cleanStationName(name) {
  if (!name) return '';
  return name
    .replace(/^\s+|\s+$/g, '')
    .replace(/\t+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.startsWith('http://') || url.startsWith('https://');
}

function filterAndCleanStations(stations) {
  log('Starting station filtering and cleaning process');

  const initialCount = stations.length;
  let filtered = [...stations];

  if (config.filtering.keepOnlyOnlineStations) {
    const before = filtered.length;
    filtered = filtered.filter(s => s.lastcheckok === 1);
    log(`Filtered offline stations: ${before - filtered.length} removed`);
  }

  if (config.filtering.removeInvalidUrls) {
    const before = filtered.length;
    filtered = filtered.filter(s => isValidUrl(s.url));
    log(`Filtered invalid URLs: ${before - filtered.length} removed`);
  }

  if (config.filtering.removeUnknownCodec) {
    const before = filtered.length;
    filtered = filtered.filter(s => s.codec && s.codec.toUpperCase() !== 'UNKNOWN');
    log(`Filtered unknown codecs: ${before - filtered.length} removed`);
  }

  if (config.filtering.removeZeroBitrate) {
    const before = filtered.length;
    filtered = filtered.filter(s => s.bitrate && s.bitrate > 0);
    log(`Filtered zero bitrate: ${before - filtered.length} removed`);
  }

  if (config.filtering.removeDuplicatesByUrl) {
    const before = filtered.length;
    const seenUrls = new Set();
    filtered = filtered.filter(s => {
      const url = s.url_resolved || s.url;
      if (seenUrls.has(url)) return false;
      seenUrls.add(url);
      return true;
    });
    log(`Filtered duplicates: ${before - filtered.length} removed`);
  }

  const cleaned = filtered.map(station => {
    const cleaned = {};

    for (const field of config.output.essentialFields) {
      if (field in station) {
        cleaned[field] = station[field];
      }
    }

    if (config.filtering.cleanStationNames && cleaned.name) {
      cleaned.name = cleanStationName(cleaned.name);
    }

    cleaned.backup_metadata = {
      added_date: new Date().toISOString(),
      source: 'radio-browser-auto'
    };

    cleaned.artwork_status = station.favicon ? 'original' : 'none';

    return cleaned;
  });

  log(`Filtering complete: ${initialCount} -> ${cleaned.length} stations (${((cleaned.length/initialCount)*100).toFixed(2)}% retained)`);

  return cleaned;
}

function mergeManualStations(autoStations) {
  const manualFile = path.join(rootDir, config.backup.dataDirectory, config.backup.manualStationsFile);

  if (!fs.existsSync(manualFile)) {
    log('No manual stations file found, skipping merge');
    return autoStations;
  }

  try {
    const manualStations = JSON.parse(fs.readFileSync(manualFile, 'utf8'));

    if (!Array.isArray(manualStations) || manualStations.length === 0) {
      log('No manual stations to merge');
      return autoStations;
    }

    const manualUuids = new Set(manualStations.map(s => s.stationuuid));
    const filtered = autoStations.filter(s => !manualUuids.has(s.stationuuid));
    const merged = [...manualStations, ...filtered];

    log(`Merged ${manualStations.length} manual stations (${manualUuids.size} replaced duplicates)`);
    return merged;

  } catch (error) {
    logError('Failed to merge manual stations', error);
    return autoStations;
  }
}

function calculateHash(data) {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}

function archiveCurrentVersion() {
  const mainFile = path.join(rootDir, config.backup.dataDirectory, config.backup.mainFile);

  if (!fs.existsSync(mainFile)) {
    log('No existing file to archive');
    return;
  }

  const archiveDir = path.join(rootDir, config.backup.archivesDirectory);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveFile = path.join(archiveDir, `stations-${timestamp}.json`);

  fs.copyFileSync(mainFile, archiveFile);
  log(`Archived current version to ${archiveFile}`);

  const archives = fs.readdirSync(archiveDir)
    .filter(f => f.startsWith('stations-') && f.endsWith('.json'))
    .sort()
    .reverse();

  if (archives.length > config.backup.maxArchives) {
    const toDelete = archives.slice(config.backup.maxArchives);
    toDelete.forEach(f => {
      fs.unlinkSync(path.join(archiveDir, f));
      log(`Deleted old archive: ${f}`);
    });
  }
}

function validateNewData(newStations, oldStations) {
  if (!newStations || !Array.isArray(newStations)) {
    throw new Error('New data is not a valid array');
  }

  if (newStations.length === 0) {
    throw new Error('New data is empty');
  }

  if (oldStations && oldStations.length > 0) {
    const threshold = (config.filtering.safetyThresholdPercent / 100) * oldStations.length;

    if (newStations.length < threshold) {
      throw new Error(
        `Safety check failed: new data has ${newStations.length} stations, ` +
        `which is less than ${config.filtering.safetyThresholdPercent}% of previous ${oldStations.length}`
      );
    }
  }

  log('Data validation passed');
}

function saveStations(stations) {
  const dataDir = path.join(rootDir, config.backup.dataDirectory);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  const mainFile = path.join(dataDir, config.backup.mainFile);
  const metadataFile = path.join(dataDir, config.backup.metadataFile);
  const lightFile = path.join(dataDir, config.backup.lightFile);
  const statsFile = path.join(dataDir, config.backup.statsFile);

  let oldStations = null;
  let oldHash = null;

  if (fs.existsSync(mainFile)) {
    try {
      oldStations = JSON.parse(fs.readFileSync(mainFile, 'utf8'));
      oldHash = calculateHash(oldStations);
    } catch (error) {
      logError('Failed to read existing file', error);
    }
  }

  validateNewData(stations, oldStations);

  const newHash = calculateHash(stations);

  if (oldHash === newHash) {
    log('No changes detected (identical hash), skipping save');
    return { changed: false, stats: null };
  }

  if (!isDryRun) {
    archiveCurrentVersion();
  }

  const jsonOutput = config.output.prettyPrint
    ? JSON.stringify(stations, null, 2)
    : JSON.stringify(stations);

  const lightStations = stations.map(s => ({
    stationuuid: s.stationuuid,
    name: s.name,
    url: s.url
  }));

  const metadata = {
    last_update: new Date().toISOString(),
    total_stations: stations.length,
    previous_total: oldStations ? oldStations.length : 0,
    change_delta: oldStations ? stations.length - oldStations.length : stations.length,
    hash: newHash,
    previous_hash: oldHash
  };

  const stats = {
    total: stations.length,
    last_update: metadata.last_update,
    countries: [...new Set(stations.map(s => s.country).filter(Boolean))].length,
    codecs: [...new Set(stations.map(s => s.codec).filter(Boolean))],
    avg_bitrate: Math.round(
      stations.reduce((sum, s) => sum + (s.bitrate || 0), 0) / stations.length
    )
  };

  if (!isDryRun) {
    fs.writeFileSync(mainFile, jsonOutput);
    fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2));
    fs.writeFileSync(lightFile, JSON.stringify(lightStations));
    fs.writeFileSync(statsFile, JSON.stringify(stats, null, 2));

    log(`Saved ${stations.length} stations to ${config.backup.mainFile}`);
    log(`File size: ${(fs.statSync(mainFile).size / 1024 / 1024).toFixed(2)} MB`);
  } else {
    log('[DRY RUN] Would save files but skipping due to dry-run mode');
  }

  return { changed: true, stats: metadata };
}

async function main() {
  const startTime = Date.now();

  try {
    log('========================================');
    log('RadioSphere Backup Process Started');
    log(`Mode: ${isDryRun ? 'DRY RUN' : 'PRODUCTION'}`);
    log('========================================');

    const rawStations = await downloadStations();
    const cleanedStations = filterAndCleanStations(rawStations);
    const finalStations = mergeManualStations(cleanedStations);
    const result = saveStations(finalStations);

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);

    log('========================================');
    log('Backup Process Completed Successfully');
    log(`Duration: ${duration}s`);
    log(`Total stations: ${finalStations.length}`);
    log(`Changes detected: ${result.changed ? 'YES' : 'NO'}`);
    log('========================================');

    process.exit(0);

  } catch (error) {
    logError('Backup process failed', error);

    log('========================================');
    log('Backup Process FAILED');
    log('========================================');

    process.exit(1);
  }
}

main();
