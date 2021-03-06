import { ErrorCode } from '../error_code';
import { INode } from './node';

// this can be used to map peerid to ip & port
export function mapInstance(superClass: new (...args: any[]) => INode) {
    return class extends superClass {
        protected m_peeridToIp: Map<string, { host: string, port: number }>;

        constructor(...args: any[]) {

            super(...args);
            //    super(...args.slice(1));   This is a mistake!
            this.m_peeridToIp = new Map();
            let iph = args[0];
            // for (let peerid of Object.keys(iph)) {
            //     let [host, port] = (iph[peerid] as string).split(':');
            //     this.m_peeridToIp.set(peerid, { host, port: parseInt(port) });
            // }

            for (let item of iph) {
                let [host, port, peerid] = (item as string).split(':');
                this.m_peeridToIp.set(peerid, { host, port: parseInt(port) });
                console.log(peerid, { host, port: parseInt(port) })
            }

        }

        protected async _peeridToIpAddress(peerid: string): Promise<{ err: ErrorCode, ip?: { host: string, port: number } }> {
            let iph = this.m_peeridToIp.get(peerid);
            if (!iph) {
                return { err: ErrorCode.RESULT_NOT_FOUND };
            }
            return { err: ErrorCode.RESULT_OK, ip: iph };
        }

    };
}

export function splitInstance(superClass: new (...args: any[]) => INode) {
    return class extends superClass {
        constructor(...args: any[]) {
            super(...args);
        }

        protected async _peeridToIpAddress(peerid: string): Promise<{ err: ErrorCode, ip?: { host: string, port: number } }> {
            let [host, port] = peerid.split(':');
            return { err: ErrorCode.RESULT_OK, ip: { host, port: parseInt(port) } };
        }
    };
}