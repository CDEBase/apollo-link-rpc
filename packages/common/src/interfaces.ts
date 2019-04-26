import { DocumentNode } from 'graphql/language/ast';

import { Status } from './constants';

export interface Event<T> {
	(listener: (e: T) => any, thisArgs?: any): void;
}

export interface IMessagePassingProtocol<T> {
  status: Status;
  send(msg: T): void;
  send(reason: any): void;
  onmessage: (msg: T)  => void;
	onopen: ()  => any | Promise<any>;
	onclose: ()  => any | Promise<any>;
	onerror: (err: Error)  => any | Promise<any>;
}

export interface Observer<T> {
    next?: (value: T) => void;
    error?: (error: Error) => void;
    complete?: () => void;
  }
  
  export interface Observable<T> {
    subscribe(observer: Observer<T>): {
      unsubscribe: () => void;
    };
  }
  
  export interface OperationOptions {
    query?: string | DocumentNode;
    variables?: Object;
    operationName?: string;
    [key: string]: any;
  }
  
  export type FormatedError = Error & {
    originalError?: any;
  };
  
  export interface Operation {
    options: OperationOptions;
    handler: (error: Error[], result?: any) => void;
  }
  
  export interface Operations {
    [id: string]: Operation;
  }
  
  export interface Middleware {
    applyMiddleware(options: OperationOptions, next: Function): void;
  }
  
  export type ConnectionParams = {
    [paramName: string]: any,
  };
  
  export type ConnectionParamsOptions = ConnectionParams | Function | Promise<ConnectionParams>;
  
  export interface ClientOptions {
    connectionParams?: ConnectionParamsOptions;
    timeout?: number;
    reconnect?: boolean;
    reconnectionAttempts?: number;
    connectionCallback?: (error: Error[], result?: any) => void;
    lazy?: boolean;
    inactivityTimeout?: number;
  }
