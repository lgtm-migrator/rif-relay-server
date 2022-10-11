import type { RelayServer } from './RelayServer';
import { ServerAction } from './StoredTransaction';
import type { SendTransactionDetails } from './TransactionManager';
import log from 'loglevel';
import { BigNumber } from 'ethers';
import { defaultEnvironment } from './Environments';

export async function replenishStrategy(
  relayServer: RelayServer,
  workerIndex: number,
  currentBlock: number
): Promise<string[]> {
  let transactionHashes: string[] = [];
  if (relayServer.isCustomReplenish()) {
    // If custom replenish is settled, here should be a call to a custom function for replenish workers strategy.
    // Delete the next error if a custom replenish fuction is implemented.
    throw new Error(
      'No custom replenish function found, to remove this error please add the custom replenish implementation here deleting this line.'
    );
  } else {
    transactionHashes = await defaultReplenishFunction(
      relayServer,
      workerIndex,
      currentBlock
    );
  }

  return transactionHashes;
}

async function defaultReplenishFunction(
  relayServer: RelayServer,
  workerIndex: number,
  currentBlock: number
): Promise<string[]> {
  const transactionHashes: string[] = [];
  let managerEthBalance = await relayServer.getManagerBalance();
  relayServer.workerBalanceRequired.currentValue =
    await relayServer.getWorkerBalance(workerIndex);
  if (
    managerEthBalance.gte(relayServer.config.blockchain.managerTargetBalance) &&
    relayServer.workerBalanceRequired.isSatisfied
  ) {
    // all filled, nothing to do
    return transactionHashes;
  }
  managerEthBalance = await relayServer.getManagerBalance();
  const mustReplenishWorker = !relayServer.workerBalanceRequired.isSatisfied;
  const isReplenishPendingForWorker =
    await relayServer.txStoreManager.isActionPending(
      ServerAction.VALUE_TRANSFER,
      relayServer.workerAddress
    );
  if (mustReplenishWorker && !isReplenishPendingForWorker) {
    const targetBalance = BigNumber.from(
      relayServer.config.blockchain.workerTargetBalance
    );
    const refill = targetBalance.sub(
      relayServer.workerBalanceRequired.currentValue
    );
    log.info(
      `== replenishServer: mgr balance=${managerEthBalance.toString()}
        \n${
          relayServer.workerBalanceRequired.description
        }\n refill=${refill.toString()}`
    );

    if (
      refill.lt(
        managerEthBalance.sub(relayServer.config.blockchain.managerMinBalance)
      )
    ) {
      log.info('Replenishing worker balance by manager rbtc balance');
      const gasLimit = BigNumber.from(
        defaultEnvironment?.mintxgascost ?? 21000
      );
      const details: SendTransactionDetails = {
        signer: relayServer.managerAddress,
        serverAction: ServerAction.VALUE_TRANSFER,
        destination: relayServer.workerAddress,
        value: refill,
        creationBlockNumber: currentBlock,
        gasLimit,
      };
      const { txHash } = await relayServer.transactionManager.sendTransaction(
        details
      );
      transactionHashes.push(txHash);
    } else {
      const message = `== replenishServer: can't replenish: mgr balance too low ${managerEthBalance.toString()} refill=${refill.toString()}`;
      relayServer.emit('fundingNeeded', message);
      log.info(message);
    }
  }

  return transactionHashes;
}
