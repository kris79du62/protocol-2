import {
    InternalServerError,
    InvalidAPIKeyError,
    isAPIError,
    ValidationError,
    ValidationErrorCodes,
} from '@0x/api-utils';
import { MetaTransaction, OtcOrder } from '@0x/protocol-utils';
import { getTokenMetadataIfExists, isNativeSymbolOrAddress, nativeWrappedTokenSymbol } from '@0x/token-metadata';
import { addressUtils, BigNumber } from '@0x/utils';
import * as express from 'express';
import * as HttpStatus from 'http-status-codes';

import { Integrator } from '../config';
import { schemas } from '../schemas';
import { GaslessSwapService } from '../services/GaslessSwapService';
import {
    FetchFirmQuoteParams,
    FetchIndicativeQuoteParams,
    FetchQuoteParamsBase,
    RfqmTypes,
    SubmitMetaTransactionSignedQuoteParams,
    SubmitRfqmSignedQuoteWithApprovalParams,
} from '../services/types';
import { ExecuteMetaTransactionEip712Context, GaslessApprovalTypes, PermitEip712Context } from '../types';
import { ConfigManager } from '../utils/config_manager';
import { HealthCheckResult, transformResultToShortResponse } from '../utils/rfqm_health_check';
import {
    RawMetaTransactionFields,
    RawOtcOrderFields,
    StringSignatureFields,
    stringsToEIP712Context,
    stringsToMetaTransactionFields,
    stringsToOtcOrderFields,
    stringsToSignature,
} from '../utils/rfqm_request_utils';
import { schemaUtils } from '../utils/schema_utils';

// If the cache is more milliseconds old than the value specified here, it will be refreshed.
const HEALTH_CHECK_RESULT_CACHE_DURATION_MS = 30000;

type HealthCheckResultCache = [HealthCheckResult, Date];

/**
 * Logic to bridge Gasless Swap API requests to the `GaslessSwapService` and translate
 * results from the `GaslessSwapService` back to API responses.
 */
export class GaslessSwapHandlers {
    private readonly _cachedHealthCheckResultByChainId = new Map<number, HealthCheckResultCache>();
    constructor(
        private readonly _gaslessSwapServices: Map<number, GaslessSwapService>,
        private readonly _configManager: ConfigManager,
    ) {}

    /**
     * Handler for the /price endpoint
     */
    public async getPriceAsync(req: express.Request, res: express.Response): Promise<void> {
        const { chainId, params } = await this._parsePriceParamsAsync(req);

        let price;
        try {
            price = await this._getServiceForChain(chainId).fetchPriceAsync(params);
        } catch (err) {
            throw new InternalServerError('Unexpected error encountered');
        }

        // Result
        res.status(HttpStatus.OK).send({
            liquidityAvailable: price !== null,
            ...price,
        });
    }

    /**
     * Handler for the /quote endpoint
     */
    public async getQuoteAsync(req: express.Request, res: express.Response): Promise<void> {
        // Parse request
        const { chainId, params } = await this._parseFetchFirmQuoteParamsAsync(req);

        let quote;
        try {
            quote = await this._getServiceForChain(chainId).fetchQuoteAsync(params);
        } catch (err) {
            throw new InternalServerError('Unexpected error encountered');
        }
        // Result
        res.status(HttpStatus.OK).send({
            liquidityAvailable: quote !== null,
            ...quote,
        });
    }

    /**
     * Handler for the `/healthz` endpoint.
     */
    public async getHealthAsync(req: express.Request, res: express.Response): Promise<void> {
        const chainId = extractChainId(req, this._gaslessSwapServices);
        const cachedResult = this._cachedHealthCheckResultByChainId.get(chainId);
        let result: HealthCheckResult;
        if (!cachedResult) {
            result = await this._getServiceForChain(chainId).runHealthCheckAsync();
            this._cachedHealthCheckResultByChainId.set(chainId, [result, new Date()]);
        } else {
            const cacheAgeMs = Date.now() - cachedResult[1].getTime();
            if (cacheAgeMs >= HEALTH_CHECK_RESULT_CACHE_DURATION_MS) {
                result = await this._getServiceForChain(chainId).runHealthCheckAsync();
                this._cachedHealthCheckResultByChainId.set(chainId, [result, new Date()]);
            } else {
                result = cachedResult[0];
            }
        }

        const response = transformResultToShortResponse(result);
        res.status(HttpStatus.OK).send(response);
    }

    /**
     * Handler for the /status/:hash endpoint
     */
    public async getStatusAsync(req: express.Request, res: express.Response): Promise<void> {
        const chainId = extractChainId(req, this._gaslessSwapServices);
        const { hash } = req.params;

        const status = await this._getServiceForChain(chainId).getStatusAsync(hash);

        status ? res.status(HttpStatus.OK).send(status) : res.status(HttpStatus.NOT_FOUND).send();
    }

    /**
     * Handler for the /submit endpoint
     */
    public async processSubmitAsync(req: express.Request, res: express.Response): Promise<void> {
        const { chainId, integrator, params } = this._parseSubmitParams(req);

        try {
            const response = await this._getServiceForChain(chainId).processSubmitAsync(
                params,
                integrator.integratorId,
            );
            res.status(HttpStatus.CREATED).send(response);
        } catch (err) {
            req.log.error(err, 'Encountered an error while queuing a signed quote');
            if (isAPIError(err)) {
                throw err;
            } else {
                throw new InternalServerError(`An unexpected error occurred`);
            }
        }
    }

    private async _parseFetchFirmQuoteParamsAsync(
        req: express.Request,
    ): Promise<{ chainId: number; params: FetchFirmQuoteParams }> {
        schemaUtils.validateSchema(req.query, schemas.firmQuoteRequestSchema as any);
        const takerAddress = req.query.takerAddress;
        const shouldCheckApproval = req.query.checkApproval === 'true' ? true : false;
        const { chainId, params } = await this._parseIndicativeAndFirmQuoteSharedParamsAsync(req);
        if (!addressUtils.isAddress(takerAddress as string)) {
            throw new ValidationError([
                {
                    field: 'takerAddress',
                    code: ValidationErrorCodes.InvalidAddress,
                    reason: `Must provide a valid takerAddress`,
                },
            ]);
        }
        return {
            chainId,
            params: {
                ...params,
                takerAddress: takerAddress as string,
                checkApproval: shouldCheckApproval,
            },
        };
    }

    private _getServiceForChain(chainId: number): GaslessSwapService {
        const service = this._gaslessSwapServices.get(chainId);

        if (!service) {
            throw new Error('No configuration exists for chain');
        }
        return service;
    }

    /**
     * Examines the API key provided in the request, ensures it is valid for RFQM, and fetches the associated
     * integrator ID.
     */
    private _validateApiKey(apiKey: string | undefined, chainId: number): { apiKey: string; integrator: Integrator } {
        if (apiKey === undefined) {
            throw new InvalidAPIKeyError('Must access with an API key');
        }
        if (!this._configManager.getRfqmApiKeyWhitelist().has(apiKey)) {
            throw new InvalidAPIKeyError('API key not authorized for RFQM access');
        }
        const integratorId = this._configManager.getIntegratorIdForApiKey(apiKey);
        if (!integratorId) {
            // With a valid configuration this should never happen
            throw new InvalidAPIKeyError('API key has no associated Integrator ID');
        }
        const integrator = this._configManager.getIntegratorByIdOrThrow(integratorId);
        if (!integrator.allowedChainIds.includes(chainId)) {
            throw new InvalidAPIKeyError(`API Key not authorized to access chain ${chainId}`);
        }
        return { apiKey, integrator };
    }

    private async _parsePriceParamsAsync(
        req: express.Request,
    ): Promise<{ chainId: number; params: FetchIndicativeQuoteParams }> {
        schemaUtils.validateSchema(req.query, schemas.indicativeQuoteRequestSchema as any);
        const { takerAddress } = req.query;
        const { chainId, params } = await this._parseIndicativeAndFirmQuoteSharedParamsAsync(req);

        return {
            chainId,
            params: {
                ...params,
                takerAddress: takerAddress as string,
            },
        };
    }

    /**
     * Parse shared params of indicative and firm quotes
     */
    private async _parseIndicativeAndFirmQuoteSharedParamsAsync(
        req: express.Request,
    ): Promise<{ chainId: number; params: FetchQuoteParamsBase }> {
        const chainId = extractChainId(req, this._gaslessSwapServices);
        const { integrator } = this._validateApiKey(req.header('0x-api-key'), chainId);
        const { affiliateAddress } = req.query;

        // Parse tokens
        const sellTokenRaw = req.query.sellToken as string;
        const buyTokenRaw = req.query.buyToken as string;
        validateNotNativeTokenOrThrow(sellTokenRaw, chainId, 'sellToken');

        let buyTokenDecimals: number;
        let sellTokenDecimals: number;
        let buyTokenContractAddress: string;
        let sellTokenContractAddress: string;

        try {
            buyTokenContractAddress = buyTokenRaw.toLocaleLowerCase().startsWith('0x')
                ? buyTokenRaw
                : contractAddressForSymbol(buyTokenRaw, chainId);
            buyTokenDecimals = await this._getServiceForChain(chainId).getTokenDecimalsAsync(buyTokenRaw);
        } catch (e) {
            throw new ValidationError([
                {
                    field: 'buyToken',
                    code: ValidationErrorCodes.AddressNotSupported,
                    reason: `Token ${buyTokenRaw} is currently unsupported`,
                },
            ]);
        }

        try {
            sellTokenContractAddress = sellTokenRaw.toLocaleLowerCase().startsWith('0x')
                ? sellTokenRaw
                : contractAddressForSymbol(sellTokenRaw, chainId);
            sellTokenDecimals = await this._getServiceForChain(chainId).getTokenDecimalsAsync(sellTokenRaw);
        } catch {
            throw new ValidationError([
                {
                    field: 'sellToken',
                    code: ValidationErrorCodes.AddressNotSupported,
                    reason: `Token ${sellTokenRaw} is currently unsupported`,
                },
            ]);
        }

        // Parse number params
        const sellAmount =
            req.query.sellAmount === undefined ? undefined : new BigNumber(req.query.sellAmount as string);
        const buyAmount = req.query.buyAmount === undefined ? undefined : new BigNumber(req.query.buyAmount as string);

        return {
            chainId,
            params: {
                buyAmount,
                buyToken: buyTokenContractAddress,
                buyTokenDecimals,
                integrator,
                sellAmount,
                sellToken: sellTokenContractAddress,
                sellTokenDecimals,
                affiliateAddress: affiliateAddress as string,
            },
        };
    }

    private _parseSubmitParams<T extends ExecuteMetaTransactionEip712Context | PermitEip712Context>(
        req: express.Request,
    ): {
        chainId: number;
        integrator: Integrator;
        params: SubmitRfqmSignedQuoteWithApprovalParams<T> | SubmitMetaTransactionSignedQuoteParams<T>;
    } {
        const chainId = extractChainId(req, this._gaslessSwapServices);
        const { integrator } = this._validateApiKey(req.header('0x-api-key'), chainId);

        const { approval, trade } = req.body;

        const parsedParams: Partial<
            SubmitRfqmSignedQuoteWithApprovalParams<T> | SubmitMetaTransactionSignedQuoteParams<T>
        > = {};

        // Parse approval params
        if (approval) {
            if (
                approval.type === GaslessApprovalTypes.ExecuteMetaTransaction ||
                approval.type === GaslessApprovalTypes.Permit
            ) {
                const eip712 = stringsToEIP712Context(approval.eip712) as T;
                const signature = stringsToSignature(approval.signature as StringSignatureFields);
                parsedParams.approval = {
                    type: approval.type,
                    eip712,
                    signature,
                };
            } else {
                throw new ValidationError([
                    {
                        field: 'approval',
                        code: ValidationErrorCodes.FieldInvalid,
                        reason: `${approval.type} is an invalid value for Approval 'type'`,
                    },
                ]);
            }
        }

        // Parse trade params
        if (trade.type === RfqmTypes.OtcOrder) {
            const order = new OtcOrder(stringsToOtcOrderFields(trade.order as RawOtcOrderFields));
            const signature = stringsToSignature(trade.signature as StringSignatureFields);
            parsedParams.trade = {
                type: trade.type,
                order,
                signature,
            };
        } else if (trade.type === RfqmTypes.MetaTransaction) {
            const metaTransaction = new MetaTransaction(
                stringsToMetaTransactionFields(trade.metaTransaction as RawMetaTransactionFields),
            );
            const signature = stringsToSignature(trade.signature as StringSignatureFields);
            parsedParams.trade = {
                type: trade.type,
                metaTransaction,
                signature,
            };
        } else {
            throw new ValidationError([
                {
                    field: 'type',
                    code: ValidationErrorCodes.FieldInvalid,
                    reason: `${trade.type} is an invalid value for Trade 'type'`,
                },
            ]);
        }

        parsedParams.kind = trade.type;

        return {
            chainId,
            integrator,
            params: parsedParams as
                | SubmitRfqmSignedQuoteWithApprovalParams<T>
                | SubmitMetaTransactionSignedQuoteParams<T>,
        };
    }
}

/**
 * Extracts the Chain Id from the request.
 *
 * Note that legacy RFQm defaulted to a chain ID of "1",
 * but that default has been removed for Gasless Swap.
 */
function extractChainId(req: express.Request, services: Map<number, GaslessSwapService>): number {
    const chainIdFromHeader = req.header('0x-chain-id');
    if (chainIdFromHeader === undefined) {
        throw new ValidationError([
            {
                field: '0x-chain-id',
                code: ValidationErrorCodes.FieldInvalid,
                reason: 'Request must include a chain ID header',
            },
        ]);
    }
    const chainId = parseInt(chainIdFromHeader, 10);
    if (Number.isNaN(chainId)) {
        throw new ValidationError([
            {
                field: '0x-chain-id',
                code: ValidationErrorCodes.FieldInvalid,
                reason: 'Invalid chain id',
            },
        ]);
    }

    if (!services.has(chainId)) {
        throw new ValidationError([
            {
                field: '0x-chain-id',
                code: ValidationErrorCodes.FieldInvalid,
                reason: 'Service unavailable on specified chain',
            },
        ]);
    }
    return chainId;
}

/**
 * Gets the token address for a given symbol.
 *
 * Throws if the symbol is not present in @0x/token-metadata
 */
function contractAddressForSymbol(symbol: string, chainId: number): string {
    const address = getTokenMetadataIfExists(symbol, chainId)?.tokenAddress;
    if (!address) {
        throw new Error('Unsupported token');
    }
    return address;
}

function validateNotNativeTokenOrThrow(token: string, chainId: number, field: string): boolean {
    if (isNativeSymbolOrAddress(token, chainId)) {
        const symbol = nativeWrappedTokenSymbol(chainId);
        throw new ValidationError([
            {
                field,
                code: ValidationErrorCodes.TokenNotSupported,
                reason: `Unwrapped Native Asset is not supported. Use ${symbol} instead`,
            },
        ]);
    }

    return true;
}
