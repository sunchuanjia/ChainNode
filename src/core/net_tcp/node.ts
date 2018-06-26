import {ErrorCode} from '../error_code';
import {Server, Socket} from 'net';
import * as EventEmitter from 'events';
import {NodeConnection, INode} from '../net/node';
import {IConnection} from '../net/connection';
import {Connection} from './connection';
const assert = require('assert');
import { read } from 'fs-extra';

export class Node extends INode {
    private m_options: any;
    private m_server: Server;

    constructor(options: {host: string, port: number}) {
        super({peerid: `${options.host}:${options.port}`});
        this.m_options = Object.create(null);
        Object.assign(this.m_options, options);
        this.m_server = new Server();
    }

    protected _connectTo(peerid: string): Promise<{err: ErrorCode, conn?: NodeConnection}> {
        let [host, port] = peerid.split(':');
        let tcp = new Socket();
        return new Promise((resolve, reject)=>{
            tcp.once('error', (e)=>{
                tcp.removeAllListeners('connect');
                resolve({err: ErrorCode.RESULT_EXCEPTION});
            });
            tcp.connect({host, port: parseInt(port)});
            tcp.once('connect', ()=>{
                let connNodeType = this._nodeConnectionType();
                let connNode: any = (new connNodeType(this, {socket: tcp , remote: peerid}));
                tcp.removeAllListeners('error');
                tcp.on('error', (e) => {this.emit('error', connNode, ErrorCode.RESULT_EXCEPTION);});
                resolve({err: ErrorCode.RESULT_OK, conn: connNode});
            });
        });
    }

    protected _connectionType(): new(...args: any[]) => IConnection {
        return Connection;
    }

    public listen(): Promise<ErrorCode> {
        return new Promise((resolve, reject)=>{
            this.m_server.listen(this.m_options.port, this.m_options.host);
            this.m_server.once('listening', ()=>{
                this.m_server.removeAllListeners('error');
                this.m_server.on('connection', (tcp: Socket)=>{
                    let connNodeType = this._nodeConnectionType();
                    let connNode: any = (new connNodeType(this, { socket: tcp, remote: `${tcp.remoteAddress}:${tcp.remotePort}` }));
                    tcp.on('error', (e) => {this.emit('error', connNode, ErrorCode.RESULT_EXCEPTION);});
                    this._onInbound(connNode);
                });
                resolve(ErrorCode.RESULT_OK);
            });
            this.m_server.once('error', (e)=>{
                this.m_server.removeAllListeners('listening');
                reject(ErrorCode.RESULT_EXCEPTION);
            });
        });
    }
}