import { utils } from 'ethers';
import chalk from 'chalk';
import type { TypedEvent } from '@rsksmart/rif-relay-contracts/dist/typechain-types/common';
import type { IRelayHub } from '@rsksmart/rif-relay-contracts/typechain-types';
import type { AppConfig } from './ServerConfigParams';

export function isSameAddress(address1: string, address2: string): boolean {
    return address1.toLowerCase() === address2.toLowerCase();
}

export function validateAddress(
    address: string,
    exceptionTitle = 'invalid address:'
): void {
    if (!utils.isAddress(address)) {
        throw new Error(`${address} ${exceptionTitle}`);
    }
}

export async function sleep(ms: number): Promise<void> {
    return await new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomInRange(min: number, max: number): number {
    return Math.floor(Math.random() * (max - min) + min);
}

export function boolString(bool: boolean): string {
    return bool
        ? chalk.green('good'.padEnd(14))
        : chalk.red('wrong'.padEnd(14));
}

export function getLatestEventData(
    events: Array<Array<TypedEvent>>
): TypedEvent | undefined {
    if (events.length === 0) {
        return;
    }
    const eventDataSorted = events
        .flat()
        .sort((a: TypedEvent, b: TypedEvent) => {
            if (a.blockNumber === b.blockNumber) {
                return b.transactionIndex - a.transactionIndex;
            }

            return b.blockNumber - a.blockNumber;
        });

    return eventDataSorted[0];
}

export function isSecondEventLater(a: TypedEvent, b: TypedEvent): boolean {
    if (a.blockNumber === b.blockNumber) {
        return b.transactionIndex > a.transactionIndex;
    }

    return b.blockNumber > a.blockNumber;
}

export function isRegistrationValid(
    relayData: IRelayHub.RelayManagerDataStruct | undefined,
    config: AppConfig,
    managerAddress: string
): boolean {
    const portIncluded: boolean = config.url.indexOf(':') > 0;

    if (relayData) {
        const manager = relayData.manager as string;

        return (
            isSameAddress(manager, managerAddress) &&
            relayData.url.toString() ===
                config.url.toString() +
                    (!portIncluded && config.port > 0
                        ? ':' + config.port.toString()
                        : '')
        );
    }

    return false;
}
