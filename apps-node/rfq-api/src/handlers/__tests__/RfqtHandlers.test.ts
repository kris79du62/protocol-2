// tslint:disable: max-file-line-count
import { ContractAddresses } from '@0x/contract-addresses';
import { OtcOrder } from '@0x/protocol-utils';
import { SignatureType } from '@0x/protocol-utils/lib/src/signature_utils';
import { FillQuoteTransformerOrderType } from '@0x/protocol-utils/lib/src/transformer_utils';
import { BigNumber } from '@0x/utils';
import * as express from 'express';
import * as asyncHandler from 'express-async-handler';
import * as HttpStatus from 'http-status-codes';
import { mapValues } from 'lodash';
import * as supertest from 'supertest';

import { Integrator } from '../../config';
import { QuoteRequestor, V4RFQIndicativeQuoteMM } from '../../quoteRequestor/QuoteRequestor';
import { FeeService } from '../../services/fee_service';
import { RfqtService } from '../../services/RfqtService';
import { RfqMakerBalanceCacheService } from '../../services/rfq_maker_balance_cache_service';
import type { RfqtV2Price, RfqtV2Quote, SignedNativeOrder } from '../../core/types';
import { ConfigManager } from '../../utils/config_manager';
import { QuoteServerClient } from '../../utils/quote_server_client';
import { RfqMakerManager } from '../../utils/rfq_maker_manager';
import { TokenMetadataManager } from '../../utils/TokenMetadataManager';
import { RfqtHandlers } from '../RfqtHandlers';
import { RfqBlockchainUtils } from '../../utils/rfq_blockchain_utils';
import { DEFAULT_MIN_EXPIRY_DURATION_MS } from '../../core/constants';
import { CacheClient } from '../../utils/cache_client';
import { TokenPriceOracle } from '../../utils/TokenPriceOracle';
import { RfqDynamicBlacklist } from '../../utils/rfq_dynamic_blacklist';

jest.mock('../../services/RfqtService', () => {
    return {
        RfqtService: jest.fn().mockImplementation(() => {
            return {
                getV1PricesAsync: jest.fn(),
                getV1QuotesAsync: jest.fn(),
                getV2PricesAsync: jest.fn(),
                getV2QuotesAsync: jest.fn(),
                getVolumeUSDAsync: jest.fn(),
            };
        }),
    };
});

jest.mock('../../utils/config_manager', () => {
    return {
        ConfigManager: jest.fn().mockImplementation(() => {
            return {
                getIntegratorByIdOrThrow: jest.fn(),
            };
        }),
    };
});

// tslint:disable: no-object-literal-type-assertion
const mockRfqtService = jest.mocked(
    new RfqtService(
        0,
        {} as RfqMakerManager,
        {} as QuoteRequestor,
        {} as QuoteServerClient,
        DEFAULT_MIN_EXPIRY_DURATION_MS,
        {} as RfqBlockchainUtils,
        {} as TokenMetadataManager,
        {} as ContractAddresses,
        {} as FeeService,
        1,
        {} as RfqMakerBalanceCacheService,
        {} as CacheClient,
        {} as TokenPriceOracle,
        new Set() as RfqDynamicBlacklist,
    ),
);
// Jest workaround for getter
mockRfqtService.feeModelVersion = 1;
mockRfqtService.getTokenDecimalsAsync = jest.fn().mockResolvedValue(18);

const mockConfigManager = jest.mocked(new ConfigManager());
// tslint:enable: no-object-literal-type-assertion

// tslint:disable-next-line: custom-no-magic-numbers
const rfqtHandlers = new RfqtHandlers(new Map([[1337, mockRfqtService]]), mockConfigManager);

/**
 * Verifies the proper response to a request using a mocked `RfqtService`.
 *
 * Each case sets up its own little Express app to avoid coupiling this
 * test to the upstream router.
 */
describe('RfqtHandlers', () => {
    describe('parameter verification with _parseV1RequestParameters', () => {
        it('throws if a required parameter is missing', async () => {
            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set('Content-type', 'application/json')
                .send({ makerToken: '0xmakertoken' });

            expect(response.body.error).toContain('missing parameters');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws if the chain ID is invalid', async () => {
            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 'liger' })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 'liger',
                    makerToken: '0xmakertoken',
                    marketOperation: 'Trade', // Invalid
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-integrator-id',
                });

            expect(response.body.error).toContain('Chain ID is invalid');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws with an invalid market operation', async () => {
            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Trade', // Invalid
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-integrator-id',
                });

            expect(response.body.error).toContain('invalid market operation');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws when the integrator does not exist', async () => {
            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                throw new Error("explodes because the integrator doesn't exist");
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-ghost-integrator-id',
                });

            expect(response.body.error).toContain('No integrator found for integrator ID');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws if there is no RFQt service for the chain id', async () => {
            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 21 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 21, // No RFQt service exists for 21
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(response.body.error).toContain('No configuration exists for chain');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });
    });

    describe('getV1PriceAsync', () => {
        it('responds with an error if the underlying service call fails', async () => {
            mockRfqtService.getV1PricesAsync.mockRejectedValueOnce(new Error('The service blew up'));

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });
            expect(response.body.error).toContain('blew up');
            expect(response.statusCode).toEqual(HttpStatus.INTERNAL_SERVER_ERROR);
        });

        it('passes calls on to RfqtService', async () => {
            mockRfqtService.getV1PricesAsync.mockResolvedValue([]);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(mockRfqtService.getV1PricesAsync.mock.calls[0]).toMatchInlineSnapshot(`
                [
                  {
                    "altRfqAssetOfferings": {},
                    "assetFillAmount": "100",
                    "chainId": 1337,
                    "comparisonPrice": undefined,
                    "integrator": {
                      "allowedChainIds": [
                        1337,
                      ],
                      "apiKeys": [],
                      "integratorId": "uuid-integrator-id",
                      "label": "Polygon Swap Machine",
                      "plp": false,
                      "rfqm": false,
                    },
                    "integratorId": "uuid-polygon-swap-machine",
                    "intentOnFilling": false,
                    "makerToken": "0xmakertoken",
                    "marketOperation": "Buy",
                    "takerAddress": "0xtakeraddress",
                    "takerToken": "0xtakertoken",
                    "txOrigin": "0xtxorigin",
                  },
                ]
            `);
        });

        it('returns prices from RFQt Service', async () => {
            const price: V4RFQIndicativeQuoteMM = {
                makerUri: 'http://maker-uri',
                makerToken: '0xmakertoken',
                makerAmount: new BigNumber(1234),
                takerToken: '0xtakertoken',
                takerAmount: new BigNumber(9876),
                expiry: new BigNumber(6969642069),
            };

            mockRfqtService.getV1PricesAsync.mockResolvedValue([price]);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(response.body.prices[0]).toStrictEqual(convertBigNumbersToJson(price));
            expect(response.statusCode).toEqual(HttpStatus.OK);
        });
    });

    describe('getV1QuotesAsync', () => {
        it('responds with an error if the underlying service call fails', async () => {
            mockRfqtService.getV1QuotesAsync.mockRejectedValueOnce(new Error('The service blew up'));

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: true,
                    integratorId: 'uuid-polygon-swap-machine',
                });
            expect(response.body.error).toContain('blew up');
            expect(response.statusCode).toEqual(HttpStatus.INTERNAL_SERVER_ERROR);
        });

        it('passes calls on to RfqtService', async () => {
            mockRfqtService.getV1QuotesAsync.mockResolvedValue([]);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: true,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(mockRfqtService.getV1QuotesAsync.mock.calls[0]).toMatchInlineSnapshot(`
                [
                  {
                    "altRfqAssetOfferings": {},
                    "assetFillAmount": "100",
                    "chainId": 1337,
                    "comparisonPrice": undefined,
                    "integrator": {
                      "allowedChainIds": [
                        1337,
                      ],
                      "apiKeys": [],
                      "integratorId": "uuid-integrator-id",
                      "label": "Polygon Swap Machine",
                      "plp": false,
                      "rfqm": false,
                    },
                    "integratorId": "uuid-polygon-swap-machine",
                    "intentOnFilling": true,
                    "makerToken": "0xmakertoken",
                    "marketOperation": "Buy",
                    "takerAddress": "0xtakeraddress",
                    "takerToken": "0xtakertoken",
                    "txOrigin": "0xtxorigin",
                  },
                ]
            `);
        });

        it('returns quotes from RFQt Service', async () => {
            const quote: SignedNativeOrder = {
                order: {
                    txOrigin: '0xtxorigin',
                    pool: '0xswimmingpool',
                    salt: new BigNumber(21),
                    makerToken: '0xmakertoken',
                    makerAmount: new BigNumber(1234),
                    takerToken: '0xtakertoken',
                    takerAmount: new BigNumber(9876),
                    expiry: new BigNumber(6969642069),
                    maker: '0xmakeraddress',
                    taker: '0xtakeraddress',
                    chainId: 1337,
                    verifyingContract: '0xdef1',
                },
                type: FillQuoteTransformerOrderType.Rfq,
                signature: {
                    v: 1,
                    r: '',
                    s: '',
                    signatureType: SignatureType.EthSign,
                },
            };

            mockRfqtService.getV1QuotesAsync.mockResolvedValue([quote]);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV1QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(response.body.quotes[0]).toStrictEqual(convertBigNumbersToJson(quote));
            expect(response.statusCode).toEqual(HttpStatus.OK);
        });
    });

    describe('parameter verification with _retrieveQuoteContext', () => {
        it('throws if a required parameter is missing', async () => {
            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({ makerToken: '0xmakertoken' });

            expect(response.body.error).toContain('missing parameter');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws if the chain ID is invalid', async () => {
            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 'liger' })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 'liger',
                    makerToken: '0xmakertoken',
                    marketOperation: 'Trade', // Invalid
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-integrator-id',
                });

            expect(response.body.error).toContain('Chain ID is invalid');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('validating gasPrice', async () => {
            const requestBody = {
                altRfqAssetOfferings: {},
                assetFillAmount: new BigNumber(100),
                chainId: 1337,
                makerToken: '0xmakertoken',
                marketOperation: 'Buy', // Invalid
                takerToken: '0xtakertoken',
                takerAddress: '0xtakeraddress',
                txOrigin: '0xtxorigin',
                intentOnFilling: false,
                integratorId: 'uuid-integrator-id',
                gasPrice: new BigNumber(1000000000),
            };

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send(requestBody);

            expect(mockRfqtService.getV2QuotesAsync.mock.calls[0][0].gasPrice).toEqual(new BigNumber(1000000000));

            const requestBody2 = {
                ...requestBody,
                gasPrice: '1000000000', // test string input
            };

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send(requestBody2);

            expect(mockRfqtService.getV2QuotesAsync.mock.calls[1][0].gasPrice).toEqual(new BigNumber(1000000000));

            const requestBody3 = {
                ...requestBody,
                gasPrice: undefined, // test string input
            };

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send(requestBody3);

            expect(mockRfqtService.getV2QuotesAsync.mock.calls[2][0].gasPrice).toEqual(undefined);
            jest.clearAllMocks();
        });

        it('throws with an invalid market operation', async () => {
            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Trade', // Invalid
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-integrator-id',
                });

            expect(response.body.error).toContain('invalid market operation');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws when the integrator does not exist', async () => {
            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                throw new Error("explodes because the integrator doesn't exist");
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-ghost-integrator-id',
                });

            expect(response.body.error).toContain('No integrator found for integrator ID');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });

        it('throws if there is no RFQt service for the chain id', async () => {
            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 21 })
                .send({
                    altRfqAssetOfferings: {},
                    assetFillAmount: new BigNumber(100),
                    chainId: 21, // No RFQt service exists for 21
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(response.body.error).toContain('No configuration exists for chain');
            expect(response.statusCode).toEqual(HttpStatus.BAD_REQUEST);
        });
    });

    describe('getV2PriceAsync', () => {
        it('responds with an error if the underlying service call fails', async () => {
            mockRfqtService.getV2PricesAsync.mockRejectedValueOnce(new Error('The service blew up'));
            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });
            expect(response.body.error).toContain('blew up');
            expect(response.statusCode).toEqual(HttpStatus.INTERNAL_SERVER_ERROR);
        });

        it('passes calls on to RfqtService', async () => {
            mockRfqtService.getV2PricesAsync.mockResolvedValue([]);
            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(mockRfqtService.getV2PricesAsync.mock.calls[0]).toMatchInlineSnapshot(`
                [
                  {
                    "assetFillAmount": "100",
                    "bucket": undefined,
                    "chainId": 1337,
                    "feeModelVersion": 1,
                    "gasPrice": undefined,
                    "integrator": {
                      "allowedChainIds": [
                        1337,
                      ],
                      "apiKeys": [],
                      "integratorId": "uuid-integrator-id",
                      "label": "Polygon Swap Machine",
                      "plp": false,
                      "rfqm": false,
                    },
                    "isFirm": false,
                    "isSelling": false,
                    "isUnwrap": false,
                    "makerAmount": "100",
                    "makerToken": "0xmakertoken",
                    "makerTokenDecimals": 18,
                    "originalMakerToken": "0xmakertoken",
                    "takerAddress": "0xtakeraddress",
                    "takerAmount": undefined,
                    "takerToken": "0xtakertoken",
                    "takerTokenDecimals": 18,
                    "trader": "0xtakeraddress",
                    "txOrigin": "0xtxorigin",
                    "volumeUSD": undefined,
                    "workflow": "rfqt",
                  },
                ]
            `);
        });

        it('returns prices from RFQt Service', async () => {
            const prices: RfqtV2Price[] = [
                {
                    makerId: 'maker1',
                    makerUri: 'http://maker-uri',
                    makerAddress: 'maker-address',
                    makerToken: '0xmakertoken',
                    makerAmount: new BigNumber(1234),
                    takerToken: '0xtakertoken',
                    takerAmount: new BigNumber(9876),
                    expiry: new BigNumber(6969642069),
                },
            ];

            mockRfqtService.getV2PricesAsync.mockResolvedValue(prices);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2PricesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(response.body.prices[0]).toStrictEqual(convertBigNumbersToJson(prices[0]));
            expect(response.statusCode).toEqual(HttpStatus.OK);
        });
    });

    describe('getV2QuotesAsync', () => {
        it('responds with an error if the underlying service call fails', async () => {
            mockRfqtService.getV2QuotesAsync.mockRejectedValueOnce(new Error('The service blew up'));

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: true,
                    integratorId: 'uuid-polygon-swap-machine',
                });
            expect(response.body.error).toContain('blew up');
            expect(response.statusCode).toEqual(HttpStatus.INTERNAL_SERVER_ERROR);
        });

        it('passes calls on to RfqtService', async () => {
            mockRfqtService.getV2QuotesAsync.mockResolvedValue([]);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: true,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(mockRfqtService.getV2QuotesAsync.mock.calls[0]).toMatchInlineSnapshot(`
                [
                  {
                    "assetFillAmount": "100",
                    "bucket": undefined,
                    "chainId": 1337,
                    "feeModelVersion": 1,
                    "gasPrice": undefined,
                    "integrator": {
                      "allowedChainIds": [
                        1337,
                      ],
                      "apiKeys": [],
                      "integratorId": "uuid-integrator-id",
                      "label": "Polygon Swap Machine",
                      "plp": false,
                      "rfqm": false,
                    },
                    "isFirm": true,
                    "isSelling": false,
                    "isUnwrap": false,
                    "makerAmount": "100",
                    "makerToken": "0xmakertoken",
                    "makerTokenDecimals": 18,
                    "originalMakerToken": "0xmakertoken",
                    "takerAddress": "0xtakeraddress",
                    "takerAmount": undefined,
                    "takerToken": "0xtakertoken",
                    "takerTokenDecimals": 18,
                    "trader": "0xtakeraddress",
                    "txOrigin": "0xtxorigin",
                    "volumeUSD": undefined,
                    "workflow": "rfqt",
                  },
                ]
            `);
        });

        it('returns quotes from RFQt Service', async () => {
            const quotes: RfqtV2Quote[] = [
                {
                    fillableMakerAmount: new BigNumber(1234),
                    fillableTakerAmount: new BigNumber(9876),
                    fillableTakerFeeAmount: new BigNumber(0),
                    makerId: 'maker1',
                    makerUri: 'https://maker-uri',
                    order: new OtcOrder({
                        txOrigin: '0xtxorigin',
                        makerToken: '0xmakertoken',
                        makerAmount: new BigNumber(1234),
                        takerToken: '0xtakertoken',
                        takerAmount: new BigNumber(9876),
                        expiryAndNonce: new BigNumber(6969642069),
                        maker: '0xmakeraddress',
                        taker: '0xtakeraddress',
                        chainId: 1337,
                        verifyingContract: '0xdef1',
                    }),
                    signature: {
                        v: 1,
                        r: '',
                        s: '',
                        signatureType: SignatureType.EthSign,
                    },
                },
            ];

            mockRfqtService.getV2QuotesAsync.mockResolvedValue(quotes);

            mockConfigManager.getIntegratorByIdOrThrow.mockImplementationOnce(() => {
                const integrator: Integrator = {
                    apiKeys: [],
                    integratorId: 'uuid-integrator-id',
                    // tslint:disable-next-line: custom-no-magic-numbers
                    allowedChainIds: [1337],
                    label: 'Polygon Swap Machine',
                    plp: false,
                    rfqm: false,
                };
                return integrator;
            });

            const response = await supertest(
                express()
                    .use(express.json())
                    .post('/', asyncHandler(rfqtHandlers.getV2QuotesAsync.bind(rfqtHandlers))),
            )
                .post('/')
                .set({ 'Content-type': 'application/json', '0x-chain-id': 1337 })
                .send({
                    assetFillAmount: new BigNumber(100),
                    chainId: 1337,
                    makerToken: '0xmakertoken',
                    marketOperation: 'Buy',
                    takerToken: '0xtakertoken',
                    takerAddress: '0xtakeraddress',
                    txOrigin: '0xtxorigin',
                    intentOnFilling: false,
                    integratorId: 'uuid-polygon-swap-machine',
                });

            expect(response.body.quotes[0]).toStrictEqual(convertBigNumbersToJson(quotes[0]));
            expect(response.statusCode).toEqual(HttpStatus.OK);
        });
    });
});

/**
 * Deeply transforms object keys from BigNumber to JSON
 */
// $eslint-fix-me https://github.com/rhinodavid/eslint-fix-me
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function convertBigNumbersToJson(x: Record<string, any>): Record<string, any> {
    return mapValues(x, (v) => {
        if (v instanceof BigNumber) {
            return v.toJSON();
        }
        if (v instanceof Object) {
            return convertBigNumbersToJson(v);
        }
        return v;
    });
}
