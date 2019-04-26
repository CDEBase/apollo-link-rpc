const cors = require('cors');
const { Server } = require('ws');
const gql = require('graphql-tag');
const express = require('express');
const { createServer } = require('http');
const { ApolloClient } = require('apollo-client');
const { InMemoryCache } = require('apollo-cache-inmemory');
const RPCHost = require('@apollo-link-rpc/link-rpc-host');
const { ServerTransport } = require('@apollo-link-rpc/transport-websocket/lib/server');

const app = express();
const server = createServer(app);
const ws = new Server({ server });
const manager = new ServerTransport();

app.use(cors({
    origin: true,
}));

const HELLO_QUERY = gql(`
    query hello($name: String) {
        hello(name: $name)
    }
`);

const client = new ApolloClient({
    cache: new InMemoryCache(),
    link: new RPCHost.RPCLink({
        transport: new RPCHost.RpcHostInstance(manager),
    }),
});

ws.on('connection', function(socket) {
    manager.connect(socket);
    socket.on('close', () => manager.disconnect(socket));

    try {
        client.query({ query: HELLO_QUERY, variables: { name: `Server Side: ${Math.random()}` } })
            .then(({data}) => data)
            .then(data => console.log('Result: ', data))
            .catch(err => console.error(err))
    } catch(e) {
        console.error(e)
    }
});

server.listen(3000, () => console.log('Server started!'));
