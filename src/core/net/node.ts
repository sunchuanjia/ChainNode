import { ErrorCode } from '../error_code';
import { IConnection } from './connection';
import { Package } from './package'; 
import { PackageStreamWriter } from './writer';
import { PackageStreamReader } from './reader';
import { EventEmitter } from 'events';
let assert = require('assert');
import {Version} from './version';
import { BufferReader } from '../lib/reader';
import { BufferWriter } from '../lib/writer';
import {LoggerOptions, LoggerInstance, initLogger} from '../lib/logger_util';

export enum CMD_TYPE {
    version= 0x01,
    versionAck = 0x02,

    userCmd = 0x10,
}

interface INodeConnection {
    addPendingWriter(writer: PackageStreamWriter): void;
    on(event: 'pkg', listener: (pkg: Package) => void): this;
    once(event: 'pkg', listener: (pkg: Package) => void): this;
}

export type NodeConnection = INodeConnection & IConnection;

export class INode extends EventEmitter {
    public async randomPeers(count: number): Promise<{err: ErrorCode, peers: string[]}> {
        return {err: ErrorCode.RESULT_NO_IMP, peers: []};
    }
    protected m_socket: any = null;
    protected m_port: number = 0;
    protected m_addr: string = '';
    protected m_peerid: string = '';
    // chain的创始块的hash值，从chain_node传入， 可用于传输中做校验
    protected m_genesis: string = '';

    protected m_inConn: NodeConnection[] = [];
    protected m_outConn: NodeConnection[] = [];
    protected m_remoteMap: Map<string, NodeConnection> = new Map();
    protected m_logger: LoggerInstance;

    constructor(options: {peerid: string} & LoggerOptions) {
        super();
        this.m_peerid = options.peerid;
        this.m_logger = initLogger(options);
    }

    set genesis_hash(genesis_hash: string) {
        this.m_genesis = genesis_hash;
    }

    get peerid() {
        return this.m_peerid;
    }

    public async init() {
    }

    public async listen(): Promise<ErrorCode> {
        return ErrorCode.RESULT_NO_IMP;
    }

    public async connectTo(peerid: string): Promise<{err: ErrorCode, peerid: string, conn?: NodeConnection}> {
        let result = await this._connectTo(peerid);
        if (!result.conn) {
            return {err: result.err, peerid};
        }
        let conn = result.conn;
        conn.setRemote(peerid);
        let ver: Version = new Version();
        ver.genesis = this.m_genesis;
        ver.peerid = this.m_peerid;
        let err = await new Promise((resolve: (value: ErrorCode) => void) => {
            conn.once('pkg', (pkg) => {
                conn.removeAllListeners('error');
                if (pkg.header.cmdType === CMD_TYPE.versionAck) {
                    if (pkg.body.isSupport) {
                        // 忽略网络传输时间
                        let nTimeDelta = pkg.body.timestamp - Date.now();
                        conn.setTimeDelta(nTimeDelta);
                        resolve(ErrorCode.RESULT_OK);
                    } else {
                        conn.close();
                        resolve(ErrorCode.RESULT_VER_NOT_SUPPORT);
                    }
                } else {
                    conn.close();
                    resolve(ErrorCode.RESULT_INVALID_STATE);
                }
            });
            let writer: BufferWriter = new BufferWriter();
            ver.encode(writer);
            let buf: Buffer = writer.render();
            let verWriter = PackageStreamWriter.fromPackage(CMD_TYPE.version, {}, buf.length).writeData(buf);
            conn.addPendingWriter(verWriter);
            conn.once('error', (_conn: IConnection, _err: ErrorCode) => {
                _conn.close(); 
                resolve(_err);
            });
        });
        if (err) {
            return {err, peerid}; 
        }
        this.m_outConn.push(result.conn);
        this.m_remoteMap.set(peerid, result.conn);
        conn.on('error', (_conn: IConnection, _err: ErrorCode) => {
            this.emit('error', result.conn, _err);
        });
        return {err: ErrorCode.RESULT_OK, peerid, conn};
    }

    public async broadcast(writer: PackageStreamWriter, options?: {count?: number, filter?: (conn: NodeConnection) => boolean}): Promise<{err: ErrorCode, count: number}> {
        let nSend: number = 0;
        let nMax: number = 999999999;
        if (options && options.count) {
            nMax = options.count;
        }
        for (let conn of this.m_inConn) {
            if (nSend === nMax) {
                return {err: ErrorCode.RESULT_OK, count: nSend};
            }
            if (!options || !options.filter || options!.filter!(conn)) {
                conn.addPendingWriter(writer.clone());
                nSend++;
            }
        }

        for (let conn of this.m_outConn) {
            if (nSend === nMax) {
                return {err: ErrorCode.RESULT_OK, count: nSend};
            }
            if (!options || !options.filter || options!.filter!(conn)) {
                conn.addPendingWriter(writer.clone());
                nSend++;
            }
        }
        return {err: ErrorCode.RESULT_OK, count: nSend};
    } 

    public isInbound(conn: NodeConnection): boolean {
        for (let c of this.m_inConn) {
            if (c === conn) {
                return true;
            }
        }
        return false;
    }

    public getOutbounds(): NodeConnection[] {
        return this.m_outConn;
    }

    public getConnection(remote: string): NodeConnection|undefined {
        return this.m_remoteMap.get(remote);
    }

    public isOutbound(conn: NodeConnection): boolean {
        for (let c of this.m_outConn) {
            if (c === conn) {
                return true;
            }
        }
        return false;
    }

    public banConnection(remote: string): void {
        // TODO: 要写到一个什么地方，禁多久，忽略这个peer
        let conn = this.m_remoteMap.get(remote);
        if (conn) {
            this.closeConnection(conn);
        }
    }
    
    public closeConnection(conn: NodeConnection): void {
        conn.removeAllListeners('error');
        conn.removeAllListeners('pkg');
        conn.once('close', (obj) => {
            let index: number = 0;
            for (let c of this.m_outConn) {
                if (c === conn) {
                    this.m_outConn.splice(index, 1);
                    return;
                }
                index++;
            }
            index = 0;
            for (let c of this.m_inConn) {
                if (c === conn) {
                    this.m_inConn.splice(index, 1);
                    return;
                }
                index++;
            }

            this.m_remoteMap.delete(conn.getRemote());
        });
        conn.close();
    }

    on(event: 'inbound', listener: (conn: NodeConnection) => void): this;
    on(event: 'error', listener: (conn: NodeConnection, err: ErrorCode) => void): this;
    on(event: 'ban', listener: (remote: string) => void): this;
    on(event: string, listener: any): this {
        return super.on(event, listener);
    }
    once(event: 'inbound', listener: (conn: NodeConnection) => void): this;
    once(event: 'error', listener: (conn: NodeConnection, err: ErrorCode) => void): this;
    once(event: string, listener: any): this {
        return super.once(event, listener);
    }

    protected _onInbound(inbound: NodeConnection) {
        inbound.once('pkg', (pkg) => {
            inbound.removeAllListeners('error');
            if (pkg.header.cmdType === CMD_TYPE.version) {
                let buff = pkg.data[0];
                let dataReader: BufferReader = new BufferReader(buff);
                let ver: Version = new Version();
                let err = ver.decode(dataReader);
                if (err) {
                    this.m_logger.warn(`recv version in invalid format from ${inbound.getRemote()} `);
                    inbound.close();
                    return;
                }
                // 检查对方包里的genesis_hash是否对应得上
                if ( ver.genesis !== this.m_genesis ) {
                    this.m_logger.warn(`recv version genesis ${ver.genesis} not match ${this.m_genesis} from ${inbound.getRemote()} `);
                    inbound.close();
                    return;
                }
                // 忽略网络传输时间
                let nTimeDelta = ver.timestamp - Date.now();
                inbound.setRemote(ver.peerid);
                inbound.setTimeDelta(nTimeDelta);
                let isSupport = true;
                let ackWriter = PackageStreamWriter.fromPackage(CMD_TYPE.versionAck, { isSupport, timestamp: Date.now() }, 0);
                inbound.addPendingWriter(ackWriter);
                if (!isSupport) {
                    inbound.close();
                    return;
                }
                this.m_inConn.push(inbound);
                this.m_remoteMap.set(ver.peerid, inbound);
                inbound.on('error', (conn: IConnection, _err: ErrorCode) => {
                    this.emit('error', inbound, _err);
                });
                this.emit('inbound', inbound);
            } else {
                inbound.close();
            }
        });
        inbound.once('error', () => {
            inbound.close();
        });
    }

    protected async _connectTo(peerid: string): Promise<{err: ErrorCode, conn?: NodeConnection}> {
        return {err: ErrorCode.RESULT_NO_IMP};
    }
    protected _connectionType(): new(...args: any[]) => IConnection {
        return IConnection;
    }
    protected _nodeConnectionType() {
        let superClass = this._connectionType();
        return class extends superClass {
            constructor(...args: any[]) {
                assert(args.length);
                let thisNode = args[0];
                super(...(args.slice(1)));
                this.m_pendingWriters = [];
                this.m_reader = new PackageStreamReader();
                this.m_reader.start(this);
                this.m_reader.on('pkg', (pkg) => {
                    super.emit('pkg', pkg);
                });
                super.on('error', (conn: IConnection, err: ErrorCode) => {
                    thisNode.closeConnection(this);
                    thisNode.emit('error', this, err);
                });

                // 接收到 reader的传出来的error 事件后, emit ban事件, 给上层的chain_node去做处理
                // 这里只需要emit给上层, 最好不要处理其他逻辑
                this.m_reader.on('error', (err: ErrorCode, column: string ) => {
                    let remote = this.getRemote();
                    thisNode.emit('ban', remote);
                });
            }
            private m_pendingWriters: PackageStreamWriter[];
            private m_reader: PackageStreamReader;
            addPendingWriter(writer: PackageStreamWriter): void {
                let onFinish = () => {
                    let _writer = this.m_pendingWriters.splice(0, 1)[0];
                    _writer.close();
                    if (this.m_pendingWriters.length) {
                        this.m_pendingWriters[0].bind(this);
                        this.m_pendingWriters[0].on('finish', onFinish);
                    }
                };
                if (!this.m_pendingWriters.length) {
                    writer.bind(this);
                    writer.on('finish', onFinish);
                } 
                this.m_pendingWriters.push(writer);
            }

            async close(): Promise<ErrorCode> {
                for (let w of this.m_pendingWriters) {
                    w.close();
                }
                this.m_pendingWriters = [];
                return await super.close();
            }
        };
    }
}