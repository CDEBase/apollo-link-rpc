import * as Logger from 'bunyan';
import { ApolloLink, Operation, FetchResult, Observable } from 'apollo-link';

import { RpcTransport } from './rpc-client';

export interface IRPCLinkOptions {
    logger: Logger,
    transport: RpcTransport,
}

export class RPCLink extends ApolloLink {
    private _logger: Logger;
    private transport: RpcTransport;

    constructor(options: IRPCLinkOptions) {
        super();

        this._logger = options.logger;
        this.transport = options.transport;
    }

    public request(operation: Operation): Observable<FetchResult> | null {
        return this
            .transport
            .request(operation) as Observable<FetchResult>;
    }
}
