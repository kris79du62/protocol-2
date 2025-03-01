// SPDX-License-Identifier: Apache-2.0
/*
  Copyright 2023 ZeroEx Intl.
  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

pragma solidity ^0.6.5;
pragma experimental ABIEncoderV2;

import "./AbstractBridgeAdapter.sol";
import "./BridgeProtocols.sol";
import "./mixins/MixinCurve.sol";
import "./mixins/MixinDodo.sol";
import "./mixins/MixinDodoV2.sol";
import "./mixins/MixinKyberDmm.sol";
import "./mixins/MixinKyberElastic.sol";
import "./mixins/MixinMooniswap.sol";
import "./mixins/MixinNerve.sol";
import "./mixins/MixinUniswapV2.sol";
import "./mixins/MixinWOOFi.sol";
import "./mixins/MixinZeroExBridge.sol";

contract BSCBridgeAdapter is
    AbstractBridgeAdapter(56, "BSC"),
    MixinCurve,
    MixinDodo,
    MixinDodoV2,
    MixinKyberDmm,
    MixinKyberElastic,
    MixinMooniswap,
    MixinNerve,
    MixinUniswapV2,
    MixinWOOFi,
    MixinZeroExBridge
{
    constructor(IEtherToken weth) public MixinCurve(weth) MixinMooniswap(weth) {}

    function _trade(
        BridgeOrder memory order,
        IERC20Token sellToken,
        IERC20Token buyToken,
        uint256 sellAmount,
        bool dryRun
    ) internal override returns (uint256 boughtAmount, bool supportedSource) {
        uint128 protocolId = uint128(uint256(order.source) >> 128);
        if (protocolId == BridgeProtocols.CURVE) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeCurve(sellToken, buyToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.UNISWAPV2) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeUniswapV2(buyToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.MOONISWAP) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeMooniswap(sellToken, buyToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.DODO) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeDodo(sellToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.DODOV2) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeDodoV2(sellToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.NERVE) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeNerve(sellToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.KYBERDMM) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeKyberDmm(buyToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.KYBERELASTIC) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeKyberElastic(sellToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.WOOFI) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeWOOFi(sellToken, buyToken, sellAmount, order.bridgeData);
        } else if (protocolId == BridgeProtocols.UNKNOWN) {
            if (dryRun) {
                return (0, true);
            }
            boughtAmount = _tradeZeroExBridge(sellToken, buyToken, sellAmount, order.bridgeData);
        }

        emit BridgeFill(order.source, sellToken, buyToken, sellAmount, boughtAmount);
    }
}
