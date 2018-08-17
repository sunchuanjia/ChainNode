import {ErrorCode} from '../error_code';
import {Socket} from 'net';
import {IConnection} from '../net';

export class TcpConnection extends IConnection {
    private m_socket: Socket;
    private m_pending: boolean;
    private m_remote: string;
    protected m_nTimeDelta: number = 0;
    constructor(options: {socket: Socket, remote: string}) {
        super();
        this.m_socket = options.socket;
        this.m_socket.on('drain', () => {
            this.m_pending = false;
            this.emit('drain');
        });
        this.m_socket.on('data', (data: Buffer) => {
            this.emit('data', [data]);
        });
        this.m_socket.on('error', (err) => {
            this.emit('error', this, ErrorCode.RESULT_EXCEPTION);
        });
        this.m_pending = false;
        this.m_remote = options.remote;
    }

    send(data: Buffer): number {
        if (this.m_pending) {
            return 0;
        } else {
            this.m_pending = !this.m_socket.write(data);
            return data.length;
        }
    }
    close(): Promise<ErrorCode> {
        if (this.m_socket) {
            this.m_socket.end();
            delete this.m_socket; 
        }
        this.emit('close', this);
        return Promise.resolve(ErrorCode.RESULT_OK);
    }

    getRemote(): string {
        return this.m_remote;
    }

    setRemote(s: string) {
        this.m_remote = s;
    }

    getTimeDelta(): number {
        return this.m_nTimeDelta;
    }

    setTimeDelta(n: number) {
        this.m_nTimeDelta = n;
    }
}