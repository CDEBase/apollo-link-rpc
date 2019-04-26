import { IMessagePassingProtocol } from '@apollo-link-rpc/common';

export class BrowserTransport implements IMessagePassingProtocol<any> {
    set onopen(fn) { this._ws.onopen = fn; }
    set onclose(fn) { this._ws.onclose = fn; }
    set onerror(fn) { this._ws.onerror = fn; }
    set onmessage(fn) { this._ws.onmessage = (msg) => fn(JSON.parse(msg.data)); }

    constructor(
        private _ws: any,
    ) {  }

    get status() {
        return this._ws.state;
    }

    close() {
        this._ws.close();
    }

    send(message: any) {
        this._ws.send(JSON.stringify(message));
    }
}
