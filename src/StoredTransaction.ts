import type { Transaction } from 'ethers';


export enum ServerAction {
    REGISTER_SERVER,
    ADD_WORKER,
    RELAY_CALL,
    VALUE_TRANSFER,
    DEPOSIT_WITHDRAWAL,
    PENALIZATION
}

export interface StoredTransactionMetadata {
    readonly from: string;
    readonly attempts: number;
    readonly serverAction: ServerAction;
    readonly creationBlockNumber: number;
    readonly boostBlockNumber?: number;
    readonly minedBlockNumber?: number;
}

export interface StoredTransactionSerialized {
    readonly to: string;
    readonly gas: number;
    readonly gasPrice: number;
    readonly data: string;
    readonly nonce: number;
    readonly txId: string;
}

export interface NonceSigner {
    nonceSigner?: {
        nonce: number;
        signer: string;
    };
}

export type StoredTransaction = StoredTransactionSerialized &
    StoredTransactionMetadata &
    NonceSigner;

/**
 * Make sure not to pass {@link StoredTransaction} as {@param metadata}, as it will override fields from {@param tx}!
 * @param tx
 * @param metadata
 */
export function createStoredTransaction(
    tx: Transaction,
    metadata: StoredTransactionMetadata
): StoredTransaction {
    const details: StoredTransactionSerialized = {
        to: tx.to,
        gas: tx.gasLimit.toNumber(),
        gasPrice:tx.gasPrice.toNumber(),
        data: tx.data,
        nonce: tx.nonce,
        txId: tx.hash
    };

    return Object.assign({}, details, metadata);
}
