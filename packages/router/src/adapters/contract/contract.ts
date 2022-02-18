import {
  CancelParams,
  createLoggingContext,
  FulfillParams,
  PrepareParams,
  RequestContext,
  isChainSupportedByGelato as _isChainSupportedByGelato,
  gelatoSend as _gelatoSend,
  MetaTxTypes,
  jsonifyError,
  MetaTxPayloads,
  RemoveLiquidityParams,
  InvariantTransactionData,
  TransactionData,
} from "@connext/nxtp-utils";
import { BigNumber, constants, Contract, providers, utils } from "ethers";
import { Evt } from "evt";
import TransactionManagerArtifact from "@connext/nxtp-contracts/artifacts/contracts/TransactionManager.sol/TransactionManager.json";
import { TransactionManager as TTransactionManager } from "@connext/nxtp-contracts/typechain";

import { getContext } from "../../router";
import {
  getContractAddress,
  getTxManagerInterface,
  getErc20ContractInterface,
  sanitationCheck,
  isRouterWhitelisted,
  getRouterContractInterface,
  incrementGasConsumed,
} from "../../lib/helpers";
import { TransactionReasons } from "../../lib/entities";
import { incrementRelayerFeesPaid } from "../../lib/helpers/metrics";

export const prepareEvt = new Evt<{ event: any; args: PrepareParams; chainId: number }>(); // TODO: fix types
export const fulfillEvt = new Evt<{ event: any; args: FulfillParams; chainId: number }>();
export const cancelEvt = new Evt<{ event: any; args: CancelParams; chainId: number }>();
export const removeLiquidityEvt = new Evt<{
  event: any;
  args: RemoveLiquidityParams;
  chainId: number;
}>();

// FOR MOCK TEST
export const isChainSupportedByGelato = _isChainSupportedByGelato;
export const gelatoSend = _gelatoSend;

export const startContractListeners = (): void => {
  const { config, txService, logger } = getContext();
  Object.entries(config.chainConfig).forEach(async ([_chainId, conf]) => {
    const chainId = Number(_chainId);
    if (config.routerContractAddress) {
      // needs event listeners for listening to relayed events
      // TODO remove this when we can query gelato for tx receipts
      // alternatively allow listening on the subgraph
      const contract = new Contract(
        conf.transactionManagerAddress,
        TransactionManagerArtifact.abi,
        txService.getProvider(chainId).fallbackProvider,
      ) as TTransactionManager;
      contract.on("TransactionPrepared", (_user, _router, _transactionId, _txData, _caller, args, event) => {
        if (utils.getAddress(config.routerContractAddress!) === utils.getAddress(_router)) {
          const invariantData: InvariantTransactionData = {
            callDataHash: args.invariantData.callDataHash,
            initiator: args.invariantData.initiator,
            receivingAssetId: args.invariantData.receivingAssetId,
            receivingChainId: args.invariantData.receivingChainId,
            sendingChainId: args.invariantData.sendingChainId,
            callTo: args.invariantData.callTo,
            receivingAddress: args.invariantData.receivingAddress,
            receivingChainTxManagerAddress: args.invariantData.receivingChainTxManagerAddress,
            router: args.invariantData.router,
            sendingAssetId: args.invariantData.sendingAssetId,
            sendingChainFallback: args.invariantData.sendingChainFallback,
            transactionId: args.invariantData.transactionId,
            user: args.invariantData.user,
          };
          prepareEvt.post({
            event,
            args: {
              amount: args.amount,
              bidSignature: args.bidSignature,
              encodedBid: args.encodedBid,
              encryptedCallData: args.encryptedCallData,
              expiry: args.expiry,
              txData: invariantData,
            },
            chainId,
          });
        }
      });
      contract.on(
        "TransactionFulfilled",
        (_user, _router, _transactionId, args, _success, _isContract, _returnData, _caller, event) => {
          if (utils.getAddress(config.routerContractAddress!) === utils.getAddress(_router)) {
            const txData: TransactionData = {
              callDataHash: args.txData.callDataHash,
              initiator: args.txData.initiator,
              receivingAssetId: args.txData.receivingAssetId,
              receivingChainId: args.txData.receivingChainId,
              sendingChainId: args.txData.sendingChainId,
              callTo: args.txData.callTo,
              receivingAddress: args.txData.receivingAddress,
              receivingChainTxManagerAddress: args.txData.receivingChainTxManagerAddress,
              router: args.txData.router,
              sendingAssetId: args.txData.sendingAssetId,
              sendingChainFallback: args.txData.sendingChainFallback,
              transactionId: args.txData.transactionId,
              user: args.txData.user,
              amount: args.txData.amount,
              expiry: args.txData.expiry,
              preparedBlockNumber: args.txData.preparedBlockNumber,
            };
            fulfillEvt.post({
              event,
              args: {
                callData: args.callData,
                signature: args.signature,
                relayerFee: args.relayerFee,
                txData,
              },
              chainId,
            });
          }
        },
      );
      contract.on("TransactionCancelled", (_user, _router, _transactionId, args, _caller, event) => {
        if (utils.getAddress(config.routerContractAddress!) === utils.getAddress(_router)) {
          const txData: TransactionData = {
            callDataHash: args.txData.callDataHash,
            initiator: args.txData.initiator,
            receivingAssetId: args.txData.receivingAssetId,
            receivingChainId: args.txData.receivingChainId,
            sendingChainId: args.txData.sendingChainId,
            callTo: args.txData.callTo,
            receivingAddress: args.txData.receivingAddress,
            receivingChainTxManagerAddress: args.txData.receivingChainTxManagerAddress,
            router: args.txData.router,
            sendingAssetId: args.txData.sendingAssetId,
            sendingChainFallback: args.txData.sendingChainFallback,
            transactionId: args.txData.transactionId,
            user: args.txData.user,
            amount: args.txData.amount,
            expiry: args.txData.expiry,
            preparedBlockNumber: args.txData.preparedBlockNumber,
          };
          cancelEvt.post({
            event,
            args: {
              signature: args.signature,
              txData,
            },
            chainId,
          });
        }
      });

      contract.on("LiquidityRemoved", (router, assetId, amount, recipient, event) => {
        if (utils.getAddress(config.routerContractAddress!) === utils.getAddress(router)) {
          removeLiquidityEvt.post({
            event,
            args: { amount, router, assetId, recipient },
            chainId,
          });
        }
      });
    }
  });
  logger.info("Started listening for events on TransactionManager");
};

/**
 * Method calls `prepare` on the `TransactionManager` on the given chain. Should be used to `prepare` the receiver-side transaction. Resolves when the transaction has been mined.
 *
 * @param chainId - The chain you are preparing a transaction on
 * @param prepareParams - Arguments to supply to contract
 * @param prepareParams.txData - The `InvariantTransactionData` for the transaction being prepared
 * @param prepareParams.amount - The amount to be deducted from the liquidity held by the router on the TransactionManager
 * @param prepareParams.expiry - The timestamp the transaction will expire by
 * @param prepareParams.encryptedCallData - The user-encrypted calldata to be executed on the receiving chain
 * @param prepareParams.encodedBid - The encoded auction bid
 * @param prepareParams.bidSignature - The signature on the winning bid
 *
 * @returns If successful, returns `TransactionReceipt` from the prepare transaction sent to the `TransactionManager.sol`. If it fails, returns a `TransactionManagerError`
 *
 */
export const prepareTransactionManager = async (
  chainId: number,
  prepareParams: PrepareParams,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(prepareTransactionManager.name);

  const { logger, txService, wallet } = getContext();
  logger.info("Method start", requestContext, methodContext, {
    prepareParams,
  });

  const { txData, amount, expiry, encodedBid, bidSignature, encryptedCallData } = prepareParams;

  await sanitationCheck(chainId, { ...txData, amount: "0", expiry: 0, preparedBlockNumber: 0 }, "prepare");

  const nxtpContractAddress = getContractAddress(chainId);
  const encodedData = getTxManagerInterface().encodeFunctionData("prepare", [
    {
      invariantData: txData,
      amount,
      expiry,
      encryptedCallData,
      encodedBid,
      bidSignature,
      encodedMeta: "0x",
    },
  ]);

  const addr = wallet.address ?? (await wallet.getAddress());
  const receipt = await txService.sendTx(
    {
      to: nxtpContractAddress,
      data: encodedData,
      value: constants.Zero,
      chainId,
      from: addr,
    },
    requestContext,
  );

  // increment fees sent (no need to await)
  incrementGasConsumed(
    txData.transactionId,
    txData.sendingAssetId,
    txData.sendingChainId,
    txData.receivingAssetId,
    txData.receivingChainId,
    chainId,
    receipt,
    txData.router.toLowerCase() === addr.toLowerCase() ? TransactionReasons.PrepareReceiver : TransactionReasons.Relay,
    requestContext,
  );

  return receipt;
};

export const prepareRouterContract = async (
  chainId: number,
  prepareParams: PrepareParams,
  routerContractAddress: string,
  signature: string,
  routerRelayerFeeAsset: string,
  routerRelayerFee: string,
  useRelayer: boolean,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(prepareRouterContract.name);

  const { logger, txService, wallet, messaging } = getContext();
  logger.info("Method start", requestContext, methodContext, {
    prepareParams,
    routerRelayerFeeAsset,
    routerRelayerFee,
  });

  const { txData, amount, expiry, encodedBid, bidSignature, encryptedCallData } = prepareParams;

  await sanitationCheck(chainId, { ...txData, amount: "0", expiry: 0, preparedBlockNumber: 0 }, "prepare");

  const encodedData = getRouterContractInterface().encodeFunctionData("prepare", [
    {
      invariantData: txData,
      amount,
      expiry,
      encryptedCallData,
      encodedBid,
      bidSignature,
      encodedMeta: "0x",
    },
    routerRelayerFeeAsset,
    routerRelayerFee,
    signature,
  ]);

  const onchainTx = {
    to: routerContractAddress,
    data: encodedData,
    value: constants.Zero,
    chainId,
    from: wallet.address,
  };
  if (useRelayer) {
    // If we are will be using relayers below, check to make sure the transaction is valid first (before relaying it)
    // by running an estimateGas check. This method will throw a TransactionReverted error (with the contract error code)
    // if the transaction would fail on chain.
    await txService.getGasEstimate(chainId, {
      ...onchainTx,
      from: undefined,
    });
  }

  // 1. Prepare tx using relayer if chain is supported by gelato.
  if (useRelayer && await isChainSupportedByGelato(chainId)) {
    logger.info("Router contract prepare: sending using Gelato relayer", requestContext, methodContext, {
      prepareParams,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const data = await gelatoSend(
        chainId,
        routerContractAddress,
        encodedData,
        routerRelayerFeeAsset,
        routerRelayerFee,
      );
      if (!data.taskId) {
        throw new Error("No taskId returned");
      }
      logger.info("Router contract prepare: sent using Gelato relayer", requestContext, methodContext, { data });

      // listen for event on contract
      const { event } = await prepareEvt
        .pipe(({ args }) => args.txData.transactionId === txData.transactionId)
        .waitFor(300_000);

      // increment router fees
      incrementRelayerFeesPaid(
        txData.transactionId,
        txData.sendingAssetId,
        txData.sendingChainId,
        txData.receivingAssetId,
        txData.receivingChainId,
        chainId,
        routerRelayerFee,
        routerRelayerFeeAsset,
        TransactionReasons.PrepareReceiver,
        requestContext,
      );

      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      logger.warn("Router contract prepare: Gelato send failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  // 2. If gelato is not supported, or gelato send failed, try using the router network.
  if (useRelayer) {
    logger.info("Router contract prepare: sending using router network", requestContext, methodContext, {
      prepareParams,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const payload = {
        chainId,
        to: routerContractAddress,
        type: MetaTxTypes.RouterContractPrepare,
        data: {
          params: prepareParams,
          signature,
          relayerFee: routerRelayerFee,
          relayerFeeAsset: routerRelayerFeeAsset,
        } as MetaTxPayloads[typeof MetaTxTypes.RouterContractPrepare],
      };
      await messaging.publishMetaTxRequest(payload);

      // listen for event on contract
      const { event } = await prepareEvt
        .pipe(({ args }) => args.txData.transactionId === txData.transactionId)
        .waitFor(300_000);

      // increment router fees
      incrementRelayerFeesPaid(
        txData.transactionId,
        txData.sendingAssetId,
        txData.sendingChainId,
        txData.receivingAssetId,
        txData.receivingChainId,
        chainId,
        routerRelayerFee,
        routerRelayerFeeAsset,
        TransactionReasons.PrepareReceiver,
        requestContext,
      );

      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      // NOTE: It is possible that the actual error was in the subscriber, and the above event's timeout
      // (see waitFor) is the error we actually caught in this block.
      logger.warn("Router contract prepare: router network failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  // 3. If all of the above failed or was otherwise not supported, use txservice to send the transaction.
  logger.info("Router contract prepare: sending using txservice", requestContext, methodContext, { prepareParams });

  const receipt = await txService.sendTx(onchainTx, requestContext);

  // increment fees sent (no need to await)
  incrementGasConsumed(
    txData.transactionId,
    txData.sendingAssetId,
    txData.sendingChainId,
    txData.receivingAssetId,
    txData.receivingChainId,
    chainId,
    receipt,
    TransactionReasons.PrepareReceiver,
    requestContext,
  );

  return receipt;
};

export const fulfillTransactionManager = async (
  chainId: number,
  fulfillParams: FulfillParams,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(fulfillTransactionManager.name);

  const { logger, txService, wallet } = getContext();
  logger.info("Method start", requestContext, methodContext);

  const { txData, relayerFee, signature: fulfillSignature, callData } = fulfillParams;

  await sanitationCheck(chainId, txData, "fulfill");

  const nxtpContractAddress = getContractAddress(chainId);

  const encodedData = getTxManagerInterface().encodeFunctionData("fulfill", [
    { txData, relayerFee, signature: fulfillSignature, callData, encodedMeta: "0x" },
  ]);

  const addr = wallet.address ?? (await wallet.getAddress());
  const receipt = await txService.sendTx(
    {
      to: nxtpContractAddress,
      data: encodedData,
      value: constants.Zero,
      chainId,
      from: addr,
    },
    requestContext,
  );

  // increment fees sent (no need to await)
  incrementGasConsumed(
    txData.transactionId,
    txData.sendingAssetId,
    txData.sendingChainId,
    txData.receivingAssetId,
    txData.receivingChainId,
    chainId,
    receipt,
    txData.router.toLowerCase() === addr.toLowerCase() ? TransactionReasons.FulfillSender : TransactionReasons.Relay,
    requestContext,
  );

  return receipt;
};

export const fulfillRouterContract = async (
  chainId: number,
  fulfillParams: FulfillParams,
  routerContractAddress: string,
  signature: string,
  routerRelayerFeeAsset: string,
  routerRelayerFee: string,
  useRelayer: boolean,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(fulfillRouterContract.name);

  const { logger, txService, wallet, messaging } = getContext();
  logger.info("Method start", requestContext, methodContext, {
    fulfillParams,
    routerRelayerFeeAsset,
    routerRelayerFee,
  });

  const { txData, relayerFee, signature: fulfillSignature, callData } = fulfillParams;

  await sanitationCheck(chainId, { ...txData, amount: "0", expiry: 0, preparedBlockNumber: 0 }, "fulfill");

  const routerEncoded = await txService.readTx({
    to: txData.router,
    data: getRouterContractInterface().encodeFunctionData("routerSigner"),
    chainId,
  });
  const [router] = getRouterContractInterface().decodeFunctionResult("routerSigner", routerEncoded);

  logger.info("Generating encoded data", requestContext, methodContext, {
    function: "fulfill",
    txData,
    relayerFee,
    fulfillSignature,
    callData,
    encodedMeta: "0x",
    routerRelayerFeeAsset,
    routerRelayerFee,
    signature,
    routerSigner: router,
  });

  const encodedData = getRouterContractInterface().encodeFunctionData("fulfill", [
    { txData, relayerFee, signature: fulfillSignature, callData, encodedMeta: "0x" },
    routerRelayerFeeAsset,
    routerRelayerFee,
    signature,
  ]);

  const onchainTx = {
    to: routerContractAddress,
    data: encodedData,
    value: constants.Zero,
    chainId,
    from: wallet.address,
  };
  if (useRelayer) {
    // If we are will be using relayers below, check to make sure the transaction is valid first (before relaying it)
    // by running an estimateGas check. This method will throw a TransactionReverted error (with the contract error code)
    // if the transaction would fail on chain.
    await txService.getGasEstimate(chainId, {
      ...onchainTx,
      from: undefined,
    });
  }

  // 1. Prepare tx using relayer if chain is supported by gelato.
  if (useRelayer && isChainSupportedByGelato(chainId)) {
    logger.info("Router contract fulfill: sending using Gelato relayer", requestContext, methodContext, {
      fulfillParams,
      routerContractAddress,
      signature,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const data = await gelatoSend(
        chainId,
        routerContractAddress,
        encodedData,
        routerRelayerFeeAsset,
        routerRelayerFee,
      );
      if (!data.taskId) {
        throw new Error("No taskId returned");
      }
      logger.info("Router contract fulfill: sent using Gelato relayer", requestContext, methodContext, { data });

      // listen for event on contract
      const { event } = await fulfillEvt
        .pipe(({ args }) => args.txData.transactionId === txData.transactionId)
        .waitFor(300_000);

      if (chainId === txData.sendingChainId) {
        // increment router fees when sending on sending chain. it doesn't take fee from router for ReceiverFulfill transactions.
        incrementRelayerFeesPaid(
          txData.transactionId,
          txData.sendingAssetId,
          txData.sendingChainId,
          txData.receivingAssetId,
          txData.receivingChainId,
          chainId,
          routerRelayerFee,
          routerRelayerFeeAsset,
          TransactionReasons.FulfillSender,
          requestContext,
        );
      }

      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      logger.warn("Router contract fulfill: Gelato send failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  // 2. If gelato is not supported, or gelato send failed, try using the router network.
  if (useRelayer) {
    logger.info("Router contract fulfill: sending using router network", requestContext, methodContext, {
      fulfillParams,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const payload = {
        chainId,
        to: routerContractAddress,
        type: MetaTxTypes.RouterContractFulfill,
        data: {
          params: fulfillParams,
          signature,
          relayerFee: routerRelayerFee,
          relayerFeeAsset: routerRelayerFeeAsset,
        } as MetaTxPayloads[typeof MetaTxTypes.RouterContractFulfill],
      };
      await messaging.publishMetaTxRequest(payload);

      // listen for event on contract
      const { event } = await fulfillEvt
        .pipe(({ args }) => args.txData.transactionId === txData.transactionId)
        .waitFor(300_000);

      if (chainId === txData.sendingChainId) {
        // increment router fees when sending on sending chain. it doesn't take fee from router for ReceiverFulfill transactions.
        incrementRelayerFeesPaid(
          txData.transactionId,
          txData.sendingAssetId,
          txData.sendingChainId,
          txData.receivingAssetId,
          txData.receivingChainId,
          chainId,
          routerRelayerFee,
          routerRelayerFeeAsset,
          TransactionReasons.FulfillSender,
          requestContext,
        );
      }

      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      // NOTE: It is possible that the actual error was in the subscriber, and the above event's timeout
      // (see waitFor) is the error we actually caught in this block.
      logger.warn("Router contract fulfill: router network failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  // 3. If all of the above failed or was otherwise not supported, use txservice to send the transaction.
  logger.info("Router contract fulfill: sending using txservice", requestContext, methodContext, { fulfillParams });
  const receipt = await txService.sendTx(onchainTx, requestContext);

  incrementGasConsumed(
    txData.transactionId,
    txData.sendingAssetId,
    txData.sendingChainId,
    txData.receivingAssetId,
    txData.receivingChainId,
    chainId,
    receipt,
    TransactionReasons.FulfillSender,
    requestContext,
  );

  return receipt;
};

export const cancelTransactionManager = async (
  chainId: number,
  cancelParams: CancelParams,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(cancelTransactionManager.name);

  const { logger, txService, wallet } = getContext();
  logger.info("Method start", requestContext, methodContext, { cancelParams });

  const { txData, signature: cancelSignature } = cancelParams;
  await sanitationCheck(chainId, txData, "cancel");

  const nxtpContractAddress = getContractAddress(chainId);

  const encodedData = getTxManagerInterface().encodeFunctionData("cancel", [
    { txData, signature: cancelSignature, encodedMeta: "0x" },
  ]);

  const addr = wallet.address ?? (await wallet.getAddress());
  const receipt = await txService.sendTx(
    {
      to: nxtpContractAddress,
      data: encodedData,
      value: constants.Zero,
      chainId,
      from: addr,
    },
    requestContext,
  );

  incrementGasConsumed(
    txData.transactionId,
    txData.sendingAssetId,
    txData.sendingChainId,
    txData.receivingAssetId,
    txData.receivingChainId,
    chainId,
    receipt,
    addr.toLowerCase() !== txData.router.toLowerCase()
      ? TransactionReasons.Relay
      : chainId === txData.sendingChainId
      ? TransactionReasons.CancelSender
      : TransactionReasons.CancelReceiver,
    requestContext,
  );

  return receipt;
};

export const cancelRouterContract = async (
  chainId: number,
  cancelParams: CancelParams,
  routerContractAddress: string,
  signature: string,
  routerRelayerFeeAsset: string,
  routerRelayerFee: string,
  useRelayer: boolean,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(cancelRouterContract.name);

  const { logger, txService, wallet, messaging } = getContext();
  logger.info("Method start", requestContext, methodContext, {
    cancelParams,
    routerRelayerFeeAsset,
    routerRelayerFee,
  });

  const { txData, signature: cancelSignature } = cancelParams;

  await sanitationCheck(chainId, { ...txData, amount: "0", expiry: 0, preparedBlockNumber: 0 }, "cancel");

  const encodedData = getRouterContractInterface().encodeFunctionData("cancel", [
    { txData, signature: cancelSignature, encodedMeta: "0x" },
    routerRelayerFeeAsset,
    routerRelayerFee,
    signature,
  ]);

  const onchainTx = {
    to: routerContractAddress,
    data: encodedData,
    value: constants.Zero,
    chainId,
    from: wallet.address,
  };
  if (useRelayer) {
    // If we are will be using relayers below, check to make sure the transaction is valid first (before relaying it)
    // by running an estimateGas check. This method will throw a TransactionReverted error (with the contract error code)
    // if the transaction would fail on chain.
    await txService.getGasEstimate(chainId, {
      ...onchainTx,
      from: undefined,
    });
  }

  // 1. Prepare tx using relayer if chain is supported by gelato.
  if (useRelayer && isChainSupportedByGelato(chainId)) {
    logger.info("Router contract cancel: sending using Gelato relayer", requestContext, methodContext, {
      cancelParams,
      routerContractAddress,
      signature,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const data = await gelatoSend(
        chainId,
        routerContractAddress,
        encodedData,
        routerRelayerFeeAsset,
        routerRelayerFee,
      );
      if (!data.taskId) {
        throw new Error("No taskId returned");
      }
      logger.info("Router contract cancel: sent using Gelato relayer", requestContext, methodContext, {
        data,
      });

      // listen for event on contract
      const { event } = await cancelEvt
        .pipe(({ args }) => args.txData.transactionId === txData.transactionId)
        .waitFor(300_000);

      // increment router fees
      incrementRelayerFeesPaid(
        txData.transactionId,
        txData.sendingAssetId,
        txData.sendingChainId,
        txData.receivingAssetId,
        txData.receivingChainId,
        chainId,
        routerRelayerFee,
        routerRelayerFeeAsset,
        chainId === txData.sendingChainId ? TransactionReasons.CancelSender : TransactionReasons.PrepareReceiver,
        requestContext,
      );

      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      logger.warn("Router contract cancel: Gelato send failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  // 2. If gelato is not supported, or gelato send failed, try using the router network.
  if (useRelayer) {
    logger.info("Router contract cancel: sending using router network", requestContext, methodContext, {
      cancelParams,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const payload = {
        chainId,
        to: routerContractAddress,
        type: MetaTxTypes.RouterContractCancel,
        data: {
          params: cancelParams,
          signature,
          relayerFee: routerRelayerFee,
          relayerFeeAsset: routerRelayerFeeAsset,
        } as MetaTxPayloads[typeof MetaTxTypes.RouterContractCancel],
      };
      await messaging.publishMetaTxRequest(payload);

      // listen for event on contract
      const { event } = await cancelEvt
        .pipe(({ args }) => args.txData.transactionId === txData.transactionId)
        .waitFor(300_000);

      // increment router fees
      incrementRelayerFeesPaid(
        txData.transactionId,
        txData.sendingAssetId,
        txData.sendingChainId,
        txData.receivingAssetId,
        txData.receivingChainId,
        chainId,
        routerRelayerFee,
        routerRelayerFeeAsset,
        chainId === txData.sendingChainId ? TransactionReasons.CancelSender : TransactionReasons.PrepareReceiver,
        requestContext,
      );

      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      // NOTE: It is possible that the actual error was in the subscriber, and the above event's timeout
      // (see waitFor) is the error we actually caught in this block.
      logger.warn("Router contract cancel: router network failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  logger.info("Router contract cancel: sending using txservice", requestContext, methodContext, { cancelParams });
  const receipt = await txService.sendTx(onchainTx, requestContext);

  incrementGasConsumed(
    txData.transactionId,
    txData.sendingAssetId,
    txData.sendingChainId,
    txData.receivingAssetId,
    txData.receivingChainId,
    chainId,
    receipt,
    txData.sendingChainId === chainId ? TransactionReasons.CancelSender : TransactionReasons.CancelReceiver,
    requestContext,
  );

  return receipt;
};

/**
 * Removes liquidity from the `TransactionManager` on the provided chain.
 *
 * @param chainId - The chain to interact with
 * @param amount - The amount of liquidity you want to remove
 * @param assetId - The assetId (token address or address(0) for native asset) of the asset you'd like to remove liquidity from onchain.
 * @param recipientAddress - The address you'd like the funds to be sent to
 * @returns If successful, returns `TransactionReceipt` for the removeLiquidity transaction. If it fails, returns a `TransactionManagerError`
 */
export const removeLiquidityTransactionManager = async (
  chainId: number,
  amount: string,
  assetId: string,
  recipientAddress: string | undefined,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(removeLiquidityTransactionManager.name, requestContext);

  const { logger, txService, wallet, signerAddress } = getContext();

  logger.info("Method start", requestContext, methodContext, { amount, assetId, recipientAddress });

  if (!recipientAddress) {
    recipientAddress = signerAddress;
  }

  const nxtpContractAddress = getContractAddress(chainId);

  const encodedData = getTxManagerInterface().encodeFunctionData("removeLiquidity", [
    amount,
    assetId,
    recipientAddress,
  ]);
  return await txService.sendTx(
    {
      to: nxtpContractAddress,
      data: encodedData,
      value: constants.Zero,
      chainId,
      from: wallet.address,
    },
    requestContext,
  );
};

export const removeLiquidityRouterContract = async (
  chainId: number,
  amount: string,
  assetId: string,
  routerContractAddress: string,
  signature: string,
  routerRelayerFeeAsset: string,
  routerRelayerFee: string,
  useRelayer: boolean,
  requestContext: RequestContext,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(removeLiquidityRouterContract.name);

  const { logger, txService, wallet, messaging } = getContext();
  logger.info("Method start", requestContext, methodContext, {
    amount,
    assetId,
    routerRelayerFeeAsset,
    routerRelayerFee,
  });

  const encodedData = getRouterContractInterface().encodeFunctionData("removeLiquidity", [
    amount,
    assetId,
    routerRelayerFeeAsset,
    routerRelayerFee,
    signature,
  ]);

  const onchainTx = {
    to: routerContractAddress,
    data: encodedData,
    value: constants.Zero,
    chainId,
    from: wallet.address,
  };
  if (useRelayer) {
    // If we are will be using relayers below, check to make sure the transaction is valid first (before relaying it)
    // by running an estimateGas check. This method will throw a TransactionReverted error (with the contract error code)
    // if the transaction would fail on chain.
    await txService.getGasEstimate(chainId, {
      ...onchainTx,
      from: undefined,
    });
  }

  // 1. Prepare tx using relayer if chain is supported by gelato.
  if (useRelayer && isChainSupportedByGelato(chainId)) {
    logger.info("Router contract removeLiquidity: sending using Gelato relayer", requestContext, methodContext, {
      amount,
      assetId,
      routerContractAddress,
      signature,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const data = await gelatoSend(
        chainId,
        routerContractAddress,
        encodedData,
        routerRelayerFeeAsset,
        routerRelayerFee,
      );
      if (!data.taskId) {
        throw new Error("No taskId returned");
      }
      logger.info("Router contract removeLiquidity: sent using Gelato relayer", requestContext, methodContext, {
        data,
      });

      // listen for event on contract
      const { event } = await removeLiquidityEvt.waitFor(300_000);
      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      logger.warn("Router contract removeLiquidity: Gelato send failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  // 2. If gelato is not supported, or gelato send failed, try using the router network.
  if (useRelayer) {
    logger.info("Router contract removeLiquidity: sending using router network", requestContext, methodContext, {
      amount,
      assetId,
      routerRelayerFeeAsset,
      routerRelayerFee,
    });

    try {
      const payload = {
        chainId,
        to: routerContractAddress,
        type: MetaTxTypes.RouterContractRemoveLiquidity,
        data: {
          params: { router: routerContractAddress, amount, assetId },
          signature,
          relayerFee: routerRelayerFee,
          relayerFeeAsset: routerRelayerFeeAsset,
        } as MetaTxPayloads[typeof MetaTxTypes.RouterContractRemoveLiquidity],
      };
      await messaging.publishMetaTxRequest(payload);

      // listen for event on contract
      const { event } = await removeLiquidityEvt.waitFor(300_000);
      return await txService.getTransactionReceipt(chainId, event.transactionHash);
    } catch (err: any) {
      // NOTE: It is possible that the actual error was in the subscriber, and the above event's timeout
      // (see waitFor) is the error we actually caught in this block.
      logger.warn("Router contract removeLiquidity: router network failed", requestContext, methodContext, {
        err: jsonifyError(err),
      });
    }
  }

  logger.info("Router contract removeLiquidity: sending using txservice", requestContext, methodContext, {
    router: routerContractAddress,
    amount,
    assetId,
  });
  return await txService.sendTx(onchainTx, requestContext);
};

export const addLiquidityForTransactionManager = async (
  chainId: number,
  amount: string,
  assetId: string,
  routerAddress: string | undefined,
  requestContext: RequestContext,
  infiniteApprove = true,
): Promise<providers.TransactionReceipt> => {
  const { methodContext } = createLoggingContext(addLiquidityForTransactionManager.name, requestContext);

  const { logger, txService, wallet, signerAddress } = getContext();

  logger.info("Method start", requestContext, methodContext, { amount, assetId, routerAddress });

  if (!routerAddress) {
    routerAddress = signerAddress;
  }

  const nxtpContractAddress = getContractAddress(chainId);

  if (assetId !== constants.AddressZero) {
    const approvedData = getErc20ContractInterface().encodeFunctionData("allowance", [
      signerAddress,
      nxtpContractAddress,
    ]);
    const approvedEncoded = await txService.readTx({
      to: assetId,
      data: approvedData,
      chainId,
    });

    const [approved] = getErc20ContractInterface().decodeFunctionResult("allowance", approvedEncoded);

    logger.info("Got approved tokens", requestContext, methodContext, { approved: approved.toString() });

    if (BigNumber.from(approved).lt(amount)) {
      const data = getErc20ContractInterface().encodeFunctionData("approve", [
        nxtpContractAddress,
        infiniteApprove ? constants.MaxUint256 : amount,
      ]);
      logger.info("Approve transaction created", requestContext, methodContext);
      const approveTx = await txService.sendTx(
        { to: assetId, data, from: signerAddress, chainId, value: constants.Zero },
        requestContext,
      );
      logger.info("Approved Transaction", requestContext, methodContext, {
        approveTx,
      });
    } else {
      logger.info("Allowance sufficient", requestContext, methodContext, {
        approved: approved.toString(),
        amount,
      });
    }
  }

  const encodedData = getTxManagerInterface().encodeFunctionData("addLiquidityFor", [amount, assetId, routerAddress]);
  return await txService.sendTx(
    {
      to: nxtpContractAddress,
      data: encodedData,
      value: constants.Zero,
      chainId,
      from: wallet.address,
    },
    requestContext,
  );
};

export const migrateLiquidity = async (
  chainId: number,
  assetId: string,
  requestContext: RequestContext,
  routerAddress?: string,
  amount?: string,
): Promise<
  { removeLiqudityTx: providers.TransactionReceipt; addLiquidityForTx: providers.TransactionReceipt } | undefined
> => {
  const { methodContext } = createLoggingContext(migrateLiquidity.name, requestContext);
  const { logger, signerAddress, contractReader } = getContext();

  if (routerAddress) {
    const res = await isRouterWhitelisted(routerAddress, chainId);
    if (!res) {
      logger.warn("router isn't whitelisted", requestContext, methodContext, { routerAddress: routerAddress, chainId });
      return;
    }
  }

  if (!amount) {
    amount = (await contractReader.getAssetBalance(assetId, chainId)).toString();
    logger.info("Got amount from contract reader", requestContext, methodContext, {
      amount,
    });
  }

  if (BigNumber.from(amount).isZero()) {
    logger.warn("Amount is zero, nothing to migrate", requestContext, methodContext, { amount });
    return;
  }

  logger.info("Method start", requestContext, methodContext, {
    chainId,
    amount,
    assetId,
    signerAddress,
    routerAddress,
  });

  const removeLiqudityTx = await removeLiquidityTransactionManager(
    chainId,
    amount,
    assetId,
    signerAddress,
    requestContext,
  );

  logger.info("Removed Liquidity", requestContext, methodContext, {
    chainId,
    amount,
    assetId,
    receiverAddress: signerAddress,
    removeLiqudityTx,
  });

  const addLiquidityForTx = await addLiquidityForTransactionManager(
    chainId,
    amount,
    assetId,
    routerAddress,
    requestContext,
  );

  logger.info("Added Liquidity", requestContext, methodContext, {
    chainId,
    amount,
    assetId,
    routerAddress,
    addLiquidityForTx,
  });

  return {
    removeLiqudityTx,
    addLiquidityForTx,
  };
};

export const getRouterBalance = async (chainId: number, router: string, assetId: string): Promise<BigNumber> => {
  const { txService } = getContext();

  const nxtpContractAddress = getContractAddress(chainId);

  const encodedData = getTxManagerInterface().encodeFunctionData("routerBalances", [router, assetId]);
  const ret = await txService.readTx({
    to: nxtpContractAddress,
    data: encodedData,
    chainId,
  });
  return BigNumber.from(ret);
};
