import { CHAINS_WITH_PRICE_ORACLES as _CHAINS_WITH_PRICE_ORACLES } from "@connext/nxtp-txservice";
import { createLoggingContext, jsonifyError, RequestContext } from "@connext/nxtp-utils";
import { constants, BigNumber, utils, providers } from "ethers";
import { getMainnetEquivalent } from ".";

import { getContext } from "../../router";
import {
  ExpressiveAssetBalance,
  feesCollected,
  gasConsumed,
  relayerFeesPaid,
  totalTransferredVolume,
  TransactionReason,
} from "../entities";
import { FailedToGetExpressiveAssetBalances } from "../errors/metrics";

export const CHAINS_WITH_PRICE_ORACLES = _CHAINS_WITH_PRICE_ORACLES;

export const getDecimals = async (assetId: string, chainId: number): Promise<number> => {
  const { chainData, txService } = getContext();

  const entry =
    chainData.get(chainId.toString())?.assetId[utils.getAddress(assetId)] ??
    chainData.get(chainId.toString())?.assetId[assetId.toLowerCase()] ??
    chainData.get(chainId.toString())?.assetId[assetId.toUpperCase()];
  let decimals = entry?.decimals;
  if (!decimals) {
    decimals = await txService.getDecimalsForAsset(chainId, assetId);
  }
  return decimals;
};

export const convertToUsd = async (
  assetId: string,
  chainId: number,
  amount: string,
  _requestContext: RequestContext,
): Promise<number> => {
  const { txService, logger, chainData } = getContext();
  const { requestContext, methodContext } = createLoggingContext(convertToUsd.name, _requestContext);
  const assetIdOnMainnet = await getMainnetEquivalent(chainId, assetId, chainData);
  const chainIdForTokenPrice = assetIdOnMainnet ? 1 : chainId;
  const assetIdForTokenPrice = assetIdOnMainnet ? assetIdOnMainnet : assetId;
  if (!CHAINS_WITH_PRICE_ORACLES.includes(chainIdForTokenPrice)) return 0;
  const price = await txService.getTokenPrice(chainIdForTokenPrice, assetIdForTokenPrice, undefined, requestContext);
  if (price.isZero()) {
    // Do nothing
    return 0;
  }

  // Convert to USD
  const decimals = await getDecimals(assetId, chainId);
  const usdWei = BigNumber.from(amount).mul(price).div(BigNumber.from(10).pow(18));
  logger.debug("Got value in wei", requestContext, methodContext, {
    assetId,
    chainId,
    decimals,
    amount,
    usdWei,
  });
  // Convert to correct decimals
  return +utils.formatUnits(usdWei, decimals);
};

export const getAssetName = (assetId: string, chainId: number): string | undefined => {
  const { config, chainData } = getContext();

  // Find matching swap pool
  const match = config.swapPools.find((pool) => {
    const idx = pool.assets.findIndex((asset) => chainId === asset.chainId && asset.assetId === assetId.toLowerCase());
    return idx !== -1;
  });

  if (match?.name) {
    return match.name;
  }

  const entry =
    chainData.get(chainId.toString())?.assetId[utils.getAddress(assetId)] ??
    chainData.get(chainId.toString())?.assetId[assetId.toUpperCase()] ??
    chainData.get(chainId.toString())?.assetId[assetId.toLowerCase()];

  if (entry?.mainnetEquivalent) {
    const mainnetEntry =
      chainData.get("1")?.assetId[utils.getAddress(entry.mainnetEquivalent)] ??
      chainData.get("1")?.assetId[entry.mainnetEquivalent.toUpperCase()] ??
      chainData.get("1")?.assetId[entry.mainnetEquivalent.toLowerCase()];
    return mainnetEntry?.symbol;
  }

  return entry?.symbol;
};

const EXPRESSIVE_LIQUIDITY_CACHE_EXPIRY = 5_000;
export const getLiquidityCacheExpiry = () => EXPRESSIVE_LIQUIDITY_CACHE_EXPIRY; // For testing
const collectExpressiveLiquidityCache: { retrieved: number; value?: Record<number, ExpressiveAssetBalance<number>[]> } =
  {
    retrieved: 0,
    value: undefined,
  };
export const collectExpressiveLiquidity = async (): Promise<
  Record<number, ExpressiveAssetBalance<number>[]> | undefined
> => {
  // For each chain, get current router balances
  const { logger, contractReader, config } = getContext();

  const { requestContext, methodContext } = createLoggingContext(collectExpressiveLiquidity.name);

  try {
    logger.debug("Method start", requestContext, methodContext);

    const elapsed = Date.now() - collectExpressiveLiquidityCache.retrieved;
    if (elapsed < getLiquidityCacheExpiry() && collectExpressiveLiquidityCache.value) {
      return collectExpressiveLiquidityCache.value;
    }

    // Get all the supported chains
    const chainIds = Object.keys(config.chainConfig).map((c) => parseInt(c));

    // Get all the asset balances for that chain
    const assetBalances: Record<number, ExpressiveAssetBalance[]> = {};
    await Promise.all(
      chainIds.map(async (chainId) => {
        try {
          const expressive = await contractReader.getExpressiveAssetBalances(chainId);
          logger.debug("Got expressive balances from subgraph", requestContext, methodContext, {
            chainId,
            expressive,
          });
          assetBalances[chainId] = expressive;
        } catch (e: any) {
          logger.warn("Failed to get expressive liquidity from subgraph", requestContext, methodContext, {
            chainId,
            error: jsonifyError(e),
          });
        }
      }),
    );
    if (Object.values(assetBalances).length === 0) {
      throw new FailedToGetExpressiveAssetBalances(chainIds);
    }

    // Convert all balances to USD
    const converted: Record<string, ExpressiveAssetBalance<number>[]> = {};
    await Promise.all(
      Object.entries(assetBalances).map(async ([chainId, assetValues]) => {
        converted[chainId] = [];
        await Promise.all(
          assetValues.map(async (value) => {
            try {
              const amount = await convertToUsd(value.assetId, +chainId, value.amount.toString(), requestContext);
              const supplied = await convertToUsd(value.assetId, +chainId, value.supplied.toString(), requestContext);
              const locked = await convertToUsd(value.assetId, +chainId, value.locked.toString(), requestContext);
              const removed = await convertToUsd(value.assetId, +chainId, value.removed.toString(), requestContext);
              // const volume = await convertToUsd(value.assetId, +chainId, value.volume.toString(), requestContext);
              // const volumeIn = await convertToUsd(value.assetId, +chainId, value.volumeIn.toString(), requestContext);
              // converted[chainId].push({ assetId: value.assetId, amount, supplied, locked, removed, volume, volumeIn });
              const val = { assetId: value.assetId, amount, supplied, locked, removed };
              logger.debug("Converted expressive balances to usd", requestContext, methodContext, {
                converted: val,
                chainId,
              });
              converted[chainId].push(val);
            } catch (e: any) {
              logger.warn("Failed to convert expressive liquidity to USD", requestContext, methodContext, {
                error: jsonifyError(e),
                value,
                chainId,
              });
            }
          }),
        );
      }),
    );

    collectExpressiveLiquidityCache.retrieved = Date.now();
    collectExpressiveLiquidityCache.value = converted;
    logger.debug("Method complete", requestContext, methodContext, { liquidity: converted });
    return converted;
  } catch (e: any) {
    logger.error("Failed to collect expressive liquidity", requestContext, methodContext, jsonifyError(e));
    return undefined;
  }
};

export const collectOnchainLiquidity = async (): Promise<Record<number, { assetId: string; amount: number }[]>> => {
  // For each chain, get current router balances
  const { logger, contractReader, config } = getContext();

  const { requestContext, methodContext } = createLoggingContext(collectOnchainLiquidity.name);
  logger.debug("Method start", requestContext, methodContext);

  try {
    // Get all the supported chains
    const chainIds = Object.keys(config.chainConfig).map((c) => parseInt(c));

    // Get all the asset balances for that chain
    const assetBalances: Record<number, { assetId: string; amount: BigNumber }[]> = {};
    await Promise.all(
      chainIds.map(async (chainId) => {
        try {
          assetBalances[chainId] = await contractReader.getAssetBalances(chainId);
        } catch (e: any) {
          logger.error(
            `Failed to collect assetBalances for chain ${chainId}`,
            requestContext,
            methodContext,
            jsonifyError(e),
          );
        }
      }),
    );

    // Convert all balances to USD
    const converted: Record<string, { assetId: string; amount: number }[]> = {};
    await Promise.all(
      Object.entries(assetBalances).map(async ([chainId, assetValues]) => {
        converted[chainId] = [];
        await Promise.all(
          assetValues.map(async (value) => {
            let usd = 0;
            try {
              usd = await convertToUsd(value.assetId, parseInt(chainId), value.amount.toString(), requestContext);
            } catch (e: any) {
              logger.debug(
                `Failed to convert ${value.assetId} to USD for chain ${chainId}`,
                requestContext,
                methodContext,
                { err: jsonifyError(e), assetId: value.assetId, chainId },
              );
            }
            converted[chainId].push({ assetId: value.assetId, amount: usd });
          }),
        );
      }),
    );

    logger.debug("Method complete", requestContext, methodContext, { liquidity: converted });
    return converted;
  } catch (e: any) {
    logger.error("Failed to collect onchain liquidity", requestContext, methodContext, jsonifyError(e));
    throw e;
  }
};

export const collectGasBalance = async (): Promise<Record<number, number>> => {
  const { config, txService, routerAddress, logger } = getContext();

  const balances: Record<number, number> = {};
  await Promise.all(
    Object.keys(config.chainConfig)
      .map((c) => +c)
      .map(async (chainId) => {
        try {
          const balance = await txService.getBalance(chainId, routerAddress, constants.AddressZero);
          balances[chainId] = +utils.formatEther(balance.toString());
        } catch (e: any) {
          logger.warn("Failed to get gas balance", undefined, undefined, {
            error: e.message,
          });
        }
      }),
  );
  return balances;
};

export const collectRpcHeads = async (): Promise<Record<number, number>> => {
  const { config, txService, logger } = getContext();

  const blocks: Record<number, number> = {};
  await Promise.all(
    Object.keys(config.chainConfig)
      .map((c) => +c)
      .map(async (chainId) => {
        try {
          blocks[chainId] = await txService.getBlockNumber(chainId);
        } catch (e: any) {
          logger.warn("Failed to get rpc head", undefined, undefined, {
            error: e.message,
          });
        }
      }),
  );
  return blocks;
};

export const collectSubgraphHeads = async (): Promise<Record<number, number>> => {
  const { config, contractReader, logger } = getContext();

  const blocks: Record<number, number> = {};
  await Promise.all(
    Object.keys(config.chainConfig)
      .map((c) => +c)
      .map(async (chainId) => {
        try {
          const records = await contractReader.getSyncRecords(chainId);
          blocks[chainId] = Math.max(...records.map((r) => r.syncedBlock));
        } catch (e: any) {
          logger.warn("Failed to get subgraph head", undefined, undefined, {
            error: e.message,
          });
        }
      }),
  );
  return blocks;
};

export const incrementFees = async (
  transactionId: string,
  sendingAssetId: string,
  sendingChainId: number,
  receivingAssetId: string,
  receivingChainId: number,
  assetId: string,
  chainId: number,
  amount: BigNumber,
  _requestContext: RequestContext,
) => {
  if (amount.isZero()) {
    return;
  }
  const { logger } = getContext();

  const { requestContext, methodContext } = createLoggingContext(incrementFees.name, _requestContext);
  logger.debug("Method start", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    assetId,
    chainId,
    amount,
  });

  if (amount.isNegative()) {
    logger.warn("Got negative fees, doing nothing", requestContext, methodContext, {
      transactionId,
      sendingAssetId,
      sendingChainId,
      receivingAssetId,
      receivingChainId,
      assetId,
      chainId,
      amount,
    });
    return;
  }

  const fees = await convertToUsd(assetId, chainId, amount.toString(), requestContext);

  logger.debug("Got fees in usd", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    assetId,
    chainId,
    amount,
    fees,
  });

  // Update counter
  feesCollected.inc(
    {
      sendingAssetId,
      sendingChainId,
      receivingAssetId,
      receivingChainId,
      assetId,
      chainId,
      assetName: getAssetName(assetId, chainId),
    },
    fees,
  );
};

/**
 * Increments gas consumed by the router signer each time it sends a transaction
 *
 * @notice This function should only be called through the `adapters/contract/contract.ts` functions. This is because
 * costs paid for the transaction will be different if it is via a relayer or the txservice, and only those
 * functions will have proper context into that.
 * @param chainId - Chain transaction was sent on
 * @param receipt - Receipt to calculate gas for
 * @param reason - Why transaction was sent
 * @param _requestContext - Request context for top-level method
 * @returns void
 */
export const incrementGasConsumed = async (
  transactionId: string,
  sendingAssetId: string,
  sendingChainId: number,
  receivingAssetId: string,
  receivingChainId: number,
  chainId: number,
  receipt: providers.TransactionReceipt | undefined,
  reason: TransactionReason,
  _requestContext: RequestContext,
) => {
  if (!receipt) {
    return;
  }
  const { logger, txService } = getContext();

  const { requestContext, methodContext } = createLoggingContext(incrementGasConsumed.name, _requestContext);
  const { cumulativeGasUsed, effectiveGasPrice } = receipt;
  const price = effectiveGasPrice ?? (await txService.getGasPrice(chainId, requestContext));
  logger.debug("Method start", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    chainId,
    gas: cumulativeGasUsed.toString(),
    price: price.toString(),
  });

  const usd = await convertToUsd(
    constants.AddressZero,
    chainId,
    cumulativeGasUsed.mul(price).toString(),
    requestContext,
  );

  logger.debug("Got gas fees in usd", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    chainId,
    gas: cumulativeGasUsed.toString(),
    price: price.toString(),
    usd: usd.toString(),
  });

  // Update counter
  // TODO: reason type
  gasConsumed.inc(
    { sendingAssetId, sendingChainId, receivingAssetId, receivingChainId, reason, chainId },
    usd,
  );
};

/**
 * Increments relayer fees paid by the router signer each time it sends a transaction via relayers.
 *
 * @notice This function should only be called through the `adapters/contract/contract.ts` functions. This is because
 * costs paid for the transaction will be different if it is via a relayer or the txservice, and only those
 * functions will have proper context into that.
 * @param chainId - Chain transaction was sent on
 * @param relayerFee - Amount sent to relayer
 * @param assetId - Asset used to pay relayer
 * @param reason - Why transaction was sent
 * @param _requestContext - Request context for top-level method
 * @returns void
 */
export const incrementRelayerFeesPaid = async (
  transactionId: string,
  sendingAssetId: string,
  sendingChainId: number,
  receivingAssetId: string,
  receivingChainId: number,
  chainId: number,
  relayerFee: string,
  assetId: string,
  reason: TransactionReason,
  _requestContext: RequestContext,
) => {
  const { logger } = getContext();

  const { requestContext, methodContext } = createLoggingContext(incrementTotalTransferredVolume.name, _requestContext);
  logger.debug("Method start", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    chainId,
    assetId,
    relayerFee,
    reason,
  });

  const usd = await convertToUsd(assetId, chainId, relayerFee, requestContext);

  relayerFeesPaid.inc(
    { sendingAssetId, sendingChainId, receivingAssetId, receivingChainId, reason, chainId, assetId },
    usd,
  );
};

export const incrementTotalTransferredVolume = async (
  transactionId: string,
  sendingAssetId: string,
  sendingChainId: number,
  receivingAssetId: string,
  receivingChainId: number,
  assetId: string,
  chainId: number,
  amount: string,
  _requestContext: RequestContext,
) => {
  const { logger } = getContext();

  const { requestContext, methodContext } = createLoggingContext(incrementTotalTransferredVolume.name, _requestContext);
  logger.debug("Method start", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    chainId,
    assetId,
    amount,
  });

  const usd = await convertToUsd(assetId, chainId, amount, requestContext);

  logger.debug("Got transferred volume in usd", requestContext, methodContext, {
    transactionId,
    sendingAssetId,
    sendingChainId,
    receivingAssetId,
    receivingChainId,
    assetId,
    chainId,
    amount,
    usd: usd.toString(),
  });

  totalTransferredVolume.inc(
    {
      sendingAssetId,
      sendingChainId,
      receivingAssetId,
      receivingChainId,
      amount,
      assetName: getAssetName(assetId, chainId),
    },
    usd,
  );
};
