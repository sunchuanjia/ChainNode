import * as sqlite from 'sqlite';
import { BlockHeader } from './block';
import { BufferWriter } from '../lib/writer';
import { BufferReader } from '../lib/reader';
import { ErrorCode } from '../error_code';
import * as assert from 'assert';
import { LoggerInstance } from 'winston';
import {LRUCache} from '../lib/LRUCache';
import { isArray } from 'util';
import { Lock } from '../lib/Lock';
import {TxStorage} from './tx_storage';
import {BlockStorage} from './block_storage';


const initHeaderSql = 'CREATE TABLE IF NOT EXISTS "headers"("hash" CHAR(64) PRIMARY KEY NOT NULL UNIQUE, "pre" CHAR(64) NOT NULL, "verified" TINYINT NOT NULL, "raw" BLOB NOT NULL);';
const initBestSql = 'CREATE TABLE IF NOT EXISTS "best"("height" INTEGER PRIMARY KEY NOT NULL UNIQUE, "hash" CHAR(64) NOT NULL,  "timestamp" INTEGER NOT NULL);'
const getByHashSql = 'SELECT raw, verified FROM headers WHERE hash = $hash';
const getByTimestampSql = 'SELECT h.raw, h.verified FROM headers AS h LEFT JOIN best AS b ON b.hash = h.hash WHERE b.timestamp = $timestamp';
const getHeightOnBestSql = 'SELECT b.height, h.raw, h.verified FROM headers AS h LEFT JOIN best AS b ON b.hash = h.hash WHERE b.hash = $hash';
const getByHeightSql = 'SELECT h.raw, h.verified FROM headers AS h LEFT JOIN best AS b ON b.hash = h.hash WHERE b.height = $height';
const insertHeaderSql = 'INSERT INTO headers (hash, pre, raw, verified) VALUES($hash, $pre, $raw, $verified)';
const getBestHeightSql = 'SELECT max(height) AS height FROM best';
const rollbackBestSql = 'DELETE best WHERE height > $height';
const extendBestSql = 'INSERT INTO best (hash, height, timestamp) VALUES($hash, $height, $timestamp)';
const getTipSql = 'SELECT h.raw, h.verified FROM headers AS h LEFT JOIN best AS b ON b.hash = h.hash ORDER BY b.height DESC';
const updateVerifiedSql = 'UPDATE headers SET verified=$verified WHERE hash=$hash';
const getByPreBlockSql = 'SELECT raw, verified FROM headers WHERE pre = $pre';

export enum VERIFY_STATE {
    notVerified = 0,
    verified = 1,
    invalid = 2
};

class BlockHeaderEntry {
    public blockheader: BlockHeader;
    public verified: VERIFY_STATE;
    constructor (blockheader: BlockHeader, verified: VERIFY_STATE) {
        this.blockheader = blockheader;
        this.verified = verified;
    }
}

// TODO: 在db之上需要一级LRU缓存提高性能
export class HeaderStorage {
    private m_db: sqlite.Database;
    private m_blockHeaderType: new () => BlockHeader;
    
    private m_logger: LoggerInstance;

    protected m_cacheHeight: LRUCache<number, BlockHeaderEntry>;
    protected m_cacheHash: LRUCache<string, BlockHeaderEntry>;
    private m_transactionLock = new Lock();

    private m_txView: TxStorage;

    constructor(options: {
        logger: LoggerInstance;
        blockHeaderType: new () => BlockHeader, 
        db: sqlite.Database, 
        blockStorage: BlockStorage
    }) {
        this.m_db = options.db;
        this.m_blockHeaderType = options.blockHeaderType;
        this.m_logger = options.logger;
        this.m_cacheHeight = new LRUCache<number, BlockHeaderEntry>(100);
        this.m_cacheHash = new LRUCache<string, BlockHeaderEntry>(100);
        this.m_txView = new TxStorage({logger: options.logger, db: options.db, blockstorage: options.blockStorage});
    }

    get txview(): TxStorage {
        return this.m_txView;
    }

    public async init(): Promise<ErrorCode> {
        try {
            let stmt = await this.m_db.run(initHeaderSql);
            stmt = await this.m_db.run(initBestSql);
        } catch (e) {
            this.m_logger.error(e);
            return ErrorCode.RESULT_EXCEPTION;
        }

        return await this.m_txView.init();
    }

    public async loadHeader(arg: number | string): Promise<{ err: ErrorCode, header?: BlockHeader, verified?: VERIFY_STATE }> {
        let rawHeader: Buffer;
        let verified: VERIFY_STATE;
        if (typeof arg === 'number') {
            let headerEntry: BlockHeaderEntry|null = this.m_cacheHeight.get(arg as number);
            if (headerEntry) {
                return {err: ErrorCode.RESULT_OK, header: headerEntry.blockheader, verified: headerEntry.verified};
            }
            try {
                let result = await this.m_db.get(getByHeightSql, { $height: arg });
                if (!result) {
                    return { err: ErrorCode.RESULT_NOT_FOUND };
                }
                rawHeader = result.raw;
                verified = result.verified;
            } catch (e) {
                this.m_logger.error(`load Header height ${arg} failed, ${e}`);
                return { err: ErrorCode.RESULT_EXCEPTION };
            }
        } else if (typeof arg === 'string') {
            if (arg === 'latest') {
                try {
                    let result = await this.m_db.get(getTipSql);
                    if (!result) {
                        return { err: ErrorCode.RESULT_NOT_FOUND };
                    }
                    rawHeader = result.raw;
                    verified = result.verified;
                } catch (e) {
                    this.m_logger.error(`load latest Header failed, ${e}`);
                    return { err: ErrorCode.RESULT_EXCEPTION };
                }
            } else {
                let headerEntry: BlockHeaderEntry|null = this.m_cacheHash.get(arg as string);
                if (headerEntry) {
                    this.m_logger.debug(`get header storage directly from cache hash: ${headerEntry.blockheader.hash} number: ${headerEntry.blockheader.number} verified: ${headerEntry.verified}`);
                    return {err: ErrorCode.RESULT_OK, header: headerEntry.blockheader, verified: headerEntry.verified};
                }

                try {
                    let result = await this.m_db.get(getByHashSql, { $hash: arg });
                    if (!result) {
                        return { err: ErrorCode.RESULT_NOT_FOUND };
                    }
                    rawHeader = result.raw;
                    verified = result.verified;
                } catch (e) {
                    this.m_logger.error(`load Header hash ${arg} failed, ${e}`);
                    return { err: ErrorCode.RESULT_EXCEPTION };
                }
            }
        } else {
            return { err: ErrorCode.RESULT_INVALID_PARAM };
        }
        let header: BlockHeader = new this.m_blockHeaderType();
        let err: ErrorCode = header.decode(new BufferReader(rawHeader, false));
        if (err !== ErrorCode.RESULT_OK) {
            return { err: ErrorCode.RESULT_OK };
        }
        if (arg !== 'latest' && header.number !== arg && header.hash !== arg) {
            return { err: ErrorCode.RESULT_EXCEPTION };
        }
        let entry: BlockHeaderEntry = new BlockHeaderEntry(header, verified);
        this.m_logger.debug(`update header storage cache hash: ${header.hash} number: ${header.number} verified: ${verified}`);
        this.m_cacheHash.set(header.hash, entry);
        if (typeof arg === 'number') {
            this.m_cacheHeight.set(header.number, entry);
        }
        
        return { err: ErrorCode.RESULT_OK, header, verified };
    }


    public async getHeightOnBest(hash: string): Promise<{ err: ErrorCode, height?: number, header?: BlockHeader }> {
        let result = await this.m_db.get(getHeightOnBestSql, {$hash: hash});
        if (!result || result.height === undefined) {
            return {err: ErrorCode.RESULT_NOT_FOUND};
        } 

        let header: BlockHeader = new this.m_blockHeaderType();
        let err: ErrorCode = header.decode(new BufferReader(result.raw, false));
        if (err !== ErrorCode.RESULT_OK) {
            return { err };
        }
        return { err: ErrorCode.RESULT_OK, height: result.height, header };
    }

    public async _saveHeader(header: BlockHeader): Promise<ErrorCode>{
        let headerRaw = header.encode(new BufferWriter()).render();
        try {
            await this.m_db.run(insertHeaderSql, { $hash: header.hash, $raw: headerRaw, $pre: header.preBlockHash, $verified: VERIFY_STATE.notVerified });
        } catch (e) {
            this.m_logger.error(`save Header ${header.hash}(${header.number}) failed, ${e}`);
            return ErrorCode.RESULT_EXCEPTION;
        }
        return ErrorCode.RESULT_OK;
    }

    public async saveHeader(header: BlockHeader): Promise<ErrorCode> {
        return await this._saveHeader(header);
    }


    public async createGenesis(genesis: BlockHeader): Promise<ErrorCode> {
        assert(genesis.number === 0);
        if (genesis.number !== 0) {
            return ErrorCode.RESULT_INVALID_PARAM;
        }
        let writer = new BufferWriter();
        genesis.encode(writer);
        let headerRaw = writer.render();
        let hash = genesis.hash;
        try {
            await this._begin();
        } catch (e) {
            this.m_logger.error(`createGenesis begin ${genesis.hash}(${genesis.number}) failed, ${e}`);
            return ErrorCode.RESULT_EXCEPTION;
        }

        try {

            await this.m_db.run(insertHeaderSql, { $hash: genesis.hash, $pre:genesis.preBlockHash, $raw: headerRaw, $verified: VERIFY_STATE.verified });
            await this.m_db.run(extendBestSql, {$hash: genesis.hash, $height: genesis.number, $timestamp: genesis.timestamp});

            await this._commit();
        } catch (e) {
            this.m_logger.error(`createGenesis ${genesis.hash}(${genesis.number}) failed, ${e}`);
            await this._rollback();
            return ErrorCode.RESULT_EXCEPTION;
        }
        return ErrorCode.RESULT_OK;
    }

    public async getNextHeader(hash: string): Promise<{err: ErrorCode, results?: {header: BlockHeader, verified: VERIFY_STATE}[]}> {
        let query: any;
        try {
            query = await this.m_db.all(getByPreBlockSql);
        } catch (e) {
            this.m_logger.error(`getNextHeader ${hash} failed, ${e}`);
            return {err: ErrorCode.RESULT_EXCEPTION};
        }
        if (!query || !query.length) {
            return {err: ErrorCode.RESULT_NOT_FOUND};
        }
        let results = [];
        for (let result of query) {
            let header: BlockHeader = new this.m_blockHeaderType();
            let err: ErrorCode = header.decode(new BufferReader(result.raw, false));
            if (err !== ErrorCode.RESULT_OK) {
                return {err};
            }
            results.push({header, verified: result.verified});
        }
        return {err: ErrorCode.RESULT_OK, results};
    }

    public async updateVerified(header: BlockHeader, verified: VERIFY_STATE): Promise<ErrorCode> {
        try {
            this.m_logger.debug(`remove header storage cache hash: ${header.hash} number: ${header.number}`);
            this.m_cacheHash.remove(header.hash);
            this.m_cacheHeight.remove(header.number);
            await this.m_db.run(updateVerifiedSql, { $hash: header.hash, $verified: verified });
        } catch (e) {
            this.m_logger.error(`updateVerified ${header.hash}(${header.number}) failed, ${e}`);
            return ErrorCode.RESULT_EXCEPTION;
        }
        return ErrorCode.RESULT_OK;
    }

    public async changeBest(header: BlockHeader): Promise<ErrorCode> {
        let sqls: string[] = [];
        let txViewOp: any = [];
        sqls.push(`INSERT INTO best (hash, height, timestamp) VALUES("${header.hash}", "${header.number}", "${header.timestamp}")`);
        txViewOp.push({op: 'add', value: header.hash});
        let forkFrom = header;
        while (true) {
            let result = await this.getHeightOnBest(forkFrom.preBlockHash);
            if (result.err === ErrorCode.RESULT_OK) {
                assert(result.header);
                forkFrom = result.header!;
                sqls.push(`DELETE FROM best WHERE height > ${forkFrom.number}`);
                txViewOp.push({op: 'remove', value: forkFrom.number});
                break;
            } else if (result.err === ErrorCode.RESULT_NOT_FOUND) {
                let result = await this.loadHeader(forkFrom.preBlockHash);
                assert(result.header);
                forkFrom = result.header!;
                sqls.push(`INSERT INTO best (hash, height, timestamp) VALUES("${forkFrom.hash}", "${forkFrom.number}", "${forkFrom.timestamp}")`);
                txViewOp.push({op: 'add', value: forkFrom.hash});
                continue;
            } else {
                return result.err;
            }
        }
        sqls.push(`UPDATE headers SET verified="${VERIFY_STATE.verified}" WHERE hash="${header.hash}"`);
        sqls = sqls.reverse();
        txViewOp = txViewOp.reverse();
        await this._begin();
        try {
            for (let e of txViewOp) {
                let err;
                if (e.op === 'add') {
                    err = await this.m_txView.add(e.value);
                } else if (e.op === 'remove') {
                    err = await this.m_txView.remove(e.value);
                } else {
                    err = ErrorCode.RESULT_FAILED;
                }

                if (err !== ErrorCode.RESULT_OK) {
                    throw new Error(`run txview error,code=${err}`);
                }
            }
            for (let sql of sqls) {
                await this.m_db.run(sql);
            }
            await this._commit();
        } catch (e) {
            this.m_logger.error(`changeBest ${header.hash}(${header.number}) failed, ${e}`);
            this._rollback();
            return ErrorCode.RESULT_EXCEPTION;
        }
        this.m_logger.debug(`remove header storage cache hash: ${header.hash} number: ${header.number}`);
        this.m_cacheHash.remove(header.hash);
        this.m_cacheHeight.clear();
        return ErrorCode.RESULT_OK;
    }

    async _begin() {
        await this.m_transactionLock.enter();
        await this.m_db.run('BEGIN;');
    }

    async _commit() {
        await this.m_db.run('COMMIT;');
        this.m_transactionLock.leave();
    }

    async _rollback() {
        await this.m_db.run('ROLLBACK;');
        this.m_transactionLock.leave();
    }

}