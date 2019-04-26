import { IMessagePassingProtocol, Status } from '@apollo-link-rpc/common';

export class ServerTransport implements IMessagePassingProtocol<any> {
    private _connections = [];
    private _handlers = {
        open: [],
        close: [],
        error: [],
        message: [],
    };
    
    public onopen(fn) {  }
    public status = Status.Open;

    set onclose(fn) { this._handlers.close.push(fn); }
    set onerror(fn) { this._handlers.error.push(fn); }
    set onmessage(fn) { this._handlers.message.push(fn); }

    constructor() { 
        this._handlers.open.forEach(fn => fn());
    }

    public connect(socket) {
        this._connections.push(socket);

        socket.on('error', () => this._handlers.error.forEach(fn => fn()));
        socket.on('message', (msg) => {
            this._handlers.message.forEach(fn => fn(JSON.parse(msg)));
        });
    }

    public disconnect(socket) {
        this._connections = this._connections.filter(ws => ws !== socket);
    }

    close() {
        this._handlers.close.forEach(fn => fn());
        this._connections.forEach(ws => ws.close());
    }

    send(arg: any) {
        this._connections.forEach(ws => ws.send(JSON.stringify(arg)));
    }
}
