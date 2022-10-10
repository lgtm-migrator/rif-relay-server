import {
    ContractInteractor,
    EnvelopingConfig
} from '@rsksmart/rif-relay-common';
import { HttpClient, HttpWrapper } from '@rsksmart/rif-relay-client';
import log from 'loglevel';
import { JsonRpcProvider } from '@ethersproject/providers';
import { BigNumber, Wallet, utils, Signer } from 'ethers';
import { sleep } from '../../Utils';

/**
 * This is helper class to execute commands to interact with the server
 */
export abstract class CommandClient {
    protected readonly httpClient: HttpClient;

    protected readonly config: EnvelopingConfig;

    protected readonly provider: JsonRpcProvider | Wallet;

    protected contractInteractor: ContractInteractor | undefined;

    constructor(host: string, config: EnvelopingConfig, mnemonic?: string) {
        this.provider = new JsonRpcProvider(host);
        if (mnemonic) {
            this.provider = Wallet.fromMnemonic(mnemonic);
        }
        this.httpClient = new HttpClient(new HttpWrapper(), config);
        this.config = config;
    }

    async initContractInteractor() {
        this.contractInteractor = await ContractInteractor.getInstance(
            this.provider as JsonRpcProvider,
            this.config
        );
    }

    async findWealthyAccount(
        requiredBalance: BigNumber = utils.parseUnits('2', 'ether')
    ): Promise<Signer> {
        let accounts: string[] = [];
        try {
            const tempProvider = this.provider as JsonRpcProvider;
            accounts = await tempProvider.listAccounts();
            for (let i = 0; i < accounts.length; i++) {
                const signer = tempProvider.getSigner(i);
                const balance = await signer.getBalance();
                if (balance.gte(requiredBalance)) {
                    log.info(
                        `Found funded account ${await signer.getAddress()}`
                    );

                    return signer;
                }
            }
        } catch (error) {
            log.error('Failed to retrieve accounts and balances:', error);
        }
        throw new Error(
            `could not find unlocked account with sufficient balance; all accounts:\n - ${accounts.join(
                '\n - '
            )}`
        );
    }

    async isRelayReady(relayUrl: string): Promise<boolean> {
        const response = await this.httpClient.getPingResponse(relayUrl);

        return response.ready;
    }

    async waitForRelay(relayUrl: string, timeout = 60): Promise<void> {
        log.error(`Will wait up to ${timeout}s for the relay to be ready`);

        const endTime = Date.now() + timeout * 1000;
        while (Date.now() < endTime) {
            let isReady = false;
            try {
                isReady = await this.isRelayReady(relayUrl);
            } catch (e) {
                if (e instanceof Error) {
                    log.info(e.message);
                } else {
                    log.error(e);
                }
            }
            if (isReady) {
                return;
            }
            await sleep(3000);
        }
        throw Error(`Relay not ready after ${timeout}s`);
    }

    abstract execute(args: unknown): Promise<void>;
}
