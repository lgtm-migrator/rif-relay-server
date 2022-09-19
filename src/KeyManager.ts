import fs from 'fs';
import type { Transaction } from 'ethers';
import log from 'loglevel';
import {Wallet, utils } from 'ethers';

export const KEYSTORE_FILENAME = 'keystore';

export class KeyManager {
    private readonly hdkey: utils.HDNode;

    private _privateKeys: Record<string, Buffer> = {};
    
    private nonces: Record<string, number> = {};

    /**
     * @param count - # of addresses managed by this manager
     * @param workdir - read seed from keystore file (or generate one and write it)
     * @param seed - if working in memory (no workdir), you can specify a seed - or use randomly generated one.
     */
    constructor(count: number, workdir?: string, seed?: Buffer) {
       /*  ow(count, ow.number); */
        if (seed != null && workdir != null) {
            throw new Error("Can't specify both seed and workdir");
        }

        if (workdir != null) {
            try {
                if (!fs.existsSync(workdir)) {
                    fs.mkdirSync(workdir, { recursive: true });
                }
                let genseed: string;
                const keyStorePath = workdir + '/' + KEYSTORE_FILENAME;
                if (fs.existsSync(keyStorePath)) {
                    genseed = Buffer.from(
                        JSON.parse(fs.readFileSync(keyStorePath).toString())
                            .seed,
                        'hex'
                    );
                } else {
                    genseed = Wallet.createRandom().privateKey;
                    fs.writeFileSync(
                        keyStorePath,
                        JSON.stringify({ seed: genseed }),
                        { flag: 'w' }
                    );
                }
                this.hdkey = EthereumHDKey.fromMasterSeed(genseed);
            } catch (e) {
                if (
                    e instanceof Error &&
                    !e.message.includes('file already exists')
                ) {
                    throw e;
                } else {
                    log.error(e);
                }
            }
        } else {
            // no workdir: working in-memory
            if (seed == null) {
                seed = Wallet.createRandom().privateKey;
            }
            this.hdkey = EthereumHDKey.fromMasterSeed(seed ?? Buffer.from(''));
        }

        this.generateKeys(count);
    }

    generateKeys(count: number): void {
        this._privateKeys = {};
        this.nonces = {};
        for (let index = 0; index < count; index++) {
            const w = this.hdkey.deriveChild(index).getWallet();
            const address = toHex(w.getAddress());
            this._privateKeys[address] = w.getPrivateKey();
            this.nonces[index] = 0;
        }
    }

    getAddress(index: number): string {
        return this.getAddresses()[index];
    }

    getAddresses(): string[] {
        return Object.keys(this._privateKeys);
    }

    isSigner(signer: string): boolean {
        return this._privateKeys[signer] != null;
    }

    signTransaction(signer: string, tx: Transaction): string {
        /* ow(signer, ow.string); */
        const privateKey = this._privateKeys[signer];
        if (privateKey === undefined) {
            throw new Error(`Can't sign: signer=${signer} is not managed`);
        }

        tx.sign(privateKey);
        const rawTx = '0x' + tx.serialize().toString('hex');
        return rawTx;
    }
}
