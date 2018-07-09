'use strict';

const EventEmitter = require('events');
const dgram = require('dgram');
const Base = require('../base/base.js');
const BaseUtil = require('../base/util.js');
const PackageModule = require('../bdt/package.js');
const ResendQueue = require('./resend_queue.js');
const PeerInfoCache = require('./peerinfo_cache.js');
const SNDHT = require('./sn_dht.js');
const SequenceU32 = BaseUtil.SequenceU32;

const LOG_INFO = Base.BX_INFO;
const LOG_WARN = Base.BX_WARN;
const LOG_DEBUG = Base.BX_DEBUG;
const LOG_CHECK = Base.BX_CHECK;
const LOG_ASSERT = Base.BX_ASSERT;
const LOG_ERROR = Base.BX_ERROR;

const BDTPackage = PackageModule.BDTPackage;
const BDT_ERROR = PackageModule.BDT_ERROR;

const Result = {
    SUCCESS: 0,
    FAILED: 1,
    PENDING: 2,
    
    PEERID_NOT_VALID: 100,
    PEERID_NOT_FOUND: 101,
    PEERID_FIND_LOCAL: 102,
    PEERID_FIND_REMOTE: 103,
    
    DEST_PEERID_NOT_FOUND: 104,
    DEST_PEERID_FIND_LOCAL: 105,
    DEST_PEERID_FIND_REMOTE: 106,
    
    SRC_PEERID_NOT_FOUND: 107,
    SRC_PEERID_FIND_LOCAL: 108,
    SRC_PEERID_FIND_REMOTE: 109,

    CACHE_FULL: 110,

    CMD_NOT_SUPPORT: 150,
};

class PackageHelper {
    constructor() {
        this.m_nextSeq = SequenceU32.random();
    }

    createPackage(cmdType) {
        let cmdPackage = {
            header: {
                'magic': BDTPackage.MAGIC,
                'version': BDTPackage.VERSION,
                'flags': 0,
                'cmdType': cmdType,
                'totalLength': 0,
                'headerLength': BDTPackage.HEADER_LENGTH,
                'bodyLength': 0,
                'src': {
                    'vport': 0,
                    'peeridHash': 0,
                },
                'dest': {
                    'vport': 0,
                    'peeridHash': 0,
                },
                'seq': this._genSeq(),
                'ackSeq': 0,
                'sessionid': 0,
            },
            'body': null,
            'data': null,
        };
        
        return cmdPackage;
    }

    static parsePackage(buffer) {
        let cmdPackage = BDTPackage.createDecoder(buffer);
        cmdPackage.decodeHeader();
        cmdPackage.decodeBody();
        return cmdPackage;
    }

    _genSeq() {
        let seq = this.m_nextSeq;
        this.m_nextSeq = SequenceU32.add(this.m_nextSeq, 1);
        return seq;
    }
}

class SN extends EventEmitter {
    constructor(peerid, mixSocket, options) {
        super();
        this.m_peerid = peerid;
        this.m_peeridHash = BDTPackage.hashPeerid(peerid);
        this.m_packageHelper = new PackageHelper();
        this.m_server = mixSocket;
        this.m_snDHT = null;
        this.m_timer = null;
        this.m_stat = {
            hits: 0,
            miss: 0,
        };

        this.m_options = {
            resendInterval: 500,
            resendTimes: 5,
            resendQueueLimit: 4098,
            peerCacheLimit: 4098,
            peerCacheTimeout: 60000,
            pingDelay: 500,

            minOnlineTime2JoinDHT: 24 * 3600000, // 要启动SN，必须在线一天
            recentSNCacheTime: 120000, // 新上线其他SN保留2分钟，在此期间通知合适的peer在它上面上线
            refreshSNDHTInterval: 600000, // 更新DHT状态周期
        };

        if (options) {
            Object.assign(this.m_options, options);
        }

        this.m_peerCache = new PeerInfoCache({MAX_PEER_COUNT: this.m_options.peerCacheLimit, PEER_TIMEOUT: this.m_options.peerCacheTimeout});
        this.m_resendQueue = new ResendQueue({MAX_PACKAGE_COUNT: this.m_options.resendQueueLimit});
    }

    start() {
        if (!this.m_timer) {
            this.m_timer = setInterval(() => this.m_resendQueue.onTimer(), 200);
            setImmediate(() => this.emit(SN.EVENT.start));
        }
    }

    stop() {
        if (this.m_timer) {
            clearInterval(this.m_timer);
            this.m_timer = null;
            setImmediate(() => this.emit(SN.EVENT.stop));
        }
    }

    // handle the accept package
    process(socket, decoder, remote){
        let result = 0;
        decoder.decodeBody();
        
        LOG_INFO(`[SN]: got package ${BDTPackage.CMD_TYPE.toString(decoder.header.cmdType)}(seq = ${decoder.header.seq}) is sendto ${remote.address}: ${remote.port}`);
        switch(decoder.header.cmdType){
            case BDTPackage.CMD_TYPE.pingReq:
                return this._processPingReq(socket, decoder, remote);
            case BDTPackage.CMD_TYPE.callReq:
                return this._processCallReq(socket, decoder, remote);
            case BDTPackage.CMD_TYPE.sn2snReq:
                return this._processSN2SNReq(socket, decoder, remote);
            case BDTPackage.CMD_TYPE.calledResp:
                return this._processCalledResp(socket, decoder, remote);
            default:
                return Result.CMD_NOT_SUPPORT;
        }
    }
    
    // isSeed标识该SN节点是否作为SN网络中的种子SN，当客户端节点没有任何SN节点信息时可以从DHT网络中得到这类节点
    signinDHT(dht, isSeed) {
        if (!this.m_snDHT) {
            let options = {
                minOnlineTime2JoinDHT: this.m_options.minOnlineTime2JoinDHT,
                recentSNCacheTime: this.m_options.recentSNCacheTime,
                refreshSNDHTInterval: this.m_options.refreshSNDHTInterval,
            };
            this.m_snDHT = new SNDHT(dht, options);
        }
        this.m_snDHT.signinServer(isSeed);
    }

    signoutDHT() {
        if (this.m_snDHT) {
            this.m_snDHT.signoutServer();
            this.m_snDHT = null;
        }
    }

    get isJoinedDHT() {
        return this.m_snDHT && this.m_snDHT.isJoinedDHT;
    }

    isMyPackage(cmdPackage) {
        let cmdType = cmdPackage.header.cmdType;
        return cmdType === BDTPackage.CMD_TYPE.pingReq
            || cmdType === BDTPackage.CMD_TYPE.callReq
            || cmdType === BDTPackage.CMD_TYPE.calledResp
            || cmdType === BDTPackage.CMD_TYPE.sn2snReq
            || cmdType === BDTPackage.CMD_TYPE.sn2snResp;
    }

    isCreatedByMe(cmdPackage) {
        let cmdType = cmdPackage.header.cmdType;
        return cmdPackage.header.src.peeridHash === this.m_peeridHash
            && (cmdType === BDTPackage.CMD_TYPE.pingResp
            || cmdType === BDTPackage.CMD_TYPE.callResp
            || cmdType === BDTPackage.CMD_TYPE.calledReq
            || cmdType === BDTPackage.CMD_TYPE.sn2snReq
            || cmdType === BDTPackage.CMD_TYPE.sn2snResp);
    }

    _sendPackage(socket, cmdPackage, remote, resendPackgeId = null, timeout = 0) {
        let encoder = BDTPackage.createEncoder(cmdPackage);
        encoder.m_header = cmdPackage.header;
        encoder.m_body = cmdPackage.body;
        encoder.encode();
        this.m_server.send(
            encoder.buffer,
            [ BaseUtil.EndPoint.toString(remote) ],
            {
                ignoreCache: false,
                socket,
                dropBusyTCP: true,
                timeout,
            }
        );

        // UDP才重试
        if(resendPackgeId && remote.protocol === BaseUtil.EndPoint.PROTOCOL.udp) {
            this.m_resendQueue.addPackage(resendPackgeId, encoder.buffer, this.m_server, remote, this.m_options.resendInterval, this.m_options.resendTimes, null);
        }
        LOG_INFO(`[SN]: package ${BDTPackage.CMD_TYPE.toString(cmdPackage.header.cmdType)}(seq = ${cmdPackage.header.seq}) is sendto ${remote.address}: ${remote.port}`);
    }

    _processPingReq(socket, cmdPackage, remote) {
        LOG_INFO(`peer(${cmdPackage.body.peerid}:${BaseUtil.EndPoint.toString(remote)}) online.sessionid:${cmdPackage.header.sessionid}`);
        if(cmdPackage.body == null) {
            LOG_WARN('[SN]: processPingReq error, body is null');
            return Result.FAILED;
        }
    
        let reqBody = cmdPackage.body;
        let reqHeader = cmdPackage.header;
        let peerid = reqBody.peerid;
        let eplist = reqBody.eplist.slice(0);
    
        //发送 pingResp
        let pingResp = this.m_packageHelper.createPackage(BDTPackage.CMD_TYPE.pingResp);
        let respHeader = pingResp.header;
        let respBody = {
                result: 0,
                peerid: null,
                eplist: null,
            };
        pingResp.body =  respBody;
        respHeader.sessionid = reqHeader.sessionid;
        respHeader.src.peeridHash = this.m_peeridHash;
        respHeader.dest.peeridHash = reqHeader.src.peeridHash;
        let hashpid = BDTPackage.hashPeerid(peerid);
        LOG_INFO(`[SN]: hash pid=${hashpid},src_peerid_hash=${cmdPackage.header.src.peeridHash}`);

        if (hashpid === reqHeader.src.peeridHash) {
            LOG_INFO('[SN]: CHECK OK,can update peer info');
            respBody.result = 0;
            respBody.peerid = reqBody.peerid;
        
            if (this.m_snDHT) {
                if (!this.m_snDHT.isJoinedDHT) {
                    respBody.offline = true;
                } else {
                    let nearSN = this.m_snDHT.getNearSN(reqBody.peerid).peerid;
                    if (nearSN && nearSN !== this.m_peerid) {
                        respBody.nearSN = nearSN;
                    }
                }
            }

            // 如果一个endpoint的ip是0地址或者内网ip
            // 并且这个endpoint的协议是tcp协议,
            // 就需要做NAT转换
            eplist.forEach( ep => {
                const [isOk, newEp ] = BaseUtil.EndPoint.conjectureEndPoint(ep, remote);
                if ( isOk ) {
                    eplist.push(newEp);
                }
            })

            // Public network ep
            let wlanEPString = BaseUtil.EndPoint.toString(remote)
            eplist.push(wlanEPString)

            // eplist remove duplicate
            eplist = Array.from(new Set(eplist))


            LOG_INFO(`[SN]: UPDATE info,peerid: ${peerid} ,eplist: ${eplist.toString()}`);

            // mount the eplist to response
            respBody.eplist = eplist;
            //update peer info
            this.m_peerCache.update(peerid, respBody, remote);
        } else {
            LOG_WARN(`[SN]: CHECK FAILED,cann\'t update peer info,hashpid != cmdPackage.src_peerid_hash,peerid:${peerid}`);
            respBody.result = 1;
        }

        respHeader.ackSeq = cmdPackage.header.seq;
        this._sendPackage(socket, pingResp, remote, null, this.m_options.pingDelay);
    
        return Result.SUCCESS;
    }
    
    _broadcastCallMessage(destPeerAddress, destPeerid, srcPeerid, srcPeerEplist, callReq) {
        let calledReq = this.m_packageHelper.createPackage(BDTPackage.CMD_TYPE.calledReq);
        let calledHeader = calledReq.header;
        calledHeader.seq = callReq.header.seq;
        calledHeader.src.vport = callReq.header.src.vport;
        calledHeader.dest.vport = callReq.header.dest.vport;
        calledHeader.src.peeridHash = callReq.header.src.peeridHash;
        calledHeader.dest.peeridHash = callReq.header.dest.peeridHash;
        calledHeader.sessionid = callReq.header.sessionid;
    
        if (callReq.body.eplist) {
            let srcEPSet = new Set([...srcPeerEplist, ...callReq.body.eplist]);
            srcPeerEplist = [...srcEPSet];
        }
        let calledBody = {
            src: srcPeerid,
            dest: destPeerid,
            eplist: Array.from(srcPeerEplist),
        };
        calledReq.body = calledBody;
    
        let resendPackageId = ResendQueue.genPackageID(BDTPackage.CMD_TYPE.calledReq, callReq.header.src.peeridHash, calledHeader.seq);
        this._sendPackage(null, calledReq, destPeerAddress, resendPackageId);
    }
    
    _processCallReq(socket, cmdPackage, remote) {
        if(cmdPackage.body == null) {
            LOG_WARN('[SN]: body is null');
            return Result.FAILED;
        }
    
        let reqHeader = cmdPackage.header;
        let reqBody = cmdPackage.body;
        let srcPeerid = reqBody.src;
        let destPeerid = reqBody.dest;
        
        let callResp = this.m_packageHelper.createPackage(BDTPackage.CMD_TYPE.callResp);
        let respHeader = callResp.header;
        respHeader.ackSeq = reqHeader.seq;
        respHeader.src.vport = reqHeader.dest.vport;
        respHeader.dest.vport = reqHeader.src.vport;
        respHeader.src.peeridHash = reqHeader.dest.peeridHash;
        respHeader.dest.peeridHash = reqHeader.src.peeridHash;
        respHeader.sessionid = reqHeader.sessionid;

        LOG_INFO(`[SN]: call remote peer, ${srcPeerid} -> ${destPeerid}`);
        
        let sendCallResp = (result, eplist, lastUpdateTime) => {
            LOG_INFO(`[SN]: will send call resp, result:${result}, ${srcPeerid} -> ${destPeerid}`);
    
            let respBody = {
                    'src': reqBody.dest,
                    'dest': reqBody.src,
                    'result': result,
                };
            if (eplist) {
                respBody.eplist = Array.from(eplist);
                respBody.time = lastUpdateTime || 0;
            }

            let nearSN = this.m_snDHT.getNearSN(destPeerid, true);
            if (nearSN && nearSN.peerid !== this.m_peerid && nearSN.eplist && nearSN.eplist.length > 0) {
                respBody.nearSN = {peerid: nearSN.peerid, eplist: nearSN.eplist};
            }
            callResp.body = respBody;
            this._sendPackage(socket, callResp, remote);
        };
    
        let sendSN2SN = (srcPeerInfo, destPeerInfo) => {
            LOG_INFO(`[SN]: will send sn2sn ${srcPeerid} -> ${destPeerid}`);
            let sn2snReq = this.m_packageHelper.createPackage(BDTPackage.CMD_TYPE.sn2snReq);
            let sn2snHeader = sn2snReq.header;
            sn2snHeader.src.peeridHash = BDTPackage.hashPeerid(this.m_perid);
            sn2snHeader.dest.peeridHash = BDTPackage.hashPeerid(destPeerInfo.peerid);
            sn2snHeader.sessionid = reqHeader.sessionid;

            let sn2snBody = {
                    src: {
                        peeridHash: reqHeader.src.peeridHash,
                        peerid: srcPeerid,
                        eplist: Array.from(srcPeerInfo.eplist.keys()),
                    },
                    dest: {
                        peeridHash: reqHeader.dest.peeridHash,
                        peerid: destPeerid,
                    }
                };
            sn2snReq.body = sn2snBody;

            let snAddr = {};
            snAddr.address = destPeerInfo.address;
            snAddr.port = destPeerInfo.port;
            this._sendPackage(null, sn2snReq, snAddr);
        };
    
        let checkPeerid = () => {
            return BDTPackage.hashPeerid(srcPeerid) === reqHeader.src.peeridHash
                && BDTPackage.hashPeerid(destPeerid) === reqHeader.dest.peeridHash;
        };
    
        if(!checkPeerid()){
            sendCallResp(Result.PEERID_NOT_VALID);
            return Result.PEERID_NOT_VALID;
        }
    
        let destPeerInfo = this.m_peerCache.getPeerInfo(destPeerid);
        let wlanEPString = BaseUtil.EndPoint.toString(remote);
        if (destPeerInfo) {
            this.m_stat.hits++;
            let srcPeerInfo = this.m_peerCache.getPeerInfo(srcPeerid);
            if (srcPeerInfo) {
                srcPeerInfo.eplist.set(wlanEPString, Date.now());
                this._broadcastCallMessage(destPeerInfo.address, destPeerInfo.peerid, srcPeerInfo.peerid, srcPeerInfo.eplist.keys(), cmdPackage);
                sendCallResp(Result.SUCCESS, destPeerInfo.eplist.keys(), destPeerInfo.lastUpdateTime);
                return Result.SUCCESS;
            } else {
                this._broadcastCallMessage(destPeerInfo.address, destPeerInfo.peerid, srcPeerid, [wlanEPString], cmdPackage);
                sendCallResp(Result.SUCCESS, destPeerInfo.eplist.keys(), destPeerInfo.lastUpdateTime);
                return Result.SUCCESS;
            }
            LOG_INFO(`Found dest peer(${srcPeerid}-${destPeerid}) from sn`);
        } else {
            sendCallResp(Result.DEST_PEERID_NOT_FOUND);
            LOG_INFO(`Result.DEST_PEERID_NOT_FOUND (${srcPeerid}-${destPeerid}), cacheSize:${this.m_peerCache.peerCount}`);
            this.m_stat.miss++;
            // 没命中，客户端需要考虑重新搜索其他SN上线，或者通过其他手段找到对方(如DHT)
            return Result.DEST_PEERID_NOT_FOUND;
        }
    }
    
    _processSN2SNReq(socket, cmdPackage, remote, source) {
        if(cmdPackage.body == null) {
            LOG_WARN('[SN]: body is null');
            return Result.FAILED;
        }
    
        let reqHeader = cmdPackage.header;
        let reqBody = cmdPackage.body;
        let srcPeerid = reqBody.src.peerid;
        let destPeerid = reqBody.dest.peerid;
        let srcEPList = new Set(reqBody.src.eplist.keys());
        
        let callResp = this.m_packageHelper.createPackage(BDTPackage.CMD_TYPE.callResp);
        let respHeader = callResp.header;
        respHeader.ackSeq = reqHeader.seq;
        respHeader.src.vport = reqHeader.dest.vport;
        respHeader.dest.vport = reqHeader.src.vport;
        respHeader.src.peeridHash = reqHeader.dest.peeridHash;
        respHeader.dest.peeridHash = reqHeader.src.peeridHash;
    
        let checkPeerid = () => {
            return hashPeerid(srcPeerid) === reqBody.src.peeridHash
                && hashPeerid(destPeerid) === reqBody.dest.peeridHash;
        };
    
        // check
        if (!checkPeerid()) {
            LOG_WARN(`[SN]: warn: process sn2sn failed, peerid invalid, ret:Result.PEERID_NOT_VALID, ${srcPeerid} -> ${destPeerid}`);
            return Result.PEERID_NOT_VALID;
        }
    
        // find dest peer info
        let destPeerInfo = this.m_peerCache.getPeerInfo(destPeerid);
        if (destPeerInfo) {
            this._broadcastCallMessage(destPeerInfo.address, destPeerInfo.peerid, srcPeerid, srcEPList, cmdPackage);
        } else {
            LOG_WARN(`[SN]: warn: process sn2sn failed, dest peerid not fond, ret:Result.PEERID_NOT_FOUND, ${srcPeerid} -> ${destPeerid}`);
        }
    
        return Result.SUCCESS;
    }
    
    _processCalledResp(socket, cmdPackage,remote) {
        let header = cmdPackage.header;
        let calledReqPackageId = ResendQueue.genPackageID(BDTPackage.CMD_TYPE.calledReq, header.dest.peeridHash, header.ackSeq);
        this.m_resendQueue.confirmPackage(calledReqPackageId);
        return Result.SUCCESS;
    }

    // <TODO> 黑名单
    isAllowed(remoteAddress) {
        return true;
    }
}

SN.EVENT = {
    start: 'start',
    stop: 'stop',
}

module.exports = SN;