import {
    ExecutionResult,
    GraphQLSchema,
    DocumentNode,
    ValidationContext,
    GraphQLFieldResolver,
  } from 'graphql';

export type ExecutionIterator = AsyncIterator<ExecutionResult>;

export interface ExecutionParams<TContext = any> {
    query: string | DocumentNode;
    variables: { [key: string]: any };
    operationName: string;
    context: TContext;
    formatResponse?: Function;
    formatError?: Function;
    callback?: Function;
    schema?: GraphQLSchema;
}

export type ConnectionContext = {
    request: any,
    initPromise?: Promise<any>,
    isLegacy: boolean,
    socket: WebSocket,
    operations: {
        [opId: string]: ExecutionIterator,
    },
};

export interface OperationMessagePayload {
    [key: string]: any; // this will support for example any options sent in init like the auth token
    query?: string;
    variables?: { [key: string]: any };
    operationName?: string;
}

export interface OperationMessage {
    payload?: OperationMessagePayload;
    id?: string;
    type: string;
}

export type ExecuteFunction = (schema: GraphQLSchema,
    document: DocumentNode,
    rootValue?: any,
    contextValue?: any,
    variableValues?: { [key: string]: any },
    operationName?: string,
    fieldResolver?: GraphQLFieldResolver<any, any>) =>
    ExecutionResult |
    Promise<ExecutionResult> |
    AsyncIterator<ExecutionResult>;

export type SubscribeFunction = (schema: GraphQLSchema,
    document: DocumentNode,
    rootValue?: any,
    contextValue?: any,
    variableValues?: { [key: string]: any },
    operationName?: string,
    fieldResolver?: GraphQLFieldResolver<any, any>,
    subscribeFieldResolver?: GraphQLFieldResolver<any, any>) =>
    AsyncIterator<ExecutionResult> |
    Promise<AsyncIterator<ExecutionResult> | ExecutionResult>;

export interface ServerOptions {
    rootValue?: any;
    schema?: GraphQLSchema;
    execute?: ExecuteFunction;
    subscribe?: SubscribeFunction;
    validationRules?:
    Array<(context: ValidationContext) => any> | ReadonlyArray<any>;
    onOperation?: Function;
    onOperationComplete?: Function;
    onConnect?: Function;
    onDisconnect?: Function;
    keepAlive?: number;
}
