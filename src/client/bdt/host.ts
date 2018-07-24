import {Options as CommandOptions} from '../lib/simple_command';
import {BdtNode} from '../../core';

import chainHost = require('../host/chain_host');

chainHost.registerNet('bdt', (commandOptions: CommandOptions): any => {
    let host = commandOptions.get('host');
    if (!host) {
        console.error('invalid bdt host');
        return ;
    }
    let port = commandOptions.get('port');
    if (!port) {
        console.error('no bdt port');
        return ;
    }

    port = (port as string).split('|');
    let udpport = 0;
    let tcpport = parseInt(port[0]);

    if (port.length === 1) {
        udpport = tcpport + 10;
    } else {
        udpport = parseInt(port[1]);
    }

    if (isNaN(tcpport) || isNaN(udpport)) {
        console.error('invalid bdt port');
        return ;
    }

    let peerid = commandOptions.get('peerid');
    if (!peerid) {
        peerid = `${host}:${port}`;
    }
    let snPeers = commandOptions.get('sn');
    if (!snPeers) {
        console.error('no sn');
        return ;
    }
    let snconfig = (snPeers as string).split('@');
    if (snconfig.length !== 4) {
        console.error('invalid sn: <SN_PEERID>@<SN_IP>@<SN_TCP_PORT>@<SN_UDP_PORT>');
    }
    const snPeer = {
        peerid: `${snconfig[0]}`,
        eplist: [
            `4@${snconfig[1]}@${snconfig[2]}@t`,
            `4@${snconfig[1]}@${snconfig[3]}@u`
        ]
    };
    let bdt_logger = {
        level: commandOptions.get('bdt_log_level') || 'info',
        // 设置log目录
        file_dir: commandOptions.get('dataDir') + '/log',
    };

    return new BdtNode({host, tcpport, udpport, peerid, snPeer, bdtLoggerOptions: bdt_logger});

});
