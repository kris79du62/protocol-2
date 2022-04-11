import { BigNumber } from '@0x/utils';

import { GWEI_DECIMALS } from '../constants';

import { GasOracle } from './GasOracle';
import { GasStationAttendant, Wei, WeiPerGas } from './GasStationAttendant';
import { calculateGasEstimate } from './rfqm_gas_estimate_utils';
import { SubmissionContext } from './SubmissionContext';

const INITIAL_MAX_PRIORITY_FEE_PER_GAS_GWEI = 2;
const MAX_PRIORITY_FEE_PER_GAS_CAP = new BigNumber(128e9); // The maximum tip we're willing to pay
// Retrying an EIP 1559 transaction: https://docs.alchemy.com/alchemy/guides/eip-1559/retry-eip-1559-tx
const MAX_PRIORITY_FEE_PER_GAS_MULTIPLIER = 1.5; // Increase multiplier for tip with each resubmission cycle

/**
 * An implementation of `GasStationAttendant` designed for Ethereum Mainnet.
 */
export class GasStationAttendantEthereum implements GasStationAttendant {
    private readonly _gasOracle: GasOracle;

    constructor(gasOracle: GasOracle) {
        this._gasOracle = gasOracle;
    }

    /**
     * The Safe Balance For Trade is based on historical data as outlined here:
     * https://0xproject.quip.com/qZdFAHLpT7JI/RFQm-healthz-System-Health-Endpoint#temp:C:cXH5851e0f15e8c4828bffc1339d
     */
    // tslint:disable-next-line: prefer-function-over-method
    public async getSafeBalanceForTradeAsync(): Promise<Wei> {
        return new BigNumber(82500000000000000);
    }

    /**
     * Uses an estimate of the current base fee with 6
     * 10% increases plus the "instant" maxPriorityFeePerGas
     * as reported by the oracle.
     *
     * Gas amount is estimated for an unwrap of the AAVE-USDC pair.
     */
    public async getWorkerBalanceForTradeAsync(): Promise<WeiPerGas> {
        const baseFee = await this._gasOracle.getBaseFeePerGasWeiAsync();
        const instantTip = await this._gasOracle.getMaxPriorityFeePerGasWeiAsync('instant');

        // Pad the baseFee for 6 10% increases
        const baseFeePad = Math.pow(1.1, 6); // tslint:disable-line: custom-no-magic-numbers
        const paddedBaseFee = baseFee.times(baseFeePad);
        const gasRate = paddedBaseFee.plus(instantTip);

        // Use a gas estimate of a pretty high-cost pair
        const gasEstimate = calculateGasEstimate(
            '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9', // AAVE
            '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
            'otc',
            true,
        );

        return gasRate.times(gasEstimate);
    }

    /**
     * Calculated by looking at historical data and seeing we average 1.5 transactions
     * per job. This means we expect to pay 2.75 GWEI priority fee plus the base fee.
     */
    public async getExpectedTransactionGasRateAsync(): Promise<WeiPerGas> {
        const baseFee = await this._gasOracle.getBaseFeePerGasWeiAsync();
        // Currently we submit a 2 GWEI tip then multiply it by 1.5 per submission
        // Trades take ~1.5 submissions on average, so that's 2.75 GWEI
        const avgMaxPriorityFeePerGasRate = 2750000000;
        return baseFee.plus(avgMaxPriorityFeePerGasRate).integerValue(BigNumber.ROUND_CEIL);
    }

    /**
     * The submission strategy starts with a maxPriorityFee of 2 GWEI and adds
     * 2 x the base fee to get the initial maxFeePerGas.
     */
    public async getNextBidAsync(
        submissionContext: SubmissionContext | null,
    ): Promise<{ maxFeePerGas: BigNumber; maxPriorityFeePerGas: BigNumber } | null> {
        const baseFee = await this._gasOracle.getBaseFeePerGasWeiAsync();
        if (!submissionContext) {
            // Our first bid is 2x the base fee + 2 GWEI tip
            const initialMaxPriorityFeePerGas = new BigNumber(INITIAL_MAX_PRIORITY_FEE_PER_GAS_GWEI).times(
                Math.pow(10, GWEI_DECIMALS),
            );
            return {
                maxPriorityFeePerGas: initialMaxPriorityFeePerGas,
                maxFeePerGas: baseFee.times(2).plus(initialMaxPriorityFeePerGas),
            };
        }
        const { maxFeePerGas: oldMaxFeePerGas, maxPriorityFeePerGas: oldMaxPriorityFeePerGas } =
            submissionContext.maxGasFees;
        const newMaxPriorityFeePerGas = oldMaxPriorityFeePerGas.times(MAX_PRIORITY_FEE_PER_GAS_MULTIPLIER);
        if (newMaxPriorityFeePerGas.isGreaterThanOrEqualTo(MAX_PRIORITY_FEE_PER_GAS_CAP)) {
            // We've reached our max; don't put in any new transactions
            return null;
        }
        // The RPC nodes still need at least a 0.1 increase in both values to accept the new transaction.
        // For the new max fee per gas, we'll take the maximum of a 0.1 increase from the last value
        // or the value from an increase in the base fee.
        const newMaxFeePerGas = BigNumber.max(
            oldMaxFeePerGas.multipliedBy(1.1), // tslint:disable-line: custom-no-magic-numbers
            baseFee.multipliedBy(2).plus(newMaxPriorityFeePerGas),
        );
        return {
            maxPriorityFeePerGas: newMaxPriorityFeePerGas.integerValue(BigNumber.ROUND_CEIL),
            maxFeePerGas: newMaxFeePerGas.integerValue(BigNumber.ROUND_CEIL),
        };
    }
}
