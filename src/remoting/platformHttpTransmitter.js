import Emitter from 'emitter-component';


import { exists } from '../utils';
import { DolphinRemotingError, DolphinSessionError } from './errors';
import Codec from './commands/codec';
import RemotingErrorHandler from './remotingErrorHandler';
import { LoggerFactory, LogLevel } from '../logging';
import {VALUE_CHANGED_COMMAND_ID, START_LONG_POLL_COMMAND_ID} from './commands/commandConstants';

const DOLPHIN_SESSION_TIMEOUT = 408;

export default class PlatformHttpTransmitter {

    constructor(url, config) {
        this.url = url;
        this.config = config;
        this.headersInfo = exists(config) ? config.headersInfo : null;
        this.failed_attempt = 0;

        const connectionConfig =  this._connectionConfig();
        this.maxRetry = exists(connectionConfig) && exists(connectionConfig.maxRetry)?connectionConfig.maxRetry: 3;
        this.timeout = exists(connectionConfig) && exists(connectionConfig.timeout)?connectionConfig.timeout: 5000;
    }

    _connectionConfig() {
        return exists(this.config) ? this.config.connection : null;
    }

    _handleError(reject, error) {
        const connectionConfig =  this._connectionConfig();
        let errorHandlers = exists(connectionConfig) && exists(connectionConfig.errorHandlers)?connectionConfig.errorHandlers: [new RemotingErrorHandler()];
        errorHandlers.forEach(function(handler) {
            handler.onError(error);
        });
        reject(error);
    }

    _send(commands) {
        const self = this;
        return new Promise((resolve, reject) => {

            if (window.client) {
                const encodedCommands = Codec.encode(commands);

                if (PlatformHttpTransmitter.LOGGER.isLogLevelUseable(LogLevel.DEBUG) && !PlatformHttpTransmitter.LOGGER.isLogLevelUseable(LogLevel.TRACE)) {
                    for (let i = 0; i < commands.length; i++) {
                        let command = commands[i];
                        if (command.id === VALUE_CHANGED_COMMAND_ID) {
                            PlatformHttpTransmitter.LOGGER.debug('send', command, encodedCommands);
                        }
                    }
                }

                const useWorker = commands.length === 1 && commands[0].id === START_LONG_POLL_COMMAND_ID;

                const httpClient = window.client.getService('HttpClient');
                if (httpClient && self.failed_attempt <= self.maxRetry) {
                    httpClient.post(self.url)
                    .withHeadersInfo(this.headersInfo)
                    .withContent(encodedCommands)
                    .readString()
                    .execute(useWorker)
                    .then((response) => {
                        resolve(response.content);
                    })
                    .catch((exception) => {
                        const status = exception.getStatus();
                        self.failed_attempt += 1;
                        if (status === DOLPHIN_SESSION_TIMEOUT) {
                            self._handleError(reject, new DolphinSessionError('PlatformHttpTransmitter: Session Timeout'));
                        } else {
                            self._handleError(reject, exception);
                        }
                    });
                } else {
                    //TODO handle failure
                    PlatformHttpTransmitter.LOGGER.error('Cannot reach the sever');
                }
            }
        });
    }

    transmit(commands, onDone) {
        this._send(commands)
            .then(responseText => {
                if (responseText.trim().length > 0) {
                    try {
                        const responseCommands = Codec.decode(responseText);
                        onDone(responseCommands);
                    } catch (err) {
                        this.emit('error', new DolphinRemotingError('PlatformHttpTransmitter: Parse error: (Incorrect response = ' + responseText + ')'));
                        onDone([]);
                    }
                } else {
                    this.emit('error', new DolphinRemotingError('PlatformHttpTransmitter: Empty response'));
                    onDone([]);
                }
            })
            .catch(error => {
                this.emit('error', error);
                onDone([]);
            });
    }

    signal(command) {
        this._send([command])
            .catch(error => this.emit('error', error));
    }
}

PlatformHttpTransmitter.LOGGER = LoggerFactory.getLogger('PlatformHttpTransmitter');

Emitter(PlatformHttpTransmitter.prototype);
