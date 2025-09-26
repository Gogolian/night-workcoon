import { writeFileSync, readFileSync, existsSync } from 'fs';
import { recordedData } from './state.js';

const config = JSON.parse(readFileSync('./config.json'));
const dataFilePath = './data/recorded_data.json';
let debounceTimer;

export function loadRecordedData() {
    if (existsSync(dataFilePath)) {
        if (config.logLevel >= 2) {
            console.log('Loading existing recorded data...');
        }
        const fileContent = readFileSync(dataFilePath, 'utf-8');
        if (fileContent) {
            try {
                const loadedData = JSON.parse(fileContent);
                Object.assign(recordedData, loadedData);
            } catch (e) {
                console.error('Could not parse recorded_data.json, starting fresh.', e);
            }
        } else {
            if (config.logLevel >= 2) {
                console.log('recorded_data.json is empty, starting fresh.');
            }
        }
    } else {
        if (config.logLevel >= 2) {
            console.log('No existing recorded data found, starting fresh.');
        }
    }
}

export function saveDataDebounced() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
        if (config.logLevel >= 3) {
            console.log('Debounced save triggered. Saving recorded data...');
        }
        writeFileSync(dataFilePath, JSON.stringify(recordedData, null, 2));
        if (config.logLevel >= 3) {
            console.log('Recorded data saved.');
        }
    }, 2000);
}

export function forceSave() {
    clearTimeout(debounceTimer);
    if (config.logLevel >= 2) {
        console.log('Force saving recorded data...');
    }
    writeFileSync(dataFilePath, JSON.stringify(recordedData, null, 2));
    if (config.logLevel >= 2) {
        console.log('Recorded data saved.');
    }
}
