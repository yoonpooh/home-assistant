const fs = require('fs').promises;
const { log, logError } = require('./utils');

const path = '/share/commax_ew11_state.json';
// const path = './devcommax_state.json'; // 로컬 테스트용

async function loadState() {
    try {
        const data = await fs.readFile(path, 'utf8');
        const state = JSON.parse(data);
        // log(`Loaded state from ${path}:`, state);
        return {
            discoveredOutlets: new Set(state.discoveredOutlets || []),
            discoveredLights: new Set(state.discoveredLights || []),
            discoveredTemps: new Set(state.discoveredTemps || []),
            discoveredFans: new Set(state.discoveredFans || []),
            discoveredMasterLights: new Set(state.discoveredMasterLights || []),
            discoveredElevators: new Set(state.discoveredElevators || []),
            discoveredSensors: new Set(state.discoveredSensors || []),
            discoveredMeters: new Set(state.discoveredMeters || []),
            parkingState: {
                parkingDiscovered: state.parkingState?.parkingDiscovered || false,
                carNumberDiscovered: state.parkingState?.carNumberDiscovered || false
            }
        };
    } catch (err) {
        if (err.code === 'ENOENT') {
            log(`No ${path} found, starting fresh.`);
            return {
                discoveredOutlets: new Set(),
                discoveredLights: new Set(),
                discoveredTemps: new Set(),
                discoveredFans: new Set(),
                discoveredElevators: new Set(),
                discoveredMasterLights: new Set(),
                discoveredSensors: new Set(),
                discoveredMeters: new Set(),
                parkingState: { parkingDiscovered: false, carNumberDiscovered: false }
            };
        } else {
            console.error(`Error loading ${path}:`, err);
            return {
                discoveredOutlets: new Set(),
                discoveredLights: new Set(),
                discoveredTemps: new Set(),
                discoveredFans: new Set(),
                discoveredElevators: new Set(),
                discoveredMasterLights: new Set(),
                discoveredSensors: new Set(),
                discoveredMeters: new Set(),
                parkingState: { parkingDiscovered: false, carNumberDiscovered: false }
            };
        }
    }
}

async function saveState(state) {
    try {
        const data = {
            discoveredOutlets: Array.from(state.discoveredOutlets),
            discoveredLights: Array.from(state.discoveredLights),
            discoveredTemps: Array.from(state.discoveredTemps),
            discoveredFans: Array.from(state.discoveredFans),
            discoveredElevators: Array.from(state.discoveredElevators),
            discoveredMasterLights: Array.from(state.discoveredMasterLights),
            discoveredSensors: Array.from(state.discoveredSensors),
            discoveredMeters: Array.from(state.discoveredMeters),
            parkingState: {
                parkingDiscovered: state.parkingState.parkingDiscovered,
                carNumberDiscovered: state.parkingState.carNumberDiscovered
            }
        };
        await fs.writeFile(path, JSON.stringify(data, null, 2), 'utf8');
        // log(`Saved state to ${path}:`, data);
    } catch (err) {
        console.error(`Error saving ${path}:`, err);
    }
}

module.exports = { loadState, saveState };