import * as _ from 'lodash';
import * as Backoff from 'backo2';
import $$observable from 'symbol-observable';
import { print } from 'graphql/language/printer';
import { ExecutionResult } from 'graphql/execution/execute';
import { getOperationAST } from 'graphql/utilities/getOperationAST';
import { default as EventEmitterType, EventEmitter, ListenerFn } from 'eventemitter3';

import { 
    Observable, Status,
    ConnectionParamsOptions, FormatedError, Operations,
    Middleware, IMessagePassingProtocol, ClientOptions, 
    WS_TIMEOUT, MessageTypes, OperationOptions, Observer, ConnectionParams, 
} from '@apollo-link-rpc/common';

export class RpcHostInstance {
    public client: any;
    public operations: Operations;
    private nextOperationId: number;
    private connectionParams: Function;
    private wsTimeout: number;
    private unsentMessagesQueue: Array<any>; // queued messages while websocket is opening.
    private reconnect: boolean;
    private reconnecting: boolean;
    private reconnectionAttempts: number;
    private backoff: any;
    private connectionCallback: any;
    private eventEmitter: EventEmitterType;
    private lazy: boolean;
    private inactivityTimeout: number;
    private inactivityTimeoutId: any;
    private closedByUser: boolean;
    private wasKeepAliveReceived: boolean;
    private tryReconnectTimeoutId: any;
    private checkConnectionIntervalId: any;
    private maxConnectTimeoutId: any;
    private middlewares: Middleware[];
    private maxConnectTimeGenerator: any;

    constructor(
        private _transport: IMessagePassingProtocol<any>,
        options?: ClientOptions,
    ) {
        const {
            lazy = false,
            reconnect = false,
            timeout = WS_TIMEOUT,
            connectionParams = {},
            inactivityTimeout = 0,
            connectionCallback = undefined,
            reconnectionAttempts = Infinity,
        } = (options || {});

        if (!this._transport) {
            throw new Error('Transport is required!');
        }

        this.connectionCallback = connectionCallback;
        this.operations = {};
        this.nextOperationId = 0;
        this.wsTimeout = timeout;
        this.unsentMessagesQueue = [];
        this.reconnect = reconnect;
        this.reconnecting = false;
        this.reconnectionAttempts = reconnectionAttempts;
        this.lazy = !!lazy;
        this.inactivityTimeout = inactivityTimeout;
        this.closedByUser = false;
        this.backoff = new Backoff({ jitter: 0.5 });
        this.eventEmitter = new EventEmitter();
        this.middlewares = [];
        this.maxConnectTimeGenerator = this.createMaxConnectTimeGenerator();
        this.connectionParams = this.getConnectionParams(connectionParams);

        if (!this.lazy) {
            this.connect();
        }
    }

    public get status() {
        if (this._transport === null) {
            return Status.Close;
        }

        return this._transport.status || Status.Open;
    }

    public close(isForced = true, closedByUser = true) {
        this.clearInactivityTimeout();
        if (this._transport !== null) {
            this.closedByUser = closedByUser;

            if (isForced) {
                this.clearCheckConnectionInterval();
                this.clearMaxConnectTimeout();
                this.clearTryReconnectTimeout();
                this.unsubscribeAll();
                this.sendMessage(undefined, MessageTypes.GQL_CONNECTION_TERMINATE, null);
            }

            this._transport.close();
            // this._transport = null;
            this.eventEmitter.emit('disconnected');

            if (!isForced) {
                this.tryReconnect();
            }
        }
    }

    public request(request: OperationOptions): Observable<ExecutionResult> {
        const getObserver = this.getObserver.bind(this);
        const executeOperation = this.executeOperation.bind(this);
        const unsubscribe = this.unsubscribe.bind(this);

        let opId: string;

        this.clearInactivityTimeout();

        return {
            [$$observable]() {
                return this;
            },
            subscribe(
                observerOrNext: ((Observer<ExecutionResult>) | ((v: ExecutionResult) => void)),
                onError?: (error: Error) => void,
                onComplete?: () => void,
            ) {
                const observer = getObserver(observerOrNext, onError, onComplete);

                opId = executeOperation(request, (error: Error[], result: any) => {
                    if (error === null && result === null) {
                        if (observer.complete) {
                            observer.complete();
                        }
                    } else if (error) {
                        if (observer.error) {
                            observer.error(error[0]);
                        }
                    } else {
                        if (observer.next) {
                            observer.next(result);
                        }
                    }
                });

                return {
                    unsubscribe: () => {
                        if (opId) {
                            unsubscribe(opId);
                            opId = null;
                        }
                    },
                };
            },
        };
    }

    public on(eventName: string, callback: ListenerFn, context?: any): Function {
        const handler = this.eventEmitter.on(eventName, callback, context);

        return () => {
            handler.off(eventName, callback, context);
        };
    }

    public onConnected(callback: ListenerFn, context?: any): Function {
        return this.on('connected', callback, context);
    }

    public onConnecting(callback: ListenerFn, context?: any): Function {
        return this.on('connecting', callback, context);
    }

    public onDisconnected(callback: ListenerFn, context?: any): Function {
        return this.on('disconnected', callback, context);
    }

    public onReconnected(callback: ListenerFn, context?: any): Function {
        return this.on('reconnected', callback, context);
    }

    public onReconnecting(callback: ListenerFn, context?: any): Function {
        return this.on('reconnecting', callback, context);
    }

    public onError(callback: ListenerFn, context?: any): Function {
        return this.on('error', callback, context);
    }

    public unsubscribeAll() {
        Object.keys(this.operations).forEach(subId => {
            this.unsubscribe(subId);
        });
    }

    public applyMiddlewares(options: OperationOptions): Promise<OperationOptions> {
        return new Promise((resolve, reject) => {
            const queue = (funcs: Middleware[], scope: any) => {
                const next = (error?: any) => {
                    if (error) {
                        reject(error);
                    } else {
                        if (funcs.length > 0) {
                            const f = funcs.shift();
                            if (f) {
                                f.applyMiddleware.apply(scope, [options, next]);
                            }
                        } else {
                            resolve(options);
                        }
                    }
                };
                next();
            };

            queue([...this.middlewares], this);
        });
    }

    public use(middlewares: Middleware[]): any {
        middlewares.map((middleware) => {
            if (typeof middleware.applyMiddleware === 'function') {
                this.middlewares.push(middleware);
            } else {
                throw new Error('Middleware must implement the applyMiddleware function.');
            }
        });

        return this;
    }

    private getConnectionParams(connectionParams: ConnectionParamsOptions): Function {
        return (): Promise<ConnectionParams> => new Promise((resolve, reject) => {
            if (typeof connectionParams === 'function') {
                try {
                    return resolve(connectionParams.call(null));
                } catch (error) {
                    return reject(error);
                }
            }

            resolve(connectionParams);
        });
    }

    private executeOperation(options: OperationOptions, handler: (error: Error[], result?: any) => void): string {
        if (this._transport === null) {
            this.connect();
        }

        const opId = this.generateOperationId();
        this.operations[opId] = { options: options, handler };

        this.applyMiddlewares(options)
            .then(processedOptions => {
                this.checkOperationOptions(processedOptions, handler);
                if (this.operations[opId]) {
                    this.operations[opId] = { options: processedOptions, handler };
                    this.sendMessage(opId, MessageTypes.GQL_START, processedOptions);
                }
            })
            .catch(error => {
                this.unsubscribe(opId);
                handler(this.formatErrors(error));
            });

        return opId;
    }

    private getObserver<T>(
        observerOrNext: ((Observer<T>) | ((v: T) => void)),
        error?: (e: Error) => void,
        complete?: () => void,
    ) {
        if (typeof observerOrNext === 'function') {
            return {
                next: (v: T) => observerOrNext(v),
                error: (e: Error) => error && error(e),
                complete: () => complete && complete(),
            };
        }

        return observerOrNext;
    }

    private createMaxConnectTimeGenerator() {
        const minValue = 1000;
        const maxValue = this.wsTimeout;

        return new Backoff({
            min: minValue,
            max: maxValue,
            factor: 1.2,
        });
    }

    private clearCheckConnectionInterval() {
        if (this.checkConnectionIntervalId) {
            clearInterval(this.checkConnectionIntervalId);
            this.checkConnectionIntervalId = null;
        }
    }

    private clearMaxConnectTimeout() {
        if (this.maxConnectTimeoutId) {
            clearTimeout(this.maxConnectTimeoutId);
            this.maxConnectTimeoutId = null;
        }
    }

    private clearTryReconnectTimeout() {
        if (this.tryReconnectTimeoutId) {
            clearTimeout(this.tryReconnectTimeoutId);
            this.tryReconnectTimeoutId = null;
        }
    }

    private clearInactivityTimeout() {
        if (this.inactivityTimeoutId) {
            clearTimeout(this.inactivityTimeoutId);
            this.inactivityTimeoutId = null;
        }
    }

    private setInactivityTimeout() {
        if (this.inactivityTimeout > 0 && Object.keys(this.operations).length === 0) {
            this.inactivityTimeoutId = setTimeout(() => {
                if (Object.keys(this.operations).length === 0) {
                    this.close();
                }
            }, this.inactivityTimeout);
        }
    }

    private checkOperationOptions(options: OperationOptions, handler: (error: Error[], result?: any) => void) {
        const { query, variables, operationName } = options;

        if (!query) {
            throw new Error('Must provide a query.');
        }

        if (!handler) {
            throw new Error('Must provide an handler.');
        }

        if (
            (!_.isString(query) && !getOperationAST(query, operationName)) ||
            (operationName && !_.isString(operationName)) ||
            (variables && !_.isObject(variables))
        ) {
            throw new Error('Incorrect option types. query must be a string or a document,' +
                '`operationName` must be a string, and `variables` must be an object.');
        }
    }

    private buildMessage(id: string, type: string, payload: any) {
        const payloadToReturn = payload && payload.query ?
            {
                ...payload,
                query: typeof payload.query === 'string' ? payload.query : print(payload.query),
            } :
            payload;

        return {
            id,
            type,
            payload: payloadToReturn,
        };
    }

    // ensure we have an array of errors
    private formatErrors(errors: any): FormatedError[] {
        if (Array.isArray(errors)) {
            return errors;
        }

        // TODO  we should not pass ValidationError to callback in the future.
        // ValidationError
        if (errors && errors.errors) {
            return this.formatErrors(errors.errors);
        }

        if (errors && errors.message) {
            return [errors];
        }

        return [{
            name: 'FormatedError',
            message: 'Unknown error',
            originalError: errors,
        }];
    }

    private sendMessage(id: string, type: string, payload: any) {
        this.sendMessageRaw(this.buildMessage(id, type, payload));
    }

    // send message, or queue it if connection is not open
    private sendMessageRaw(message: Object) {
        switch (this.status) {
            case Status.Open:
                // let serializedMessage: string = JSON.stringify(message);
                // try {
                //     JSON.parse(serializedMessage);
                // } catch (e) {
                //     this.eventEmitter.emit('error', new Error(`Message must be JSON-serializable. Got: ${message}`));
                // }
                this._transport.send(message);
                break;
            case Status.Connecting:
                this.unsentMessagesQueue.push(message);

                break;
            default:
                if (!this.reconnecting) {
                    this.eventEmitter.emit('error', new Error('A message was not sent because socket is not connected, is closing or ' +
                        'is already closed. Message was: ' + JSON.stringify(message)));
                }
        }
    }

    private generateOperationId(): string {
        return String(++this.nextOperationId);
    }

    private tryReconnect() {
        if (!this.reconnect || this.backoff.attempts >= this.reconnectionAttempts) {
            return;
        }

        if (!this.reconnecting) {
            Object.keys(this.operations).forEach((key) => {
                this.unsentMessagesQueue.push(
                    this.buildMessage(key, MessageTypes.GQL_START, this.operations[key].options),
                );
            });
            this.reconnecting = true;
        }

        this.clearTryReconnectTimeout();

        const delay = this.backoff.duration();
        this.tryReconnectTimeoutId = setTimeout(() => {
            this.connect();
        }, delay);
    }

    private flushUnsentMessagesQueue() {
        this.unsentMessagesQueue.forEach((message) => {
            this.sendMessageRaw(message);
        });
        this.unsentMessagesQueue = [];
    }

    private checkConnection() {
        if (this.wasKeepAliveReceived) {
            this.wasKeepAliveReceived = false;
            return;
        }

        if (!this.reconnecting) {
            this.close(false, true);
        }
    }

    private checkMaxConnectTimeout() {
        this.clearMaxConnectTimeout();

        // Max timeout trying to connect
        this.maxConnectTimeoutId = setTimeout(() => {
            if (this.status !== Status.Open) {
                this.reconnecting = true;
                this.close(false, true);
            }
        }, this.maxConnectTimeGenerator.duration());
    }

    private connect = () => {
        this.checkMaxConnectTimeout();
        this._transport.onopen = async () => {
            if (this.status === Status.Open) {
                this.clearMaxConnectTimeout();
                this.closedByUser = false;
                this.eventEmitter.emit(this.reconnecting ? 'reconnecting' : 'connecting');

                try {
                    const connectionParams: ConnectionParams = await this.connectionParams();

                    // Send CONNECTION_INIT message, no need to wait for connection to success (reduce roundtrips)
                    this.sendMessage(undefined, MessageTypes.GQL_CONNECTION_INIT, connectionParams);
                    this.flushUnsentMessagesQueue();
                } catch (error) {
                    this.sendMessage(undefined, MessageTypes.GQL_CONNECTION_ERROR, error);
                    this.flushUnsentMessagesQueue();
                }
            }
        };

        this._transport.onclose = () => {
            if (!this.closedByUser) {
                this.close(false, false);
            }
        };

        this._transport.onerror = (err: Error) => {
            // Capture and ignore errors to prevent unhandled exceptions, wait for
            // onclose to fire before attempting a reconnect.
            this.eventEmitter.emit('error', err);
        };

        this._transport.onmessage = (data: any) => this.processReceivedData(data);
    }

    private processReceivedData(parsedMessage: any) {
        if (!parsedMessage) {
            return;
        }

        let opId: string = parsedMessage.id;

        if (
            [MessageTypes.GQL_DATA,
            MessageTypes.GQL_COMPLETE,
            MessageTypes.GQL_ERROR,
            ].indexOf(parsedMessage.type) !== -1 && !this.operations[opId]
        ) {
            this.unsubscribe(opId);

            return;
        }

        switch (parsedMessage.type) {
            case MessageTypes.GQL_CONNECTION_ERROR:
                if (this.connectionCallback) {
                    this.connectionCallback(parsedMessage.payload);
                }
                break;

            case MessageTypes.GQL_CONNECTION_ACK:
                this.eventEmitter.emit(this.reconnecting ? 'reconnected' : 'connected');
                this.reconnecting = false;
                this.backoff.reset();
                this.maxConnectTimeGenerator.reset();

                if (this.connectionCallback) {
                    this.connectionCallback();
                }
                break;

            case MessageTypes.GQL_COMPLETE:
                this.operations[opId].handler(null, null);
                delete this.operations[opId];
                break;

            case MessageTypes.GQL_ERROR:
                this.operations[opId].handler(this.formatErrors(parsedMessage.payload), null);
                delete this.operations[opId];
                break;

            case MessageTypes.GQL_DATA:
                const parsedPayload = !parsedMessage.payload.errors ?
                    parsedMessage.payload : { ...parsedMessage.payload, errors: this.formatErrors(parsedMessage.payload.errors) };
                this.operations[opId].handler(null, parsedPayload);
                break;

            case MessageTypes.GQL_CONNECTION_KEEP_ALIVE:
                const firstKA = typeof this.wasKeepAliveReceived === 'undefined';
                this.wasKeepAliveReceived = true;

                if (firstKA) {
                    this.checkConnection();
                }

                if (this.checkConnectionIntervalId) {
                    clearInterval(this.checkConnectionIntervalId);
                    this.checkConnection();
                }
                this.checkConnectionIntervalId = setInterval(this.checkConnection.bind(this), this.wsTimeout);
                break;

            default:
                throw new Error('Invalid message type!');
        }
    }

    private unsubscribe(opId: string) {
        if (this.operations[opId]) {
            delete this.operations[opId];
            this.setInactivityTimeout();
            this.sendMessage(opId, MessageTypes.GQL_STOP, undefined);
        }
    }
}
