// commandHandler.js
const PriorityQueue = require('./priorityQueue');
const { calculateChecksum, getTimestamp } = require('./deviceParser');
const topicPrefix = process.env.MQTT_TOPIC_PREFIX || 'devcommax';

class CommandHandler {
    constructor() {
        this.pq = new PriorityQueue();
        this.lastDataTime = Date.now();
        this.lastMqtt = Date.now();
        this.commandMetadata = new Map(); // 명령 메타데이터 저장 (타이머, 재시도 횟수 등)
        this.MAX_RETRIES = 3; // 최대 재시도 횟수
        this.RETRY_TIMEOUT = 500; // 재시도 대기 시간 (500ms)
    }

    safeWrite(command, socket) {
        if (!socket.writableNeedDrain) {
            socket.write(command);
            console.log(`${getTimestamp()} -> ${command.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase()}`);
        } else {
            this.pq.enqueue(command, 1);
        }
    }

    sendCommand(cmd, priority = 1) {
        const commandEntry = {
            command: cmd,
            priority,
            sentAt: Date.now(),
            retries: 0,
            deviceType: this.getDeviceTypeFromCommand(cmd),
            deviceId: cmd[1].toString(16).padStart(2, '0')
        };
        this.pq.enqueue(commandEntry.command, priority);
        this.commandMetadata.set(commandEntry.command.toString('hex'), commandEntry);
        this.startRetryTimer(commandEntry);
    }

    startRetryTimer(commandEntry) {
        commandEntry.timeout = setTimeout(() => {
            this.retryCommand(commandEntry);
        }, this.RETRY_TIMEOUT);
    }

    retryCommand(commandEntry) {
        const hexKey = commandEntry.command.toString('hex');
        if (!this.commandMetadata.has(hexKey)) return; // 이미 삭제된 경우 무시

        if (commandEntry.retries >= this.MAX_RETRIES) {
            console.error(`${getTimestamp()} Command failed after ${this.MAX_RETRIES} retries: ${hexKey}`);
            this.commandMetadata.delete(hexKey);
            return;
        }

        commandEntry.retries += 1;
        console.log(`${getTimestamp()} -> ${hexKey.match(/.{1,2}/g).join(' ')} Retrying command (${commandEntry.retries}/${this.MAX_RETRIES})`);
        this.pq.enqueue(commandEntry.command, commandEntry.priority); // 큐에 다시 추가
        this.startRetryTimer(commandEntry);
    }

    removeCommand(command) {
        const hexKey = command.toString('hex');
        const commandEntry = this.commandMetadata.get(hexKey);
        if (commandEntry) {
            clearTimeout(commandEntry.timeout);
            this.commandMetadata.delete(hexKey);
        }
    }

    getDeviceTypeFromCommand(command) {
        const header = command[0];
        switch (header) {
            case 0x7A: return 'outlet';
            case 0x31: return 'light';
            case 0x04: return 'temp';
            case 0x78: return 'fan';
            case 0xA0: return 'elevator';
            case 0x22: return 'master_light';
            default: return null;
        }
    }

    handleAckOrState(bytes) {
        const header = bytes[0];
        let deviceId;
        let deviceType;

        switch (header) {
            case 0xF9: case 0xFA:
                deviceType = 'outlet';
                deviceId = bytes[2].toString(16).padStart(2, '0');
            break;

            case 0xB1: case 0xB0:
                deviceType = 'light';
                deviceId = bytes[2].toString(16).padStart(2, '0');
            break;

            case 0x82: case 0x84:
                deviceType = 'temp';
                deviceId = bytes[2].toString(16).padStart(2, '0');
            break;

            case 0xF6: case 0xF8:
                deviceType = 'fan';
                deviceId = bytes[2].toString(16).padStart(2, '0');
            break;

            case 0x26:
                deviceType = 'elevator';
                deviceId = bytes[2].toString(16).padStart(2, '0');
            break;

            // 0xA2 가 EV 랑 겹침. EV 는 0x26 패킷이 지속적으로 오기 때문에 이 패킷으로 ACK 를 대체.
            case 0xA2: case 0xA0:
                deviceType = 'master_light';
                deviceId = bytes[2].toString(16).padStart(2, '0');
            break;

            default:
                return;
        }

        // 해당 디바이스와 관련된 명령 찾기
        for (const [hexKey, entry] of this.commandMetadata.entries()) {
            if (entry.deviceType === deviceType && entry.deviceId === deviceId) {
                console.log(`${getTimestamp()} <- ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ').toUpperCase()} ACK/State received for command ${hexKey.match(/.{1,2}/g).join(' ').toUpperCase()}`);
                this.removeCommand(Buffer.from(hexKey, 'hex'));
                break;
            }
        }
    }

    dequeueAndWrite(socket) {
        const gap = Date.now() - this.lastDataTime;
        if (!this.pq.isEmpty()) {
            const { value } = this.pq.dequeue();
            this.safeWrite(value, socket);
        }
    }

    createOutletCommand(deviceId, commandType, value, power = 0) {
        const powerHigh = (power >> 8) & 0xFF;
        const powerLow = power & 0xFF;

        const bytes = [
            0x7A,
            parseInt(deviceId, 16),
            commandType,
            value,
            powerHigh,
            powerLow,
            0x00
        ];
        bytes.push(calculateChecksum(bytes));
        return Buffer.from(bytes);
    }

    createLightPacket(deviceId, power, brightness) {
        const header = 0x31;
        const deviceIdByte = parseInt(deviceId, 16);

        const bytes = [
            header,
            deviceIdByte,
            power,
            0x00,
            0x00,
            0x00,
            brightness
        ];

        const checksum = calculateChecksum(bytes);
        return Buffer.from([...bytes, checksum]);
    }

    createTemperatureCommand(deviceId, type, value) {
        const bytes = [
            0x04,
            parseInt(deviceId, 16),
            type,
            value,
            0x00, 0x00, 0x00
        ];
        bytes.push(calculateChecksum(bytes));
        return Buffer.from(bytes);
    }

    createVentilationCommand(deviceId, commandType, value) {
        const bytes = [
            0x78,
            parseInt(deviceId, 16),
            commandType,
            value,
            0x00, 0x00, 0x00
        ];
        bytes.push(calculateChecksum(bytes));
        return Buffer.from(bytes);
    }

    createElevatorCallCommand(deviceId) {
        const bytes = [
            0xA0,
            parseInt(deviceId, 16),
            0x01,
            0x00,
            0x28,
            0xD7,
            0x00
        ];
        bytes.push(calculateChecksum(bytes));
        return Buffer.from(bytes);
    }

    createMasterLightCommand(deviceId, state) {
        const bytes = [
            0x22,
            parseInt(deviceId, 16),
            state, // 0x01: ON, 0x00: OFF
            0x01,
            0x00,
            0x00,
            0x00
        ];
        bytes.push(calculateChecksum(bytes));
        return Buffer.from(bytes);
    }

    handleMessage(topic, message, mqttClient) {
        const packet = topic.split('/');
        const packetRaw = message.toString();

        const lastPart = packet.at(-1);
        if (!lastPart.includes("set") && !lastPart.includes("call")) return;

        const device = packet[1];
        const deviceId = Number(packet[2].replace(/^(outlet_|light_|temp_)/, ''));
        const deviceId2 = packet[2].replace(/^(outlet_|light_|temp_)/, '');

        switch (device) {
            case 'outlet':
                if (packet.length === 4) {
                    const stateByte = packetRaw === 'ON' ? 0x01 : 0x00;
                    const command = this.createOutletCommand(deviceId2, 0x01, stateByte);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/outlet/${deviceId2}/state`, packetRaw, { retain: true });
                } else if (packet.at(-2) === 'standby_power') {
                    const power = parseInt(packetRaw, 10);
                    if (isNaN(power) || power < 0 || power > 50) return;
                    const command = this.createOutletCommand(deviceId2, 0x03, 0x00, power);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/outlet/${deviceId2}/standby_power`, power.toString(), { retain: true });
                } else if (packet.at(-2) === 'standby_mode') {
                    const modeByte = packetRaw === 'AUTO' ? 0x01 : 0x00;
                    const command = this.createOutletCommand(deviceId2, 0x02, modeByte);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/outlet/${deviceId2}/standby_mode`, packetRaw, { retain: true });
                }
                break;

            case 'light':
                if (packet.at(-2) === 'brightness') {
                    this.lastMqtt = Date.now();
                    const brightness = Number(packetRaw);
                    const power = 0x03;
                    const packetBuffer = this.createLightPacket(deviceId, power, brightness);
                    this.sendCommand(packetBuffer);

                    const btopic = `${topicPrefix}/light/${deviceId2}/brightness`;
                    mqttClient.publish(btopic, packetRaw, { retain: true }, (err) => {
                        if (err) console.error(`Failed to publish brightness for device ${deviceId}:`, err);
                    });

                    const ptopic = `${topicPrefix}/light/${deviceId2}/state`;
                    mqttClient.publish(ptopic, 'ON', { retain: true }, (err) => {
                        if (err) console.error(`Failed to publish state for device ${deviceId}:`, err);
                    });
                } else {
                    // 밝기 조정 이후 즉시 ON 명령이 오는데 이미 켜져있으므로 무시 해야함.
                    const gap = Date.now() - this.lastMqtt;
                    if (gap < 10) return;

                    this.lastMqtt = Date.now();
                    const power = packetRaw === 'ON' ? 0x01 : 0x00;
                    const packetBuffer = this.createLightPacket(deviceId, power, 0);
                    this.sendCommand(packetBuffer);

                    const topic = `${topicPrefix}/light/${deviceId2}/state`;
                    mqttClient.publish(topic, power ? 'ON' : 'OFF', { retain: true }, (err) => {
                        if (err) console.error(`Failed to publish state for device ${deviceId}:`, err);
                    });
                }
                break;

            case 'temp':
                if (packet.at(-1) === 'set_mode') {
                    const mode = packetRaw;
                    const value = mode === 'off' ? 0x00 : 0x81;
                    const command = this.createTemperatureCommand(deviceId, 0x04, value);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/temp/${deviceId2}/mode`, mode, { retain: true });
                } else if (packet.at(-1) === 'set_temp') {
                    const temp16 = parseInt(packetRaw, 16);
                    const temp = parseInt(packetRaw, 10);

                    if (isNaN(temp) || temp < 16 || temp > 30) return;
                    const command = this.createTemperatureCommand(deviceId, 0x03, temp16);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/temp/${deviceId2}/mode`, "heat", { retain: true });
                    mqttClient.publish(`${topicPrefix}/temp/${deviceId2}/target_temp`, temp.toString(), { retain: true });
                }
                break;

            case 'fan':
                if (packet.at(-1) === 'set') {
                    const state = packetRaw === 'ON' ? 0x04 : 0x00;
                    const command = this.createVentilationCommand(deviceId2, 0x01, state);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/fan/${deviceId2}/state`, packetRaw, { retain: true });
                } else if (packet.at(-1) === 'set_mode') {
                    const modeValue = packetRaw === 'auto' ? 0x02 : packetRaw === 'bypass' ? 0x07 : 0x04;
                    const command = this.createVentilationCommand(deviceId2, 0x01, modeValue);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/fan/${deviceId2}/mode`, packetRaw, { retain: true });
                } else if (packet.at(-1) === 'set_speed') {
                    const speed = parseInt(packetRaw, 10);
                    if (isNaN(speed) || speed < 0 || speed > 3) {
                        console.error(`Invalid speed: ${packetRaw}. Must be between 0 and 3`);
                        return;
                    }
                    if (speed === 0) {
                        const command = this.createVentilationCommand(deviceId2, 0x01, 0x00);
                        this.sendCommand(command);
                        mqttClient.publish(`${topicPrefix}/fan/${deviceId2}/state`, "OFF", { retain: true });
                        mqttClient.publish(`${topicPrefix}/fan/${deviceId2}/speed`, "0", { retain: true });
                    } else {
                        const speedValue = speed === 1 ? 0x01 : speed === 2 ? 0x02 : 0x03;
                        const command = this.createVentilationCommand(deviceId2, 0x02, speedValue);
                        this.sendCommand(command);
                        mqttClient.publish(`${topicPrefix}/fan/${deviceId2}/speed`, speed.toString(), { retain: true });
                        mqttClient.publish(`${topicPrefix}/fan/${deviceId2}/state`, "ON", { retain: true });
                    }
                }
                break;

            case 'elevator':
                // console.log(packet);
                // console.log(packetRaw);
                // if (packet.at(-1) === 'call') {
                //     const command = this.createElevatorCallCommand(deviceId2);
                //     this.sendCommand(command);
                //     console.log(`Elevator ${deviceId2}: Call command sent`);
                // }
            break;

            case 'master_light':
                if (packet.at(-1) === 'set') { // devcommax/master_light/set
                    const state = packetRaw === 'ON' ? 0x01 : 0x00;
                    const command = this.createMasterLightCommand("01", state);
                    this.sendCommand(command);
                    mqttClient.publish(`${topicPrefix}/master_light/state`, packetRaw, { retain: true });
                }
            break;
        }
    }
}

module.exports = CommandHandler;