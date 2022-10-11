import fs from 'fs';
import log from 'loglevel';
import { Wallet, utils, PopulatedTransaction } from 'ethers';
import type { SignedTransactionDetails } from './TransactionManager';

export const KEYSTORE_FILENAME = 'keystore';

type keystore = {
  seed: string;
};

export class KeyManager {
  private readonly _hdkey!: utils.HDNode;

  private _privateKeys: Record<string, string> = {};

  private _nonces: Record<string, number> = {};

  /**
   * @param count - # of addresses managed by this manager
   * @param workdir - read seed from keystore file (or generate one and write it)
   * @param seed - if working in memory (no workdir), you can specify a seed - or use randomly generated one.
   */
  constructor(count: number, workdir?: string, seed?: string) {
    /*  ow(count, ow.number); */
    if (seed && workdir) {
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
          const seedObject = JSON.parse(
            fs.readFileSync(keyStorePath).toString()
          ) as keystore;
          genseed = seedObject.seed;
        } else {
          genseed = Wallet.createRandom().privateKey;
          fs.writeFileSync(keyStorePath, JSON.stringify({ seed: genseed }), {
            flag: 'w',
          });
        }
        this._hdkey = utils.HDNode.fromSeed(genseed);
      } catch (e) {
        if (e instanceof Error && !e.message.includes('file already exists')) {
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
      this._hdkey = utils.HDNode.fromSeed(seed ?? Buffer.from(''));
    }

    this.generateKeys(count);
  }

  generateKeys(count: number): void {
    this._privateKeys = {};
    this._nonces = {};
    for (let index = 0; index < count; index++) {
      const w = this._hdkey.derivePath(index.toString());
      this._privateKeys[w.address] = w.privateKey;
      this._nonces[index] = 0;
    }
  }

  getAddress(index: number): string | undefined {
    return this.getAddresses()[index];
  }

  getAddresses(): string[] {
    return Object.keys(this._privateKeys);
  }

  isSigner(signer: string): boolean {
    return this._privateKeys[signer] != null;
  }

  async signTransaction(
    address: string,
    utx: PopulatedTransaction
  ): Promise<SignedTransactionDetails> {
    /* ow(signer, ow.string); */
    const privateKey = this._privateKeys[address];
    if (privateKey === undefined) {
      throw new Error(`Can't sign: signer=${address} is not managed`);
    }

    const signer = new Wallet(privateKey);
    const signedTx = await signer.signTransaction(utx);

    const txHash = utils.keccak256(signedTx);

    return { signedTx, txHash };
  }
}
