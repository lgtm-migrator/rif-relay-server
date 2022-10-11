import log from 'loglevel';
import type { EventEmitter } from 'events';
import { BigNumber, constants } from 'ethers';
import chalk from 'chalk';

import type {
    ContractInteractor,
    ManagerEvent,
    PastEventOptions
} from '@rsksmart/rif-relay-common';
import type { IRelayHub } from '@rsksmart/rif-relay-contracts/typechain-types';
import type { TypedEvent } from '@rsksmart/rif-relay-contracts/typechain-types/common';

import type { ServerConfigParams } from './ServerConfigParams';
import type {
    SendTransactionDetails,
    TransactionManager
} from './TransactionManager';
import type { TxStoreManager } from './TxStoreManager';
import { ServerAction } from './StoredTransaction';
import { AmountRequired } from './AmountRequired';
import { defaultEnvironment } from './Environments';


import {
    boolString,
    getLatestEventData,
    isRegistrationValid,
    isSecondEventLater
} from './Utils';
import type { StakeUnlockedEvent } from '@rsksmart/rif-relay-contracts/typechain-types/contracts/RelayHub';

export type RelayServerRegistryInfo = {
    url: string;
};

const mintxgascost = defaultEnvironment?.mintxgascost;

export class RegistrationManager {

    private _balanceRequired: AmountRequired;

    public get balanceRequired(): AmountRequired {
        return this._balanceRequired;
    }

    private _stakeRequired: AmountRequired;

    public get stakeRequired(): AmountRequired {
        return this._stakeRequired;
    }

    private _isStakeLocked = false;

    private _isInitialized = false;

    private readonly _hubAddress: string;

    private readonly _managerAddress: string;

    private readonly _workerAddress: string;

    private readonly _eventEmitter: EventEmitter;

    private readonly _contractInteractor: ContractInteractor;

    private _ownerAddress: string | undefined;

    private readonly _transactionManager: TransactionManager;

    private _config: ServerConfigParams;

    private readonly _txStoreManager: TxStoreManager;

    private _relayData: IRelayHub.RelayManagerDataStruct | undefined;

    private _lastWorkerAddedTransaction: TypedEvent | undefined;

    private _delayedEvents: Array<{ block: number; eventData: TypedEvent }> = [];

    get isStakeLocked(): boolean {
        return this._isStakeLocked;
    }

    set isStakeLocked(newValue: boolean) {
        const oldValue = this._isStakeLocked;
        this._isStakeLocked = newValue;
        if (newValue !== oldValue) {
            log.info(
                `Manager stake is ${newValue ? 'now' : 'no longer'} locked`
            );
            this.printNotRegisteredMessage();
        }
    }

    constructor(
        contractInteractor: ContractInteractor,
        transactionManager: TransactionManager,
        txStoreManager: TxStoreManager,
        eventEmitter: EventEmitter,
        config: ServerConfigParams,
        // exposed from key manager?
        managerAddress: string,
        workerAddress: string
    ) {
        const listener = (): void => {
            this.printNotRegisteredMessage();
        };
        this._balanceRequired = new AmountRequired(
            'Balance',
            BigNumber.from(config.blockchain.managerMinBalance),
            listener
        );
        this._stakeRequired = new AmountRequired(
            'Stake',
            BigNumber.from(config.blockchain.managerMinStake),
            listener
        );

        this._contractInteractor = contractInteractor;
        this._hubAddress = config.contracts.relayHubAddress;
        this._managerAddress = managerAddress;
        this._workerAddress = workerAddress;
        this._eventEmitter = eventEmitter;
        this._transactionManager = transactionManager;
        this._txStoreManager = txStoreManager;
        this._config = config;
    }

    async init(): Promise<void> {
        if (this._lastWorkerAddedTransaction == null) {
            this._lastWorkerAddedTransaction =
                await this._queryLatestWorkerAddedEvent();
        }

        this._isInitialized = true;
    }

    async handlePastEvents(
        hubEventsSinceLastScan: TypedEvent[],
        lastScannedBlock: number,
        currentBlock: number,
        forceRegistration: boolean
    ): Promise<string[]> {
        if (!this._isInitialized) {
            throw new Error('RegistrationManager not initialized');
        }
        const options = {
            fromBlock: lastScannedBlock + 1,
            toBlock: 'latest'
        };

        type DefaultManagerEvent = Extract<
            ManagerEvent,
            'StakeAdded' | 'StakeUnlocked' | 'StakeWithdrawn'
        >;
        const eventsNames: DefaultManagerEvent[] = [
            'StakeAdded',
            'StakeUnlocked',
            'StakeWithdrawn'
        ];
        const decodedEvents = await this._contractInteractor.getPastEventsForHub(
            options,
            eventsNames
        );
        this.printEvents(decodedEvents, options);
        let transactionHashes: string[] = [];
        // TODO: what about 'penalize' events? should send balance to owner, I assume
        for (const eventData of decodedEvents.flat()) {
            switch (eventData.event) {
                case 'StakeAdded':
                    await this.refreshStake();
                    break;
                case 'StakeUnlocked':
                    await this.refreshStake();
                    
                    this._delayedEvents.push({
                        block: (eventData as StakeUnlockedEvent).args.withdrawBlock.toNumber(),
                        eventData
                    });
                    break;
                case 'StakeWithdrawn':
                    await this.refreshStake();
                    transactionHashes = transactionHashes.concat(
                        await this._handleStakeWithdrawnEvent(
                            eventData,
                            currentBlock
                        )
                    );
                    break;
            }
        }

        this._relayData = await this.getRelayData();

        for (const eventData of hubEventsSinceLastScan) {
            switch (eventData.event) {
                case 'RelayWorkersAdded':
                    if (
                        this._lastWorkerAddedTransaction == null ||
                        isSecondEventLater(
                            this._lastWorkerAddedTransaction,
                            eventData
                        )
                    ) {
                        this._lastWorkerAddedTransaction = eventData;
                    }
                    break;
            }
        }

        // handle HubUnauthorized only after the due time
        for (const eventData of this._extractDuePendingEvents(currentBlock)) {
            switch (eventData.event) {
                case 'StakeUnlocked':
                    transactionHashes = transactionHashes.concat(
                        await this._handleStakeUnlockedEvent(
                            eventData,
                            currentBlock
                        )
                    );
                    break;
            }
        }

        const isRegistrationCorrect = this._isRegistrationCorrect();
        const isRegistrationPending = await this._txStoreManager.isActionPending(
            ServerAction.REGISTER_SERVER
        );
        if (
            !(isRegistrationPending || isRegistrationCorrect) ||
            forceRegistration
        ) {
            transactionHashes = transactionHashes.concat(
                await this.attemptRegistration(currentBlock)
            );
        }

        return transactionHashes;
    }

    async getRelayData(): Promise<IRelayHub.RelayManagerDataStruct> {
        const relayData: IRelayHub.RelayManagerDataStruct[] =
            await this._contractInteractor.getRelayInfo(
                new Set<string>([this._managerAddress])
            );
        if (relayData.length > 1) {
            throw new Error(
                'More than one relay manager found for ' + this._managerAddress
            );
        }
        if (relayData.length == 1 && relayData[0]) {
            return relayData[0];
        }
        throw new Error('No relay manager found for ' + this._managerAddress);
    }

    _extractDuePendingEvents(currentBlock: number): TypedEvent[] {
        const ret = this._delayedEvents
            .filter((event) => event.block <= currentBlock)
            .map((e) => e.eventData);
        this._delayedEvents = [
            ...this._delayedEvents.filter((event) => event.block > currentBlock)
        ];

        return ret;
    }

    _isRegistrationCorrect(): boolean {
        return isRegistrationValid(
            this._relayData,
            this._config.app,
            this._managerAddress
        );
    }

    // I erased _parseEvent since its not being used

    async _handleStakeWithdrawnEvent(
        dlog: TypedEvent,
        currentBlock: number
    ): Promise<string[]> {
        log.warn('Handling StakeWithdrawn event:', dlog);

        return await this.withdrawAllFunds(true, currentBlock);
    }

    async _handleStakeUnlockedEvent(
        dlog: TypedEvent,
        currentBlock: number
    ): Promise<string[]> {
        log.warn('Handling StakeUnlocked event:', dlog);

        return await this.withdrawAllFunds(false, currentBlock);
    }

    /**
     * @param withdrawManager - whether to send the relay manager's balance to the owner.
     *        Note that more than one relay process could be using the same manager account.
     * @param currentBlock
     */
    async withdrawAllFunds(
        withdrawManager: boolean,
        currentBlock: number
    ): Promise<string[]> {
        let transactionHashes: string[] = [];
        transactionHashes = transactionHashes.concat(
            await this._sendWorkersEthBalancesToOwner(currentBlock)
        );
        if (withdrawManager) {
            transactionHashes = transactionHashes.concat(
                await this._sendManagerEthBalanceToOwner(currentBlock)
            );
        }

        this._eventEmitter.emit('unstaked');

        return transactionHashes;
    }

    async refreshBalance(): Promise<void> {
        const currentBalance = await this._contractInteractor.getBalance(
            this._managerAddress
        );
        this._balanceRequired.currentValue = currentBalance;
    }

    async refreshStake(): Promise<void> {
        const stakeInfo = await this._contractInteractor.getStakeInfo(
            this._managerAddress
        );

        const stake = stakeInfo.stake;
        if (stake.eq(constants.Zero)) {
            return;
        }

        // a locked stake does not have the 'withdrawBlock' field set
        this.isStakeLocked = stakeInfo.withdrawBlock.eq(constants.Zero);
        this._stakeRequired.currentValue = stake;

        // first time getting stake, setting owner
        if (!this._ownerAddress) {
            this._ownerAddress = stakeInfo.owner;
            log.info('Got staked for the first time');
            this.printNotRegisteredMessage();
        }
    }

    async addRelayWorker(currentBlock: number): Promise<string> {
        // register on chain
        const addRelayWorkerMethod =
            await this._contractInteractor.relayHub.populateTransaction.addRelayWorkers(
                [this._workerAddress]
            );
        const gasLimit = await this._transactionManager.attemptEstimateGas(
            'AddRelayWorkers',
            addRelayWorkerMethod,
            this._managerAddress
        );
        const details: SendTransactionDetails = {
            signer: this._managerAddress,
            gasLimit,
            serverAction: ServerAction.ADD_WORKER,
            method: addRelayWorkerMethod,
            destination: this._hubAddress,
            creationBlockNumber: currentBlock
        };
        const { txHash } = await this._transactionManager.sendTransaction(
            details
        );

        return txHash;
    }

    // TODO: extract worker registration sub-flow
    async attemptRegistration(currentBlock: number): Promise<string[]> {
        const allPrerequisitesOk =
            this.isStakeLocked &&
            this._stakeRequired.isSatisfied &&
            this._balanceRequired.isSatisfied;
        if (!allPrerequisitesOk) {
            log.info(
                'Not all prerequisites for registration are met yet. Registration attempt cancelled'
            );

            return [];
        }

        let transactions: string[] = [];
        // add worker only if not already added
        const workersAdded = this._isWorkerValid();
        const addWorkersPending = await this._txStoreManager.isActionPending(
            ServerAction.ADD_WORKER
        );
        if (!(workersAdded || addWorkersPending)) {
            const txHash = await this.addRelayWorker(currentBlock);
            transactions = transactions.concat(txHash);
        }

        const portIncluded: boolean = this._config.app.url.indexOf(':') > 0;
        const registerUrl =
            this._config.app.url +
            (!portIncluded && this._config.app.port > 0
                ? ':' + this._config.app.port.toString()
                : '');
        const registerMethod =
            await this._contractInteractor.relayHub.populateTransaction.registerRelayServer(
                registerUrl
            );
        const gasLimit = await this._transactionManager.attemptEstimateGas(
            'RegisterRelay',
            registerMethod,
            this._managerAddress
        );
        const details: SendTransactionDetails = {
            serverAction: ServerAction.REGISTER_SERVER,
            gasLimit,
            signer: this._managerAddress,
            method: registerMethod,
            destination: this._hubAddress,
            creationBlockNumber: currentBlock
        };
        const { txHash } = await this._transactionManager.sendTransaction(
            details
        );
        transactions = transactions.concat(txHash);
        log.debug(
            `Relay ${this._managerAddress} registered on hub ${this._hubAddress}. `
        );

        return transactions;
    }

    async _sendManagerEthBalanceToOwner(
        currentBlock: number
    ): Promise<string[]> {
        const gasPrice = await this._contractInteractor.provider.getGasPrice();
        const transactionHashes: string[] = [];
        const gasLimit = BigNumber.from(mintxgascost);
        const txCost = gasPrice.mul(gasLimit);

        const managerBalance = await this._contractInteractor.getBalance(
            this._managerAddress
        );
        const value = managerBalance.sub(txCost);
        // sending manager RBTC balance to owner
        if (managerBalance.gte(txCost)) {
            log.info(
                `Sending manager RBTC balance ${managerBalance.toString()} to owner`
            );
            const details: SendTransactionDetails = {
                signer: this._managerAddress,
                serverAction: ServerAction.VALUE_TRANSFER,
                destination: this._ownerAddress ?? '',
                gasLimit,
                gasPrice,
                value,
                creationBlockNumber: currentBlock
            };
            const { txHash } = await this._transactionManager.sendTransaction(
                details
            );
            transactionHashes.push(txHash);
        } else {
            log.error(
                `manager balance too low: ${managerBalance.toString()}, tx cost: ${txCost.toString()}`
            );
        }

        return transactionHashes;
    }

    async _sendWorkersEthBalancesToOwner(
        currentBlock: number
    ): Promise<string[]> {
        // sending workers' balance to owner (currently one worker, todo: extend to multiple)
        const transactionHashes: string[] = [];
        const gasPrice = await this._contractInteractor.provider.getGasPrice();
        const gasLimit = BigNumber.from(mintxgascost);
        const txCost = gasPrice.mul(gasLimit);
        const workerBalance = await this._contractInteractor.getBalance(
            this._workerAddress
        );
        const value = workerBalance.sub(txCost);
        if (workerBalance.gte(txCost)) {
            log.info(
                `Sending workers' RBTC balance ${workerBalance.toString()} to owner`
            );
            const details: SendTransactionDetails = {
                signer: this._workerAddress,
                serverAction: ServerAction.VALUE_TRANSFER,
                destination: this._ownerAddress ?? '',
                gasLimit,
                gasPrice,
                value,
                creationBlockNumber: currentBlock
            };
            const { txHash } = await this._transactionManager.sendTransaction(
                details
            );
            transactionHashes.push(txHash);
        } else {
            log.info(
                `balance too low: ${workerBalance.toString()}, tx cost: ${txCost.toString()}`
            );
        }

        return transactionHashes;
    }

    async _queryLatestWorkerAddedEvent(): Promise<TypedEvent | undefined> {
        const workersAddedEvents =
            await this._contractInteractor.getPastEventsForHub(
                {
                    fromBlock: 1
                },
                ['RelayWorkersAdded']
            );

        return getLatestEventData(workersAddedEvents);
    }

    _isWorkerValid(): boolean {
        return this._lastWorkerAddedTransaction
            ? this._lastWorkerAddedTransaction.event === 'RelayWorkersAdded'
            : false;
    }

    isRegistered(): boolean {
        const isRegistrationCorrect = this._isRegistrationCorrect();

        return (
            this._stakeRequired.isSatisfied &&
            this.isStakeLocked &&
            isRegistrationCorrect
        );
    }

    printNotRegisteredMessage(): void {
        if (this._isRegistrationCorrect()) {
            return;
        }
        const message = `\nNot registered yet. Prerequisites:
${this._balanceRequired.description}
${this._stakeRequired.description}
Stake locked   | ${boolString(this.isStakeLocked)}
Manager        | ${this._managerAddress}
Worker         | ${this._workerAddress}
Owner          | ${this._ownerAddress ?? chalk.red('k256')}
`;
        log.info(message);
    }

    printEvents(
        decodedEvents: Array<Array<TypedEvent>>,
        { fromBlock }: PastEventOptions
    ): void {
        const flatDecodedEvents = decodedEvents.flat();
        if (decodedEvents.length === 0) {
            return;
        }
        log.info(
            `Handling ${flatDecodedEvents.length} events emitted since block: ${fromBlock?.toString() ?? ''
            }`
        );
        for (const decodedEvent of flatDecodedEvents) {
            log.info(`
Name      | ${decodedEvent.event?.padEnd(25) ?? ''}
Block     | ${decodedEvent.blockNumber}
TxHash    | ${decodedEvent.transactionHash}
`);
        }
    }
}
