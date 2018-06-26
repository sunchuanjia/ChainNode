import * as ValueBlock from '../value_chain/block';
import { BufferWriter } from '../lib/writer';
import { BufferReader } from '../lib/reader';
import { ErrorCode } from '../error_code';
import { Chain } from '../chain/chain';
import * as POWConsensus from './consensus';
import * as assert from 'assert';
import * as digest from '../lib/digest';

export const INT32_MAX = 0xffffffff;

// type Constructor<T> = new () => T;

// export function blockHeaderClass<T extends BaseBlock.BlockHeader>(superBlockHeader: Constructor<T>) {
//     class BlockHeaderClass extends (superBlockHeader as Constructor<BaseBlock.BlockHeader>) {
export class BlockHeader extends ValueBlock.BlockHeader {
    constructor() {
        super();
        this.m_bits = 0;
        this.m_nonce = 0;
        this.m_nonce1 = 0;

        //this.m_bits = POWUtil.getTarget(prevheader);
    }

    private m_bits: number;
    private m_nonce: number;
    private m_nonce1: number;

    get bits(): number {
        return this.m_bits;
    }

    set bits(bits: number) {
        this.m_bits = bits;
    }

    get nonce(): number {
        return this.m_nonce;
    }

    get nonce1(): number {
        return this.m_nonce1;
    }

    set nonce(nonce: number) {
        assert(nonce <= INT32_MAX);
        this.m_nonce = nonce;
    }

    set nonce1(nonce: number) {
        assert(nonce <= INT32_MAX);
        this.m_nonce1 = nonce;
    }

    protected _encodeHashContent(writer: BufferWriter): BufferWriter {
        writer = super._encodeHashContent(writer);
        writer.writeU32(this.m_bits);
        return writer;
    }

    public encode(writer: BufferWriter): BufferWriter {
        writer = super.encode(writer);
        writer.writeU32(this.m_nonce);
        writer.writeU32(this.m_nonce1);
        return writer;
    }

    protected _decodeHashContent(reader: BufferReader): ErrorCode {
        let err: ErrorCode = super._decodeHashContent(reader);
        if (err !== ErrorCode.RESULT_OK) {
            return err;
        }
        this.m_bits = reader.readU32();
        return ErrorCode.RESULT_OK;
    }

    public decode(reader: BufferReader): ErrorCode {
        let err: ErrorCode =  super.decode(reader);
        if (err !== ErrorCode.RESULT_OK) {
            return err;
        }
        this.m_nonce = reader.readU32();
        this.m_nonce1 = reader.readU32();
        return ErrorCode.RESULT_OK;
    }

    public async verify(chain: Chain): Promise<{err: ErrorCode, valid?: boolean}> {
        let vr = await super.verify(chain);
        if (vr.err || !vr.valid) {
            return vr;
        }
        //check bits
        let {err, target} = await POWConsensus.getTarget(this, chain);
        if (err) {
            return {err};
        }
        if(this.m_bits !== target) {
            return {err: ErrorCode.RESULT_OK, valid: false};
        }
        //check POW
        return {err: ErrorCode.RESULT_OK, valid: this.verifyPOW()};
    }

    public verifyPOW(): boolean {
        let content: Buffer = this.encode(new BufferWriter()).render();
        return POWConsensus.verifyPOW(digest.hash256(content), this.m_bits);
    }

    public stringify(): any {
        let obj = super.stringify();
        obj.difficulty = this.bits;
        return obj;
    }
}
//     return BlockHeaderClass as Constructor<T & BlockHeaderClass>;
// }
