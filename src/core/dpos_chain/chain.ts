import { BigNumber } from 'bignumber.js';
import { ErrorCode } from '../error_code';
import {Chain, ChainTypeOptions, Block, ValueTransactionContext, ValueEventContext, ValueViewContext, BaseHandler, ValueChain, Storage, BlockExecutor, BlockHeader, IReadableStorage, ViewExecutor} from '../value_chain';

import { DposBlockHeader } from './block';
import * as consensus from './consensus';
import * as ValueContext from '../value_chain/context';
import { DposBlockExecutor } from './executor';
import { LoggerOptions } from '../lib/logger_util';

export type DposTransactionContext = {
    vote: (from: string, candiates: string) => Promise<ErrorCode>;
    mortgage: (from: string, amount: BigNumber) => Promise<ErrorCode>;
    unmortgage: (from: string, amount: BigNumber) => Promise<ErrorCode>;
    register: (from: string) => Promise<ErrorCode>;
} & ValueTransactionContext;

export type DposEventContext = {
    vote: (from: string, candiates: string) => Promise<ErrorCode>;
    mortgage: (from: string, amount: BigNumber) => Promise<ErrorCode>;
    unmortgage: (from: string, amount: BigNumber) => Promise<ErrorCode>;
    register: (from: string) => Promise<ErrorCode>;
} & ValueEventContext;

export type DposViewContext = {
    getVote: () => Promise<Map<string, BigNumber> >;
    getStoke: (address: string) => Promise<BigNumber>;
    getCandidates: () => Promise<string[]>;
} & ValueViewContext;

const initMinersSql = 'CREATE TABLE IF NOT EXISTS "miners"("hash" CHAR(64) PRIMARY KEY NOT NULL UNIQUE, "miners" TEXT NOT NULL);';
const updateMinersSql = 'REPLACE INTO miners (hash, miners) values ($hash, $miners)';
const getMinersSql = 'SELECT miners FROM miners WHERE hash=$hash';

export class DposChain extends ValueChain {

    constructor(options: LoggerOptions) {
        super(options);
        // DPOS中，只广播tipheader
        this.m_broadcastDepth = 0;
    }

    public async initComponents(dataDir: string, handler: BaseHandler): Promise<ErrorCode> {
        let err = await super.initComponents(dataDir, handler);
        if (err) {
            return err;
        }

        try {
            await this.m_db!.run(initMinersSql);
            return ErrorCode.RESULT_OK;
        } catch (e) {
            this.logger.error(e);
            return ErrorCode.RESULT_EXCEPTION;
        }
    }

    public async newBlockExecutor(block: Block, storage: Storage): Promise<{err: ErrorCode, executor?: BlockExecutor}> {
        let kvBalance = (await storage.getKeyValue(Chain.dbSystem, ValueChain.kvBalance)).kv!;

        let ve = new ValueContext.Context(kvBalance);
        let externalContext = Object.create(null);
        externalContext.getBalance = async (address: string): Promise<BigNumber> => {
            return await ve.getBalance(address);
        };
        externalContext.transferTo = async (address: string, amount: BigNumber): Promise<ErrorCode> => {
            return await ve.transferTo(ValueChain.sysAddress, address, amount);
        };

        let dbr = await storage.getReadableDataBase(Chain.dbSystem);
        if (dbr.err) {
            return {err: dbr.err};
        }
        let de = new consensus.Context(dbr.value!, this.globalOptions, this.logger);
        externalContext.vote = async (from: string, candiates: string[]): Promise<ErrorCode> => {
            let vr = await de.vote(from, candiates);
            if (vr.err) {
                throw new Error();
            }
            return vr.returnCode!;
        };
        externalContext.mortgage = async (from: string, amount: BigNumber): Promise<ErrorCode> => {
            let mr = await de.mortgage(from, amount);
            if (mr.err) {
                throw new Error();
            }

            return mr.returnCode!;
        };
        externalContext.unmortgage = async (from: string, amount: BigNumber): Promise<ErrorCode> => {
            let mr = await de.unmortgage(from, amount);
            if (mr.err) {
                throw new Error();
            }

            return mr.returnCode!;
        };
        externalContext.register = async (from: string): Promise<ErrorCode> => {
            let mr = await de.registerToCandidate(from);
            if (mr.err) {
                throw new Error();
            }

            return mr.returnCode!;
        };
        externalContext.getVote = async (): Promise<Map<string, BigNumber> > => {
            let gvr = await de.getVote();
            if (gvr.err) {
                throw new Error();
            }
            return gvr.vote!;
        };
        externalContext.getStoke = async (address: string): Promise<BigNumber> => {
            let gsr = await de.getStoke(address);
            if (gsr.err) {
                throw new Error();
            }
            return gsr.stoke!;
        };
        externalContext.getCandidates = async (): Promise<string[]> => {
            let gc = await de.getCandidates();
            if (gc.err) {
                throw Error();
            }

            return gc.candidates!;
        };

        externalContext.getMiners = async (): Promise<string[]> => {
            let gm = await de.getNextMiners();
            if (gm.err) {
                throw Error();
            }

            return gm.creators!;
        };

        let executor = new DposBlockExecutor({logger: this.logger, block, storage, handler: this.handler, externContext: externalContext, globalOptions: this.globalOptions!});
        return {err: ErrorCode.RESULT_OK, executor: executor as BlockExecutor};
    }

    public async newViewExecutor(header: BlockHeader, storage: IReadableStorage, method: string, param: Buffer|string|number|undefined): Promise<{err: ErrorCode, executor?: ViewExecutor}> {
        let nvex = await super.newViewExecutor(header, storage, method, param);

        let externalContext = nvex.executor!.externContext;
        let dbr = await storage.getReadableDataBase(Chain.dbSystem);
        if (dbr.err) {
            return {err: dbr.err};
        }
        let de = new consensus.Context(dbr.value!, this.globalOptions, this.logger);

        externalContext.getVote = async (): Promise<Map<string, BigNumber> > => {
            let gvr = await de.getVote();
            if (gvr.err) {
                throw new Error();
            }
            return gvr.vote!;
        };
        externalContext.getStoke = async (address: string): Promise<BigNumber> => {
            let gsr = await de.getStoke(address);
            if (gsr.err) {
                throw new Error();
            }
            return gsr.stoke!;
        };
        externalContext.getCandidates = async (): Promise<string[]> => {
            let gc = await de.getCandidates();
            if (gc.err) {
                throw Error();
            }

            return gc.candidates!;
        };

        return nvex;
    }

    protected async _compareWork(left: DposBlockHeader, right: DposBlockHeader): Promise<{err: ErrorCode, result?: number}> {
        // 更长的链优先
        let height = left.number - right.number;
        if (height !== 0) {
            return {err: ErrorCode.RESULT_OK, result: height};
        }
        // 高度相同更晚的优先
        let tir = await left.getTimeIndex(this);
        if (tir.err) {
            return {err: tir.err};
        }
        let leftIndex = tir.index!;
        tir = await right.getTimeIndex(this);
        if (tir.err) {
            return {err: tir.err};
        }
        let rightIndex = tir.index!;
        let time = leftIndex - rightIndex;
        if (time !== 0) {
            return {err: ErrorCode.RESULT_OK, result: time};
        }
        // 时间戳都相同， 就算了， 很罕见吧， 随缘
        return {err: ErrorCode.RESULT_OK, result: time}; 
    }

    protected async _calcuteReqLimit(fromHeader: string, limit: number) {
        let hr = await this.getHeader(fromHeader);
        let reSelectionBlocks = this.globalOptions!.reSelectionBlocks;
        return reSelectionBlocks - (hr.header!.number % reSelectionBlocks);
    }

    public async getMiners(header: DposBlockHeader): Promise<{err: ErrorCode, header?: DposBlockHeader, creators?: string[]}> {
        let en = consensus.ViewContext.getElectionBlockNumber(this.globalOptions, header.number);
        let electionHeader: DposBlockHeader;
        if (header.number === en) {
            electionHeader = header;
        } else {
            let hr = await this.getHeader(header.preBlockHash, en - header.number + 1);
            if (hr.err) {
                this.logger.error(`get electionHeader error,number=${header.number},prevblockhash=${header.preBlockHash}`);
                return { err: hr.err };
            }
            electionHeader = hr.header as DposBlockHeader;
        }

        try {
            const gm = await this.m_db!.get(getMinersSql, {$hash: electionHeader.hash});
            if (!gm || !gm.miners) {
                this.logger.error(`getMinersSql error,election block hash=${electionHeader.hash},en=${en},header.height=${header.number}`);
                return {err: ErrorCode.RESULT_NOT_FOUND};
            }

            return {err: ErrorCode.RESULT_OK, header: electionHeader, creators: JSON.parse(gm.miners)};
        } catch (e) {
            this.logger.error(e);
            return {err: ErrorCode.RESULT_EXCEPTION};
        }
    }

    protected async _onVerifiedBlock(block: Block): Promise<ErrorCode> {
        if (block.number !== 0 && block.number % this.globalOptions.reSelectionBlocks !== 0) {
            return ErrorCode.RESULT_OK;
        }

        let gs = await this.storageManager.getSnapshotView(block.hash);
        if (gs.err) {
            return gs.err;
        }
        let dbr = await gs.storage!.getReadableDataBase(Chain.dbSystem);
        if (dbr.err) {
            return dbr.err;
        }
        let denv = new consensus.ViewContext(dbr.value!, this.globalOptions, this.m_logger!);
        let minersInfo = await denv.getNextMiners();
        this.storageManager.releaseSnapshotView(block.hash);
        if (minersInfo.err) {
            return minersInfo.err;
        }
        try {
            await this.m_db!.run(updateMinersSql, {$hash: block.hash, $miners: JSON.stringify(minersInfo.creators!)});
            return ErrorCode.RESULT_OK;
        } catch (e) {
            this.logger.error(e);
            return ErrorCode.RESULT_EXCEPTION;
        }
    }

    onCheckGlobalOptions(globalOptions: any): boolean {
        if (!super.onCheckGlobalOptions(globalOptions)) {
            return false;
        }
        return consensus.onCheckGlobalOptions(globalOptions);
    }

    protected _getBlockHeaderType() {
        return DposBlockHeader;
    }

    protected _onCheckTypeOptions(typeOptions: ChainTypeOptions): boolean {
        return typeOptions.consensus === 'dpos';
    }
}