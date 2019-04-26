import { execute, subscribe } from 'graphql';
import { makeExecutableSchema } from 'graphql-tools';
import { RpcMainInstance } from '@apollo-link-rpc/link-rpc-main';
import { BrowserTransport } from '@apollo-link-rpc/transport-websocket/lib/browser';

const typeDefs = `
    type Query {
        hello(name: String): String
    }
`;

const resolvers = {
    Query: {
        hello: (root, { name }) => `Hello, ${name || 'world'}!`,
    },
};

const schema = makeExecutableSchema({ typeDefs, resolvers });

const ws = new WebSocket('ws://localhost:3000');

const transport = new BrowserTransport(ws);
const mainInstance = new RpcMainInstance(transport, {
    schema,
    execute,
    subscribe,
});
