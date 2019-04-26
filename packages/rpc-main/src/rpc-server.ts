import * as _ from 'lodash';
import * as WebSocket from 'ws';
import {
    parse,
    validate,
    GraphQLSchema,
    specifiedRules,
    ExecutionResult,
    ValidationContext,
} from 'graphql';
import {
    IMessagePassingProtocol, MessageTypes, 
    createEmptyIterable, isASubscriptionOperation } from '@apollo-link-rpc/common';
import { createAsyncIterator, forAwaitEach, isAsyncIterable } from 'iterall';

import { parseLegacyProtocolMessage } from './legacy/parse-legacy-protocol';
import { ExecuteFunction, SubscribeFunction, ConnectionContext, 
    ExecutionIterator, ExecutionParams, OperationMessage, ServerOptions } from './interfaces';

export class RpcMainInstance {
    private onConnect: Function;
    private onOperation: Function;
    private onDisconnect: Function;
    private onOperationComplete: Function;

    private schema: GraphQLSchema;
    private execute: ExecuteFunction;
    private subscribe: SubscribeFunction;

    private rootValue: any;
    private keepAlive: number;
    private closeHandler: () => void;

    private specifiedRules:
        Array<(context: ValidationContext) => any> |
        ReadonlyArray<any>;

    constructor(
        private _transport: IMessagePassingProtocol,
        options: ServerOptions,
    ) {
        const { onOperation, onOperationComplete, onConnect, onDisconnect } = options;

        this.loadExecutor(options);
         this._connectionHandler();
        this.specifiedRules = options.validationRules || specifiedRules;

        this.onConnect = onConnect;
        this.onOperation = onOperation;
        this.onDisconnect = onDisconnect;
        this.onOperationComplete = onOperationComplete;
    }

    public close(): void {
        this.closeHandler();
    }

    private _connectionHandler = (() => {
        const connectionContext: ConnectionContext = Object.create(null);

        connectionContext.operations = {};
        connectionContext.isLegacy = false;
        connectionContext.initPromise = Promise.resolve(true);

        const connectionClosedHandler = (error: any) => {
            if (error) {
                this.sendError(
                    connectionContext,
                    '',
                    { message: error.message ? error.message : error },
                    MessageTypes.GQL_CONNECTION_ERROR,
                );

                // setTimeout(() => {
                //     // 1011 is an unexpected condition prevented the request from being fulfilled
                //     connectionContext.socket.close(1011);
                // }, 10);
            }
            this.onClose(connectionContext);

            if (this.onDisconnect) {
                this.onDisconnect(connectionContext);
            }
        };

        this._transport.onclose = connectionClosedHandler;
        this._transport.onerror = connectionClosedHandler;
        this._transport.onmessage = this.onMessage(connectionContext);
    });

    private loadExecutor(options: ServerOptions) {
        const { execute, subscribe, schema, rootValue } = options;

        if (!execute) {
            throw new Error('Must provide `execute` for websocket server constructor.');
        }

        this.schema = schema;
        this.execute = execute;
        this.rootValue = rootValue;
        this.subscribe = subscribe;
    }

    private unsubscribe(connectionContext: ConnectionContext, opId: string) {
        if (connectionContext.operations && connectionContext.operations[opId]) {
            if (connectionContext.operations[opId].return) {
                connectionContext.operations[opId].return();
            }

            delete connectionContext.operations[opId];

            if (this.onOperationComplete) {
                this.onOperationComplete(this._transport, opId);
            }
        }
    }

    private onClose(connectionContext: ConnectionContext) {
        Object.keys(connectionContext.operations).forEach((opId) => {
            this.unsubscribe(connectionContext, opId);
        });
    }

    private onMessage(connectionContext: ConnectionContext) {
        return (message: any) => {
            let parsedMessage: OperationMessage;
            try {
                parsedMessage = parseLegacyProtocolMessage(connectionContext, message);
            } catch (e) {
                this.sendError(connectionContext, null, { message: e.message }, MessageTypes.GQL_CONNECTION_ERROR);
                return;
            }

            if (!parsedMessage) {
                return;
            }

            const opId = parsedMessage.id;
            switch (parsedMessage.type) {
                case MessageTypes.GQL_CONNECTION_INIT:
                    if (this.onConnect) {
                        connectionContext.initPromise = new Promise((resolve, reject) => {
                            try {
                                // TODO - this should become a function call with just 2 arguments in the future
                                // when we release the breaking change api: parsedMessage.payload and connectionContext
                                resolve(this.onConnect(parsedMessage.payload, this._transport, connectionContext));
                            } catch (e) {
                                reject(e);
                            }
                        });
                    }

                    connectionContext.initPromise.then((result) => {
                        if (result === false) {
                            throw new Error('Prohibited connection!');
                        }

                        this.sendMessage(
                            connectionContext,
                            undefined,
                            MessageTypes.GQL_CONNECTION_ACK,
                            undefined,
                        );

                        if (this.keepAlive) {
                            this.sendKeepAlive(connectionContext);
                            // Regular keep alive messages if keepAlive is set
                            const keepAliveTimer = setInterval(() => {
                                this.sendKeepAlive(connectionContext)
                            }, this.keepAlive);
                        }
                    }).catch((error: Error) => {
                        this.sendError(
                            connectionContext,
                            opId,
                            { message: error.message },
                            MessageTypes.GQL_CONNECTION_ERROR,
                        );

                        // Close the connection with an error code, ws v2 ensures that the
                        // connection is cleaned up even when the closing handshake fails.
                        // 1011: an unexpected condition prevented the operation from being fulfilled
                        // We are using setTimeout because we want the message to be flushed before
                        // disconnecting the client
                        setTimeout(() => {
                            this._transport.close(1011);
                        }, 10);
                    });
                    break;

                case MessageTypes.GQL_CONNECTION_TERMINATE:
                    this._transport.close();
                    break;

                case MessageTypes.GQL_START:
                    connectionContext.initPromise.then((initResult) => {
                        // if we already have a subscription with this id, unsubscribe from it first
                        if (connectionContext.operations && connectionContext.operations[opId]) {
                            this.unsubscribe(connectionContext, opId);
                        }

                        const baseParams: ExecutionParams = {
                            schema: this.schema,
                            callback: <any>undefined,
                            formatError: <any>undefined,
                            formatResponse: <any>undefined,
                            query: parsedMessage.payload.query,
                            variables: parsedMessage.payload.variables,
                            operationName: parsedMessage.payload.operationName,
                            context: _.isObject(initResult) 
                                ? Object.assign(Object.create(Object.getPrototypeOf(initResult)), initResult) 
                                : {},
                        };

                        let promisedParams = Promise.resolve(baseParams);

                        // set an initial mock subscription to only registering opId
                        connectionContext.operations[opId] = createEmptyIterable();

                        if (this.onOperation) {
                            let messageForCallback: any = parsedMessage;
                            promisedParams = Promise.resolve(this.onOperation(messageForCallback, baseParams, this._transport));
                        }

                        promisedParams.then((params) => {
                            if (typeof params !== 'object') {
                                const error = `Invalid params returned from onOperation! return values must be an object!`;
                                this.sendError(connectionContext, opId, { message: error });

                                throw new Error(error);
                            }

                            if (!params.schema) {
                                const error = 'Missing schema information. The GraphQL schema should be provided either statically in' +
                                    ' the `SubscriptionServer` constructor or as a property on the object returned from onOperation!';
                                this.sendError(connectionContext, opId, { message: error });

                                throw new Error(error);
                            }

                            const document = typeof baseParams.query !== 'string' ? baseParams.query : parse(baseParams.query);
                            let executionPromise: Promise<AsyncIterator<ExecutionResult> | ExecutionResult>;
                            const validationErrors = validate(params.schema, document, this.specifiedRules);

                            if (validationErrors.length > 0) {
                                executionPromise = Promise.resolve({ errors: validationErrors });
                            } else {
                                let executor: SubscribeFunction | ExecuteFunction = this.execute;
                                if (this.subscribe && isASubscriptionOperation(document, params.operationName)) {
                                    executor = this.subscribe;
                                }
                                executionPromise = Promise.resolve(executor(params.schema,
                                    document,
                                    this.rootValue,
                                    params.context,
                                    params.variables,
                                    params.operationName));
                            }

                            return executionPromise.then((executionResult) => ({
                                executionIterable: isAsyncIterable(executionResult) ?
                                    executionResult : createAsyncIterator([executionResult]),
                                params,
                            }));
                        }).then(({ executionIterable, params }) => {
                            forAwaitEach(
                                executionIterable as any,
                                (value: ExecutionResult) => {
                                    let result = value;

                                    if (params.formatResponse) {
                                        try {
                                            result = params.formatResponse(value, params);
                                        } catch (err) {
                                            console.error('Error in formatError function:', err);
                                        }
                                    }

                                    this.sendMessage(connectionContext, opId, MessageTypes.GQL_DATA, result);
                                })
                                .then(() => {
                                    this.sendMessage(connectionContext, opId, MessageTypes.GQL_COMPLETE, null);
                                })
                                .catch((e: Error) => {
                                    let error = e;

                                    if (params.formatError) {
                                        try {
                                            error = params.formatError(e, params);
                                        } catch (err) {
                                            console.error('Error in formatError function: ', err);
                                        }
                                    }

                                    // plain Error object cannot be JSON stringified.
                                    if (Object.keys(e).length === 0) {
                                        error = { name: e.name, message: e.message };
                                    }

                                    this.sendError(connectionContext, opId, error);
                                });

                            return executionIterable;
                        }).then((subscription: ExecutionIterator) => {
                            connectionContext.operations[opId] = subscription;
                        }).then(() => {
                            // NOTE: This is a temporary code to support the legacy protocol.
                            // As soon as the old protocol has been removed, this coode should also be removed.
                            this.sendMessage(connectionContext, opId, MessageTypes.SUBSCRIPTION_SUCCESS, undefined);
                        }).catch((e: any) => {
                            if (e.errors) {
                                this.sendMessage(connectionContext, opId, MessageTypes.GQL_DATA, { errors: e.errors });
                            } else {
                                this.sendError(connectionContext, opId, { message: e.message });
                            }

                            // Remove the operation on the server side as it will be removed also in the client
                            this.unsubscribe(connectionContext, opId);
                            return;
                        });
                        return promisedParams;
                    }).catch((error) => {
                        // Handle initPromise rejected
                        this.sendError(connectionContext, opId, { message: error.message });
                        this.unsubscribe(connectionContext, opId);
                    });
                    break;

                case MessageTypes.GQL_STOP:
                    // Find subscription id. Call unsubscribe.
                    this.unsubscribe(connectionContext, opId);
                    break;

                default:
                    this.sendError(connectionContext, opId, { message: 'Invalid message type!' });
            }
        };
    }

    private sendKeepAlive(connectionContext: ConnectionContext): void {
        if (connectionContext.isLegacy) {
            this.sendMessage(connectionContext, undefined, MessageTypes.KEEP_ALIVE, undefined);
        } else {
            this.sendMessage(connectionContext, undefined, MessageTypes.GQL_CONNECTION_KEEP_ALIVE, undefined);
        }
    }

    private sendMessage(connectionContext: ConnectionContext, opId: string, type: string, payload: any): void {
        const parsedMessage = parseLegacyProtocolMessage(connectionContext, {
            type,
            id: opId,
            payload,
        });

        this._transport.send(parsedMessage);
    }

    private sendError(connectionContext: ConnectionContext, opId: string, errorPayload: any,
        overrideDefaultErrorType?: string): void {
        const sanitizedOverrideDefaultErrorType = overrideDefaultErrorType || MessageTypes.GQL_ERROR;
        if ([
            MessageTypes.GQL_CONNECTION_ERROR,
            MessageTypes.GQL_ERROR,
        ].indexOf(sanitizedOverrideDefaultErrorType) === -1) {
            throw new Error('overrideDefaultErrorType should be one of the allowed error messages' +
                ' GQL_CONNECTION_ERROR or GQL_ERROR');
        }

        this.sendMessage(
            connectionContext,
            opId,
            sanitizedOverrideDefaultErrorType,
            errorPayload,
        );
    }
}
